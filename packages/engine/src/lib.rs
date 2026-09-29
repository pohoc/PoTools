//! Cross-platform Rust tool engine. The desktop host adapts filesystem and UI
//! permissions; tool behavior lives in this package.

pub use potools_core::{Artifact, InputFile, ToolResult};
use serde_json::Value;

#[derive(Clone, Debug)]
pub struct RunContext<'a> {
    pub tool: &'a str,
    pub options: &'a Value,
    pub locale: &'a str,
    pub inputs: &'a [InputFile],
    pub name_pattern: Option<&'a str>,
    pub runtime_data: Option<&'a Value>,
}

#[derive(Clone, Debug)]
pub struct EngineError {
    pub code: &'static str,
    pub message: String,
    pub hint_key: Option<&'static str>,
}

impl EngineError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            hint_key: None,
        }
    }

    pub fn with_hint(mut self, hint_key: &'static str) -> Self {
        self.hint_key = Some(hint_key);
        self
    }
}

pub mod ocr;

pub mod services;

pub mod tools;
#[cfg(feature = "wasm")]
pub mod wasm;

pub fn run_tool(context: &RunContext<'_>) -> Result<Option<ToolResult>, EngineError> {
    if let Some(result) = tools::text::run(context)? {
        return Ok(Some(result));
    }
    if let Some(result) = tools::crypto::run(context)? {
        return Ok(Some(result));
    }
    if let Some(result) = tools::developer_rust::run(context)? {
        return Ok(Some(result));
    }
    if let Some(result) = tools::image::run(context)? {
        return Ok(Some(result));
    }
    if let Some(result) = tools::pdf_basic::run(context)? {
        return Ok(Some(result));
    }
    if let Some(result) = tools::pdf_extra::run(context)? {
        return Ok(Some(result));
    }
    if let Some(result) = tools::pdf_convert::run(context)? {
        return Ok(Some(result));
    }
    Ok(None)
}
