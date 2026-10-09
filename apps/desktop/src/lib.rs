//! Tauri IPC surface: engine entry points plus the privileged native services.
//!
//! # Command execution policy
//!
//! In Tauri v2 a plain `#[tauri::command]` function runs **inline on the
//! WebView's main thread**, so every command that touches the filesystem,
//! spawns a process, hits the network, or runs the PDF/image engine is declared
//! `#[tauri::command(async)]` to move it onto the async runtime instead.
//! Without that, a large conversion or an invoice scan freezes the whole window
//! for its duration.
//!
//! Only `desktop_runtime_info` (a few env lookups), `dns_lookup` (already
//! `async fn`) and `exit_app` (must run on the main thread) stay synchronous.
//!
//! The remaining refinement, for when several heavy jobs run concurrently, is to
//! wrap the CPU-bound bodies in `tauri::async_runtime::spawn_blocking` so they
//! occupy the blocking pool rather than an async worker.

use std::path::PathBuf;
use std::time::Instant;

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

mod access;
use access::PathGrants;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeTextRunResult {
    text: String,
    artifacts: Vec<serde_json::Value>,
    warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    extra: Option<serde_json::Map<String, serde_json::Value>>,
    ms: u128,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeToolFailure {
    code: String,
    message: String,
    hint_key: Option<&'static str>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeTextRunReply {
    handled: bool,
    result: Option<NativeTextRunResult>,
    error: Option<NativeToolFailure>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeEngineInput {
    id: String,
    name: String,
    path: Option<String>,
    // Absent when the file is already on disk: the host reads it directly, so
    // tens of megabytes never cross the bridge as a base64 JSON payload.
    data_base64: Option<String>,
}

#[tauri::command(async)]
fn engine_run_text_tool(
    tool: String,
    options: serde_json::Value,
    locale: Option<String>,
    name_pattern: Option<String>,
    runtime_data: Option<serde_json::Value>,
) -> NativeTextRunReply {
    let started = Instant::now();
    let context = potools_engine::RunContext {
        tool: &tool,
        options: &options,
        locale: locale.as_deref().unwrap_or("zh-CN"),
        inputs: &[],
        name_pattern: name_pattern.as_deref(),
        runtime_data: runtime_data.as_ref(),
    };
    run_native_tool(context, started, None)
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
fn engine_run_file_tool(
    grants: tauri::State<'_, PathGrants>,
    tool: String,
    options: serde_json::Value,
    locale: Option<String>,
    name_pattern: Option<String>,
    runtime_data: Option<serde_json::Value>,
    inputs: Vec<NativeEngineInput>,
    job_id: Option<String>,
    temp_root: Option<String>,
    output_dir: Option<String>,
    on_progress: tauri::ipc::Channel<serde_json::Value>,
) -> Result<NativeTextRunReply, String> {
    use base64::Engine as _;
    let started = Instant::now();
    let inputs = match inputs
        .into_iter()
        .map(|input| {
            let NativeEngineInput {
                id,
                name,
                path,
                data_base64,
            } = input;
            let bytes = match (data_base64, &path) {
                // A file already on disk is read right here: with bytes absent
                // the caller means "read the path", keeping the webview out of
                // the multi-megabyte round trip entirely.
                (None, Some(path)) => {
                    let authorized = grants.require_read(path).map_err(|error| {
                        potools_engine::EngineError::new("fileUnreadable", error)
                    })?;
                    potools_engine::services::filesystem::read_file_bytes(
                        authorized.to_string_lossy().to_string(),
                    )
                    .map_err(|error| potools_engine::EngineError::new("fileUnreadable", error))?
                }
                (Some(data), _) => base64::engine::general_purpose::STANDARD
                    .decode(data.as_bytes())
                    .map_err(|error| {
                        potools_engine::EngineError::new(
                            "bad_request",
                            format!("Invalid input bytes: {error}"),
                        )
                    })?,
                (None, None) => Vec::new(),
            };
            Ok(potools_engine::InputFile {
                id,
                name,
                path: path.map(PathBuf::from),
                bytes,
            })
        })
        .collect::<Result<Vec<_>, potools_engine::EngineError>>()
    {
        Ok(inputs) => inputs,
        Err(error) => return Ok(native_tool_error(error)),
    };
    let staging = match (job_id.as_deref(), temp_root.as_deref()) {
        (Some(job_id), Some(temp_root)) if !temp_root.trim().is_empty() => Some(NativeStaging {
            grants: &grants,
            job_id,
            temp_root,
            output_dir: output_dir.as_deref().filter(|dir| !dir.trim().is_empty()),
        }),
        _ => None,
    };
    // Split reports one step per output group; the channel forwards each step
    // to the UI as it happens instead of one jump from 1% to done.
    let sink: potools_engine::progress::Sink =
        std::rc::Rc::new(move |done: usize, total: usize| {
            let _ = on_progress.send(serde_json::json!({ "done": done, "total": total }));
        });
    let context = potools_engine::RunContext {
        tool: &tool,
        options: &options,
        locale: locale.as_deref().unwrap_or("zh-CN"),
        inputs: &inputs,
        name_pattern: name_pattern.as_deref(),
        runtime_data: runtime_data.as_ref(),
    };
    Ok(potools_engine::progress::with(Some(sink), || {
        run_native_tool(context, started, staging)
    }))
}

/// Where the engine's artifacts should be written: the job's temp dir plus, if
/// the user picked an output dir, the final copy. Paths are grant-checked here
/// exactly like `stage_job_artifact_binary` does for JS-side staging.
struct NativeStaging<'a> {
    grants: &'a PathGrants,
    job_id: &'a str,
    temp_root: &'a str,
    output_dir: Option<&'a str>,
}

fn stage_native_artifacts(
    staging: NativeStaging<'_>,
    artifacts: Vec<potools_engine::Artifact>,
) -> Result<Vec<serde_json::Value>, potools_engine::EngineError> {
    let authorize = |path: &str| {
        staging
            .grants
            .require_write(path)
            .map_err(|error| potools_engine::EngineError::new("bad_request", error))
    };
    let job_dir = format!("{}/jobs/{}", staging.temp_root, staging.job_id);
    authorize(&job_dir)?;
    if let Some(dir) = staging.output_dir {
        authorize(dir)?;
    }
    let mut staged = Vec::with_capacity(artifacts.len());
    for artifact in artifacts {
        match potools_engine::services::filesystem::stage_artifact(
            staging.temp_root.to_string(),
            staging.job_id.to_string(),
            artifact.name.clone(),
            staging.output_dir.map(str::to_string),
            &artifact.bytes,
        ) {
            Ok(st) => {
                // Same contract as `write_output_file`: a path this process
                // wrote becomes readable, so "reveal the artifact" works even
                // though the output dir itself is write-only.
                staging
                    .grants
                    .grant_file(std::path::Path::new(&st.staged_path));
                if let Some(path) = &st.output_path {
                    staging.grants.grant_file(std::path::Path::new(path));
                }
                staged.push(serde_json::json!({
                    "name": st.name,
                    "kind": artifact.kind,
                    "sizeBytes": artifact.size_bytes,
                    "sourceFileId": artifact.source_file_id,
                    "stagedPath": st.staged_path,
                    "outputPath": st.output_path,
                }));
            }
            Err(error) => return Err(potools_engine::EngineError::new("internal", error)),
        }
    }
    Ok(staged)
}

fn run_native_tool(
    context: potools_engine::RunContext<'_>,
    started: Instant,
    staging: Option<NativeStaging<'_>>,
) -> NativeTextRunReply {
    use base64::Engine as _;
    match potools_engine::run_tool(&context) {
        Ok(Some(result)) => {
            let potools_engine::ToolResult {
                text,
                artifacts,
                warnings,
                extra,
            } = result;
            let artifacts = match staging {
                // Written to disk here: replying with paths keeps multi-MB
                // outputs out of the JSON IPC and off the JS main thread.
                Some(staging) => match stage_native_artifacts(staging, artifacts) {
                    Ok(artifacts) => artifacts,
                    Err(error) => return native_tool_error(error),
                },
                None => artifacts.into_iter().map(|artifact| serde_json::json!({
                    "name": artifact.name, "kind": artifact.kind, "sizeBytes": artifact.size_bytes,
                    "sourceFileId": artifact.source_file_id,
                    "dataBase64": base64::engine::general_purpose::STANDARD.encode(artifact.bytes),
                })).collect(),
            };
            NativeTextRunReply {
                handled: true,
                result: Some(NativeTextRunResult {
                    text: text.unwrap_or_default(),
                    artifacts,
                    warnings,
                    extra: if extra.is_empty() { None } else { Some(extra) },
                    ms: started.elapsed().as_millis(),
                }),
                error: None,
            }
        }
        Ok(None) => NativeTextRunReply {
            handled: false,
            result: None,
            error: None,
        },
        Err(error) => native_tool_error(error),
    }
}

fn native_tool_error(error: potools_engine::EngineError) -> NativeTextRunReply {
    NativeTextRunReply {
        handled: true,
        result: None,
        error: Some(NativeToolFailure {
            code: error.code.into(),
            message: error.message,
            hint_key: error.hint_key,
        }),
    }
}

#[tauri::command(async)]
fn write_file_bytes(
    grants: tauri::State<'_, PathGrants>,
    path: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    // Only a path the user chose in the save dialog (or a file this process
    // wrote) is writable; see `access.rs` for why IPC cannot grant this itself.
    let authorized = grants.require_write(&path)?;
    potools_engine::services::filesystem::write_file_bytes(
        authorized.to_string_lossy().to_string(),
        bytes,
    )
}

#[tauri::command(async)]
fn invoice_scan_list(
    directory: String,
    recursive: Option<bool>,
    max_files: Option<f64>,
    exclude_directory: Option<String>,
) -> Result<potools_engine::services::invoice::InvoiceScanListing, String> {
    potools_engine::services::invoice::invoice_scan_list(
        directory,
        recursive,
        max_files,
        exclude_directory,
    )
}

#[tauri::command(async)]
fn invoice_read_candidate(
    path: String,
    expected_size_bytes: u64,
) -> Result<potools_engine::services::invoice::InvoiceCandidateRead, String> {
    potools_engine::services::invoice::invoice_read_candidate(path, expected_size_bytes)
}

#[tauri::command(async)]
fn invoice_archive(
    input: potools_engine::services::invoice::InvoiceArchiveInput,
) -> Result<serde_json::Value, String> {
    potools_engine::services::invoice::invoice_archive(input)
}

#[tauri::command(async)]
fn invoice_undo(archive_id: String) -> Result<serde_json::Value, String> {
    potools_engine::services::invoice::invoice_undo(archive_id)
}

#[cfg(test)]
mod invoice_tests;

type StagedArtifact = potools_engine::services::filesystem::StagedArtifact;
type TempUsage = potools_engine::services::temp::TempUsage;
type TempCleanResult = potools_engine::services::temp::TempCleanResult;

#[tauri::command(async)]
fn temp_usage(root: String) -> TempUsage {
    potools_engine::services::temp::temp_usage(root)
}

#[tauri::command(async)]
fn temp_clean(
    root: String,
    older_than_days: f64,
    keep_jobs: usize,
    protect_jobs: Vec<String>,
) -> TempCleanResult {
    potools_engine::services::temp::temp_clean(root, older_than_days, keep_jobs, protect_jobs)
}

type WrittenFile = potools_engine::services::filesystem::WrittenFile;
type DirectoryListing = potools_engine::services::filesystem::DirectoryListing;
type DesktopRuntimeInfo = potools_engine::services::runtime::DesktopRuntimeInfo;

#[tauri::command(async)]
fn system_network_probe() -> potools_engine::services::network::NativeNetworkResult {
    potools_engine::services::network::system_network_probe()
}

#[tauri::command]
async fn dns_lookup(hostname: String, record_type: String) -> Result<Vec<String>, String> {
    potools_engine::services::network::dns_lookup(hostname, record_type).await
}

#[tauri::command(async)]
fn ping_host(host: String, count: usize) -> potools_engine::services::network::NativeNetworkResult {
    potools_engine::services::network::ping_host(host, count)
}

#[tauri::command(async)]
fn tcp_check_host(
    host: String,
    port: u16,
) -> potools_engine::services::network::NativeNetworkResult {
    potools_engine::services::network::tcp_check_host(host, port)
}

#[tauri::command(async)]
fn system_font_candidates(grants: tauri::State<'_, PathGrants>) -> Vec<String> {
    let paths = potools_engine::services::runtime::system_font_candidates();
    // Reading these needs no dialog: the list comes from the OS enumeration this
    // process performs, not from a value handed over by the WebView. Without the
    // grant, CJK font embedding lost every candidate (the reader swallows the
    // denial), so converted documents silently rendered without the font.
    for path in &paths {
        grants.grant_file(std::path::Path::new(path));
    }
    paths
}

#[tauri::command]
fn desktop_runtime_info() -> DesktopRuntimeInfo {
    potools_engine::services::runtime::desktop_runtime_info()
}

#[tauri::command(async)]
fn read_file_bytes(grants: tauri::State<'_, PathGrants>, path: String) -> Result<Vec<u8>, String> {
    let authorized = grants.require_read(&path)?;
    potools_engine::services::filesystem::read_file_bytes(authorized.to_string_lossy().to_string())
}

#[tauri::command(async)]
fn read_file_binary(
    grants: tauri::State<'_, PathGrants>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let authorized = grants.require_read(&path)?;
    potools_engine::services::filesystem::read_file_bytes(authorized.to_string_lossy().to_string())
        .map(tauri::ipc::Response::new)
}

#[tauri::command(async)]
fn browse_directories(path: Option<String>) -> Result<DirectoryListing, String> {
    potools_engine::services::filesystem::browse_directories(path)
}

#[tauri::command(async)]
fn stage_job_artifact_binary(
    grants: tauri::State<'_, PathGrants>,
    request: tauri::ipc::Request<'_>,
) -> Result<StagedArtifact, String> {
    let header = |name: &str| -> Result<String, String> {
        request
            .headers()
            .get(name)
            .ok_or_else(|| format!("Missing IPC header: {name}"))?
            .to_str()
            .map(str::to_owned)
            .map_err(|error| error.to_string())
    };
    let job_id = header("x-potools-job-id")?;
    let name = header("x-potools-name")?;
    let temp_root = header("x-potools-temp-root")?;
    let output_dir = header("x-potools-output-dir")
        .ok()
        .filter(|value| !value.is_empty());
    // The staging target is `<temp_root>/jobs/<job>`, so checking that path
    // accepts only temp roots the app actually granted (`<root>/jobs`).
    let staging = format!("{temp_root}/jobs/{job_id}");
    grants.require_write(&staging)?;
    if let Some(dir) = output_dir.as_ref() {
        grants.require_write(dir)?;
    }
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes,
        tauri::ipc::InvokeBody::Json(_) => {
            return Err("Expected binary artifact payload".to_string())
        }
    };
    let staged = potools_engine::services::filesystem::stage_artifact(
        temp_root, job_id, name, output_dir, bytes,
    )?;
    // Reading back a file this process just wrote is what keeps the "reveal the
    // saved file" affordance working without granting reads on the whole
    // (user-configurable, script-settable) output directory.
    grants.grant_file(std::path::Path::new(&staged.staged_path));
    if let Some(path) = &staged.output_path {
        grants.grant_file(std::path::Path::new(path));
    }
    Ok(staged)
}

#[tauri::command(async)]
fn write_output_file(
    grants: tauri::State<'_, PathGrants>,
    dir: String,
    name: String,
    bytes: Vec<u8>,
) -> Result<WrittenFile, String> {
    let authorized = grants.require_write(&dir)?;
    let written = potools_engine::services::filesystem::write_output_file(
        authorized.to_string_lossy().to_string(),
        name,
        bytes,
    )?;
    // Reading back a file this process just wrote is what keeps the "reveal the
    // saved file" affordance working without granting reads on the whole
    // (user-configurable, script-settable) output directory.
    grants.grant_file(std::path::Path::new(&written.path));
    Ok(written)
}

#[tauri::command(async)]
fn copy_staged_artifact(
    grants: tauri::State<'_, PathGrants>,
    from: String,
    dir: String,
    name: String,
    temp_root: String,
) -> Result<String, String> {
    let source = grants.require_read(&from)?;
    let destination = grants.require_write(&dir)?;
    let root =
        potools_engine::services::filesystem::validate_absolute_path(&temp_root, "临时目录")?;
    let copied = potools_engine::services::filesystem::copy_staged_artifact(
        source.to_string_lossy().to_string(),
        destination.to_string_lossy().to_string(),
        name,
        root.to_string_lossy().to_string(),
    )?;
    grants.grant_file(std::path::Path::new(&copied));
    Ok(copied)
}

#[tauri::command(async)]
fn open_path(
    grants: tauri::State<'_, PathGrants>,
    path: String,
    _reveal: Option<bool>,
) -> Result<(), String> {
    // Handing a path to the OS handler is a launch primitive, so it is gated the
    // same way as a read.
    let authorized = grants.require_read(&path)?;
    potools_engine::services::shell::open_path(authorized.to_string_lossy().to_string(), _reveal)
}

#[tauri::command(async)]
fn print_file(
    grants: tauri::State<'_, PathGrants>,
    path: String,
) -> Result<serde_json::Value, String> {
    let authorized = grants.require_read(&path)?;
    potools_engine::services::shell::print_file(authorized.to_string_lossy().to_string())
}

#[tauri::command]
fn exit_app(app: AppHandle) {
    app.exit(0);
}

#[derive(serde::Deserialize)]
struct DialogFilter {
    name: String,
    extensions: Vec<String>,
}

/// Show the native open dialog **from Rust** and grant what the user picked.
///
/// This has to happen here rather than in the frontend: a dialog driven from JS
/// would leave Rust unable to tell a user's choice from a script's claim, and any
/// "grant this path" command would simply be invoked by the script itself.
#[tauri::command(async)]
fn pick_files(
    app: AppHandle,
    grants: tauri::State<'_, PathGrants>,
    filters: Vec<DialogFilter>,
    multiple: bool,
) -> Vec<String> {
    let mut dialog = app.dialog().file();
    for filter in filters {
        let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
        dialog = dialog.add_filter(&filter.name, &extensions);
    }
    let picked = if multiple {
        dialog.blocking_pick_files()
    } else {
        dialog.blocking_pick_file().map(|file| vec![file])
    };
    picked
        .unwrap_or_default()
        .into_iter()
        .filter_map(|file| {
            let path = file.into_path().ok()?;
            grants.grant_path(&path);
            Some(path.to_string_lossy().to_string())
        })
        .collect()
}

#[tauri::command(async)]
fn pick_directory(
    app: AppHandle,
    grants: tauri::State<'_, PathGrants>,
) -> Result<Option<String>, String> {
    Ok(app
        .dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|folder| {
            let path = folder.into_path().ok()?;
            grants.grant_dir(&path);
            Some(path.to_string_lossy().to_string())
        }))
}

