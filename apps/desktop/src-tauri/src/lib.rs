use hickory_resolver::{proto::rr::RecordType, system_conf, TokioAsyncResolver};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::collections::{HashMap, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

use tauri::{AppHandle, Emitter, Manager, State};

/// Holds the engine child process. The release build may run the embedded Node
/// runtime from the same PoTools executable; development keeps the Node sidecar.
#[derive(Clone, Default)]
struct Engine {
    child: Arc<Mutex<Option<Child>>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    ready_frame: Arc<Mutex<Option<String>>>,
}

#[cfg(not(all(target_os = "windows", feature = "node-embed")))]
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

#[cfg(not(all(target_os = "windows", feature = "node-embed")))]
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
#[cfg(all(target_os = "windows", feature = "node-embed"))]
fn engine_launch(app: &AppHandle) -> Result<(PathBuf, Vec<String>, Option<PathBuf>), String> {
    let executable =
        std::env::current_exe().map_err(|error| format!("获取 PoTools 路径失败: {error}"))?;
    let working_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("获取 PoTools 数据目录失败: {error}"))?;
    fs::create_dir_all(&working_dir).map_err(|error| format!("创建引擎工作目录失败: {error}"))?;
    Ok((
        executable,
        vec!["--engine-child".to_string()],
        Some(working_dir),
    ))
}

#[cfg(not(all(target_os = "windows", feature = "node-embed")))]
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
    if !cfg!(all(target_os = "windows", feature = "node-embed")) {
        args.insert(0, format!("--max-old-space-size={}", heap_limit));
    }

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
        command.env("POTOOLS_ENGINE_DIR", &dir);
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

#[cfg(all(target_os = "windows", feature = "node-embed"))]
pub fn run_embedded_engine_child(engine_args: Vec<String>) -> i32 {
    use std::ffi::CString;

    extern "C" {
        fn potools_run_embedded_node(
            executable: *const std::ffi::c_char,
            engine_args: *const *const std::ffi::c_char,
            engine_argc: usize,
            bundle: *const u8,
            bundle_size: usize,
        ) -> i32;
    }

    let executable = match std::env::current_exe() {
        Ok(path) => path.to_string_lossy().into_owned(),
        Err(error) => {
            eprintln!("PoTools Node embedder: cannot resolve executable path: {error}");
            return 1;
        }
    };
    let executable = match CString::new(executable) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("PoTools Node embedder: invalid executable path: {error}");
            return 1;
        }
    };
    // The C++ bootstrap owns argv[1] (the virtual bundle filename). Keep this
    // slice limited to actual engine arguments such as `serve --stdio`.
    let args = match engine_args
        .into_iter()
        .map(CString::new)
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(args) => args,
        Err(error) => {
            eprintln!("PoTools Node embedder: invalid engine argument: {error}");
            return 1;
        }
    };
    let arg_ptrs = args.iter().map(|arg| arg.as_ptr()).collect::<Vec<_>>();
    let bundle = include_bytes!(env!("POTOOLS_ENGINE_BUNDLE"));
    unsafe {
        potools_run_embedded_node(
            executable.as_ptr(),
            arg_ptrs.as_ptr(),
            arg_ptrs.len(),
            bundle.as_ptr(),
            bundle.len(),
        )
    }
}

#[tauri::command]
fn write_file_bytes(path: String, bytes: Vec<u8>) -> Result<(), String> {
    let target = PathBuf::from(path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&target, bytes).map_err(|error| error.to_string())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct InvoiceArchiveInput {
    source_directory: String,
    target_directory: String,
    conflict: String,
    files: Vec<InvoiceArchiveFile>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct InvoiceArchiveFile {
    path: String,
    sha256: String,
    relative_path: String,
    enabled: bool,
    fields: Option<serde_json::Value>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct InvoiceScanCandidate {
    path: String,
    relative_path: String,
    name: String,
    extension: String,
    size_bytes: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct InvoiceScanListing {
    source_directory: String,
    files: Vec<InvoiceScanCandidate>,
    skipped: Vec<serde_json::Value>,
    exceeded: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct InvoiceCandidateRead {
    bytes: Vec<u8>,
    current_size_bytes: u64,
    changed_while_reading: bool,
}

#[derive(Clone)]
struct InvoiceUndoFile {
    path: PathBuf,
    sha256: String,
}

#[derive(Clone)]
struct InvoiceUndoArchive {
    target_root: PathBuf,
    files: Vec<InvoiceUndoFile>,
}

#[derive(Default)]
struct InvoiceUndoState {
    archives: HashMap<String, InvoiceUndoArchive>,
    order: VecDeque<String>,
}

fn invoice_undo_archives() -> &'static Mutex<InvoiceUndoState> {
    static ARCHIVES: OnceLock<Mutex<InvoiceUndoState>> = OnceLock::new();
    ARCHIVES.get_or_init(|| Mutex::new(InvoiceUndoState::default()))
}

fn invoice_sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn invoice_extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}").to_ascii_lowercase())
}

#[tauri::command]
fn invoice_scan_list(
    directory: String,
    recursive: Option<bool>,
    max_files: Option<f64>,
    exclude_directory: Option<String>,
) -> Result<InvoiceScanListing, String> {
    const MAX_FILES: usize = 2000;
    let requested_root = PathBuf::from(&directory);
    if directory.is_empty() || !requested_root.is_absolute() {
        return Err("请选择有效的来源目录".to_string());
    }
    let root = fs::canonicalize(&requested_root).map_err(|_| "无法访问来源目录")?;
    if !fs::metadata(&root)
        .map_err(|error| error.to_string())?
        .is_dir()
    {
        return Err("来源路径不是目录".to_string());
    }
    let excluded = exclude_directory
        .filter(|path| !path.trim().is_empty())
        .map(|path| {
            let raw = PathBuf::from(&path);
            let absolute = if raw.is_absolute() {
                raw
            } else {
                std::env::current_dir().unwrap_or_default().join(raw)
            };
            fs::canonicalize(&absolute)
                .unwrap_or_else(|_| invoice_normalize_absolute(&absolute).unwrap_or(absolute))
        });
    if excluded
        .as_ref()
        .is_some_and(|path| path == &root || path.starts_with(&root))
    {
        return Err("归档目标不能与来源目录相同或位于来源目录内".to_string());
    }
    let requested_limit = max_files.unwrap_or(MAX_FILES as f64);
    let limit = if requested_limit.is_finite() {
        requested_limit.trunc().clamp(1.0, MAX_FILES as f64) as usize
    } else {
        MAX_FILES
    };
    let recurse = recursive != Some(false);
    let mut files = Vec::new();
    let mut skipped = Vec::new();
    let mut total_bytes = 0_u64;
    let mut exceeded = false;

    fn walk(
        directory: &Path,
        root: &Path,
        excluded: Option<&Path>,
        recursive: bool,
        limit: usize,
        total_bytes: &mut u64,
        exceeded: &mut bool,
        files: &mut Vec<InvoiceScanCandidate>,
        skipped: &mut Vec<serde_json::Value>,
    ) {
        const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;
        const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
        const ALLOWED: [&str; 7] = [".pdf", ".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"];
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(error) => {
                let relative = directory
                    .strip_prefix(root)
                    .unwrap_or(directory)
                    .to_string_lossy()
                    .replace('\\', "/");
                skipped.push(serde_json::json!({"relativePath":relative,"reason":format!("无法读取目录：{}", error)}));
                return;
            }
        };
        for result in entries {
            if files.len() >= limit || *total_bytes >= MAX_TOTAL_BYTES {
                *exceeded = true;
                return;
            }
            let Ok(entry) = result else { continue };
            let path = entry.path();
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            if excluded.is_some_and(|excluded| path == excluded || path.starts_with(excluded)) {
                continue;
            }
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => {
                    skipped.push(serde_json::json!({"relativePath":relative,"reason":"文件状态已变化，已跳过"}));
                    continue;
                }
            };
            if file_type.is_symlink() {
                skipped.push(serde_json::json!({"relativePath":relative,"reason":"跳过符号链接"}));
                continue;
            }
            if file_type.is_dir() {
                if recursive {
                    walk(
                        &path,
                        root,
                        excluded,
                        recursive,
                        limit,
                        total_bytes,
                        exceeded,
                        files,
                        skipped,
                    );
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let Some(extension) = invoice_extension(&path) else {
                continue;
            };
            if !ALLOWED.contains(&extension.as_str()) {
                continue;
            }
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                    metadata
                }
                _ => {
                    skipped.push(serde_json::json!({"relativePath":relative,"reason":"文件状态已变化，已跳过"}));
                    continue;
                }
            };
            if metadata.len() > MAX_FILE_BYTES {
                skipped.push(
                    serde_json::json!({"relativePath":relative,"reason":"超过单文件 100 MB 上限"}),
                );
                continue;
            }
            if total_bytes.saturating_add(metadata.len()) > MAX_TOTAL_BYTES {
                *exceeded = true;
                return;
            }
            *total_bytes = total_bytes.saturating_add(metadata.len());
            files.push(InvoiceScanCandidate {
                path: path.to_string_lossy().into_owned(),
                relative_path: relative,
                name: entry.file_name().to_string_lossy().into_owned(),
                extension,
                size_bytes: metadata.len(),
            });
        }
    }

    walk(
        &root,
        &root,
        excluded.as_deref(),
        recurse,
        limit,
        &mut total_bytes,
        &mut exceeded,
        &mut files,
        &mut skipped,
    );
    Ok(InvoiceScanListing {
        source_directory: root.to_string_lossy().into_owned(),
        files,
        skipped,
        exceeded,
    })
}

