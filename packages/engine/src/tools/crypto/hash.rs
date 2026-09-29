//! Rust implementations of the encoding and basic cryptography tools.
//!
//! Text output is returned as a text artifact, matching the existing engine's
//! `emitText` convention. Labels are kept language neutral because this layer
//! currently receives no localization catalog.

use crate::{Artifact, EngineError, RunContext, ToolResult};
use serde_json::{json, Value};
use sha2::{Digest, Sha256, Sha384, Sha512};

type RunResult = Result<Option<ToolResult>, EngineError>;

pub fn run(ctx: &RunContext<'_>) -> RunResult {
    let result = match ctx.tool {
        "hash" => hash_tool(ctx)?,
        "hmac" => hmac_tool(ctx)?,
        "file-checksum" => file_checksum(ctx)?,
        _ => return Ok(None),
    };
    Ok(Some(result))
}

pub(super) fn bad(field: &str, reason: &str) -> EngineError {
    EngineError::new("bad_request", format!("Invalid {field}: {reason}"))
}

pub(super) fn string<'a>(ctx: &'a RunContext<'_>, key: &str, default: &'a str) -> &'a str {
    ctx.options
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or(default)
}

pub(super) fn boolean(ctx: &RunContext<'_>, key: &str, default: bool) -> bool {
    ctx.options
        .get(key)
        .and_then(Value::as_bool)
        .unwrap_or(default)
}

pub(super) fn number(ctx: &RunContext<'_>, key: &str, default: u64) -> u64 {
    ctx.options
        .get(key)
        .and_then(Value::as_u64)
        .unwrap_or(default)
}

pub(super) fn required<'a>(ctx: &'a RunContext<'_>, key: &str) -> Result<&'a str, EngineError> {
    let value = string(ctx, key, "").trim();
    if value.is_empty() {
        Err(bad(key, "must not be empty"))
    } else {
        Ok(value)
    }
}

pub(super) fn artifact(
    name: &str,
    text: String,
    extra: serde_json::Map<String, Value>,
) -> ToolResult {
    let mut out = ToolResult::default();
    out.text = Some(text.clone());
    out.artifacts
        .push(Artifact::new(name, "text", text.into_bytes()));
    out.extra = extra;
    out
}

pub(super) fn hex(bytes: &[u8], upper: bool) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(s, "{:02x}", b);
    }
    if upper {
        s.to_ascii_uppercase()
    } else {
        s
    }
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
pub(super) fn b64_encode(input: &[u8], url: bool) -> String {
    let table = if url {
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    } else {
        B64
    };
    let mut out = String::new();
    for chunk in input.chunks(3) {
        let n = ((chunk[0] as u32) << 16)
            | ((chunk.get(1).copied().unwrap_or(0) as u32) << 8)
            | chunk.get(2).copied().unwrap_or(0) as u32;
        out.push(table[((n >> 18) & 63) as usize] as char);
        out.push(table[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            table[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            table[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

pub(super) fn b64_decode(raw: &str) -> Result<Vec<u8>, EngineError> {
    let compact: String = raw
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '\u{3000}')
        .filter(|c| *c != '=')
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            c => c,
        })
        .collect();
    if compact.is_empty() || compact.len() % 4 == 1 {
        return Err(bad("input", "invalid Base64 length"));
    }
    let mut out = Vec::new();
    let mut acc = 0u32;
    let mut bits = 0;
    for (i, c) in compact.chars().enumerate() {
        let v = B64
            .iter()
            .position(|x| *x as char == c)
            .ok_or_else(|| bad("input", &format!("invalid Base64 character at {}", i + 1)))?
            as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 255) as u8);
        }
    }
    if bits > 0 && acc & ((1 << bits) - 1) != 0 {
        return Err(bad("input", "invalid Base64 trailing bits"));
    }
    Ok(out)
}

pub(super) fn input_bytes(raw: &str, charset: &str) -> Vec<u8> {
    if charset == "latin1" {
        raw.encode_utf16().map(|u| u as u8).collect()
    } else {
        raw.as_bytes().to_vec()
    }
}

pub(super) fn decode_hex(raw: &str) -> Result<Vec<u8>, EngineError> {
    let compact: String = raw
        .replace("\\x", "")
        .replace("\\X", "")
        .replace("0x", "")
        .replace("0X", "")
        .chars()
        .filter(|c| !c.is_whitespace() && !",:._-".contains(*c))
        .collect();
    if compact.is_empty() || compact.len() % 2 != 0 {
        return Err(bad("input", "hex input must contain complete byte pairs"));
    }
    let mut out = Vec::new();
    for i in (0..compact.len()).step_by(2) {
        out.push(
            u8::from_str_radix(&compact[i..i + 2], 16)
                .map_err(|_| bad("input", "invalid hexadecimal character"))?,
        );
    }
    Ok(out)
}

