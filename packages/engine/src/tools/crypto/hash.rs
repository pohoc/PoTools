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
    use super::enc::{self, fill, Tmpl};
    use crate::tools::text::fmt::{align_rows, join_blocks, row, section};
    let en = enc::is_en(ctx);
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
        rows.push(row(*algo, hex(&digest(algo, &bytes)?, upper)));
    }
    let first = rows.first().map(|(_, v)| v.clone()).unwrap_or_default();
    let mut extra = serde_json::Map::new();
    extra.insert("algorithms".into(), json!(rows.len()));
    extra.insert("algorithm".into(), json!(algos.join(",")));
    extra.insert("inputBytes".into(), json!(bytes.len()));
    extra.insert("digest".into(), json!(first));
    let detail = if requested == "all" {
        if en {
            format!("{} algorithms", algos.len())
        } else {
            format!("{} 种算法", algos.len())
        }
    } else {
        requested.to_string()
    };
    let form_label = match form {
        "hex" => enc::t(en, "十六进制串（先解码为字节）", "Hex string (decoded to bytes first)"),
        "base64" => enc::t(en, "Base64 串（先解码为字节）", "Base64 string (decoded to bytes first)"),
        _ => enc::t(en, "普通文本（UTF-8 取字节）", "Plain text (UTF-8 bytes)"),
    };
    let mut blocks = vec![
        section(enc::t(en, "摘要结果", "Digests")),
        align_rows(&rows),
        section(&format!(
            "{}{detail}",
            enc::t(en, "哈希摘要 · ", "Digest - ")
        )),
        align_rows(&[
            row(enc::t(en, "输入形式", "Input form"), form_label),
            row(
                enc::t(en, "输入字节", "Input bytes"),
                fill(en, Tmpl::Bytes, bytes.len()),
            ),
            row(enc::t(en, "输入预览", "Input preview"), enc::preview(en, raw, 72)),
            row(
                enc::t(en, "输出大小写", "Output case"),
                enc::t(en, if upper { "大写" } else { "小写" }, if upper { "uppercase" } else { "lowercase" }),
            ),
        ]),
    ];
    let mut notes = vec![
        enc::t(
            en,
            "· 输入按去除首尾空白后的内容计算；需要保留空格/换行时请改用文件校验类工具。",
            "- The input is trimmed of leading and trailing whitespace; use the file checksum tool to keep spaces and line breaks.",
        )
        .to_string(),
    ];
    if form != "text" {
        notes.push(
            if en {
                format!("- inputAs={form}: the input is decoded to {} bytes first, and those bytes are what gets digested.", bytes.len())
            } else {
                format!("· inputAs={form}：先把输入解码为 {} 字节，再对这些字节求摘要。", bytes.len())
            },
        );
    }
    let raw_bytes = raw.len();
    if bytes.len() != raw_bytes {
        notes.push(
            if en {
                format!("- The raw text is {raw_bytes} bytes; the decoded {} bytes are what took part in the calculation.", bytes.len())
            } else {
                format!("· 原始文本为 {raw_bytes} 字节，实际参与计算的是解码后的 {} 字节。", bytes.len())
            },
        );
    }
    blocks.push(section(enc::t(en, "说明", "Notes")));
    blocks.push(notes.join("\n"));
    // emitText convention: one trailing newline in both text and artifact.
    let body = format!("{}\n", join_blocks(blocks.iter().map(String::as_str)).trim_end());
    Ok(artifact("hash.txt", body, extra))
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
    let alt_label = if format == "hex" { "base64" } else { "hex" };
    let mut extra = serde_json::Map::new();
    extra.insert("algorithm".into(), json!(algo));
    extra.insert("format".into(), json!(format));
    extra.insert("algorithms".into(), json!(1));
    extra.insert("signature".into(), json!(primary));
    let text = hmac_report(ctx, algo, &primary, &alternative, alt_label, format, secret, message);
    Ok(artifact("hmac.txt", text, extra))
}