#[tauri::command(async)]
fn save_as(
    app: AppHandle,
    grants: tauri::State<'_, PathGrants>,
    name: String,
) -> Result<Option<String>, String> {
    Ok(app
        .dialog()
        .file()
        .set_file_name(&name)
        .blocking_save_file()
        .and_then(|file| {
            let path = file.into_path().ok()?;
            grants.grant_file(&path);
            Some(path.to_string_lossy().to_string())
        }))
}

/// Point the staging area at the user's configured temp directory.
///
/// The setting is visible and persisted, so honouring it is expected; only its
/// app-owned `jobs/` and `inbox/` subdirectories are granted, which is what stops
/// a script from aiming the setting at a sensitive directory and reading it.
#[tauri::command(async)]
fn set_temp_dir(grants: tauri::State<'_, PathGrants>, dir: Option<String>) -> Result<(), String> {
    let Some(dir) = dir.filter(|value| !value.trim().is_empty()) else {
        grants.grant_temp_root(&std::env::temp_dir());
        return Ok(());
    };
    let root = potools_engine::services::filesystem::validate_absolute_path(&dir, "临时目录")?;
    if !root.is_dir() {
        return Err(format!("临时目录不存在：{dir}"));
    }
    grants.grant_temp_root(&root);
    Ok(())
}

