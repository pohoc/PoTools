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
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

mod access;
use access::{ApprovalKind, PathGrants};

mod jobs;
use jobs::JobCancels;

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
    cancellations: tauri::State<'_, JobCancels>,
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
    // RUN-02: the flag lives as long as this call. `cancel_native_job` sets it;
    // the reader is installed for the engine and consulted at both boundaries
    // where the host itself does work — reading each input, writing each artifact.
    let (cancel_flag, _cancel_registration) = match job_id.as_deref() {
        Some(id) => {
            let (flag, registration) = cancellations.register(id);
            (Some(flag), Some(registration))
        }
        None => (None, None),
    };
    let cancel_reader: potools_engine::cancel::Token = {
        let flag = cancel_flag.clone();
        std::rc::Rc::new(move || {
            flag.as_ref()
                .is_some_and(|flag| flag.load(std::sync::atomic::Ordering::SeqCst))
        })
    };
    let inputs = match inputs
        .into_iter()
        .map(|input| {
            let NativeEngineInput {
                id,
                name,
                path,
                data_base64,
            } = input;
            if cancel_reader() {
                return Err(potools_engine::EngineError::new(
                    "cancelled",
                    "任务已取消，未再读取后续文件",
                ));
            }
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
            cancelled: &*cancel_reader,
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
    let cancel_for_run = std::rc::Rc::clone(&cancel_reader);
    Ok(potools_engine::progress::with(Some(sink), || {
        potools_engine::cancel::with(Some(cancel_for_run), || {
            run_native_tool(context, started, staging)
        })
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
    /// Re-checked immediately before every write: a job the user cancelled must
    /// not produce official output, even if the tool finished anyway.
    cancelled: &'a dyn Fn() -> bool,
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
        if (staging.cancelled)() {
            return Err(potools_engine::EngineError::new(
                "cancelled",
                "任务已取消，未写出任何产物",
            ));
        }
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

/// Ask a running native job to stop. Returns whether a native job with that id
/// was actually live here; the caller's own state moves to `cancelled` either
/// way, and the runner's terminal guard keeps any late reply from reversing it.
#[tauri::command(async)]
fn cancel_native_job(cancellations: tauri::State<'_, JobCancels>, job_id: String) -> bool {
    cancellations.cancel(&job_id)
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
    grants: tauri::State<'_, PathGrants>,
    directory: String,
    recursive: Option<bool>,
    max_files: Option<f64>,
    exclude_directory: Option<String>,
) -> Result<potools_engine::services::invoice::InvoiceScanListing, String> {
    invoice_scan_list_authorized(&grants, directory, recursive, max_files, exclude_directory)
}

/// Authorization happens here, at the IPC entry point, rather than inside the
/// service: a command body that takes a bare path is a path any script in the
/// WebView can name. Splitting the two also lets the tests drive the exact
/// function the webview reaches, `State` extractor aside.
fn invoice_scan_list_authorized(
    grants: &PathGrants,
    directory: String,
    recursive: Option<bool>,
    max_files: Option<f64>,
    exclude_directory: Option<String>,
) -> Result<potools_engine::services::invoice::InvoiceScanListing, String> {
    let source = grants.require_source_dir(&directory, "来源目录")?;
    potools_engine::services::invoice::invoice_scan_list(
        source.to_string_lossy().into_owned(),
        recursive,
        max_files,
        exclude_directory,
    )
}

#[tauri::command(async)]
fn invoice_read_candidate(
    grants: tauri::State<'_, PathGrants>,
    path: String,
    expected_size_bytes: u64,
) -> Result<potools_engine::services::invoice::InvoiceCandidateRead, String> {
    invoice_read_candidate_authorized(&grants, path, expected_size_bytes)
}

fn invoice_read_candidate_authorized(
    grants: &PathGrants,
    path: String,
    expected_size_bytes: u64,
) -> Result<potools_engine::services::invoice::InvoiceCandidateRead, String> {
    let source = grants.require_source_file(&path)?;
    potools_engine::services::invoice::invoice_read_candidate(
        source.to_string_lossy().into_owned(),
        expected_size_bytes,
    )
}

#[tauri::command(async)]
fn invoice_archive(
    grants: tauri::State<'_, PathGrants>,
    input: potools_engine::services::invoice::InvoiceArchiveInput,
) -> Result<serde_json::Value, String> {
    invoice_archive_authorized(&grants, input)
}

fn invoice_archive_authorized(
    grants: &PathGrants,
    input: potools_engine::services::invoice::InvoiceArchiveInput,
) -> Result<serde_json::Value, String> {
    let source = grants.require_source_dir(&input.source_directory, "来源目录")?;
    let target = grants.require_destination_dir(&input.target_directory)?;
    potools_engine::services::invoice::invoice_archive(
        potools_engine::services::invoice::InvoiceArchiveInput {
            source_directory: source.to_string_lossy().into_owned(),
            target_directory: target.to_string_lossy().into_owned(),
            ..input
        },
    )
}

#[tauri::command(async)]
fn invoice_undo(
    grants: tauri::State<'_, PathGrants>,
    archive_id: String,
) -> Result<serde_json::Value, String> {
    invoice_undo_authorized(&grants, archive_id)
}

fn invoice_undo_authorized(
    grants: &PathGrants,
    archive_id: String,
) -> Result<serde_json::Value, String> {
    // An archive id only names an entry in this process's memory, so the caller
    // must additionally still hold write authority over the归档 directory before
    // any copy is removed.
    potools_engine::services::invoice::invoice_undo(archive_id, &|path| grants.can_write(path))
}

#[cfg(test)]
mod invoice_tests;
#[cfg(test)]
mod secure_paths_tests;

type StagedArtifact = potools_engine::services::filesystem::StagedArtifact;
type TempUsage = potools_engine::services::temp::TempUsage;
type TempCleanResult = potools_engine::services::temp::TempCleanResult;

#[tauri::command(async)]
fn temp_usage(grants: tauri::State<'_, PathGrants>, root: String) -> Result<TempUsage, String> {
    temp_usage_authorized(&grants, root)
}

fn temp_usage_authorized(grants: &PathGrants, root: String) -> Result<TempUsage, String> {
    let trusted = grants.require_app_temp_root(&root)?;
    Ok(potools_engine::services::temp::temp_usage(
        trusted.to_string_lossy().into_owned(),
    ))
}

#[tauri::command(async)]
fn temp_clean(
    grants: tauri::State<'_, PathGrants>,
    root: String,
    older_than_days: f64,
    keep_jobs: usize,
    protect_jobs: Vec<String>,
) -> Result<TempCleanResult, String> {
    temp_clean_authorized(&grants, root, older_than_days, keep_jobs, protect_jobs)
}

fn temp_clean_authorized(
    grants: &PathGrants,
    root: String,
    older_than_days: f64,
    keep_jobs: usize,
    protect_jobs: Vec<String>,
) -> Result<TempCleanResult, String> {
    let trusted = grants.require_app_temp_root(&root)?;
    Ok(potools_engine::services::temp::temp_clean(
        trusted.to_string_lossy().into_owned(),
        older_than_days,
        keep_jobs,
        protect_jobs,
    ))
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
fn browse_directories(
    grants: tauri::State<'_, PathGrants>,
    path: Option<String>,
) -> Result<DirectoryListing, String> {
    browse_directories_authorized(&grants, path)
}

fn browse_directories_authorized(
    grants: &PathGrants,
    path: Option<String>,
) -> Result<DirectoryListing, String> {
    // Only the folders the user picked or the ones Rust seeded (their own home
    // and standard folders) may be enumerated, and a failed read lists nothing.
    let authorized = grants.resolve_browsable(path.as_deref())?;
    potools_engine::services::filesystem::browse_directories(
        path,
        &authorized,
        &grants.browse_roots(),
    )
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
    let name = decode_header_value(header("x-potools-name")?, "artifact name")?;
    let temp_root = decode_header_value(header("x-potools-temp-root")?, "temp root")?;
    let output_dir = header("x-potools-output-dir")
        .ok()
        .filter(|value| !value.is_empty())
        .map(|value| decode_header_value(value, "output dir"))
        .transpose()?; // The staging target is `<temp_root>/jobs/<job>`, so checking that path
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

#[cfg(test)]
mod header_value_tests {
    use super::decode_header_value;

    #[test]
    fn ascii_values_pass_through_untouched() {
        let encoded = "%2FUsers%2Fpohoc%2FDocuments%2FPoTools";
        assert_eq!(
            decode_header_value(encoded.to_string(), "output dir").unwrap(),
            "/Users/pohoc/Documents/PoTools",
        );
        assert_eq!(
            decode_header_value("plain-name.pdf".to_string(), "artifact name").unwrap(),
            "plain-name.pdf"
        );
    }

    #[test]
    fn decodes_the_frontend_percent_encoding_for_non_ascii_names() {
        // The exact encodeURIComponent output for
        // "保安二部2024年4月-11月入职人员合同-2-split (9) (2)-compressed.pdf".
        let encoded = "%E4%BF%9D%E5%AE%89%E4%BA%8C%E9%83%A82024%E5%B9%B44%E6%9C%88-11%E6%9C%88%E5%85%A5%E8%81%8C%E4%BA%BA%E5%91%98%E5%90%88%E5%90%8C-2-split%20(9)%20(2)-compressed.pdf";
        assert_eq!(
            decode_header_value(encoded.to_string(), "artifact name").unwrap(),
            "保安二部2024年4月-11月入职人员合同-2-split (9) (2)-compressed.pdf",
        );
    }

    #[test]
    fn broken_escapes_are_rejected_with_the_field_label() {
        // %FF never forms valid UTF-8, so the decode must fail, not mojibake.
        let error = decode_header_value("%FF.pdf".to_string(), "artifact name").unwrap_err();
        assert!(error.contains("artifact name"), "{error}");
    }
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

/// Show the native folder dialog **from Rust** and grant what the user picked.
///
/// `purpose` is `"output"` or `"temp"` when the pick is for one of those
/// persisted settings: the gesture then also *records the approval* the setting
/// needs later, so the user is not asked to confirm the same folder twice.
#[tauri::command(async)]
fn pick_directory(
    app: AppHandle,
    grants: tauri::State<'_, PathGrants>,
    purpose: Option<String>,
) -> Result<Option<String>, String> {
    let Some(folder) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let Some(path) = folder.into_path().ok() else {
        return Ok(None);
    };
    grants.grant_dir(&path);
    if let Some(kind) = approval_kind(purpose.as_deref()) {
        grants.approve_directory(&path, kind)?;
    }
    Ok(Some(path.to_string_lossy().into_owned()))
}

fn approval_kind(value: Option<&str>) -> Option<ApprovalKind> {
    match value {
        Some("output") => Some(ApprovalKind::Output),
        Some("temp") => Some(ApprovalKind::Temp),
        _ => None,
    }
}

/// Ask the user, **in a native dialog**, to approve a directory they typed (or
/// that a restored setting names) for the output/temp role. Approval is recorded
/// by this process, so a later `set_output_dir` / `set_temp_dir` for the same
/// path needs no gesture of its own. Declining returns `false` and grants
/// nothing.
#[tauri::command(async)]
// The labels have to travel from the WebView so the prompt follows the active
// locale, and Tauri's IPC takes them as flat arguments.
#[allow(clippy::too_many_arguments)]
fn approve_directory(
    app: AppHandle,
    grants: tauri::State<'_, PathGrants>,
    dir: String,
    purpose: String,
    title: String,
    message: String,
    confirm_label: String,
    cancel_label: String,
) -> Result<bool, String> {
    let Some(kind) = approval_kind(Some(purpose.as_str())) else {
        return Err(format!("未知的目录用途：{purpose}"));
    };
    let target = potools_engine::services::filesystem::validate_absolute_path(&dir, "目录")?;
    if !target.is_dir() {
        return Err(format!("目录不存在：{dir}"));
    }
    if grants.is_approved(&target, kind) {
        return Ok(true);
    }
    let allowed = app
        .dialog()
        .message(message)
        .title(title)
        .buttons(MessageDialogButtons::OkCancelCustom(
            confirm_label,
            cancel_label,
        ))
        .blocking_show();
    if !allowed {
        return Ok(false);
    }
    grants.approve_directory(&target, kind)?;
    Ok(true)
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
            // The only writable file grant in the app: the user chose this exact
            // destination in a native save dialog.
            grants.grant_writable_file(&path);
            Some(path.to_string_lossy().to_string())
        }))
}

/// Point the staging area at the user's configured temp directory.
///
/// The setting is visible and persisted, but a value arriving here is only a
/// string: it is honoured **when this process recorded the user's approval for
/// that directory** (native pick, or a confirmed `approve_directory`), and
/// otherwise refused. Otherwise `set_temp_dir` would be a command any WebView
/// script could use to aim the app's writes and cleanup at a folder of its
/// choosing. Clearing the setting falls back to the platform temp dir, which is
/// Rust's own value rather than a claim from the WebView.
#[tauri::command(async)]
fn set_temp_dir(grants: tauri::State<'_, PathGrants>, dir: Option<String>) -> Result<(), String> {
    set_temp_dir_authorized(&grants, dir)
}

fn set_temp_dir_authorized(grants: &PathGrants, dir: Option<String>) -> Result<(), String> {
    let Some(dir) = dir.filter(|value| !value.trim().is_empty()) else {
        // "Use the default": the derived root, granted because Rust computed it.
        let root = grants.app_default_temp().unwrap_or_else(std::env::temp_dir);
        grants.grant_temp_root(&root);
        return Ok(());
    };
    let root = grants.require_approved(&dir, ApprovalKind::Temp, "临时目录")?;
    grants.grant_temp_root(&root);
    Ok(())
}

/// Grant the configured output directory for **writes only**, and only once the
/// user has approved that directory through a native gesture.
#[tauri::command(async)]
fn set_output_dir(grants: tauri::State<'_, PathGrants>, dir: Option<String>) -> Result<(), String> {
    set_output_dir_authorized(&grants, dir)
}

fn set_output_dir_authorized(grants: &PathGrants, dir: Option<String>) -> Result<(), String> {
    let Some(dir) = dir.filter(|value| !value.trim().is_empty()) else {
        return Ok(());
    };
    let root = grants.require_approved(&dir, ApprovalKind::Output, "输出目录")?;
    grants.grant_write_dir(&root);
    Ok(())
}

/// IPC header values are restricted to Latin-1 by the WebView (a non-ASCII
/// artifact name or folder path makes `new Headers()` throw a bare
/// "Type error" TypeError), so the frontend sends these values
/// `encodeURIComponent`-encoded and this restores them.
fn decode_header_value(value: String, label: &str) -> Result<String, String> {
    percent_encoding::percent_decode_str(&value)
        .decode_utf8()
        .map(|decoded| decoded.to_string())
        .map_err(|error| format!("Invalid UTF-8 in {label} header: {error}"))
}

/// "Save next to the source files": ask the user in a **native dialog** to grant
/// write access to a resolved source folder. The dialog gesture is the only
/// sound authority for a grant the WebView did not hold before (see the
/// `PathGrants` threat model — a grant command callable from JS would simply be
/// invoked by a script). Already-granted folders return true without prompting;
/// a decline returns false and the caller falls back to the configured folder.
#[tauri::command(async)]
fn request_output_dir_grant(
    app: AppHandle,
    grants: tauri::State<'_, PathGrants>,
    dir: String,
    title: String,
    message: String,
    confirm_label: String,
    cancel_label: String,
) -> Result<bool, String> {
    let target = potools_engine::services::filesystem::validate_absolute_path(&dir, "输出目录")?;
    if !target.is_dir() {
        return Err(format!("输出目录不存在：{dir}"));
    }
    if grants.can_write(&target) {
        return Ok(true);
    }
    let allowed = app
        .dialog()
        .message(message)
        .title(title)
        .buttons(MessageDialogButtons::OkCancelCustom(
            confirm_label,
            cancel_label,
        ))
        .blocking_show();
    if allowed {
        grants.grant_write_dir(&target);
    }
    Ok(allowed)
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
        .manage(JobCancels::new())
        .setup(|app| {
            let grants = app.state::<PathGrants>();
            // Approved directories were recorded by this process on an earlier
            // run, so a saved output/temp setting is honoured again on launch
            // without any value from the WebView having to be trusted for it.
            if let Ok(config_dir) = app.path().app_config_dir() {
                if let Err(error) =
                    grants.load_approvals(&config_dir.join("directory-approvals.json"))
                {
                    eprintln!("[potools] {error}");
                }
            }
            for (_, root) in potools_engine::services::filesystem::standard_browse_roots() {
                grants.allow_browsing(&root);
            }
            // Artifacts get staged before the frontend can report a configured
            // temp directory, and the derived defaults are Rust's own values, so
            // `<Documents>/PoTools` (writes) and `<temp>/potools` (staging) are
            // granted up front instead of waiting on an IPC argument.
            let runtime = potools_engine::services::runtime::desktop_runtime_info();
            grants.grant_app_defaults(
                std::path::Path::new(&runtime.default_output_dir),
                std::path::Path::new(&runtime.default_temp_dir),
            );
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
            cancel_native_job,
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
            approve_directory,
            set_temp_dir,
            set_output_dir,
            request_output_dir_grant,
            path_grants
        ])
        .build(tauri::generate_context!())
        .expect("error while building PoTools")
        .run(|_app_handle, _event| {});
}