#[tauri::command]
fn invoice_read_candidate(
    path: String,
    expected_size_bytes: u64,
) -> Result<InvoiceCandidateRead, String> {
    const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;
    let source = PathBuf::from(path);
    let metadata = fs::symlink_metadata(&source).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("文件状态已变化，已跳过".to_string());
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err("超过单文件 100 MB 上限".to_string());
    }
    let bytes = fs::read(&source).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("超过单文件 100 MB 上限".to_string());
    }
    let current_size_bytes = fs::metadata(&source)
        .map_err(|error| error.to_string())?
        .len();
    let changed_while_reading =
        bytes.len() as u64 != current_size_bytes || current_size_bytes != expected_size_bytes;
    Ok(InvoiceCandidateRead {
        bytes,
        current_size_bytes,
        changed_while_reading,
    })
}

fn invoice_within(root: &Path, path: &Path) -> bool {
    path != root && path.starts_with(root)
}

fn invoice_normalize_absolute(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("请选择有效的归档目标目录".to_string());
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            std::path::Component::RootDir => normalized.push(component.as_os_str()),
            std::path::Component::CurDir => (),
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            std::path::Component::Normal(part) => normalized.push(part),
        }
    }
    Ok(normalized)
}

fn invoice_safe_segments(value: &str) -> Result<Vec<String>, String> {
    if value.is_empty()
        || value.len() > 2048
        || value.starts_with(['/', '\\'])
        || value.as_bytes().get(1) == Some(&b':')
    {
        return Err("目标路径必须是相对路径".to_string());
    }
    let mut segments = Vec::new();
    for raw in value.replace('\\', "/").split('/') {
        if raw.is_empty() {
            continue;
        }
        if raw == "." || raw == ".." {
            return Err("目标路径不能包含 . 或 ..".to_string());
        }
        let mut safe: String = raw
            .chars()
            .map(|ch| {
                if ch.is_control() || "<>:\"|?*".contains(ch) {
                    '_'
                } else {
                    ch
                }
            })
            .collect();
        while safe.ends_with([' ', '.']) {
            safe.pop();
        }
        safe = safe.chars().take(120).collect();
        if safe.is_empty() {
            safe.push('_');
        }
        let stem = safe.split('.').next().unwrap_or("");
        let upper_stem = stem.to_ascii_uppercase();
        let bytes = upper_stem.as_bytes();
        let reserved_numbered = bytes.len() == 4
            && (bytes.starts_with(b"COM") || bytes.starts_with(b"LPT"))
            && (b'1'..=b'9').contains(&bytes[3]);
        if ["CON", "PRN", "AUX", "NUL"].contains(&upper_stem.as_str()) || reserved_numbered {
            safe.insert(0, '_');
        }
        segments.push(safe);
    }
    if segments.is_empty() || segments.len() > 24 {
        return Err("目标路径层级无效".to_string());
    }
    Ok(segments)
}

fn invoice_ensure_safe_directory(root: &Path, directory: &Path) -> Result<(), String> {
    if !directory.starts_with(root) {
        return Err("目标目录超出归档目录".to_string());
    }
    let relative = directory
        .strip_prefix(root)
        .map_err(|_| "目标目录超出归档目录")?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let std::path::Component::Normal(segment) = component else {
            return Err("目标路径包含无效目录".to_string());
        };
        current.push(segment);
        match fs::create_dir(&current) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(error) => return Err(error.to_string()),
        }
        let metadata = fs::symlink_metadata(&current).map_err(|error| error.to_string())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("目标目录包含符号链接或非目录".to_string());
        }
    }
    Ok(())
}

