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

use tauri::AppHandle;

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
    data_base64: String,
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
    run_native_tool(context, started)
}

#[tauri::command(async)]
fn engine_run_file_tool(
    tool: String,
    options: serde_json::Value,
    locale: Option<String>,
    name_pattern: Option<String>,
    runtime_data: Option<serde_json::Value>,
    inputs: Vec<NativeEngineInput>,
) -> NativeTextRunReply {
    use base64::Engine as _;
    let started = Instant::now();
    let inputs = match inputs
        .into_iter()
        .map(|input| {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(input.data_base64.as_bytes())
                .map_err(|error| {
                    potools_engine::EngineError::new(
                        "bad_request",
                        format!("Invalid input bytes: {error}"),
                    )
                })?;
            Ok(potools_engine::InputFile {
                id: input.id,
                name: input.name,
                path: input.path.map(PathBuf::from),
                bytes,
            })
        })
        .collect::<Result<Vec<_>, potools_engine::EngineError>>()
    {
        Ok(inputs) => inputs,
        Err(error) => return native_tool_error(error),
    };
    let context = potools_engine::RunContext {
        tool: &tool,
        options: &options,
        locale: locale.as_deref().unwrap_or("zh-CN"),
        inputs: &inputs,
        name_pattern: name_pattern.as_deref(),
        runtime_data: runtime_data.as_ref(),
    };
    run_native_tool(context, started)
}

fn run_native_tool(
    context: potools_engine::RunContext<'_>,
    started: Instant,
) -> NativeTextRunReply {
    use base64::Engine as _;
    match potools_engine::run_tool(&context) {
        Ok(Some(result)) => NativeTextRunReply {
            handled: true,
            result: Some(NativeTextRunResult {
                text: result.text.unwrap_or_default(),
                artifacts: result.artifacts.into_iter().map(|artifact| serde_json::json!({
                    "name": artifact.name, "kind": artifact.kind, "sizeBytes": artifact.size_bytes,
                    "sourceFileId": artifact.source_file_id,
                    "dataBase64": base64::engine::general_purpose::STANDARD.encode(artifact.bytes),
                })).collect(),
                warnings: result.warnings,
                extra: if result.extra.is_empty() { None } else { Some(result.extra) },
                ms: started.elapsed().as_millis(),
            }),
            error: None,
        },
        Ok(None) => NativeTextRunReply { handled: false, result: None, error: None },
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
fn write_file_bytes(path: String, bytes: Vec<u8>) -> Result<(), String> {
    potools_engine::services::filesystem::write_file_bytes(path, bytes)
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
fn system_font_candidates() -> Vec<String> {
    potools_engine::services::runtime::system_font_candidates()
}

#[tauri::command]
fn desktop_runtime_info() -> DesktopRuntimeInfo {
    potools_engine::services::runtime::desktop_runtime_info()
}

#[tauri::command(async)]
fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    potools_engine::services::filesystem::read_file_bytes(path)
}

#[tauri::command(async)]
fn read_file_binary(path: String) -> Result<tauri::ipc::Response, String> {
    potools_engine::services::filesystem::read_file_bytes(path).map(tauri::ipc::Response::new)
}

#[tauri::command(async)]
fn browse_directories(path: Option<String>) -> Result<DirectoryListing, String> {
    potools_engine::services::filesystem::browse_directories(path)
}

#[tauri::command(async)]
fn stage_job_artifact_binary(request: tauri::ipc::Request<'_>) -> Result<StagedArtifact, String> {
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
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes,
        tauri::ipc::InvokeBody::Json(_) => {
            return Err("Expected binary artifact payload".to_string())
        }
    };
    potools_engine::services::filesystem::stage_artifact(temp_root, job_id, name, output_dir, bytes)
}

#[tauri::command(async)]
fn write_output_file(dir: String, name: String, bytes: Vec<u8>) -> Result<WrittenFile, String> {
    potools_engine::services::filesystem::write_output_file(dir, name, bytes)
}

#[tauri::command(async)]
fn copy_staged_artifact(
    from: String,
    dir: String,
    name: String,
    temp_root: String,
) -> Result<String, String> {
    potools_engine::services::filesystem::copy_staged_artifact(from, dir, name, temp_root)
}

#[tauri::command(async)]
fn open_path(path: String, _reveal: Option<bool>) -> Result<(), String> {
    potools_engine::services::shell::open_path(path, _reveal)
}

#[tauri::command(async)]
fn print_file(path: String) -> Result<serde_json::Value, String> {
    potools_engine::services::shell::print_file(path)
}

#[tauri::command]
fn exit_app(app: AppHandle) {
    app.exit(0);
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
            exit_app
        ])
        .build(tauri::generate_context!())
        .expect("error while building PoTools")
        .run(|_app_handle, _event| {});
}
