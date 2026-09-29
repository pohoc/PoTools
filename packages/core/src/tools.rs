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

/// The checked-in domain JSON is shared data. Rust owns the catalog API and validation;
/// the TypeScript package exposes a compatibility view for UI type checking.
pub fn all_tools() -> Result<Vec<ToolDescriptor>, serde_json::Error> {
    CATALOGS.iter().try_fold(Vec::new(), |mut catalog, source| {
        catalog.extend(serde_json::from_str::<Vec<ToolDescriptor>>(source)?);
        Ok(catalog)
    })
}

pub fn find_tool<'a>(catalog: &'a [ToolDescriptor], id: &str) -> Option<&'a ToolDescriptor> {
    catalog.iter().find(|tool| tool.id == id)
}