fn invoice_free_destination(requested: &Path) -> Result<PathBuf, String> {
    let parent = requested.parent().ok_or("目标路径无效")?;
    let stem = requested
        .file_stem()
        .and_then(|v| v.to_str())
        .unwrap_or("output");
    let extension = requested
        .extension()
        .and_then(|v| v.to_str())
        .map(|v| format!(".{v}"))
        .unwrap_or_default();
    for suffix in 1..=9999 {
        let name = if suffix == 1 {
            requested.file_name().unwrap_or_default().to_os_string()
        } else {
            format!("{stem} ({suffix}){extension}").into()
        };
        let candidate = parent.join(name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("同名文件过多，无法自动生成不冲突的名称".to_string())
}

fn invoice_csv_cell(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn invoice_iso_now() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let days = (now.as_secs() / 86_400) as i64;
    let seconds = now.as_secs() % 86_400;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        seconds / 3600,
        (seconds / 60) % 60,
        seconds % 60,
        now.subsec_millis()
    )
}

fn invoice_report_path(root: &Path) -> Result<PathBuf, String> {
    let base = format!(
        "potools-invoice-report-{}",
        invoice_iso_now().replace([':', '.'], "-")
    );
    for suffix in 1..=100 {
        let name = if suffix == 1 {
            format!("{base}.json")
        } else {
            format!("{base}-{suffix}.json")
        };
        let path = root.join(name);
        if !path.exists() {
            return Ok(path);
        }
    }
    Err("无法创建归档报告文件".to_string())
}

#[tauri::command]
fn invoice_archive(input: InvoiceArchiveInput) -> Result<serde_json::Value, String> {
    const MAX_FILES: usize = 2000;
    const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;
    if input.files.len() > MAX_FILES || !input.files.iter().any(|item| item.enabled) {
        return Err(format!("请选择 1 至 {MAX_FILES} 个归档文件"));
    }
    if input.target_directory.is_empty() {
        return Err("请选择有效的归档目标目录".to_string());
    }
    let requested_source = PathBuf::from(&input.source_directory);
    let requested_target = invoice_normalize_absolute(Path::new(&input.target_directory))?;
    if !requested_source.is_absolute() {
        return Err("来源目录已不可用，请重新扫描".to_string());
    }
    let source_root =
        fs::canonicalize(&requested_source).map_err(|_| "来源目录已不可用，请重新扫描")?;
    let source_meta = fs::metadata(&source_root).map_err(|error| error.to_string())?;
    if !source_meta.is_dir() {
        return Err("来源路径不是目录".to_string());
    }
    if requested_target == source_root
        || requested_target.starts_with(&source_root)
        || source_root.starts_with(&requested_target)
    {
        return Err("归档目标必须是来源目录之外的独立目录".to_string());
    }
    fs::create_dir_all(&requested_target).map_err(|error| error.to_string())?;
    let target_root = fs::canonicalize(&requested_target).map_err(|error| error.to_string())?;
    if target_root == source_root
        || target_root.starts_with(&source_root)
        || source_root.starts_with(&target_root)
    {
        return Err("归档目标与来源目录不能重叠".to_string());
    }
    let mut copied = Vec::new();
    let mut skipped = Vec::new();
    let mut failed = Vec::new();
    for item in input.files.iter().filter(|item| item.enabled) {
        let mut temporary: Option<PathBuf> = None;
        let result = (|| -> Result<(PathBuf, String), String> {
            let source = PathBuf::from(&item.path);
            if !source.is_absolute() {
                return Err("源文件不在已扫描目录内".to_string());
            }
            let source_abs = source;
            let source_real = fs::canonicalize(&source_abs).map_err(|e| e.to_string())?;
            if !source_real.starts_with(&source_root) {
                return Err("源文件已移出来源目录".to_string());
            }
            let source_info = fs::symlink_metadata(&source_abs).map_err(|e| e.to_string())?;
            if !source_info.is_file() || source_info.file_type().is_symlink() {
                return Err("源文件不再是普通文件".to_string());
            }
            if source_info.len() > MAX_FILE_BYTES {
                return Err("源文件超过 100 MB 上限".to_string());
            }
            if item.sha256.len() != 64 || !item.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("扫描校验信息无效，请重新扫描".to_string());
            }
            let bytes = fs::read(&source_real).map_err(|e| e.to_string())?;
            let digest = invoice_sha256(&bytes);
            if digest != item.sha256.to_ascii_lowercase() {
                return Err("源文件内容已变化，请重新扫描".to_string());
            }
            let segments = invoice_safe_segments(&item.relative_path)?;
            let mut requested = target_root.clone();
            for segment in segments {
                requested.push(segment);
            }
            if !requested.starts_with(&target_root) {
                return Err("目标路径超出归档目录".to_string());
            }
            let parent = requested.parent().ok_or("目标路径无效")?;
            invoice_ensure_safe_directory(&target_root, parent)?;
            let destination = if input.conflict == "skip" {
                if destination_exists(&requested) {
                    return Err("conflict:目标文件已存在".to_string());
                }
                requested
            } else {
                invoice_free_destination(&requested)?
            };
            let temp = destination.with_file_name(format!(".potools-{}.tmp", Uuid::new_v4()));
            temporary = Some(temp.clone());
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)
                .map_err(|e| e.to_string())?;
            file.write_all(&bytes).map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
            let copied_bytes = fs::read(&temp).map_err(|e| e.to_string())?;
            if invoice_sha256(&copied_bytes) != digest {
                return Err("复制校验失败".to_string());
            }
            fs::hard_link(&temp, &destination).map_err(|e| e.to_string())?;
            // The destination is now safely linked and digest-verified. A
            // cleanup failure must not report a failed copy while leaving an
            // untracked destination behind.
            let _ = fs::remove_file(&temp);
            temporary = None;
            Ok((destination, digest))
        })();
        match result {
            Ok((target, digest)) => copied.push(serde_json::json!({ "source": item.path, "target": target.to_string_lossy(), "sha256": digest, "fields": item.fields.clone().unwrap_or_else(|| serde_json::json!({"date":"","seller":"","buyer":"","invoiceNo":"","amount":"","type":""})) })),
            Err(reason) => {
                if let Some(temp) = temporary { let _ = fs::remove_file(temp); }
                if let Some(message) = reason.strip_prefix("conflict:") { skipped.push(serde_json::json!({"source": item.path, "reason": message})); }
                else { failed.push(serde_json::json!({"source": item.path, "reason": reason})); }
            }
        }
    }
    let archive_id = Uuid::new_v4().to_string();
    let undo_files = copied
        .iter()
        .filter_map(|item| {
            Some(InvoiceUndoFile {
                path: PathBuf::from(item.get("target")?.as_str()?),
                sha256: item.get("sha256")?.as_str()?.to_string(),
            })
        })
        .collect::<Vec<_>>();
    {
        let mut archives = invoice_undo_archives()
            .lock()
            .map_err(|_| "撤销记录锁不可用")?;
        archives.archives.insert(
            archive_id.clone(),
            InvoiceUndoArchive {
                target_root: target_root.clone(),
                files: undo_files,
            },
        );
        archives.order.push_back(archive_id.clone());
        while archives.archives.len() > 32 {
            if let Some(oldest) = archives.order.pop_front() {
                archives.archives.remove(&oldest);
            } else {
                break;
            }
        }
    }
    let created_at = invoice_iso_now();
    let report = serde_json::json!({"archiveId":archive_id,"createdAt":created_at,"sourceDirectory":source_root.to_string_lossy(),"targetDirectory":target_root.to_string_lossy(),"conflict":input.conflict,"copied":copied,"skipped":skipped,"failed":failed});
    let mut csv = String::from(
        "\u{feff}source,target,sha256,date,seller,buyer,invoiceNo,amount,type,result,reason\r\n",
    );
    for item in report["copied"].as_array().into_iter().flatten() {
        let fields = &item["fields"];
        let values = [
            item["source"].as_str().unwrap_or(""),
            item["target"].as_str().unwrap_or(""),
            item["sha256"].as_str().unwrap_or(""),
            fields["date"].as_str().unwrap_or(""),
            fields["seller"].as_str().unwrap_or(""),
            fields["buyer"].as_str().unwrap_or(""),
            fields["invoiceNo"].as_str().unwrap_or(""),
            fields["amount"].as_str().unwrap_or(""),
            fields["type"].as_str().unwrap_or(""),
            "copied",
            "",
        ];
        csv.push_str(&values.map(invoice_csv_cell).join(","));
        csv.push_str("\r\n");
    }
    for item in report["skipped"].as_array().into_iter().flatten() {
        let values = [
            item["source"].as_str().unwrap_or(""),
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "skipped",
            item["reason"].as_str().unwrap_or(""),
        ];
        csv.push_str(&values.map(invoice_csv_cell).join(","));
        csv.push_str("\r\n");
    }
    for item in report["failed"].as_array().into_iter().flatten() {
        let values = [
            item["source"].as_str().unwrap_or(""),
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "failed",
            item["reason"].as_str().unwrap_or(""),
        ];
        csv.push_str(&values.map(invoice_csv_cell).join(","));
        csv.push_str("\r\n");
    }
    let mut warnings = Vec::new();
    let mut report_path: Option<PathBuf> = None;
    let mut csv_report_path: Option<PathBuf> = None;
    let report_result = invoice_report_path(&target_root).and_then(|path| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        file.write_all(
            serde_json::to_string_pretty(&report)
                .map_err(|e| e.to_string())?
                .as_bytes(),
        )
        .map_err(|e| e.to_string())?;
        Ok(path)
    });
    match report_result {
        Ok(path) => {
            let csv_path = path.with_extension("csv");
            let csv_result = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&csv_path)
                .and_then(|mut file| file.write_all(csv.as_bytes()));
            report_path = Some(path);
            if csv_result.is_ok() {
                csv_report_path = Some(csv_path);
            } else {
                warnings.push("report-write-failed");
            }
        }
        Err(_) => warnings.push("report-write-failed"),
    }
    Ok(
        serde_json::json!({"archiveId":archive_id,"copied":report["copied"],"skipped":report["skipped"],"failed":report["failed"],"reportPath":report_path.map(|v|v.to_string_lossy().into_owned()),"csvReportPath":csv_report_path.map(|v|v.to_string_lossy().into_owned()),"warnings":warnings}),
    )
}

