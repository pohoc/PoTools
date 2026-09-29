use super::shared::*;
use crate::{Artifact, EngineError, RunContext, ToolResult};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::json;

pub fn run(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    match ctx.tool {
        "file-base64" => encode_file(ctx),
        "base64-file" => decode_file(ctx),
        _ => Err(err("Unsupported developer file tool")),
    }
}

fn encode_file(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let file = ctx
        .inputs
        .first()
        .ok_or_else(|| EngineError::new("empty_selection", msg(ctx, "dev.error.empty")))?;
    if file.bytes.len() > 8 * 1024 * 1024 {
        return Err(error(ctx, "dev.error.tooLarge"));
    }
    let encoded = STANDARD.encode(&file.bytes);
    let mut result = ToolResult::default();
    result.artifacts.push(Artifact::new(
        format!("{}.base64.txt", file.name),
        "text",
        encoded.as_bytes().to_vec(),
    ));
    result.extra = extra([
        (String::from("sourceBytes"), json!(file.bytes.len())),
        (String::from("encodedCharacters"), json!(encoded.len())),
    ]);
    Ok(result)
}

fn decode_file(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let source = required(ctx)?;
    let mut name = string(ctx, "filename", "decoded.bin")
        .to_string()
        .replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "_")
        .chars()
        .map(|character| {
            if (character as u32) <= 0x1f {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    name = truncate_utf16(&name, 120);
    if name.trim().is_empty() {
        name = "decoded.bin".into();
    }
    let mut payload = source.to_string();
    if let Some((header, rest)) = payload.split_once(',') {
        if header.to_ascii_lowercase().starts_with("data:")
            && header.to_ascii_lowercase().ends_with(";base64")
        {
            payload = rest.to_string();
        }
    }
    payload.retain(|character| !character.is_whitespace());
    payload = payload.replace('-', "+").replace('_', "/");
    if payload.len() > 12 * 1024 * 1024 {
        return Err(error(ctx, "dev.error.tooLarge"));
    }
    if !valid_base64_syntax(&payload) || payload.len() % 4 == 1 {
        return Err(error(ctx, "dev.error.base64"));
    }
    let canonical = payload.trim_end_matches('=').to_string();
    let padded = payload.trim_end_matches('=').to_string()
        + &"=".repeat((4 - payload.trim_end_matches('=').len() % 4) % 4);
    let bytes = STANDARD
        .decode(padded.as_bytes())
        .map_err(|_| error(ctx, "dev.error.base64"))?;
    if STANDARD.encode(&bytes).trim_end_matches('=') != canonical {
        return Err(error(ctx, "dev.error.base64"));
    }
    let mut result = ToolResult::default();
    result
        .artifacts
        .push(Artifact::new(&name, "binary", bytes.clone()));
    result.extra = extra([
        (String::from("filename"), json!(name)),
        (String::from("bytes"), json!(bytes.len())),
    ]);
    Ok(result)
}

fn valid_base64_syntax(source: &str) -> bool {
    let mut padding = false;
    let mut padding_count = 0;
    for byte in source.bytes() {
        if byte == b'=' {
            padding = true;
            padding_count += 1;
            if padding_count > 2 {
                return false;
            }
        } else if padding || !byte.is_ascii_alphanumeric() && byte != b'+' && byte != b'/' {
            return false;
        }
    }
    true
}

fn truncate_utf16(source: &str, limit: usize) -> String {
    let mut units = 0;
    let mut end = source.len();
    for (index, character) in source.char_indices() {
        let width = character.len_utf16();
        if units + width > limit {
            end = index;
            break;
        }
        units += width;
    }
    source[..end].to_string()
}
