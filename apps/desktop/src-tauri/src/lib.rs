use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};

/// Holds the Node sidecar. All PDF work happens in that process, never here.
#[derive(Clone, Default)]
struct Engine {
    child: Arc<Mutex<Option<Child>>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    ready_frame: Arc<Mutex<Option<String>>>,
}

fn find_node(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("POTOOLS_NODE") {
        let path = PathBuf::from(explicit);
        if path.exists() {
            return Some(path);
        }
    }

    // Installers carry a private Node runtime beside the engine bundle, so
    // launch does not depend on a shell or a system Node installation.
    if cfg!(any(target_os = "windows", target_os = "macos")) {
        let runtime_name = if cfg!(target_os = "windows") {
            "engine/node.exe"
        } else {
            "engine/node"
        };
        let resource_node = app
            .path()
            .resolve(runtime_name, tauri::path::BaseDirectory::Resource);
        let executable_node = std::env::current_exe()
            .ok()
            .and_then(|executable| executable.parent().map(|dir| dir.join(runtime_name)));
        for path in resource_node.ok().into_iter().chain(executable_node) {
            if path.is_file() {
                eprintln!("[potools] using bundled Node runtime at {}", path.display());
                return Some(path);
            }
        }

        #[cfg(target_os = "windows")]
        {
            let probe = Command::new("where.exe")
                .arg("node.exe")
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .output()
                .ok()?;
            return String::from_utf8_lossy(&probe.stdout)
                .lines()
                .map(str::trim)
                .map(PathBuf::from)
                .find(|path| path.is_file());
        }
        #[cfg(target_os = "macos")]
        {
            // Keep the environment lookup as a developer convenience if the
            // bundled runtime is missing from a locally-built app bundle.
            let probe = Command::new("sh")
                .arg("-lc")
                .arg("command -v node")
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .output()
                .ok()?;
            return String::from_utf8_lossy(&probe.stdout)
                .lines()
                .map(str::trim)
                .map(PathBuf::from)
                .find(|path| path.is_file());
        }
    }

    let probe = Command::new("sh")
        .arg("-lc")
        .arg("command -v node")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok();
    if let Some(output) = probe {
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !text.is_empty() && Path::new(&text).exists() {
            return Some(PathBuf::from(text));
        }
    }
    let fixed = [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ];
    for candidate in fixed {
        if Path::new(candidate).exists() {
            return Some(PathBuf::from(candidate));
        }
    }
    // nvm installs are common on developer machines and are absent from a GUI PATH.
    let mut newest: Option<(String, PathBuf)> = None;
    if let Some(home) = std::env::var_os("HOME") {
        let versions = PathBuf::from(home).join(".nvm/versions/node");
        if let Ok(entries) = fs::read_dir(versions) {
            for entry in entries.flatten() {
                let binary = entry.path().join("bin/node");
                if !binary.exists() {
                    continue;
                }
                let key = entry.file_name().to_string_lossy().to_string();
                if newest.as_ref().is_none_or(|(existing, _)| key > *existing) {
                    newest = Some((key, binary));
                }
            }
        }
    }
    newest.map(|(_, path)| path)
}

fn dev_engine_dir() -> Option<PathBuf> {
    let mut dir = std::env::current_dir().ok()?;
    for _ in 0..5 {
        for candidate in [
            dir.join("packages/engine"),
            dir.join("../../packages/engine"),
        ] {
            if candidate.join("package.json").exists() && candidate.join("src/index.ts").exists() {
                return Some(candidate.canonicalize().unwrap_or(candidate));
            }
        }
        dir = dir.parent()?.to_path_buf();
    }
    None
}

/// Resolution order: explicit env override → development tree → bundled resource.
/// The dev tree comes first because the esbuild bundle keeps native modules
/// (`sharp`) external, and only the source tree can resolve them.
fn engine_launch(app: &AppHandle) -> Result<(PathBuf, Vec<String>, Option<PathBuf>), String> {
    let node = find_node(app).ok_or_else(|| {
        if cfg!(target_os = "windows") {
            "找不到 Node 运行时。请重装包含运行时的 PoTools，或设置 POTOOLS_NODE 环境变量。"
                .to_string()
        } else {
            "找不到 Node 运行时。请安装 Node 18+ 或设置 POTOOLS_NODE 环境变量。".to_string()
        }
    })?;

    if let Ok(explicit) = std::env::var("POTOOLS_ENGINE") {
        let script = PathBuf::from(explicit);
        if script.exists() {
            let cwd = script.parent().map(|p| p.to_path_buf());
            return Ok((node, vec![script.to_string_lossy().to_string()], cwd));
        }
    }

    if let Some(engine_dir) = dev_engine_dir() {
        let tsx = engine_dir.join("node_modules/.bin/tsx");
        if tsx.exists() {
            return Ok((
                tsx,
                vec![
                    engine_dir
                        .join("src/index.ts")
                        .to_string_lossy()
                        .to_string(),
                    "--log".to_string(),
                    std::env::var("POTOOLS_LOG_LEVEL").unwrap_or_else(|_| "info".to_string()),
                ],
                Some(engine_dir),
            ));
        }
        return Ok((
            node,
            vec![
                "--import".to_string(),
                "tsx".to_string(),
                engine_dir
                    .join("src/index.ts")
                    .to_string_lossy()
                    .to_string(),
            ],
            Some(engine_dir),
        ));
    }

    let resource = app
        .path()
        .resolve("engine", tauri::path::BaseDirectory::Resource)
        .map_err(|_| {
            "找不到 PDF 引擎（开发目录 packages/engine 或安装包 resources/engine）".to_string()
        })?;
    for name in ["engine.mjs", "engine.cjs", "server.js"] {
        let script = resource.join(name);
        if script.exists() {
            // On Windows, avoid passing a drive-qualified main-module path to
            // Node. Starting from the resource directory and using a relative
            // entry path sidesteps drive-relative path parsing (`D:`) while
            // preserving normal module resolution for engine/node_modules.
            let entry = if cfg!(target_os = "windows") {
                name.to_string()
            } else {
                script.to_string_lossy().to_string()
            };
            return Ok((node, vec![entry], Some(resource)));
        }
    }
    Err(format!("引擎入口缺失：{}", resource.display()))
}