fn destination_exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

#[tauri::command]
fn invoice_undo(archive_id: String) -> Result<serde_json::Value, String> {
    let archive = invoice_undo_archives()
        .lock()
        .map_err(|_| "撤销记录锁不可用")?
        .archives
        .get(&archive_id)
        .cloned()
        .ok_or("本次归档记录已过期或不存在")?;
    let mut removed = Vec::new();
    let mut skipped = Vec::new();
    for item in archive.files {
        let result = (|| -> Result<(), String> {
            if !invoice_within(&archive.target_root, &item.path) {
                return Err("文件不在本次归档目录内".to_string());
            }
            let meta =
                fs::symlink_metadata(&item.path).map_err(|_| "目标已不存在或不再是普通文件")?;
            if !meta.is_file() || meta.file_type().is_symlink() {
                return Err("目标已不存在或不再是普通文件".to_string());
            }
            let tombstone = item
                .path
                .with_file_name(format!(".potools-undo-{}.tmp", Uuid::new_v4()));
            fs::rename(&item.path, &tombstone).map_err(|e| e.to_string())?;
            let restore = |reason: String| -> String {
                match fs::hard_link(&tombstone, &item.path)
                    .and_then(|_| fs::remove_file(&tombstone))
                {
                    Ok(()) => reason,
                    Err(error) => format!(
                        "{reason}；未能恢复原路径，文件保留在 {} ({error})",
                        tombstone.display()
                    ),
                }
            };
            let moved_meta =
                fs::symlink_metadata(&tombstone).map_err(|e| restore(e.to_string()))?;
            if !moved_meta.is_file() || moved_meta.file_type().is_symlink() {
                return Err(restore("撤销目标已被替换，已保留临时文件".to_string()));
            }
            let real = fs::canonicalize(&tombstone).map_err(|e| restore(e.to_string()))?;
            if !real.starts_with(&archive.target_root) {
                return Err(restore("目标路径已被重定向到归档目录之外".to_string()));
            }
            let digest = invoice_sha256(&fs::read(&real).map_err(|e| restore(e.to_string()))?);
            if digest != item.sha256 {
                return Err(restore("文件内容已变化，已保留该文件".to_string()));
            }
            fs::remove_file(&tombstone).map_err(|e| restore(e.to_string()))?;
            Ok(())
        })();
        match result {
            Ok(()) => removed.push(item.path.to_string_lossy().into_owned()),
            Err(reason) => skipped
                .push(serde_json::json!({"path":item.path.to_string_lossy(),"reason":reason})),
        }
    }
    let mut state = invoice_undo_archives()
        .lock()
        .map_err(|_| "撤销记录锁不可用")?;
    state.archives.remove(&archive_id);
    state.order.retain(|id| id != &archive_id);
    Ok(serde_json::json!({"removed":removed,"skipped":skipped}))
}

#[cfg(test)]
mod invoice_archive_tests {
    use super::*;