fn hmac_report(
    ctx: &RunContext<'_>,
    algo: &str,
    primary: &str,
    alternative: &str,
    alt_label: &str,
    format: &str,
    secret: &str,
    message: &str,
) -> String {
    use super::enc::{self, fill, Tmpl};
    use crate::tools::text::fmt::{align_rows, join_blocks, row, section};
    let en = enc::is_en(ctx);
    let blocks = vec![
        section(enc::t(en, "签名结果", "Signatures")),
        align_rows(&[row(algo, primary)]),
        section(&format!(
            "{}{alt_label}",
            enc::t(en, "等价表示 · ", "Equivalent form - ")
        )),
        align_rows(&[row(algo, alternative)]),
        section(&format!(
            "{}{algo} · {format}",
            enc::t(en, "HMAC 签名 · ", "HMAC signature - ")
        )),
        align_rows(&[
            row(
                enc::t(en, "密钥", "Key"),
                if en {
                    format!("•••• ({} characters)", secret.chars().count())
                } else {
                    format!("••••（{} 字符）", secret.chars().count())
                },
            ),
            row(
                enc::t(en, "密钥字节", "Key bytes"),
                fill(en, Tmpl::Bytes, secret.len()),
            ),
            row(enc::t(en, "消息", "Message"), enc::preview(en, message, 72)),
            row(
                enc::t(en, "消息字节", "Message bytes"),
                fill(en, Tmpl::Bytes, message.len()),
            ),
            row(
                enc::t(en, "输出大小写", "Output case"),
                enc::t(
                    en,
                    if boolean(ctx, "uppercase", false) && format == "hex" {
                        "大写"
                    } else {
                        "原样"
                    },
                    if boolean(ctx, "uppercase", false) && format == "hex" {
                        "uppercase"
                    } else {
                        "as is"
                    },
                ),
            ),
        ]),
        section(enc::t(en, "说明", "Notes")),
        [
            enc::t(
                en,
                "· 密钥与消息都按 UTF-8 取字节，HMAC 结构为 H(key⊕opad ‖ H(key⊕ipad ‖ message))。",
                "- Key and message are taken as UTF-8 bytes; HMAC is H(key opad || H(key ipad || message)).",
            ),
            enc::t(en, "· 签名密钥不会写入结果内容。", "- The signing key is omitted from the result."),
        ]
        .join("\n"),
    ];
    // emitText convention: one trailing newline.
    format!("{}\n", join_blocks(blocks.iter().map(String::as_str)).trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::RunContext;

    fn ctx<'a>(tool: &'a str, options: &'a serde_json::Value) -> RunContext<'a> {
        RunContext {
            tool,
            options,
            locale: "zh-CN",
            inputs: &[],
            name_pattern: None,
            runtime_data: None,
        }
    }

    #[test]
    fn hash_report_matches_product_framing() {
        let options = serde_json::json!({"input":"abc","algorithm":"all"});
        let result = run(&ctx("hash", &options)).unwrap().unwrap();
        let text = result.text.unwrap();
        assert!(text.starts_with("── 摘要结果 ─"));
        assert!(text.contains("  md5         900150983cd24fb0d6963f7d28e17f72"));
        assert!(text.contains("── 哈希摘要 · 6 种算法 ─"));
        assert!(text.contains("  输入字节    3 字节"));
        assert!(text.ends_with("改用文件校验类工具。\n"));
    }

    #[test]
    fn hmac_report_matches_product_framing() {
        let options = serde_json::json!({"message":"hello","secret":"key","algorithm":"sha256"});
        let result = run(&ctx("hmac", &options)).unwrap().unwrap();
        let text = result.text.unwrap();
        assert!(text.starts_with("── 签名结果 ─"));
        assert!(text.contains("  sha256  9307b3b915efb5171ff14d8cb55fbcc798c6c0ef1456d66ded1a6aa723a58b7b"));
        assert!(text.contains("── 等价表示 · base64 ─"));
        assert!(text.contains("  密钥        ••••（3 字符）"));
    }
}