fn pump_stderr<R: Read + Send + 'static>(
    reader: R,
    app: AppHandle,
    recent: Arc<Mutex<Vec<String>>>,
) {
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            match line {
                Ok(text) if !text.trim().is_empty() => {
                    let display = text.chars().take(500).collect::<String>();
                    if let Ok(mut lines) = recent.lock() {
                        lines.push(display.clone());
                        if lines.len() > 20 {
                            lines.remove(0);
                        }
                    }
                    let _ = writeln!(std::io::stderr(), "[engine] {}", display);
                    let _ = app.emit("engine://log", display);
                }
                Err(_) => break,
                _ => {}
            }
        }
    });
}

fn recent_stderr(lines: &Arc<Mutex<Vec<String>>>) -> String {
    lines
        .lock()
        .map(|lines| lines.join("\n"))
        .unwrap_or_default()
}

fn pump_stdout<R: Read + Send + 'static>(
    reader: R,
    app: AppHandle,
    first_frame: mpsc::SyncSender<Result<String, String>>,
) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut first = String::new();
        let result = match reader.read_line(&mut first) {
            Ok(0) => Err("引擎关闭了 stdout，没有发送 ready 握手".to_string()),
            Ok(_) => Ok(first.trim_end().to_string()),
            Err(error) => Err(format!("读取引擎握手失败: {error}")),
        };
        let _ = first_frame.send(result.clone());
        if let Ok(line) = result {
            if !line.trim().is_empty() {
                let _ = app.emit("engine://line", line);
            }
        }
        for line in reader.lines() {
            match line {
                Ok(text) if !text.trim().is_empty() => {
                    let _ = app.emit("engine://line", text);
                }
                Err(_) => break,
                _ => {}
            }
        }
    });
}