    fn test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("potools-{label}-{}", Uuid::new_v4()))
    }

    #[test]
    fn invoice_archive_and_undo_preserve_verified_files() {
        let root = test_root("invoice-archive");
        let source = root.join("source");
        let target = root.join("target");
        fs::create_dir_all(source.join("2026")).unwrap();
        let source_file = source.join("2026/invoice.pdf");
        let contents = b"invoice-pdf-fixture";
        fs::write(&source_file, contents).unwrap();
        let result = invoice_archive(InvoiceArchiveInput {
            source_directory: source.to_string_lossy().into_owned(),
            target_directory: target.to_string_lossy().into_owned(),
            conflict: "rename".into(),
            files: vec![InvoiceArchiveFile {
                path: source_file.to_string_lossy().into_owned(),
                sha256: invoice_sha256(contents),
                relative_path: "2026/invoice.pdf".into(),
                enabled: true,
                fields: None,
            }],
        })
        .unwrap();
        assert_eq!(result["copied"].as_array().unwrap().len(), 1);
        let copied_path = PathBuf::from(result["copied"][0]["target"].as_str().unwrap());
        assert_eq!(fs::read(&copied_path).unwrap(), contents);
        assert!(PathBuf::from(result["reportPath"].as_str().unwrap()).is_file());
        assert!(PathBuf::from(result["csvReportPath"].as_str().unwrap()).is_file());

        let undo = invoice_undo(result["archiveId"].as_str().unwrap().to_string()).unwrap();
        assert_eq!(undo["removed"].as_array().unwrap().len(), 1);
        assert!(!copied_path.exists());
        assert_eq!(fs::read(&source_file).unwrap(), contents);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invoice_archive_skip_conflict_does_not_replace_destination() {
        let root = test_root("invoice-conflict");
        let source = root.join("source");
        let target = root.join("target");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&target).unwrap();
        let source_file = source.join("invoice.pdf");
        let target_file = target.join("invoice.pdf");
        fs::write(&source_file, b"new").unwrap();
        fs::write(&target_file, b"existing").unwrap();
        let result = invoice_archive(InvoiceArchiveInput {
            source_directory: source.to_string_lossy().into_owned(),
            target_directory: target.to_string_lossy().into_owned(),
            conflict: "skip".into(),
            files: vec![InvoiceArchiveFile {
                path: source_file.to_string_lossy().into_owned(),
                sha256: invoice_sha256(b"new"),
                relative_path: "invoice.pdf".into(),
                enabled: true,
                fields: None,
            }],
        })
        .unwrap();
        assert_eq!(result["skipped"].as_array().unwrap().len(), 1);
        assert_eq!(fs::read(&target_file).unwrap(), b"existing");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invoice_relative_paths_reject_traversal_and_sanitize_windows_names() {
        assert!(invoice_safe_segments("../escape.pdf").is_err());
        assert!(invoice_safe_segments("C:/escape.pdf").is_err());
        assert_eq!(
            invoice_safe_segments("2026/CON.pdf").unwrap(),
            ["2026", "_CON.pdf"]
        );
    }

    #[test]
    fn invoice_scan_lists_allowed_files_and_honors_recursion_limit() {
        let root = test_root("invoice-scan");
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("root.pdf"), b"root").unwrap();
        fs::write(root.join("notes.txt"), b"ignored").unwrap();
        fs::write(root.join("nested/child.jpg"), b"child").unwrap();

        let shallow =
            invoice_scan_list(root.to_string_lossy().into_owned(), Some(false), None, None)
                .unwrap();
        assert_eq!(shallow.files.len(), 1);
        assert_eq!(shallow.files[0].name, "root.pdf");

        let recursive = invoice_scan_list(
            root.to_string_lossy().into_owned(),
            Some(true),
            Some(1.0),
            None,
        )
        .unwrap();
        assert_eq!(recursive.files.len(), 1);
        assert!(recursive.exceeded);
        let read = invoice_read_candidate(
            recursive.files[0].path.clone(),
            recursive.files[0].size_bytes,
        )
        .unwrap();
        assert_eq!(read.bytes.len() as u64, read.current_size_bytes);
        assert!(!read.changed_while_reading);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn invoice_scan_skips_symbolic_links() {
        let root = test_root("invoice-scan-symlink");
        fs::create_dir_all(&root).unwrap();
        let real = root.join("real.pdf");
        fs::write(&real, b"pdf").unwrap();
        std::os::unix::fs::symlink(&real, root.join("linked.pdf")).unwrap();
        let listing =
            invoice_scan_list(root.to_string_lossy().into_owned(), None, None, None).unwrap();
        assert_eq!(listing.files.len(), 1);
        assert_eq!(listing.skipped.len(), 1);
        assert_eq!(listing.skipped[0]["reason"], "跳过符号链接");
        fs::remove_dir_all(root).unwrap();
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StagedArtifact {
    staged_path: String,
    output_path: Option<String>,
    name: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopRuntimeInfo {
    platform: &'static str,
    default_output_dir: String,
    default_temp_dir: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TempUsage {
    dir: String,
    jobs: usize,
    files: u64,
    bytes: u64,
    oldest_at: Option<u64>,
    newest_at: Option<u64>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TempCleanResult {
    removed_jobs: usize,
    removed_files: u64,
    freed_bytes: u64,
    kept_jobs: usize,
}

type TempEntry = (PathBuf, String, u64);

fn temp_groups(root: &Path, subdirectory: &str) -> Vec<TempEntry> {
    let Ok(entries) = fs::read_dir(root.join(subdirectory)) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            if !entry.file_type().ok()?.is_dir() {
                return None;
            }
            let path = entry.path();
            let modified = entry.metadata().ok()?.modified().unwrap_or(UNIX_EPOCH);
            let modified_ms = modified
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .min(u64::MAX as u128) as u64;
            Some((
                path,
                entry.file_name().to_string_lossy().into_owned(),
                modified_ms,
            ))
        })
        .collect()
}

fn temp_groups_all(root: &Path) -> Vec<TempEntry> {
    ["jobs", "inbox"]
        .into_iter()
        .flat_map(|sub| temp_groups(root, sub))
        .collect()
}

fn temp_dir_size(path: &Path) -> (u64, u64) {
    let mut files = 0_u64;
    let mut bytes = 0_u64;
    let mut pending = vec![path.to_path_buf()];
    while let Some(current) = pending.pop() {
        let Ok(entries) = fs::read_dir(current) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                pending.push(entry.path());
            } else {
                files = files.saturating_add(1);
                bytes = bytes.saturating_add(entry.metadata().map(|info| info.len()).unwrap_or(0));
            }
        }
    }
    (files, bytes)
}

#[tauri::command]
fn temp_usage(root: String) -> TempUsage {
    let path = PathBuf::from(root);
    let groups = temp_groups_all(&path);
    let (files, bytes) = groups
        .iter()
        .fold((0_u64, 0_u64), |(files, bytes), (dir, _, _)| {
            let (next_files, next_bytes) = temp_dir_size(dir);
            (
                files.saturating_add(next_files),
                bytes.saturating_add(next_bytes),
            )
        });
    let oldest_at = groups.iter().map(|(_, _, modified)| *modified).min();
    let newest_at = groups.iter().map(|(_, _, modified)| *modified).max();
    TempUsage {
        dir: path.to_string_lossy().into_owned(),
        jobs: groups.len(),
        files,
        bytes,
        oldest_at,
        newest_at,
    }
}

#[tauri::command]
fn temp_clean(
    root: String,
    older_than_days: f64,
    keep_jobs: usize,
    protect_jobs: Vec<String>,
) -> TempCleanResult {
    let path = PathBuf::from(root);
    let cutoff = if older_than_days.is_finite() && older_than_days > 0.0 {
        Duration::try_from_secs_f64(older_than_days * 86_400.0)
            .ok()
            .and_then(|age| SystemTime::now().checked_sub(age))
    } else {
        None
    };
    let protected: std::collections::HashSet<String> = protect_jobs.into_iter().collect();
    let mut removed_jobs = 0;
    let mut removed_files = 0_u64;
    let mut freed_bytes = 0_u64;
    let mut kept_jobs = 0;
    for subdirectory in ["jobs", "inbox"] {
        let mut groups = temp_groups(&path, subdirectory);
        groups.sort_by(|left, right| right.2.cmp(&left.2));
        for (index, (directory, name, modified_ms)) in groups.into_iter().enumerate() {
            let modified = UNIX_EPOCH + Duration::from_millis(modified_ms);
            let too_recent = cutoff.is_some_and(|limit| modified > limit);
            if index < keep_jobs || protected.contains(&name) || too_recent {
                kept_jobs += 1;
                continue;
            }
            let (files, bytes) = temp_dir_size(&directory);
            if fs::remove_dir_all(directory).is_ok() {
                removed_jobs += 1;
                removed_files = removed_files.saturating_add(files);
                freed_bytes = freed_bytes.saturating_add(bytes);
            } else {
                kept_jobs += 1;
            }
        }
    }
    TempCleanResult {
        removed_jobs,
        removed_files,
        freed_bytes,
        kept_jobs,
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WrittenFile {
    path: String,
    name: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryListing {
    path: String,
    requested: String,
    parent: Option<String>,
    dirs: Vec<DirectoryEntry>,
    quick: Vec<QuickDirectory>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeNetworkResult {
    stdout: String,
    stderr: String,
    error_code: Option<String>,
    connected: Option<bool>,
    elapsed_ms: Option<u128>,
    interface_count: Option<usize>,
    dns_servers: Option<String>,
}

#[tauri::command]
fn system_network_probe() -> NativeNetworkResult {
    #[cfg(target_os = "windows")]
    let output = Command::new("ipconfig").arg("/all").output();
    #[cfg(target_os = "macos")]
    let output = Command::new("/sbin/ifconfig").arg("-a").output();
    #[cfg(target_os = "linux")]
    let output = Command::new("ip")
        .args(["address"])
        .output()
        .or_else(|_| Command::new("ifconfig").arg("-a").output());

    let dns_servers = {
        #[cfg(target_os = "windows")]
        {
            let text = output
                .as_ref()
                .ok()
                .map(|value| String::from_utf8_lossy(&value.stdout).into_owned())
                .unwrap_or_default();
            text.lines()
                .filter(|line| {
                    line.to_lowercase().contains("dns servers") || line.contains("DNS 服务器")
                })
                .map(|line| {
                    line.split_once(':')
                        .map(|(_, value)| value.trim())
                        .unwrap_or("")
                        .to_string()
                })
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join(", ")
        }
        #[cfg(target_os = "macos")]
        {
            Command::new("/usr/sbin/scutil")
                .arg("--dns")
                .output()
                .ok()
                .map(|value| {
                    String::from_utf8_lossy(&value.stdout)
                        .lines()
                        .filter_map(|line| {
                            line.trim()
                                .strip_prefix("nameserver[")
                                .and_then(|rest| rest.split_once(':'))
                                .map(|(_, value)| value.trim().to_string())
                        })
                        .filter(|value| !value.is_empty())
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default()
        }
        #[cfg(target_os = "linux")]
        {
            fs::read_to_string("/etc/resolv.conf")
                .unwrap_or_default()
                .lines()
                .filter_map(|line| line.trim().strip_prefix("nameserver ").map(str::to_string))
                .collect::<Vec<_>>()
                .join(", ")
        }
    };
    match output {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            #[cfg(target_os = "windows")]
            let interface_count = stdout
                .lines()
                .filter(|line| {
                    let lower = line.to_lowercase();
                    lower.contains("adapter ") || lower.contains("适配器")
                })
                .count();
            #[cfg(target_os = "macos")]
            let interface_count = stdout
                .lines()
                .filter(|line| !line.starts_with(char::is_whitespace) && line.contains(": flags="))
                .count();
            #[cfg(target_os = "linux")]
            let interface_count = stdout
                .lines()
                .filter(|line| {
                    line.split_once(':').is_some_and(|(index, _)| {
                        index
                            .trim()
                            .chars()
                            .all(|character| character.is_ascii_digit())
                            && !index.trim().is_empty()
                    })
                })
                .count();
            NativeNetworkResult {
                stdout,
                stderr,
                error_code: (!output.status.success())
                    .then(|| format!("exit-{}", output.status.code().unwrap_or(-1))),
                connected: None,
                elapsed_ms: None,
                interface_count: Some(interface_count),
                dns_servers: Some(dns_servers),
            }
        }
        Err(error) => NativeNetworkResult {
            stdout: String::new(),
            stderr: error.to_string(),
            error_code: Some(error.to_string()),
            connected: None,
            elapsed_ms: None,
            interface_count: Some(0),
            dns_servers: Some(dns_servers),
        },
    }
}

#[tauri::command]
async fn dns_lookup(hostname: String, record_type: String) -> Result<Vec<String>, String> {
    let query_type = match record_type.to_ascii_uppercase().as_str() {
        "A" => RecordType::A,
        "AAAA" => RecordType::AAAA,
        "MX" => RecordType::MX,
        "TXT" => RecordType::TXT,
        "NS" => RecordType::NS,
        "CNAME" => RecordType::CNAME,
        "SOA" => RecordType::SOA,
        _ => return Err("不支持的 DNS 记录类型".into()),
    };
    let (config, mut options) = system_conf::read_system_conf()
        .map_err(|error| format!("无法读取系统 DNS 配置：{error}"))?;
    options.timeout = Duration::from_millis(2500);
    options.attempts = 1;
    let resolver = TokioAsyncResolver::tokio(config, options);
    let query_name = if hostname.ends_with('.') {
        hostname
    } else {
        format!("{hostname}.")
    };
    let lookup = resolver
        .lookup(query_name, query_type)
        .await
        .map_err(|error| format!("DNS 查询失败：{error}"))?;
    let records = lookup.iter().map(ToString::to_string).collect::<Vec<_>>();
    if records.is_empty() {
        return Err("未查询到 DNS 记录".into());
    }
    Ok(records)
}

#[tauri::command]
fn ping_host(host: String, count: usize) -> NativeNetworkResult {
    if !valid_network_host(&host) {
        return NativeNetworkResult {
            stdout: String::new(),
            stderr: String::new(),
            error_code: Some("EINVAL".into()),
            connected: Some(false),
            elapsed_ms: None,
            interface_count: None,
            dns_servers: None,
        };
    }
    let count = count.clamp(1, 10);
    let mut command = Command::new("ping");
    #[cfg(target_os = "windows")]
    command.args(["-n", &count.to_string(), "-w", "2000", &host]);
    #[cfg(target_os = "macos")]
    command.args(["-c", &count.to_string(), "-W", "2000", &host]);
    #[cfg(target_os = "linux")]
    command.args(["-c", &count.to_string(), "-W", "2", &host]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let deadline = Instant::now() + Duration::from_millis((count as u64) * 2300 + 1500);
    let child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    match child {
        Ok(mut child) => {
            let mut timed_out = false;
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) if Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(20))
                    }
                    Ok(None) => {
                        timed_out = true;
                        let _ = child.kill();
                        let _ = child.wait();
                        break;
                    }
                    Err(_) => {
                        let _ = child.kill();
                        let _ = child.wait();
                        break;
                    }
                }
            }
            let output = child.wait_with_output();
            match output {
                Ok(output) => {
                    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                    let error_code = if timed_out {
                        Some("timeout".into())
                    } else if output.status.success() {
                        None
                    } else {
                        Some(format!("exit-{}", output.status.code().unwrap_or(-1)))
                    };
                    NativeNetworkResult {
                        stdout,
                        stderr,
                        error_code,
                        connected: Some(!timed_out && output.status.success()),
                        elapsed_ms: None,
                        interface_count: None,
                        dns_servers: None,
                    }
                }
                Err(error) => NativeNetworkResult {
                    stdout: String::new(),
                    stderr: error.to_string(),
                    error_code: Some("error".into()),
                    connected: Some(false),
                    elapsed_ms: None,
                    interface_count: None,
                    dns_servers: None,
                },
            }
        }
        Err(error) => NativeNetworkResult {
            stdout: String::new(),
            stderr: error.to_string(),
            error_code: Some(if error.kind() == std::io::ErrorKind::NotFound {
                "ENOENT".into()
            } else {
                "error".into()
            }),
            connected: Some(false),
            elapsed_ms: None,
            interface_count: None,
            dns_servers: None,
        },
    }
}

#[tauri::command]
fn tcp_check_host(host: String, port: u16) -> NativeNetworkResult {
    if !valid_network_host(&host) || port == 0 {
        return NativeNetworkResult {
            stdout: String::new(),
            stderr: String::new(),
            error_code: Some("EINVAL".into()),
            connected: Some(false),
            elapsed_ms: Some(0),
            interface_count: None,
            dns_servers: None,
        };
    }
    let started = Instant::now();
    let result = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|error| error)
        .and_then(|addresses| {
            let mut last_error = None;
            for address in addresses.take(16) {
                let remaining = Duration::from_secs(5).saturating_sub(started.elapsed());
                if remaining.is_zero() {
                    break;
                }
                match TcpStream::connect_timeout(&address, remaining) {
                    Ok(stream) => {
                        let _ = stream.shutdown(std::net::Shutdown::Both);
                        return Ok(());
                    }
                    Err(error) => last_error = Some(error),
                }
            }
            Err(last_error
                .unwrap_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no address")))
        });
    let elapsed_ms = started.elapsed().as_millis();
    let (connected, error_code) = match result {
        Ok(()) => (true, None),
        Err(error) => {
            let code = match error.kind() {
                std::io::ErrorKind::ConnectionRefused => "ECONNREFUSED",
                std::io::ErrorKind::TimedOut => "ETIMEDOUT",
                std::io::ErrorKind::NotFound => "ENOTFOUND",
                std::io::ErrorKind::AddrNotAvailable => "EADDRNOTAVAIL",
                _ => "error",
            };
            (false, Some(code.to_string()))
        }
    };
    NativeNetworkResult {
        stdout: String::new(),
        stderr: String::new(),
        error_code,
        connected: Some(connected),
        elapsed_ms: Some(elapsed_ms),
        interface_count: None,
        dns_servers: None,
    }
}

fn valid_network_host(host: &str) -> bool {
    if host.is_empty() || host.len() > 253 || host.chars().any(char::is_whitespace) {
        return false;
    }
    host.parse::<std::net::IpAddr>().is_ok()
        || host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label.chars().all(|character| {
                    character.is_ascii_alphanumeric() || character == '-' || character == '_'
                })
                && !label.starts_with('-')
                && !label.ends_with('-')
        })
}

