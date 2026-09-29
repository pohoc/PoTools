//! JWT decode and optional HS/RS/ES signature verification.
use super::hash::{artifact, hex};
use crate::{EngineError, RunContext, ToolResult};
use base64::{
    engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD},
    Engine,
};
use hmac::{Hmac, Mac};
use p256::ecdsa::{
    signature::Verifier as _, Signature as EcSignature, VerifyingKey as EcVerifyingKey,
};
use rsa::{
    pkcs1v15::{Signature as RsaSignature, VerifyingKey as RsaVerifyingKey},
    pkcs8::DecodePublicKey,
    RsaPublicKey,
};
use serde_json::{json, Map, Value};
use sha2::{Sha256, Sha384, Sha512};

type RunResult = Result<Option<ToolResult>, EngineError>;
fn val(ctx: &RunContext<'_>, k: &str) -> String {
    match ctx.options.get(k) {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.trim().to_string(),
        Some(v) => v.to_string(),
    }
}
fn num(ctx: &RunContext<'_>, k: &str, d: f64) -> f64 {
    match ctx.options.get(k) {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(d),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(d),
        _ => d,
    }
}
fn en(ctx: &RunContext<'_>) -> bool {
    ctx.locale.starts_with("en")
}
fn badmsg(ctx: &RunContext<'_>, field: &str, reason: &str, example: &str) -> EngineError {
    EngineError::new(
        "bad_request",
        if en(ctx) {
            format!("Invalid {field}: {reason}. Example: {example}")
        } else {
            format!("字段 {field} 无效：{reason}。示例：{example}")
        },
    )
}
fn b64(raw: &str, ctx: &RunContext<'_>, field: &str) -> Result<Vec<u8>, EngineError> {
    let s = raw
        .trim()
        .trim_end_matches('=')
        .replace('+', "-")
        .replace('/', "_");
    if s.is_empty()
        || !s
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err(badmsg(
            ctx,
            field,
            "invalid Base64URL",
            "eyJhbGciOiJIUzI1NiJ9",
        ));
    }
    URL_SAFE_NO_PAD
        .decode(&s)
        .or_else(|_| URL_SAFE.decode(raw))
        .map_err(|_| badmsg(ctx, field, "invalid Base64URL", "eyJhbGciOiJIUzI1NiJ9"))
}
fn json_obj(
    bytes: &[u8],
    ctx: &RunContext<'_>,
    part: &str,
) -> Result<Map<String, Value>, EngineError> {
    let val: Value = serde_json::from_slice(bytes).map_err(|e| {
        badmsg(
            ctx,
            "token",
            &format!("invalid {part} JSON: {e}"),
            "{\"alg\":\"HS256\"}",
        )
    })?;
    val.as_object().cloned().ok_or_else(|| {
        badmsg(
            ctx,
            "token",
            &format!("{part} must be a JSON object"),
            "{\"alg\":\"HS256\"}",
        )
    })
}
fn verify_hs(alg: &str, key: &[u8], data: &[u8], sig: &[u8]) -> bool {
    let valid = match alg {
        "hs256" => Hmac::<Sha256>::new_from_slice(key).map(|mut m| {
            m.update(data);
            m.verify_slice(sig).is_ok()
        }),
        "hs384" => Hmac::<Sha384>::new_from_slice(key).map(|mut m| {
            m.update(data);
            m.verify_slice(sig).is_ok()
        }),
        _ => Hmac::<Sha512>::new_from_slice(key).map(|mut m| {
            m.update(data);
            m.verify_slice(sig).is_ok()
        }),
    };
    valid.unwrap_or(false)
}
fn verify_asym(alg: &str, keytext: &str, data: &[u8], sig: &[u8]) -> Result<bool, String> {
    if alg == "rs256" {
        let key = RsaPublicKey::from_public_key_pem(keytext).map_err(|e| e.to_string())?;
        let verifier = RsaVerifyingKey::<Sha256>::new(key);
        let signature = RsaSignature::try_from(sig).map_err(|e| e.to_string())?;
        Ok(verifier.verify(data, &signature).is_ok())
    } else {
        let key = EcVerifyingKey::from_public_key_pem(keytext).map_err(|e| e.to_string())?;
        let signature = EcSignature::from_slice(sig).map_err(|e| e.to_string())?;
        Ok(key.verify(data, &signature).is_ok())
    }
}
fn pretty(value: &Map<String, Value>) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".into())
}
pub fn run(ctx: &RunContext<'_>) -> RunResult {
    if ctx.tool != "jwt" {
        return Ok(None);
    }
    let token = val(ctx, "token");
    if token.is_empty() {
        return Err(badmsg(
            ctx,
            "token",
            "must not be empty",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.…",
        ));
    }
    let compact = token
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>();
    let parts = compact.split('.').collect::<Vec<_>>();
    if parts.len() != 3 {
        return Err(badmsg(
            ctx,
            "token",
            &format!("expected 3 parts, found {}", parts.len()),
            "eyJhbGciOi….eyJzdWIiOi….signature",
        ));
    }
    let header = json_obj(&b64(parts[0], ctx, "token(header)")?, ctx, "header")?;
    let claims = json_obj(&b64(parts[1], ctx, "token(payload)")?, ctx, "payload")?;
    let sig = b64(parts[2], ctx, "token(signature)")?;
    let header_alg = header
        .get("alg")
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| v.to_string())
        })
        .unwrap_or_else(|| {
            if en(ctx) {
                "missing".into()
            } else {
                "缺失".into()
            }
        });
    let requested = val(ctx, "algorithm");
    let alg = if requested.is_empty() || requested == "auto" {
        header_alg.to_ascii_lowercase()
    } else {
        requested.to_ascii_lowercase()
    };
    if !["hs256", "hs384", "hs512", "rs256", "es256"].contains(&alg.as_str()) {
        return Err(badmsg(
            ctx,
            "algorithm",
            &format!("unsupported algorithm {header_alg}"),
            "hs256",
        ));
    }
    let verify = match ctx.options.get("verify") {
        Some(Value::Bool(true)) => true,
        Some(Value::String(v)) => v == "true",
        _ => false,
    };
    let secret = val(ctx, "secret");
    if verify && secret.is_empty() {
        return Err(EngineError::new(
            "bad_request",
            if en(ctx) {
                format!("Verification key required for {}", alg.to_uppercase())
            } else {
                format!("验证 {} 需要密钥", alg.to_uppercase())
            },
        ));
    }
    let now = chrono::Utc::now().timestamp();
    let leeway = num(ctx, "leeway", 0.).round().clamp(0., 3600.) as i64;
    let exp = claims.get("exp").and_then(Value::as_i64);
    let nbf = claims.get("nbf").and_then(Value::as_i64);
    let expired = exp.map(|v| now - leeway > v).unwrap_or(false);
    let not_yet = nbf.map(|v| now + leeway < v).unwrap_or(false);
    let signing = format!("{}.{}", parts[0], parts[1]);
    let mut status = "decoded";
    let mut verdict = String::from("Not verified");
    if verify {
        let outcome = if alg.starts_with("hs") {
            Ok(verify_hs(&alg, secret.as_bytes(), signing.as_bytes(), &sig))
        } else {
            verify_asym(&alg, &secret, signing.as_bytes(), &sig).map_err(|e| e)
        };
        match outcome {
            Ok(true) => {
                status = if expired {
                    "expired"
                } else if not_yet {
                    "not-yet-valid"
                } else {
                    "valid"
                };
                verdict = if expired || not_yet {
                    "Signature valid; time claim failed".into()
                } else {
                    "Signature valid".into()
                };
            }
            Ok(false) => {
                status = if expired {
                    "expired"
                } else if not_yet {
                    "not-yet-valid"
                } else {
                    "invalid-signature"
                };
                verdict = "Signature invalid".into();
            }
            Err(error) => {
                status = "invalid-signature";
                verdict = format!("Verification failed: {error}");
            }
        }
    }
    let mut lines = vec![
        format!("JWT · {}", header_alg),
        format!(
            "Parts: {} · {} · {}",
            parts[0].len(),
            parts[1].len(),
            parts[2].len()
        ),
        format!("Signature: {} bytes · {}", sig.len(), hex(&sig, false)),
        format!("Algorithm: {header_alg} → {}", alg.to_uppercase()),
        format!("Signing input: {signing}"),
        "Header".into(),
        pretty(&header),
        "Claims".into(),
        pretty(&claims),
    ];
    for k in ["iss", "sub", "aud", "jti", "typ"] {
        if let Some(v) = claims.get(k) {
            lines.push(format!("{k}: {}", v));
        }
    }
    for (k, v) in [
        ("iat", claims.get("iat")),
        ("nbf", claims.get("nbf")),
        ("exp", claims.get("exp")),
    ] {
        if let Some(n) = v.and_then(Value::as_i64) {
            lines.push(format!(
                "{k}: {} · T={n}",
                chrono::DateTime::from_timestamp(n, 0)
                    .map(|d| d.to_rfc3339())
                    .unwrap_or_else(|| "invalid date".into())
            ));
        }
    }
    lines.push(format!("Leeway: {leeway}s"));
    lines.push(format!("Result: {verdict}"));
    let mut extra = serde_json::Map::new();
    extra.insert("alg".into(), json!(header_alg));
    extra.insert("status".into(), json!(status));
    extra.insert("claims".into(), json!(claims.len()));
    extra.insert("expired".into(), json!(if expired { "yes" } else { "no" }));
    extra.insert(
        "notYetValid".into(),
        json!(if not_yet { "yes" } else { "no" }),
    );
    extra.insert("verify".into(), json!(verdict));
    Ok(Some(artifact("jwt.txt", lines.join("\n"), extra)))
}
