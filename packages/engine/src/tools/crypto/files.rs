use super::hash::{artifact, b64_decode, b64_encode, bad, digest, hex, string};
use super::{EngineError, RunContext, ToolResult};
use crate::Artifact;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::json;

pub(super) fn run(ctx: &RunContext<'_>) -> Result<Option<ToolResult>, EngineError> {
    if ctx.tool == "file-checksum" {
        return file_checksum(ctx).map(Some);
    }
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
            result
                .extra
                .insert("sourceBytes".into(), json!(input.bytes.len()));
            result
                .extra
                .insert("encodedCharacters".into(), json!(encoded.len()));
            Ok(Some(result))
        }
        "base64-file" => {
            let raw = ctx
                .options
                .get("input")
                .and_then(|v| v.as_str())
                .unwrap_or("SGVsbG8=");
            let name = safe_name(
                ctx.options
                    .get("filename")
                    .and_then(|v| v.as_str())
                    .unwrap_or("decoded.bin"),
            );
            let bytes = b64_decode(raw).map_err(|_| bad("input", "invalid Base64 data"))?;
            if bytes.len() > 8 * 1024 * 1024 {
                return Err(bad("input", "decoded file exceeds 8 MiB limit"));
            }
            let mut result = ToolResult::default();
            result
                .artifacts
                .push(Artifact::new(&name, "binary", bytes.clone()));
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
    if name.trim().is_empty() {
        "decoded.bin".into()
    } else {
        name
    }
}

pub(super) fn file_checksum(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    if ctx.inputs.is_empty() {
        // The product treats file-checksum as a file job, not a text tool; a
        // bare tool.run therefore reports unsupported (matches the engine).
        return Err(EngineError::new(
            "unsupported",
            if ctx.locale.starts_with("en") {
                "Tool \"file-checksum\" is not a plain-text tool; submit files through the job queue (job.submit) instead."
            } else {
                "工具「file-checksum」不是纯文本工具，请通过任务队列（job.submit）提交文件后运行。"
            },
        ));
    }
    let requested = string(ctx, "algorithm", "all");
    let algos: &[&str] = if requested == "all" {
        &["md5", "sha1", "sha256", "sha512"]
    } else {
        &[requested]
    };
    let format = if string(ctx, "format", "hex") == "base64" {
        "base64"
    } else {
        "hex"
    };
    let expected_raw = string(ctx, "expected", "").trim();
    let mut expected = Vec::<(Option<String>, String)>::new();
    for token in expected_raw
        .split(['\r', '\n', ',', ';'])
        .flat_map(str::split_whitespace)
    {
        let (tag, value) = token
            .find(['=', ':'])
            .map(|i| (Some(token[..i].to_ascii_lowercase()), token[i + 1..].trim()))
            .unwrap_or((None, token));
        let hex_like = value.len() >= 16 && value.bytes().all(|b| b.is_ascii_hexdigit());
        let base64_body = value.trim_end_matches('=');
        let padding = value.len() - base64_body.len();
        let b64_like = value.len() >= 8
            && padding <= 2
            && base64_body
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/');
        let tag_valid = tag.as_deref().is_none_or(|t| {
            ["md5", "sha1", "sha256", "sha384", "sha512", "blake2b512"].contains(&t)
        });
        if tag_valid && (hex_like || b64_like) {
            expected.push((tag, value.to_string()))
        }
    }
    let mut warnings = Vec::new();
    if !expected_raw.is_empty() && expected.is_empty() {
        warnings.push("No recognizable expected checksum was supplied".to_string())
    }
    if !expected.is_empty() && ctx.inputs.len() > 1 {
        warnings.push(format!(
            "{} expected checksum(s) supplied for multiple files",
            expected.len()
        ))
    }
    let mut lines = vec![
        format!("Files: {}", ctx.inputs.len()),
        format!(
            "Total bytes: {}",
            ctx.inputs.iter().map(|x| x.bytes.len()).sum::<usize>()
        ),
        format!("Expected digest entries: {}", expected.len()),
    ];
    let mut mismatches = 0usize;
    let mut matched = 0usize;
    for input in ctx.inputs {
        lines.push(format!("{} ({} bytes)", input.name, input.bytes.len()));
        for algo in algos {
            let sum = digest(algo, &input.bytes)?;
            let h = hex(&sum, false);
            let b = b64_encode(&sum, false);
            lines.push(format!(
                "  {algo}: {}",
                if format == "base64" { &b } else { &h }
            ));
            if !expected.is_empty() {
                let hit = expected.iter().any(|(tag, value)| {
                    tag.as_deref().is_none_or(|t| t == *algo)
                        && (value.eq_ignore_ascii_case(&h) || *value == b)
                });
                if hit {
                    matched += 1
                } else {
                    mismatches += 1
                }
                lines.push(format!(
                    "  expected: {}",
                    if hit { "matched" } else { "unmatched" }
                ));
            }
        }
    }
    let mut extra = serde_json::Map::new();
    extra.insert("files".into(), json!(ctx.inputs.len()));
    extra.insert("algorithms".into(), json!(algos.len()));
    extra.insert("algorithm".into(), json!(algos.join(",")));
    extra.insert("format".into(), json!(format));
    extra.insert(
        "checkedBytes".into(),
        json!(ctx.inputs.iter().map(|x| x.bytes.len()).sum::<usize>()),
    );
    extra.insert("matched".into(), json!(matched));
    extra.insert("mismatched".into(), json!(mismatches));
    if mismatches > 0 {
        warnings.push(format!(
            "{mismatches} expected checksum comparison(s) did not match"
        ))
    }
    let mut result = artifact("checksums.txt", lines.join("\n"), extra);
    result.warnings = warnings;
    Ok(result)
}