#[cfg(test)]
mod network_tests {
    use super::{tcp_check_host, valid_network_host};
    use std::net::TcpListener;

    #[test]
    fn validates_hostnames_and_ip_literals() {
        assert!(valid_network_host("example.com"));
        assert!(valid_network_host("127.0.0.1"));
        assert!(valid_network_host("::1"));
        assert!(!valid_network_host("bad host"));
        assert!(!valid_network_host("-invalid.example"));
    }

    #[test]
    fn connects_to_a_local_tcp_listener() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind local listener");
        let port = listener.local_addr().expect("listener address").port();
        let accept =
            std::thread::spawn(move || listener.accept().expect("accept local connection"));
        let result = tcp_check_host("127.0.0.1".into(), port);
        let _ = accept.join().expect("listener thread");
        assert_eq!(result.connected, Some(true));
        assert_eq!(result.error_code, None);
    }
}

#[derive(serde::Serialize)]
struct DirectoryEntry {
    name: String,
    path: String,
}

#[derive(serde::Serialize)]
struct QuickDirectory {
    id: &'static str,
    path: String,
}

#[tauri::command]
fn system_font_candidates() -> Vec<String> {
    let mut candidates = Vec::new();
    if let Some(explicit) = std::env::var_os("POTOOLS_FONT") {
        candidates.push(PathBuf::from(explicit));
    }
    #[cfg(target_os = "windows")]
    {
        let system_root = std::env::var_os("SystemRoot")
            .or_else(|| std::env::var_os("WINDIR"))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        let mut directories = vec![system_root.join("Fonts")];
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            directories.push(
                PathBuf::from(local)
                    .join("Microsoft")
                    .join("Windows")
                    .join("Fonts"),
            );
        }
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            directories.push(
                PathBuf::from(profile)
                    .join("AppData")
                    .join("Local")
                    .join("Microsoft")
                    .join("Windows")
                    .join("Fonts"),
            );
        }
        for name in [
            "msyh.ttc",
            "msyh.ttf",
            "msyhl.ttc",
            "msyhbd.ttc",
            "simhei.ttf",
            "simsun.ttc",
            "simsun.ttf",
            "simfang.ttf",
            "simkai.ttf",
            "Deng.ttf",
            "Dengb.ttf",
            "Dengl.ttf",
            "msjh.ttc",
            "mingliu.ttc",
        ] {
            candidates.extend(directories.iter().map(|directory| directory.join(name)));
        }
        for directory in &directories {
            append_font_files(&mut candidates, directory, 0);
        }
    }
    #[cfg(target_os = "macos")]
    {
        candidates.extend(
            [
                "/Library/Fonts/Arial Unicode.ttf",
                "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
                "/System/Library/Fonts/STHeiti Light.ttc",
                "/System/Library/Fonts/Hiragino Sans GB.ttc",
                "/System/Library/Fonts/Supplemental/Songti.ttc",
            ]
            .into_iter()
            .map(PathBuf::from),
        );
        for directory in [
            PathBuf::from("/Library/Fonts"),
            PathBuf::from("/System/Library/Fonts"),
            PathBuf::from("/System/Library/Fonts/Supplemental"),
        ] {
            append_font_files(&mut candidates, &directory, 0);
        }
        if let Some(home) = std::env::var_os("HOME") {
            append_font_files(
                &mut candidates,
                &PathBuf::from(home).join("Library/Fonts"),
                0,
            );
        }
    }
    #[cfg(target_os = "linux")]
    {
        let font_directories = [
            PathBuf::from("/usr/share/fonts"),
            PathBuf::from("/usr/local/share/fonts"),
        ];
        candidates.extend(
            [
                "/usr/share/fonts/truetype/arphic/uming.ttc",
                "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
                "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
                "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
                "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            ]
            .into_iter()
            .map(PathBuf::from),
        );
        for directory in &font_directories {
            append_font_files(&mut candidates, directory, 0);
        }
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            for directory in [home.join(".local/share/fonts"), home.join(".fonts")] {
                append_font_files(&mut candidates, &directory, 0);
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    candidates
        .into_iter()
        .filter(|path| path.is_file())
        .filter_map(|path| {
            let value = path.to_string_lossy().into_owned();
            seen.insert(value.to_lowercase()).then_some(value)
        })
        .collect()
}

fn append_font_files(candidates: &mut Vec<PathBuf>, directory: &Path, depth: u8) {
    if depth > 5 || candidates.len() >= 2048 {
        return;
    }
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
    paths.sort();
    for path in paths {
        if candidates.len() >= 2048 {
            return;
        }
        let Ok(file_type) = fs::symlink_metadata(&path).map(|metadata| metadata.file_type()) else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            append_font_files(candidates, &path, depth + 1);
        } else if file_type.is_file()
            && path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| {
                    matches!(
                        extension.to_ascii_lowercase().as_str(),
                        "ttf" | "otf" | "ttc"
                    )
                })
        {
            candidates.push(path);
        }
    }
}

