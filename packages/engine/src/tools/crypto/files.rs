use super::hash::{bad, b64_decode};
use super::{EngineError, RunContext, ToolResult};
use crate::Artifact;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::json;

pub(super) fn run(ctx: &RunContext<'_>) -> Result<Option<ToolResult>, EngineError> {
    match ctx.tool {
        "file-base64" => {
            let Some(input) = ctx.inputs.first() else {
                return Err(EngineError::new("empty_selection", "请先添加文件"));
            };
            if input.bytes.len() > 8 * 1024 * 1024 {
                return Err(bad("file", "exceeds 8 MiB limit"));
            }
            let encoded = STANDARD.encode(&input.bytes);
            let mut result = ToolResult::default();
            result.artifacts.push(Artifact::new(
                format!("{}.base64.txt", input.name),
                "text",
                encoded.as_bytes().to_vec(),
            ));
            result.extra.insert("sourceBytes".into(), json!(input.bytes.len()));
            result.extra.insert("encodedCharacters".into(), json!(encoded.len()));
            Ok(Some(result))
        }
        "base64-file" => {
            let raw = ctx.options.get("input").and_then(|v| v.as_str()).unwrap_or("SGVsbG8=");
            let name = safe_name(ctx.options.get("filename").and_then(|v| v.as_str()).unwrap_or("decoded.bin"));
            let bytes = b64_decode(raw).map_err(|_| bad("input", "invalid Base64 data"))?;
            if bytes.len() > 8 * 1024 * 1024 {
                return Err(bad("input", "decoded file exceeds 8 MiB limit"));
            }
            let mut result = ToolResult::default();
            result.artifacts.push(Artifact::new(&name, "binary", bytes.clone()));
            result.extra.insert("filename".into(), json!(name));
            result.extra.insert("bytes".into(), json!(bytes.len()));
            Ok(Some(result))
        }
        _ => Ok(None),
    }
}

fn safe_name(value: &str) -> String {
    let mut name = value
        .chars()
        .map(|character| {
            if character.is_control() || "\\/:*?\"<>|".contains(character) {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    while name.encode_utf16().count() > 120 {
        name.pop();
    }
    if name.trim().is_empty() { "decoded.bin".into() } else { name }
}