/// Grant the configured output directory for **writes only**.
#[tauri::command(async)]
fn set_output_dir(grants: tauri::State<'_, PathGrants>, dir: Option<String>) -> Result<(), String> {
    let Some(dir) = dir.filter(|value| !value.trim().is_empty()) else {
        return Ok(());
    };
    let root = potools_engine::services::filesystem::validate_absolute_path(&dir, "输出目录")?;
    if !root.is_dir() {
        return Err(format!("输出目录不存在：{dir}"));
    }
    grants.grant_write_dir(&root);
    Ok(())
}

/// Diagnostics for the grant set, so a missing grant is visible instead of
/// mysterious. Contains only paths the user themselves chose or configured.
#[tauri::command(async)]
fn path_grants(grants: tauri::State<'_, PathGrants>) -> String {
    grants.describe()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(PathGrants::new())
        .setup(|app| {
            // Artifacts get staged before the frontend can report a configured
            // temp directory, so the platform default is granted up front;
            // `set_temp_dir` swaps it when the user changes the setting.
            app.state::<PathGrants>()
                .grant_temp_root(&std::env::temp_dir());
            Ok(())
        })
        .on_window_event(|window, event| {
            // An OS drop is a real user gesture, so it grants. The frontend's own
            // drag-drop listener only drives the drop-zone UI.
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let grants = window.app_handle().state::<PathGrants>();
                for path in paths {
                    grants.grant_path(path);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            engine_run_text_tool,
            engine_run_file_tool,
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
            stage_job_artifact_binary,
            copy_staged_artifact,
            invoice_archive,
            invoice_scan_list,
            invoice_read_candidate,
            invoice_undo,
            open_path,
            print_file,
            exit_app,
            pick_files,
            pick_directory,
            save_as,
            set_temp_dir,
            set_output_dir,
            path_grants
        ])
        .build(tauri::generate_context!())
        .expect("error while building PoTools")
        .run(|_app_handle, _event| {});
}