pub(super) fn digest(name: &str, bytes: &[u8]) -> Result<Vec<u8>, EngineError> {
    use blake2::Blake2b512;
    use md5::Md5;
    use sha1::Sha1;
    let result = match name {
        "md5" => Md5::digest(bytes).to_vec(),
        "sha1" => Sha1::digest(bytes).to_vec(),
        "sha256" => Sha256::digest(bytes).to_vec(),
        "sha384" => Sha384::digest(bytes).to_vec(),
        "sha512" => Sha512::digest(bytes).to_vec(),
        "blake2b512" => Blake2b512::digest(bytes).to_vec(),
        _ => return Err(bad("algorithm", "unsupported digest algorithm")),
    };
    Ok(result)
}

fn hash_tool(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let raw = required(ctx, "input")?;
    let form = string(ctx, "inputAs", "text");
    let bytes = match form {
        "hex" => decode_hex(raw)?,
        "base64" => b64_decode(raw)?,
        _ => raw.as_bytes().to_vec(),
    };
    let requested = string(ctx, "algorithm", "all");
    let algos: &[&str] = if requested == "all" {
        &["md5", "sha1", "sha256", "sha384", "sha512", "blake2b512"]
    } else {
        &[requested]
    };
    let upper = boolean(ctx, "uppercase", false);
    let mut rows = Vec::new();
    for algo in algos {
        rows.push(format!("{algo}: {}", hex(&digest(algo, &bytes)?, upper)));
    }
    let first = rows
        .first()
        .and_then(|r| r.split_once(": ").map(|(_, v)| v))
        .unwrap_or("");
    let mut extra = serde_json::Map::new();
    extra.insert("algorithms".into(), json!(rows.len()));
    extra.insert("algorithm".into(), json!(algos.join(",")));
    extra.insert("inputBytes".into(), json!(bytes.len()));
    extra.insert("digest".into(), json!(first));
    let preview = raw.chars().take(72).collect::<String>();
    let text=format!("Digest results\n{}\n\nInput form: {form}\nInput bytes: {}\nInput preview: {}\nHex case: {}",rows.join("\n"),bytes.len(),if preview.is_empty(){"(blank)".into()}else{preview},if upper{"upper"}else{"lower"});
    Ok(artifact("hash.txt", text, extra))
}

fn hmac_tool(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    use hmac::{Hmac, Mac};
    let message = required(ctx, "message")?;
    let secret = string(ctx, "secret", "");
    if secret.is_empty() {
        return Err(bad("secret", "must not be empty"));
    }
    let algo = string(ctx, "algorithm", "sha256");
    let mac = match algo {
        "sha1" => Hmac::<sha1::Sha1>::new_from_slice(secret.as_bytes())
            .unwrap()
            .chain_update(message.as_bytes())
            .finalize()
            .into_bytes()
            .to_vec(),
        "sha256" => Hmac::<Sha256>::new_from_slice(secret.as_bytes())
            .unwrap()
            .chain_update(message.as_bytes())
            .finalize()
            .into_bytes()
            .to_vec(),
        "sha384" => Hmac::<Sha384>::new_from_slice(secret.as_bytes())
            .unwrap()
            .chain_update(message.as_bytes())
            .finalize()
            .into_bytes()
            .to_vec(),
        "sha512" => Hmac::<Sha512>::new_from_slice(secret.as_bytes())
            .unwrap()
            .chain_update(message.as_bytes())
            .finalize()
            .into_bytes()
            .to_vec(),
        "md5" => Hmac::<md5::Md5>::new_from_slice(secret.as_bytes())
            .unwrap()
            .chain_update(message.as_bytes())
            .finalize()
            .into_bytes()
            .to_vec(),
        _ => {
            return Err(bad(
                "algorithm",
                "choose sha256, sha1, sha384, sha512, or md5",
            ))
        }
    };
    let format = if string(ctx, "format", "hex") == "base64" {
        "base64"
    } else {
        "hex"
    };
    let upper = boolean(ctx, "uppercase", false);
    let primary = if format == "base64" {
        let encoded = b64_encode(&mac, false);
        if upper {
            encoded.to_ascii_uppercase()
        } else {
            encoded
        }
    } else {
        hex(&mac, upper)
    };
    let alternative = if format == "base64" {
        hex(&mac, upper)
    } else {
        b64_encode(&mac, false)
    };
    let text = format!(
        "{algo}: {primary}\nEquivalent: {alternative}\nMessage bytes: {}\nSecret: [masked]",
        message.len()
    );
    let mut extra = serde_json::Map::new();
    extra.insert("algorithm".into(), json!(algo));
    extra.insert("format".into(), json!(format));
    extra.insert("algorithms".into(), json!(1));
    extra.insert("signature".into(), json!(primary));
    Ok(artifact("hmac.txt", text, extra))
}

fn file_checksum(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    if ctx.inputs.is_empty() {
        return Err(
            EngineError::new("empty_selection", "Select at least one file")
                .with_hint("error.emptySelection"),
        );
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
        .split(|c: char| c == '\r' || c == '\n' || c == ',' || c == ';')
        .flat_map(str::split_whitespace)
    {
        let (tag, value) = token
            .find(|c| c == '=' || c == ':')
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
        let tag_valid = tag.as_deref().map_or(true, |t| {
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
    if expected.len() > 0 && ctx.inputs.len() > 1 {
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
                    tag.as_deref().map_or(true, |t| t == *algo)
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