fn start_engine(
    app: &AppHandle,
    engine: &Engine,
    concurrency: Option<u32>,
) -> Result<String, String> {
    // Hold the child lock through spawn and handshake so app startup and the
    // frontend cannot race and create two Node processes.
    let mut child_guard = engine
        .child
        .lock()
        .map_err(|_| "engine state poisoned".to_string())?;
    if let Some(child) = child_guard.as_mut() {
        if child
            .try_wait()
            .map_err(|error| format!("检查引擎进程失败: {error}"))?
            .is_none()
        {
            if let Some(frame) = engine
                .ready_frame
                .lock()
                .map_err(|_| "engine state poisoned")?
                .clone()
            {
                return Ok(frame);
            }
            return Err("引擎进程已启动，但尚未完成 ready 握手".to_string());
        }
        *child_guard = None;
        *engine.stdin.lock().map_err(|_| "engine state poisoned")? = None;
        *engine
            .ready_frame
            .lock()
            .map_err(|_| "engine state poisoned")? = None;
    }
    let (program, mut args, cwd) = engine_launch(app)?;
    eprintln!("[potools] spawning {:?} {:?} cwd={:?}", program, args, cwd);
    args.push("serve".to_string());
    args.push("--stdio".to_string());
    if let Some(count) = concurrency {
        args.push("--concurrency".to_string());
        args.push(count.to_string());
    }
    // The engine uses WASM PDF rendering and image codecs; cap V8's old-space
    // per platform to prevent a single large document from ballooning without
    // constraining the native WebView process.
    let heap_limit = if cfg!(target_os = "windows") {
        "768"
    } else {
        "1024"
    };
    args.insert(0, format!("--max-old-space-size={}", heap_limit));

    let mut command = Command::new(&program);
    command
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // The sidecar is managed by PoTools and must not create a closable
        // console window. Its standard streams remain connected to our pipes.
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    if let Some(dir) = cwd {
        command.current_dir(dir);
    }
    // Release unused glibc arenas after large document jobs on Linux.
    if cfg!(target_os = "linux") {
        command.env("MALLOC_ARENA_MAX", "2");
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("启动引擎失败 ({}): {}", program.display(), error))?;
    let stdout = child.stdout.take().ok_or("引擎缺少 stdout")?;
    let stderr = child.stderr.take().ok_or("引擎缺少 stderr")?;
    let stdin = child.stdin.take().ok_or("引擎缺少 stdin")?;

    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    pump_stdout(stdout, app.clone(), ready_tx);
    let stderr_lines = Arc::new(Mutex::new(Vec::new()));
    pump_stderr(stderr, app.clone(), stderr_lines.clone());

    let frame = match ready_rx.recv_timeout(Duration::from_secs(45)) {
        Ok(Ok(frame)) => frame,
        Ok(Err(error)) => {
            let _ = child.kill();
            let _ = child.wait();
            let detail = recent_stderr(&stderr_lines);
            return Err(if detail.is_empty() {
                error
            } else {
                format!("{error}\n引擎日志:\n{detail}")
            });
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            let process_status = child
                .try_wait()
                .ok()
                .flatten()
                .map(|status| format!("，进程退出状态 {status}"))
                .unwrap_or_default();
            let _ = child.kill();
            let _ = child.wait();
            let detail = recent_stderr(&stderr_lines);
            let logs = if detail.is_empty() {
                String::new()
            } else {
                format!("\n引擎日志:\n{detail}")
            };
            return Err(format!(
                "引擎在 45 秒内没有发送 ready 握手{process_status}{logs}"
            ));
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            let _ = child.kill();
            let _ = child.wait();
            let detail = recent_stderr(&stderr_lines);
            return Err(if detail.is_empty() {
                "引擎握手读取线程异常退出".to_string()
            } else {
                format!("引擎握手读取线程异常退出\n引擎日志:\n{detail}")
            });
        }
    };
    let parsed: serde_json::Value = match serde_json::from_str(&frame) {
        Ok(parsed) => parsed,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "引擎 ready 握手不是有效 JSON: {error}; 输出: {frame}"
            ));
        }
    };
    if parsed.get("id").and_then(serde_json::Value::as_str) != Some("ready")
        || !parsed
            .get("result")
            .is_some_and(serde_json::Value::is_object)
    {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("引擎 ready 握手格式不正确: {frame}"));
    }

    *engine.stdin.lock().map_err(|_| "poisoned".to_string())? = Some(stdin);
    *engine
        .ready_frame
        .lock()
        .map_err(|_| "poisoned".to_string())? = Some(frame.clone());
    *child_guard = Some(child);
    Ok(frame)
}

#[tauri::command]
async fn engine_start(
    app: AppHandle,
    engine: State<'_, Engine>,
    concurrency: Option<u32>,
) -> Result<String, String> {
    let engine = engine.inner().clone();
    tauri::async_runtime::spawn_blocking(move || start_engine(&app, &engine, concurrency))
        .await
        .map_err(|error| format!("等待引擎启动失败: {error}"))?
}

#[tauri::command]
fn engine_write(engine: State<'_, Engine>, line: String) -> Result<(), String> {
    let mut guard = engine.stdin.lock().map_err(|_| "poisoned".to_string())?;
    let writer = guard.as_mut().ok_or("引擎未启动")?;
    writeln!(writer, "{}", line).map_err(|error| error.to_string())?;
    writer.flush().map_err(|error| error.to_string())
}

#[tauri::command]
fn engine_stop(engine: State<'_, Engine>) -> Result<(), String> {
    if let Some(mut child) = engine.child.lock().map_err(|_| "poisoned")?.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    let _ = engine.stdin.lock().map_err(|_| "poisoned")?.take();
    let _ = engine.ready_frame.lock().map_err(|_| "poisoned")?.take();
    Ok(())
}

#[tauri::command]
fn write_file_bytes(path: String, bytes: Vec<u8>) -> Result<(), String> {
    let target = PathBuf::from(path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&target, bytes).map_err(|error| error.to_string())
}

#[tauri::command]
fn open_path(path: String, reveal: Option<bool>) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err(format!("路径不存在: {}", path));
    }
    #[cfg(target_os = "macos")]
    let spawned = match reveal.unwrap_or(false) {
        true => Command::new("open").arg("-R").arg(&target).spawn(),
        false => Command::new("open").arg(&target).spawn(),
    };
    #[cfg(target_os = "windows")]
    let spawned = {
        let mut command = Command::new("explorer");
        if reveal.unwrap_or(false) {
            command.arg("/select,").arg(&target);
        } else {
            command.arg(&target);
        }
        command.spawn()
    };
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let spawned = {
        let mut command = Command::new("xdg-open");
        command.arg(&target);
        command.spawn()
    };
    spawned.map(|_| ()).map_err(|error| error.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Engine::default())
        .invoke_handler(tauri::generate_handler![
            engine_start,
            engine_write,
            engine_stop,
            write_file_bytes,
            open_path
        ])
        .build(tauri::generate_context!())
        .expect("error while building PoTools")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                let engine = app_handle.state::<Engine>();
                if let Some(mut child) = engine.child.lock().ok().and_then(|mut g| g.take()) {
                    let _ = child.kill();
                }
            }
        });
}
