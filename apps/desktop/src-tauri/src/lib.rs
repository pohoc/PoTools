use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};

/// Holds the Node sidecar. All PDF work happens in that process, never here.
#[derive(Default)]
struct Engine {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
}

fn find_node() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("POTOOLS_NODE") {
        let path = PathBuf::from(explicit);
        if path.exists() {
            return Some(path);
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
    let node = find_node().ok_or_else(|| {
        "找不到 Node 运行时。请安装 Node 18+ 或设置 POTOOLS_NODE 环境变量。".to_string()
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
                    engine_dir.join("src/index.ts").to_string_lossy().to_string(),
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
                engine_dir.join("src/index.ts").to_string_lossy().to_string(),
            ],
            Some(engine_dir),
        ));
    }

    let resource = app
        .path()
        .resolve("engine", tauri::path::BaseDirectory::Resource)
        .map_err(|_| "找不到 PDF 引擎（开发目录 packages/engine 或安装包 resources/engine）".to_string())?;
    for name in ["engine.mjs", "engine.cjs", "server.js"] {
        let script = resource.join(name);
        if script.exists() {
            return Ok((node, vec![script.to_string_lossy().to_string()], Some(resource)));
        }
    }
    Err(format!("引擎入口缺失：{}", resource.display()))
}

fn pump<R: std::io::Read + Send + 'static>(reader: R, app: AppHandle, channel: String, mirror_stderr: bool) {
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            match line {
                Ok(text) if !text.trim().is_empty() => {
                    if mirror_stderr {
                        let _ = writeln!(std::io::stderr(), "[engine] {}", text);
                    }
                    let _ = app.emit(&channel, text);
                }
                Err(_) => break,
                _ => {}
            }
        }
    });
}

fn start_engine(app: &AppHandle, engine: &Engine, concurrency: Option<u32>) -> Result<(), String> {
    {
        let guard = engine.child.lock().map_err(|_| "engine state poisoned".to_string())?;
        if guard.is_some() {
            return Ok(());
        }
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
    let heap_limit = if cfg!(target_os = "windows") { "768" } else { "1024" };
    args.insert(0, format!("--max-old-space-size={}", heap_limit));

    let mut command = Command::new(&program);
    command
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
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

    pump(stdout, app.clone(), "engine://line".to_string(), false);
    pump(stderr, app.clone(), "engine://log".to_string(), true);

    *engine.stdin.lock().map_err(|_| "poisoned".to_string())? = Some(stdin);
    *engine.child.lock().map_err(|_| "poisoned".to_string())? = Some(child);
    Ok(())
}

#[tauri::command]
fn engine_start(app: AppHandle, engine: State<'_, Engine>, concurrency: Option<u32>) -> Result<(), String> {
    start_engine(&app, &engine, concurrency)
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
        // Own the sidecar from startup so the first RPC never races the webview.
        .setup(|app| {
            let handle = app.handle().clone();
            let engine = handle.state::<Engine>();
            if let Err(error) = start_engine(&handle, &engine, None) {
                eprintln!("[potools] engine autostart failed: {}", error);
            }
            Ok(())
        })
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
