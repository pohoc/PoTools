use super::hash::{
    artifact, b64_decode, b64_encode, bad, boolean, decode_hex, hex, input_bytes, number, required,
    string,
};
use super::unicode::{unicode_decode, unicode_encode, unknown_html_entities};
use super::url::{build_query, parse_pairs, parse_url, percent_decode, percent_encode, split_url};
use super::{EngineError, RunContext, ToolResult};
use serde_json::json;

type RunResult = Result<Option<ToolResult>, EngineError>;

pub fn run(ctx: &RunContext<'_>) -> RunResult {
    if matches!(
        ctx.tool,
        "base64" | "radix" | "hex" | "url-codec" | "unicode-escape"
    ) {
        return run_encoding(ctx).map(Some);
    }
    Ok(None)
}
fn radix_encode(bytes: &[u8], alphabet: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    let zeros = bytes.iter().take_while(|b| **b == 0).count();
    let mut digits = vec![0u8];
    for byte in &bytes[zeros..] {
        let mut carry = *byte as u32;
        for digit in digits.iter_mut() {
            carry += (*digit as u32) << 8;
            *digit = (carry % alphabet.len() as u32) as u8;
            carry /= alphabet.len() as u32;
        }
        while carry > 0 {
            digits.push((carry % alphabet.len() as u32) as u8);
            carry /= alphabet.len() as u32;
        }
    }
    let mut out = String::from_utf8(vec![alphabet[0]; zeros]).unwrap();
    if bytes.len() > zeros {
        for d in digits.iter().rev() {
            out.push(alphabet[*d as usize] as char);
        }
    }
    out
}

