//! RFC 6238 TOTP generator and verifier.
use super::hash::{artifact, bad};
use crate::{EngineError, RunContext, ToolResult};
use chrono::{DateTime, Local, TimeZone, Utc};
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha1::Sha1;
use sha2::{Sha256, Sha384, Sha512};

type RunResult = Result<Option<ToolResult>, EngineError>;
const B32: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

fn option_string(ctx: &RunContext<'_>, key: &str) -> String {
    match ctx.options.get(key) {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(v)) => v.trim().to_string(),
        Some(Value::Bool(v)) => v.to_string(),
        Some(Value::Number(v)) => v.to_string(),
        Some(v) => v.to_string(),
    }
}
fn num(ctx: &RunContext<'_>, key: &str, default: f64) -> f64 {
    match ctx.options.get(key) {
        Some(Value::Number(v)) => v.as_f64().unwrap_or(default),
        Some(Value::String(v)) => {
            let s = v.trim();
            if s.is_empty() {
                0.0
            } else {
                s.parse().unwrap_or(default)
            }
        }
        Some(Value::Bool(v)) => {
            if *v {
                1.0
            } else {
                0.0
            }
        }
        _ => default,
    }
}
fn clamp(v: f64, lo: f64, hi: f64) -> u32 {
    v.round().clamp(lo, hi) as u32
}
fn en(ctx: &RunContext<'_>) -> bool {
    ctx.locale.starts_with("en")
}
fn invalid(field: &str, why: &str, example: &str, ctx: &RunContext<'_>) -> EngineError {
    let message = if en(ctx) {
        format!("Invalid {field}: {why}. Example: {example}")
    } else {
        format!("字段 {field} 无效：{why}。示例：{example}")
    };
    EngineError::new("bad_request", message)
}
fn decode32(raw: &str, ctx: &RunContext<'_>) -> Result<Vec<u8>, EngineError> {
    let cleaned: String = raw
        .to_ascii_uppercase()
        .chars()
        .filter(|c| !c.is_whitespace() && !matches!(c, '-' | '_' | '='))
        .collect();
    if cleaned.is_empty() {
        return Err(invalid(
            "secret",
            if en(ctx) {
                "must not be empty"
            } else {
                "密钥不能为空"
            },
            "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
            ctx,
        ));
    }
    let mut out = Vec::new();
    let mut acc = 0u32;
    let mut bits = 0usize;
    for c in cleaned.chars() {
        let v = B32.iter().position(|x| *x as char == c).ok_or_else(|| {
            invalid(
                "secret",
                if en(ctx) {
                    "contains invalid Base32 characters"
                } else {
                    "包含无效 Base32 字符"
                },
                "GEZDGNBVGY3TQOJQ…",
                ctx,
            )
        })? as u32;
        acc = (acc << 5) | v;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 255) as u8);
        }
    }
    if bits >= 5 || out.is_empty() {
        return Err(invalid(
            "secret",
            if en(ctx) {
                "has invalid Base32 length"
            } else {
                "Base32 长度无效"
            },
            "GEZDGNBVGY3TQOJQ…",
            ctx,
        ));
    }
    Ok(out)
}
fn encode32(bytes: &[u8]) -> String {
    let (mut acc, mut bits, mut out) = (0u32, 0usize, String::new());
    for b in bytes {
        acc = (acc << 8) | *b as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(B32[((acc >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(B32[((acc << (5 - bits)) & 31) as usize] as char);
    }
    out
}
fn percent_decode(s: &str) -> String {
    let mut out = Vec::new();
    let b = s.replace('+', " ").into_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) =
                u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or(""), 16)
            {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
fn parse_uri(s: &str) -> Option<(String, String, std::collections::BTreeMap<String, String>)> {
    let t = s.trim();
    if !t.to_ascii_lowercase().starts_with("otpauth://") {
        return None;
    }
    let body = &t[10..];
    let (head, q) = body.split_once('?').unwrap_or((body, ""));
    let (typ, label) = head.split_once('/').unwrap_or(("totp", ""));
    let mut params = std::collections::BTreeMap::new();
    for p in q.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = p.split_once('=').unwrap_or((p, ""));
        params.insert(k.trim().to_ascii_lowercase(), percent_decode(v.trim()));
    }
    Some((typ.to_ascii_lowercase(), percent_decode(label), params))
}
fn hotp(
    secret: &[u8],
    counter: i64,
    algorithm: &str,
    digits: u32,
) -> Result<(String, u32), EngineError> {
    let mut msg = (counter as u64).to_be_bytes().to_vec();
    let digest = match algorithm {
        "sha1" => Hmac::<Sha1>::new_from_slice(secret)
            .map_err(|_| bad("secret", "invalid key"))?
            .chain_update(&msg)
            .finalize()
            .into_bytes()
            .to_vec(),
        "sha256" => Hmac::<Sha256>::new_from_slice(secret)
            .map_err(|_| bad("secret", "invalid key"))?
            .chain_update(&msg)
            .finalize()
            .into_bytes()
            .to_vec(),
        "sha384" => Hmac::<Sha384>::new_from_slice(secret)
            .map_err(|_| bad("secret", "invalid key"))?
            .chain_update(&msg)
            .finalize()
            .into_bytes()
            .to_vec(),
        _ => Hmac::<Sha512>::new_from_slice(secret)
            .map_err(|_| bad("secret", "invalid key"))?
            .chain_update(&msg)
            .finalize()
            .into_bytes()
            .to_vec(),
    };
    msg.clear();
    let offset = (digest[digest.len() - 1] & 15) as usize;
    let binary = (((digest[offset] & 127) as u32) << 24)
        | ((digest[offset + 1] as u32) << 16)
        | ((digest[offset + 2] as u32) << 8)
        | digest[offset + 3] as u32;
    Ok((
        format!(
            "{:0width$}",
            binary % 10u32.pow(digits),
            width = digits as usize
        ),
        binary,
    ))
}
fn at_ms(raw: &str, ctx: &RunContext<'_>) -> Result<(i64, String), EngineError> {
    let s = raw.trim();
    if s.is_empty() || s.eq_ignore_ascii_case("now") {
        return Ok((
            Utc::now().timestamp_millis(),
            if en(ctx) {
                "now (this very moment)"
            } else {
                "now（当前时刻）"
            }
            .into(),
        ));
    }
    if let Ok(n) = s.parse::<f64>() {
        if !n.is_finite() {
            return Err(invalid(
                "at",
                "invalid timestamp",
                "now / 59 / 2026-01-01T00:00:00Z",
                ctx,
            ));
        }
        let ms = if n.abs() >= 1e11 { n } else { n * 1000. };
        let raw = s.to_string();
        return Ok((
            ms as i64,
            if en(ctx) {
                if n.abs() >= 1e11 {
                    format!("{raw} (read as a millisecond timestamp)")
                } else {
                    format!("{raw} (read as a second timestamp)")
                }
            } else if n.abs() >= 1e11 {
                format!("{raw}（按毫秒时间戳解释）")
            } else {
                format!("{raw}（按秒时间戳解释）")
            },
        ));
    }
    let parsed = DateTime::parse_from_rfc3339(s)
        .map(|d| d.timestamp_millis())
        .or_else(|_| DateTime::parse_from_rfc2822(s).map(|d| d.timestamp_millis()))
        .or_else(|_| NaiveDateFallback::parse(s))
        .map_err(|e| {
            invalid(
                "at",
                &format!("invalid date/time: {e}"),
                "now / 59 / 1234567890 / 2026-01-01T00:00:00Z",
                ctx,
            )
        })?;
    Ok((
        parsed,
        if en(ctx) {
            format!("{s} (parsed as a flex time expression)")
        } else {
            format!("{s}（按 flex 时间表达式解析）")
        },
    ))
}
struct NaiveDateFallback;
impl NaiveDateFallback {
    fn parse(s: &str) -> Result<i64, chrono::ParseError> {
        use chrono::NaiveDateTime;
        let n = NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S")
            .or_else(|_| NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S"))
            .or_else(|_| NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M"))?;
        Ok(Local
            .from_local_datetime(&n)
            .single()
            .unwrap_or_else(|| Local.from_utc_datetime(&n))
            .timestamp_millis())
    }
}
#[path = "totp-report.rs"]
mod report;
use report::report;

#[rustfmt::skip]
pub fn run(ctx: &RunContext<'_>) -> RunResult {
    if ctx.tool != "totp" {
        return Ok(None);
    }
    let raw_secret = option_string(ctx, "secret");
    if raw_secret.is_empty() {
        return Err(invalid(
            "secret",
            if en(ctx) {
                "base32 secret or otpauth URI is required"
            } else {
                "请输入 Base32 密钥或 otpauth URI"
            },
            "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
            ctx,
        ));
    }
    let mode = if option_string(ctx, "mode") == "verify" {
        "verify"
    } else {
        "generate"
    };
    let (mut digits, mut period, mut algo) = (
        clamp(num(ctx, "digits", 6.), 6., 10.),
        clamp(num(ctx, "period", 30.), 1., 3600.),
        option_string(ctx, "algorithm"),
    );
    if !["sha1", "sha256", "sha384", "sha512"].contains(&algo.as_str()) {
        algo = "sha1".to_string();
    }
    let mut secret_text = raw_secret.to_string();
    let mut overrides = Vec::new();
    let uri = parse_uri(&raw_secret);
    if let Some((typ, label, params)) = &uri {
        secret_text = params.get("secret").cloned().unwrap_or_default();
        if secret_text.is_empty() {
            return Err(invalid(
                "secret",
                if en(ctx) {
                    "otpauth URI has no secret parameter"
                } else {
                    "otpauth URI 缺少 secret 参数"
                },
                "otpauth://totp/Alice?secret=GEZDGNBVGY3TQOJQ",
                ctx,
            ));
        }
        for (key, max, current) in [("digits", 10, &mut digits), ("period", 3600, &mut period)] {
            if let Some(v) = params
                .get(key)
                .and_then(|x| x.parse::<u32>().ok())
                .filter(|x| *x > 0)
            {
                *current = v.clamp(if key == "digits" { 6 } else { 1 }, max);
                overrides.push(format!("{key}={current}"));
            }
        }
        let a = params
            .get("algorithm")
            .or_else(|| params.get("algo"))
            .map(|v| v.to_ascii_lowercase().replace('-', ""));
        if let Some(a) = a.filter(|v| ["sha1", "sha256", "sha384", "sha512"].contains(&v.as_str()))
        {
            algo = a;
            overrides.push(format!("algorithm={algo}"));
        }
        if let Some(issuer) = params.get("issuer") {
            overrides.push(format!("issuer={issuer}"));
        }
        if !label.is_empty() {
            overrides.push(format!("label={label}"));
        }
        if typ != "totp" {
            overrides.push(format!("type={typ} (treated as TOTP)"));
        }
    }
    let secret = decode32(&secret_text, ctx)?;
    let (at, label) = at_ms(
        &if option_string(ctx, "at").is_empty() { "now".to_string() } else { option_string(ctx, "at") },
        ctx,
    )?;
    let window = clamp(num(ctx, "window", 1.), 0., 100.);
    report(
        ctx,
        uri.is_some(),
        &overrides,
        mode,
        &secret,
        &algo,
        digits,
        period,
        window,
        at,
        &label,
        &option_string(ctx, "code"),
    )
    .map(Some)
}
