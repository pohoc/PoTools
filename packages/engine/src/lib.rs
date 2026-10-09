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

pub mod progress;

pub mod services;

pub mod tools;
#[cfg(feature = "wasm")]
pub mod wasm;

/// Human-readable text from a panic payload, for the `internal` error message.
fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(text) = payload.downcast_ref::<&str>() {
        (*text).to_owned()
    } else if let Some(text) = payload.downcast_ref::<String>() {
        text.clone()
    } else {
        "工具执行时发生内部错误".to_owned()
    }
}

/// Runs a tool body, converting a panic into an `EngineError`.
///
/// Every tool consumes bytes the user chose to open, and third-party parsers
/// (PDF, image, zip, XML, YAML) are not panic-free by contract. Without this
/// guard a malformed document takes down the whole host process instead of
/// failing one job.
///
/// On `wasm32-unknown-unknown` there is no unwinding, so a panic still traps the
/// Worker; the JS worker pool is responsible for respawning it.
fn guarded<F>(run: F) -> Result<Option<ToolResult>, EngineError>
where
    F: FnOnce() -> Result<Option<ToolResult>, EngineError>,
{
    // `AssertUnwindSafe` is sound here: the engine keeps no per-call mutable
    // state behind these references, and the only process-wide state (the
    // invoice undo registry) is mutex-protected and never held across a tool.
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(run)) {
        Ok(result) => result,
        Err(payload) => Err(EngineError::new("internal", panic_message(&*payload))),
    }
}

pub fn run_tool(context: &RunContext<'_>) -> Result<Option<ToolResult>, EngineError> {
    guarded(|| dispatch(context))
}

fn dispatch(context: &RunContext<'_>) -> Result<Option<ToolResult>, EngineError> {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A panicking tool body must surface as `internal`, not unwind out of the
    /// engine into the Tauri command or the wasm ABI.
    #[test]
    fn panic_inside_a_tool_becomes_an_engine_error() {
        let outcome = guarded(|| panic!("simulated parser panic"));
        match outcome {
            Err(error) => {
                assert_eq!(error.code, "internal");
                assert!(
                    error.message.contains("simulated parser panic"),
                    "unexpected message: {}",
                    error.message
                );
            }
            Ok(_) => panic!("panic must not be reported as a successful run"),
        }
    }

    #[test]
    fn successful_runs_pass_through_the_guard() {
        let outcome = guarded(|| Ok(None));
        assert!(matches!(outcome, Ok(None)));
        let failure = guarded(|| Err(EngineError::new("unreadable_file", "bad bytes")));
        assert_eq!(failure.unwrap_err().code, "unreadable_file");
    }
}
