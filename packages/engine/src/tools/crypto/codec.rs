use super::hash::bad;
use super::{EngineError, RunContext, ToolResult};

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
pub(super) fn radix_encode(bytes: &[u8], alphabet: &[u8]) -> String {
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

pub(super) fn base32_encode(bytes: &[u8], alphabet: &[u8], padded: bool) -> String {
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
        while !out.len().is_multiple_of(8) {
            out.push('=');
        }
    }
    out
}
pub(super) fn base32_decode(
    raw: &str,
    alphabet: &[u8],
    crockford: bool,
) -> Result<Vec<u8>, EngineError> {
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

pub(super) fn radix_decode(raw: &str, alphabet: &[u8], fold: bool) -> Result<Vec<u8>, EngineError> {
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
    // Framing moved to `codec_report` (and `codec_report_text`); this module
    // keeps the byte transforms (base32/radix etc.) and shared primitives.
    super::codec_report::run_encoding(ctx)
}
