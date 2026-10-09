#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceArchiveInput {
    pub source_directory: String,
    pub target_directory: String,
    pub conflict: String,
    pub files: Vec<InvoiceArchiveFile>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceArchiveFile {
    pub path: String,
    pub sha256: String,
    pub relative_path: String,
    pub enabled: bool,
    pub fields: Option<serde_json::Value>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceScanCandidate {
    pub path: String,
    pub relative_path: String,
    pub name: String,
    pub extension: String,
    pub size_bytes: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceScanListing {
    pub source_directory: String,
    pub files: Vec<InvoiceScanCandidate>,
    pub skipped: Vec<serde_json::Value>,
    pub exceeded: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceCandidateRead {
    pub bytes: Vec<u8>,
    pub current_size_bytes: u64,
    pub changed_while_reading: bool,
}
