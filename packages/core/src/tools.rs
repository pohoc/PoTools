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

/// The task shape a tool's interface is built around, per
/// `docs/standards/TOOL_INTERACTION.md` §1. Declared per tool in the catalog
/// because the main mode follows the user's task, not the presence of a
/// `textarea` field or a `layout: "text"` entry (RFC-0001).
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExperienceKind {
    /// Input transforms into output on the same screen (JSON, Base64, case).
    InstantTransform,
    /// A structured value is parsed into grouped fields (JWT, X.509, UA).
    StructuredInspector,
    /// Parameters produce a computed result (date diff, cron, IPv4 subnet).
    Calculator,
    /// A value is generated rather than derived (password, UUID, TOTP).
    Generator,
    /// The user manipulates a preview directly (page organizer, crop, ID photo).
    VisualEditor,
    /// A queue of files is processed with per-item status (merge, compress).
    BatchProcessor,
    /// Stepped flow with a pre-check and an explicit commit (invoice organizing).
    GuidedWorkflow,
}

/// When a run is issued. Separate from [`ExperienceKind`]: two tools can share a
/// layout and differ in cost, and `live` may only be claimed by cheap, side-effect
/// free local work (`docs/standards/TOOL_INTERACTION.md` §2).
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExecutionMode {
    /// Re-run as soon as the input validates.
    Live,
    /// Re-run after a short settle, discarding stale replies.
    Debounced,
    /// Only run when the user asks.
    Manual,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolExperience {
    pub kind: ExperienceKind,
    pub execution: ExecutionMode,
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
    /// Required so no tool can ship without an explicit interaction model;
    /// `layout` and `interaction` describe the old generic workbench.
    pub experience: ToolExperience,
}

/// Every embedded tool catalog as `(file name, JSON source)`, in embedding order.
/// The file names exist so contract checks can point a reader at the offending
/// JSON: `all_tools()` loses provenance as soon as the domain lists are
/// concatenated. `packages/core/tests/catalog_contract.rs` walks this list.
///
/// `catalog/id-photo.json` is deliberately absent: it is option data (presets)
/// for the `id-photo` tool, not a tool list. See `crate::id_photo`.
pub const CATALOG_SOURCES: &[(&str, &str)] = &[
    (
        "page-management.json",
        include_str!("../catalog/page-management.json"),
    ),
    (
        "annotation.json",
        include_str!("../catalog/annotation.json"),
    ),
    ("metadata.json", include_str!("../catalog/metadata.json")),
    (
        "optimization.json",
        include_str!("../catalog/optimization.json"),
    ),
    (
        "conversion.json",
        include_str!("../catalog/conversion.json"),
    ),
    (
        "page-layout.json",
        include_str!("../catalog/page-layout.json"),
    ),
    (
        "extraction.json",
        include_str!("../catalog/extraction.json"),
    ),
    (
        "invoice-organizing.json",
        include_str!("../catalog/invoice-organizing.json"),
    ),
    (
        "image-processing.json",
        include_str!("../catalog/image-processing.json"),
    ),
    ("time.json", include_str!("../catalog/time.json")),
    ("crypto.json", include_str!("../catalog/crypto.json")),
    ("finance.json", include_str!("../catalog/finance.json")),
    ("developer.json", include_str!("../catalog/developer.json")),
    ("network.json", include_str!("../catalog/network.json")),
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
    let parsed = CATALOG_SOURCES
        .iter()
        .try_fold(Vec::new(), |mut catalog, (_file, source)| {
            catalog.extend(serde_json::from_str::<Vec<ToolDescriptor>>(source)?);
            Ok(catalog)
        })?;
    Ok(CATALOG.get_or_init(|| parsed))
}

static CATALOG: std::sync::OnceLock<Vec<ToolDescriptor>> = std::sync::OnceLock::new();

pub fn find_tool<'a>(catalog: &'a [ToolDescriptor], id: &str) -> Option<&'a ToolDescriptor> {
    catalog.iter().find(|tool| tool.id == id)
}
