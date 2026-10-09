//! Tool registry metadata types. Concrete catalog data is declared by domain.

use crate::fields::ToolField;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolCategory {
    Organize,
    Convert,
    Optimize,
    Edit,
    Extract,
    Metadata,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolLayout {
    Standard,
    Organizer,
    Splitter,
    Metadata,
    ImageGrid,
    Text,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolWorkflow {
    PageManagement,
    PageLayout,
    Annotation,
    Conversion,
    Extraction,
    Optimization,
    Metadata,
    ImageProcessing,
    InvoiceOrganizing,
    Time,
    Crypto,
    Developer,
    Network,
    Finance,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDescriptor {
    pub id: String,
    pub name_key: String,
    pub desc_key: String,
    pub category: ToolCategory,
    pub workflow: ToolWorkflow,
    pub input_formats: Vec<String>,
    pub output_formats: Vec<String>,
    pub icon: String,
    pub order: u32,
    pub accept: String,
    pub multi_file: bool,
    pub layout: ToolLayout,
    pub fields: Vec<ToolField>,
    pub artifact_kind: String,
    pub requires_input: Option<bool>,
    pub order_sensitive: Option<bool>,
    pub keywords: Option<Vec<String>>,
    pub network_access: Option<String>,
}

const CATALOGS: &[&str] = &[
    include_str!("../catalog/page-management.json"),
    include_str!("../catalog/annotation.json"),
    include_str!("../catalog/metadata.json"),
    include_str!("../catalog/optimization.json"),
    include_str!("../catalog/conversion.json"),
    include_str!("../catalog/page-layout.json"),
    include_str!("../catalog/extraction.json"),
    include_str!("../catalog/invoice-organizing.json"),
    include_str!("../catalog/image-processing.json"),
    include_str!("../catalog/time.json"),
    include_str!("../catalog/crypto.json"),
    include_str!("../catalog/finance.json"),
    include_str!("../catalog/developer.json"),
    include_str!("../catalog/network.json"),
];

/// The checked-in domain JSON is shared data. Rust owns the catalog API and
/// validation; the Web contract mirror in `apps/web/src/lib/core-contract.ts`
/// exists only for UI type checking.
///
/// The 14 embedded blobs are ~187 KB of JSON, so the parse result is cached for
/// the lifetime of the process instead of being redone on every call.
pub fn all_tools() -> Result<&'static [ToolDescriptor], serde_json::Error> {
    if let Some(cached) = CATALOG.get() {
        return Ok(cached);
    }
    // Parse before initialising so a malformed catalog stays a recoverable error
    // rather than poisoning a `OnceLock`. A lost race just re-parses once.
    let parsed = CATALOGS
        .iter()
        .try_fold(Vec::new(), |mut catalog, source| {
            catalog.extend(serde_json::from_str::<Vec<ToolDescriptor>>(source)?);
            Ok(catalog)
        })?;
    Ok(CATALOG.get_or_init(|| parsed))
}

static CATALOG: std::sync::OnceLock<Vec<ToolDescriptor>> = std::sync::OnceLock::new();

pub fn find_tool<'a>(catalog: &'a [ToolDescriptor], id: &str) -> Option<&'a ToolDescriptor> {
    catalog.iter().find(|tool| tool.id == id)
}