fn base32_encode(bytes: &[u8], alphabet: &[u8], padded: bool) -> String {
    let mut out = String::new();
    let mut acc = 0u32;
    let mut bits = 0;
    for byte in bytes {
        acc = (acc << 8) | *byte as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(alphabet[((acc >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(alphabet[((acc << (5 - bits)) & 31) as usize] as char);
    }
    if padded {
        while out.len() % 8 != 0 {
            out.push('=');
        }
    }
    out
}
fn base32_decode(raw: &str, alphabet: &[u8], crockford: bool) -> Result<Vec<u8>, EngineError> {
    let compact: Vec<u8> = raw
        .bytes()
        .filter(|b| !b.is_ascii_whitespace() && *b != b'-' && *b != b'=')
        .collect();
    if compact.is_empty() {
        return Err(bad("input", "empty base32 input"));
    }
    let mut out = Vec::new();
    let mut acc = 0u32;
    let mut bits = 0;
    for (i, raw) in compact.iter().enumerate() {
        let mut c = raw.to_ascii_uppercase();
        if crockford {
            c = match c {
                b'I' | b'L' => b'1',
                b'O' => b'0',
                b'U' => return Err(bad("input", "U is not valid in Crockford base32")),
                c => c,
            };
        }
        let value = alphabet
            .iter()
            .position(|a| a.to_ascii_uppercase() == c)
            .ok_or_else(|| bad("input", &format!("invalid base32 character at {}", i + 1)))?
            as u32;
        acc = (acc << 5) | value;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 255) as u8)
        }
    }
    if bits >= 5 || (bits > 0 && acc & ((1 << bits) - 1) != 0) {
        return Err(bad("input", "invalid truncated base32 bits"));
    }
    Ok(out)
}

fn radix_decode(raw: &str, alphabet: &[u8], fold: bool) -> Result<Vec<u8>, EngineError> {
    let chars: Vec<u8> = raw.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if chars.is_empty() {
        return Err(bad("input", "empty radix input"));
    }
    let mut zeros = 0;
    while zeros < chars.len() && chars[zeros] == alphabet[0] {
        zeros += 1;
    }
    let mut bytes: Vec<u8> = Vec::new();
    for c in chars.iter().skip(zeros) {
        let c = if fold { c.to_ascii_uppercase() } else { *c };
        let val = alphabet
            .iter()
            .position(|a| {
                if fold {
                    a.to_ascii_uppercase() == c
                } else {
                    *a == c
                }
            })
            .ok_or_else(|| bad("input", "invalid character for radix alphabet"))?
            as u32;
        let mut carry = val;
        for b in bytes.iter_mut() {
            carry += (*b as u32) * alphabet.len() as u32;
            *b = (carry & 255) as u8;
            carry >>= 8;
        }
        while carry > 0 {
            bytes.push((carry & 255) as u8);
            carry >>= 8;
        }
    }
    bytes.reverse();
    while bytes.first() == Some(&0) {
        bytes.remove(0);
    }
    let mut out = vec![0; zeros];
    out.extend(bytes);
    Ok(out)
}

fn run_encoding(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let raw = required(ctx, "input")?;
    let mode = match (ctx.tool, string(ctx, "mode", "encode")) {
        ("url-codec", mode @ ("encode" | "decode" | "parse" | "build")) => mode,
        (_, "decode") => "decode",
        _ => "encode",
    };
    let mut extra = serde_json::Map::new();
    let (name, text) = match ctx.tool {
        "base64" => {
            let url = string(ctx, "variant", "standard") == "urlsafe";
            let charset = string(ctx, "charset", "utf8");
            let data_uri = boolean(ctx, "dataUri", false);
            let output = if mode == "encode" {
                let b = input_bytes(raw, charset);
                let mut s = b64_encode(&b, url);
                let wrap = number(ctx, "lineWrap", 0) as usize;
                if wrap > 0 {
                    s = s
                        .as_bytes()
                        .chunks(wrap)
                        .map(|x| std::str::from_utf8(x).unwrap_or(""))
                        .collect::<Vec<_>>()
                        .join("\n");
                }
                if data_uri {
                    format!(
                        "{s}\n\ndata:{};base64,{}",
                        string(ctx, "mime", "text/plain"),
                        b64_encode(&b, url)
                    )
                } else {
                    s
                }
            } else {
                let body = raw
                    .strip_prefix("data:")
                    .and_then(|x| x.split_once(",").map(|(_, b)| b))
                    .unwrap_or(raw);
                let b = b64_decode(body)?;
                String::from_utf8_lossy(&b).to_string()
            };
            extra.insert("mode".into(), json!(mode));
            extra.insert(
                "variant".into(),
                json!(if url { "urlsafe" } else { "standard" }),
            );
            ("base64.txt", output)
        }
        "hex" => {
            let charset = string(ctx, "charset", "utf8");
            let upper = boolean(ctx, "uppercase", false);
            let sep = string(ctx, "separator", "none");
            let out = if mode == "encode" {
                let h = hex(&input_bytes(raw, charset), upper);
                match sep {
                    "space" => h
                        .as_bytes()
                        .chunks(2)
                        .map(|x| std::str::from_utf8(x).unwrap())
                        .collect::<Vec<_>>()
                        .join(" "),
                    "backslash-x" => h
                        .as_bytes()
                        .chunks(2)
                        .map(|x| format!("\\x{}", std::str::from_utf8(x).unwrap()))
                        .collect(),
                    "prefix-0x" => h
                        .as_bytes()
                        .chunks(2)
                        .map(|x| format!("0x{}", std::str::from_utf8(x).unwrap()))
                        .collect::<Vec<_>>()
                        .join(" "),
                    _ => h,
                }
            } else {
                let b = decode_hex(raw)?;
                if charset == "latin1" {
                    b.iter().map(|c| *c as char).collect()
                } else {
                    String::from_utf8_lossy(&b).into_owned()
                }
            };
            extra.insert("mode".into(), json!(mode));
            ("hex.txt", out)
        }
        "radix" => {
            let name = match string(ctx, "alphabet", "base32") {
                "base32" => "base32",
                "base32-crockford" => "base32-crockford",
                "base58-btc" => "base58-btc",
                "base58-ripple" => "base58-ripple",
                "base36" => "base36",
                "base16" => "base16",
                _ => "base32",
            };
            let alphabet: &[u8] = match name {
                "base32" => b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
                "base32-crockford" => b"0123456789ABCDEFGHJKMNPQRSTVWXYZ",
                "base58-btc" => b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz",
                "base58-ripple" => b"rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz",
                "base36" => b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
                _ => b"0123456789ABCDEF",
            };
            let out = if mode == "encode" {
                if name == "base32" {
                    base32_encode(raw.as_bytes(), alphabet, true)
                } else if name == "base32-crockford" {
                    base32_encode(raw.as_bytes(), alphabet, false)
                } else {
                    radix_encode(raw.as_bytes(), alphabet)
                }
            } else {
                let b = if name == "base32" || name == "base32-crockford" {
                    base32_decode(raw, alphabet, name == "base32-crockford")?
                } else {
                    radix_decode(raw, alphabet, name == "base36" || name == "base16")?
                };
                String::from_utf8_lossy(&b).into_owned()
            };
            extra.insert("mode".into(), json!(mode));
            extra.insert("alphabet".into(), json!(name));
            ("radix.txt", out)
        }
        "url-codec" => {
            let component = boolean(ctx, "component", true);
            let form = boolean(ctx, "form", false);
            let out = match mode {
                "encode" => percent_encode(raw, component, form),
                "decode" => percent_decode(raw, component, form)?,
                "parse" => parse_url(raw)?,
                "build" => build_query(raw, component)?,
                _ => return Err(bad("mode", "unsupported URL codec mode")),
            };
            extra.insert("mode".into(), json!(mode));
            ("url-codec.txt", out)
        }
        "unicode-escape" => {
            let style = string(ctx, "style", "unicode");
            let out = if mode == "encode" {
                unicode_encode(raw, style)
            } else {
                unicode_decode(raw, style)?
            };
            extra.insert("mode".into(), json!(mode));
            extra.insert("style".into(), json!(style));
            ("unicode-escape.txt", out)
        }
        _ => unreachable!(),
    };
    match ctx.tool {
        "base64" => {
            if mode == "encode" {
                let bytes = input_bytes(raw, string(ctx, "charset", "utf8"));
                extra.insert("inputBytes".into(), json!(bytes.len()));
                extra.insert("outputChars".into(), json!(text.chars().count()));
                extra.insert(
                    "mime".into(),
                    json!(if boolean(ctx, "dataUri", false) {
                        string(ctx, "mime", "text/plain")
                    } else {
                        "-"
                    }),
                );
            } else {
                let body = raw
                    .strip_prefix("data:")
                    .and_then(|x| x.split_once(',').map(|(_, v)| v))
                    .unwrap_or(raw);
                let bytes = b64_decode(body)?;
                let decoded = String::from_utf8_lossy(&bytes);
                let stable = b64_encode(&bytes, string(ctx, "variant", "standard") == "urlsafe")
                    .trim_end_matches('=')
                    == body
                        .split_whitespace()
                        .collect::<String>()
                        .trim_end_matches('=');
                extra.insert("decodedBytes".into(), json!(bytes.len()));
                extra.insert("decodedChars".into(), json!(decoded.chars().count()));
                extra.insert(
                    "roundTrip".into(),
                    json!(if stable { "ok" } else { "differs" }),
                );
            }
        }
        "hex" => {
            if mode == "encode" {
                extra.insert(
                    "inputBytes".into(),
                    json!(input_bytes(raw, string(ctx, "charset", "utf8")).len()),
                );
                extra.insert("outputChars".into(), json!(text.chars().count()));
            } else {
                let bytes = decode_hex(raw)?;
                extra.insert("decodedBytes".into(), json!(bytes.len()));
                extra.insert("decodedChars".into(), json!(text.chars().count()));
            }
        }
        "radix" => {
            if mode == "encode" {
                extra.insert("inputBytes".into(), json!(raw.len()));
                extra.insert("outputChars".into(), json!(text.len()));
            } else {
                extra.insert("decodedBytes".into(), json!(text.len()));
                extra.insert("stable".into(), json!("yes"));
            }
        }
        "url-codec" => {
            let component = boolean(ctx, "component", true);
            extra.insert(
                "component".into(),
                json!(if component { "component" } else { "url" }),
            );
            if mode == "encode" || mode == "decode" {
                extra.insert("inputChars".into(), json!(raw.chars().count()));
                extra.insert("outputChars".into(), json!(text.chars().count()));
            } else if mode == "parse" {
                let (_, query, _, _, had_query) = split_url(raw);
                let q = if query.is_empty()
                    && !had_query
                    && raw.contains('=')
                    && !raw.contains("://")
                {
                    raw
                } else {
                    query
                };
                let pairs = parse_pairs(q)?;
                let mut counts = std::collections::HashMap::<String, usize>::new();
                for p in pairs.iter() {
                    *counts.entry(p.key.clone()).or_default() += 1
                }
                extra.insert("params".into(), json!(pairs.len()));
                extra.insert(
                    "repeated".into(),
                    json!(counts.values().filter(|n| **n > 1).count()),
                );
            } else {
                let count = raw.lines().filter(|l| !l.trim().is_empty()).count();
                extra.insert("params".into(), json!(count));
                extra.insert("queryLength".into(), json!(text.len()));
            }
        }
        "unicode-escape" => {
            extra.insert("inputChars".into(), json!(raw.chars().count()));
            extra.insert("outputChars".into(), json!(text.chars().count()));
            if mode == "encode" {
                extra.insert(
                    "nonAscii".into(),
                    json!(raw.chars().filter(|c| *c as u32 > 0x7e).count()),
                );
            } else {
                extra.insert("unknownEntities".into(), json!(0));
            }
        }
        _ => {}
    }
    let mut result = artifact(name, text, extra);
    if ctx.tool == "unicode-escape"
        && mode == "decode"
        && string(ctx, "style", "unicode").starts_with("html-")
    {
        let count = unknown_html_entities(raw);
        if count > 0 {
            result.warnings.push(format!(
                "{count} unknown named HTML entity/entities were left unchanged"
            ))
        }
    }
    Ok(result)
}