#[tauri::command]
fn desktop_runtime_info() -> DesktopRuntimeInfo {
    let home = if cfg!(target_os = "windows") {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    } else {
        std::env::var_os("HOME").map(PathBuf::from)
    }
    .unwrap_or_else(std::env::temp_dir);
    let mut output_parents = Vec::new();
    #[cfg(target_os = "windows")]
    {
        if let Some(one_drive) = std::env::var_os("OneDrive") {
            output_parents.push(PathBuf::from(one_drive).join("Documents"));
        }
        output_parents.push(home.join("Documents"));
    }
    #[cfg(not(target_os = "windows"))]
    {
        for folder in ["Documents", "文档", "Skrivbord", "Schreibtisch", "Bureau"] {
            output_parents.push(home.join(folder));
        }
    }
    output_parents.push(home.clone());
    let parent = output_parents
        .iter()
        .find(|path| path.exists())
        .unwrap_or(&home);
    DesktopRuntimeInfo {
        platform: if cfg!(target_os = "windows") {
            "win32"
        } else if cfg!(target_os = "macos") {
            "darwin"
        } else {
            "linux"
        },
        default_output_dir: parent.join("PoTools").to_string_lossy().to_string(),
        default_temp_dir: std::env::temp_dir()
            .join("potools")
            .to_string_lossy()
            .to_string(),
    }
}

fn normalize_absolute_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            std::path::Component::RootDir => normalized.push(component.as_os_str()),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if !normalized.pop() {
                    normalized.push(component.as_os_str());
                }
            }
            std::path::Component::Normal(part) => normalized.push(part),
        }
    }
    normalized
}

fn natural_directory_order(left: &str, right: &str) -> Ordering {
    fn chunks(value: &str) -> Vec<(bool, String)> {
        let mut result = Vec::new();
        let mut current = String::new();
        let mut digits = None;
        for character in value.chars() {
            let is_digit = character.is_ascii_digit();
            if digits.is_some_and(|previous| previous != is_digit) {
                result.push((digits.unwrap_or(false), std::mem::take(&mut current)));
            }
            digits = Some(is_digit);
            current.push(character);
        }
        if !current.is_empty() {
            result.push((digits.unwrap_or(false), current));
        }
        result
    }

    let left_chunks = chunks(left);
    let right_chunks = chunks(right);
    for (left_chunk, right_chunk) in left_chunks.iter().zip(&right_chunks) {
        let order = if left_chunk.0 && right_chunk.0 {
            let left_digits = left_chunk.1.trim_start_matches('0');
            let right_digits = right_chunk.1.trim_start_matches('0');
            left_digits
                .len()
                .cmp(&right_digits.len())
                .then_with(|| left_digits.cmp(right_digits))
                .then_with(|| left_chunk.1.len().cmp(&right_chunk.1.len()))
        } else {
            left_chunk
                .1
                .to_lowercase()
                .cmp(&right_chunk.1.to_lowercase())
        };
        if order != Ordering::Equal {
            return order;
        }
    }
    left_chunks
        .len()
        .cmp(&right_chunks.len())
        .then_with(|| left.cmp(right))
}

#[tauri::command]
fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|error| error.to_string())
}

