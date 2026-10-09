//! Cross-platform wire contracts. Platform-specific handles and IO stay outside core.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;

mod tool_id;
pub use tool_id::ToolId;

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    Pdf,
    Image,
    Text,
    Json,
    Binary,
    Docx,
    Doc,
    Xlsx,
    Xls,
    Pptx,
    Ppt,
    Md,
    Html,
    Csv,
    Rtf,
    Epub,
    Ofd,
}

#[derive(Clone, Debug)]
pub struct InputFile {
    pub id: String,
    pub name: String,
    pub path: Option<PathBuf>,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub name: String,
    pub kind: String,
    #[serde(skip)]
    pub bytes: Vec<u8>,
    pub size_bytes: usize,
    pub source_file_id: Option<String>,
}

impl Artifact {
    pub fn new(name: impl Into<String>, kind: impl Into<String>, bytes: Vec<u8>) -> Self {
        let size_bytes = bytes.len();
        Self {
            name: name.into(),
            kind: kind.into(),
            bytes,
            size_bytes,
            source_file_id: None,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default)]
    pub artifacts: Vec<Artifact>,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub extra: Map<String, Value>,
}

impl ToolResult {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            text: Some(text.into()),
            ..Self::default()
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRef {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub data_base64: Option<String>,
    #[serde(default)]
    pub size_bytes: Option<u64>,
    #[serde(default)]
    pub mime: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobGlobals {
    pub font_path: Option<String>,
    pub temp_dir: Option<String>,
    pub password: Option<String>,
    pub locale: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobOutputRequest {
    pub dir: Option<String>,
    pub want_bytes: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRequest {
    pub id: String,
    pub tool: String,
    #[serde(default)]
    pub files: Vec<FileRef>,
    #[serde(default)]
    pub options: Map<String, Value>,
    #[serde(default)]
    pub output: Option<JobOutputRequest>,
    #[serde(default)]
    pub globals: Option<JobGlobals>,
    #[serde(default)]
    pub name_pattern: Option<String>,
    #[serde(default)]
    pub created_at: Option<u64>,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobState {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    pub state: JobState,
    pub percent: f64,
    pub phase: Option<String>,
    pub message_key: Option<String>,
    pub current: Option<u64>,
    pub total: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobError {
    pub code: String,
    pub message: String,
    pub details: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputFile {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub path: Option<String>,
    pub staged_missing: Option<bool>,
    pub data_base64: Option<String>,
    pub size_bytes: u64,
    pub page: Option<u32>,
    pub source_file_id: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSummary {
    pub input_bytes: u64,
    pub output_bytes: u64,
    pub page_count_in: u32,
    pub page_count_out: u32,
    pub size_delta_percent: Option<f64>,
    pub extra: Option<Map<String, Value>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSnapshot {
    pub id: String,
    pub tool: String,
    pub label: Option<String>,
    pub file_names: Vec<String>,
    pub created_at: u64,
    pub finished_at: Option<u64>,
    pub progress: JobProgress,
    pub artifacts: Vec<OutputFile>,
    pub summary: Option<JobSummary>,
    pub warnings: Vec<String>,
    pub error: Option<JobError>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    pub page: u32,
    pub width: f64,
    pub height: f64,
    pub rotation: i32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbedPdf {
    pub file_id: String,
    pub name: String,
    pub size_bytes: u64,
    pub page_count: u32,
    pub pages: Vec<PageInfo>,
    pub metadata: BTreeMap<String, String>,
    pub encrypted: bool,
    pub uniform_size: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineFeatures {
    pub rasterizer: String,
    pub image_codec: bool,
    pub cjk_font: Option<String>,
    pub busy: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub name: String,
    pub version: String,
    pub protocol: u32,
    pub platform: String,
    pub node_version: String,
    pub pid: u32,
    pub default_output_dir: String,
    pub temp_dir: String,
    pub default_temp_dir: String,
    pub features: EngineFeatures,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QuickDirectoryId {
    Home,
    Documents,
    Downloads,
    Desktop,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickDirectory {
    pub id: QuickDirectoryId,
    pub path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub path: String,
    pub requested: String,
    pub parent: Option<String>,
    pub dirs: Vec<DirectoryEntry>,
    pub quick: Vec<QuickDirectory>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TempUsage {
    pub dir: String,
    pub jobs: u64,
    pub files: u64,
    pub bytes: u64,
    pub oldest_at: Option<u64>,
    pub newest_at: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TempCleanResult {
    pub removed_jobs: u64,
    pub removed_files: u64,
    pub freed_bytes: u64,
    pub kept_jobs: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum RpcMethodName {
    #[serde(rename = "engine.info")]
    EngineInfo,
    #[serde(rename = "engine.ping")]
    EnginePing,
    #[serde(rename = "engine.setTempDir")]
    EngineSetTempDir,
    #[serde(rename = "tools.list")]
    ToolsList,
    #[serde(rename = "tool.run")]
    ToolRun,
    #[serde(rename = "job.submit")]
    JobSubmit,
    #[serde(rename = "job.cancel")]
    JobCancel,
    #[serde(rename = "job.list")]
    JobList,
    #[serde(rename = "job.clear")]
    JobClear,
    #[serde(rename = "file.probe")]
    FileProbe,
    #[serde(rename = "fs.browse")]
    FsBrowse,
    #[serde(rename = "file.bytes")]
    FileBytes,
    #[serde(rename = "page.thumbs")]
    PageThumbs,
    #[serde(rename = "page.list")]
    PageList,
    #[serde(rename = "file.write")]
    FileWrite,
    #[serde(rename = "shell.reveal")]
    ShellReveal,
    #[serde(rename = "shell.print")]
    ShellPrint,
    #[serde(rename = "temp.stat")]
    TempStat,
    #[serde(rename = "temp.clean")]
    TempClean,
    #[serde(rename = "invoice.scan")]
    InvoiceScan,
    #[serde(rename = "invoice.archive")]
    InvoiceArchive,
    #[serde(rename = "invoice.undo")]
    InvoiceUndo,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextRunResult {
    pub text: String,
    pub artifacts: Vec<Artifact>,
    pub warnings: Vec<String>,
    pub extra: Option<Map<String, Value>>,
    pub ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceFields {
    pub date: String,
    pub seller: String,
    pub buyer: String,
    pub invoice_no: String,
    pub amount: String,
    pub r#type: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceScanEntry {
    pub path: String,
    pub relative_path: String,
    pub name: String,
    pub extension: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub page_count: Option<u32>,
    pub extracted_text: String,
    pub recognition: String,
    pub fields: InvoiceFields,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceScanResult {
    pub source_directory: String,
    pub scanned_at: u64,
    pub files: Vec<InvoiceScanEntry>,
    pub skipped: Vec<Map<String, Value>>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "event")]
pub enum EngineEvent {
    #[serde(rename = "job.updated")]
    JobUpdated { job: JobSnapshot },
    #[serde(rename = "log")]
    Log { level: String, message: String },
}