#[tauri::command]
fn read_file_binary(path: String) -> Result<tauri::ipc::Response, String> {
    fs::read(path)
        .map(tauri::ipc::Response::new)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn browse_directories(path: Option<String>) -> Result<DirectoryListing, String> {
    let home = if cfg!(target_os = "windows") {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    } else {
        std::env::var_os("HOME").map(PathBuf::from)
    }
    .unwrap_or_else(std::env::temp_dir);
    let requested_path = path.unwrap_or_default();
    let requested = if requested_path.trim().is_empty() {
        home.clone()
    } else {
        let candidate = PathBuf::from(requested_path.trim());
        if candidate.is_absolute() {
            normalize_absolute_path(&candidate)
        } else {
            normalize_absolute_path(
                &std::env::current_dir()
                    .map_err(|error| error.to_string())?
                    .join(candidate),
            )
        }
    };

    let mut listed = requested.clone();
    let entries = loop {
        match fs::read_dir(&listed) {
            Ok(entries) => break entries,
            Err(_) => {
                let Some(parent) = listed.parent() else {
                    return Err(format!("无法读取目录：{}", listed.display()));
                };
                if parent == listed {
                    return Err(format!("无法读取目录：{}", listed.display()));
                }
                listed = parent.to_path_buf();
            }
        }
    };

    let mut dirs = entries
        .filter_map(Result::ok)
        .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|entry| {
            entry
                .file_type()
                .ok()
                .filter(|kind| kind.is_dir())
                .map(|_| DirectoryEntry {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    path: entry.path().to_string_lossy().into_owned(),
                })
        })
        .collect::<Vec<_>>();
    dirs.sort_by(|left, right| natural_directory_order(&left.name, &right.name));

    let mut quick = vec![QuickDirectory {
        id: "home",
        path: home.to_string_lossy().into_owned(),
    }];
    for (id, folder) in [
        ("documents", "Documents"),
        ("downloads", "Downloads"),
        ("desktop", "Desktop"),
    ] {
        let candidate = home.join(folder);
        if candidate.is_dir() {
            quick.push(QuickDirectory {
                id,
                path: candidate.to_string_lossy().into_owned(),
            });
        }
    }

    Ok(DirectoryListing {
        path: listed.to_string_lossy().into_owned(),
        requested: requested.to_string_lossy().into_owned(),
        parent: listed
            .parent()
            .map(|parent| parent.to_string_lossy().into_owned()),
        dirs,
        quick,
    })
}

#[tauri::command]
fn stage_job_artifact(
    job_id: String,
    name: String,
    bytes: Vec<u8>,
    output_dir: Option<String>,
    temp_root: String,
) -> Result<StagedArtifact, String> {
    let file_name = safe_artifact_name(&name);
    let job_dir = PathBuf::from(temp_root)
        .join("jobs")
        .join(safe_temp_segment(&job_id));
    fs::create_dir_all(&job_dir).map_err(|error| error.to_string())?;
    let (staged_path, _) = write_unique(&job_dir, &file_name, &bytes)?;
    let (output_path, final_name) = if let Some(dir) = output_dir.filter(|value| !value.is_empty())
    {
        let directory = PathBuf::from(dir);
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let (path, name) = write_unique(&directory, &file_name, &bytes)?;
        (Some(path.to_string_lossy().to_string()), name)
    } else {
        (None, file_name)
    };
    Ok(StagedArtifact {
        staged_path: staged_path.to_string_lossy().to_string(),
        output_path,
        name: final_name,
    })
}

#[tauri::command]
fn write_output_file(dir: String, name: String, bytes: Vec<u8>) -> Result<WrittenFile, String> {
    let directory = PathBuf::from(dir);
    if !directory.is_dir() {
        return Err(format!("输出目录不存在：{}", directory.display()));
    }
    let (path, name) = write_unique(&directory, &safe_artifact_name(&name), &bytes)?;
    Ok(WrittenFile {
        path: path.to_string_lossy().to_string(),
        name,
    })
}

#[tauri::command]
fn copy_staged_artifact(
    from: String,
    dir: String,
    name: String,
    temp_root: String,
) -> Result<String, String> {
    let root = PathBuf::from(temp_root).join("jobs");
    let source = PathBuf::from(from);
    if !source.starts_with(&root) || !source.is_file() {
        return Err("找不到该临时产物".to_string());
    }
    let destination = PathBuf::from(dir);
    if !destination.is_dir() {
        return Err(format!("输出目录不存在：{}", destination.display()));
    }
    let bytes = fs::read(source).map_err(|error| error.to_string())?;
    let (path, _) = write_unique(&destination, &safe_artifact_name(&name), &bytes)?;
    Ok(path.to_string_lossy().to_string())
}

fn safe_artifact_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|character| {
            if character.is_control() || "\\/:*?\"<>|".contains(character) {
                '_'
            } else {
                character
            }
        })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "output.pdf".to_string()
    } else {
        trimmed.chars().take(120).collect()
    }
}

fn safe_temp_segment(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    if cleaned.is_empty() {
        "job".to_string()
    } else {
        cleaned
    }
}

fn write_unique(directory: &Path, name: &str, bytes: &[u8]) -> Result<(PathBuf, String), String> {
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem.to_string(), format!(".{extension}")),
        _ => (name.to_string(), String::new()),
    };
    for index in 1..=10_000 {
        let candidate = if index == 1 {
            name.to_string()
        } else {
            format!("{stem} ({index}){extension}")
        };
        let path = directory.join(&candidate);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                if let Err(error) = file.write_all(bytes) {
                    let _ = fs::remove_file(&path);
                    return Err(error.to_string());
                }
                return Ok((path, candidate));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("无法为输出文件生成不冲突的名称".to_string())
}

#[tauri::command]
fn open_path(path: String, _reveal: Option<bool>) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err(format!("路径不存在: {}", path));
    }
    #[cfg(target_os = "macos")]
    let spawned = match _reveal.unwrap_or(false) {
        true => Command::new("open").arg("-R").arg(&target).spawn(),
        false => Command::new("open").arg(&target).spawn(),
    };
    #[cfg(target_os = "windows")]
    let spawned = {
        let mut command = Command::new("explorer");
        if _reveal.unwrap_or(false) {
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

fn output_with_timeout(
    mut command: Command,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let started = Instant::now();
    loop {
        match child.try_wait().map_err(|error| error.to_string())? {
            Some(_) => return child.wait_with_output().map_err(|error| error.to_string()),
            None if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("系统打印命令执行超时".to_string());
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

#[tauri::command]
fn print_file(path: String) -> Result<serde_json::Value, String> {
    if path.trim().is_empty() {
        return Err("缺少待打印文件路径".to_string());
    }
    let target = PathBuf::from(&path);
    if !target.is_file() {
        return Err(format!("待打印文件不存在：{}", path));
    }

    #[cfg(target_os = "windows")]
    let result = {
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Process -LiteralPath $args[0] -Verb Print",
        ]);
        command.arg(&target);
        output_with_timeout(command, Duration::from_secs(15)).map(|output| {
            if output.status.success() {
                Ok(serde_json::json!({ "started": true }))
            } else {
                Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
            }
        })
    };

    #[cfg(not(target_os = "windows"))]
    let result = {
        let mut command = Command::new("lp");
        command.arg(&target);
        output_with_timeout(command, Duration::from_secs(30)).map(|output| {
            if output.status.success() {
                Ok(serde_json::json!({
                    "started": true,
                    "queue": String::from_utf8_lossy(&output.stdout).trim()
                }))
            } else {
                Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
            }
        })
    };

    result
        .map_err(|error| {
            format!(
                "无法发起系统打印，请确认已配置默认打印机和文件关联：{}",
                error
            )
        })?
        .map_err(|detail| {
            format!(
                "无法发起系统打印，请确认已配置默认打印机和文件关联：{}",
                detail
            )
        })
}

#[tauri::command]
fn exit_app(app: AppHandle) {
    app.exit(0);
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Engine::default())
        .invoke_handler(tauri::generate_handler![
            engine_start,
            engine_write,
            engine_stop,
            desktop_runtime_info,
            system_font_candidates,
            system_network_probe,
            dns_lookup,
            ping_host,
            tcp_check_host,
            temp_usage,
            temp_clean,
            write_file_bytes,
            write_output_file,
            read_file_bytes,
            read_file_binary,
            browse_directories,
            stage_job_artifact,
            copy_staged_artifact,
            invoice_archive,
            invoice_scan_list,
            invoice_read_candidate,
            invoice_undo,
            open_path,
            print_file,
            exit_app
        ])
        .build(tauri::generate_context!())
        .expect("error while building PoTools")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                let engine = app_handle.state::<Engine>();
                if let Some(mut child) = engine.child.lock().ok().and_then(|mut g| g.take()) {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}
