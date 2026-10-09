//! RSA key generation, OAEP/PKCS1 encryption, and PKCS#1 signatures.
use super::hash::{artifact, hex};
use crate::{EngineError, RunContext, ToolResult};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use rsa::pkcs1v15::Pkcs1v15Sign;
use rsa::{
    pkcs1::{DecodeRsaPrivateKey, DecodeRsaPublicKey},
    pkcs8::{DecodePrivateKey, DecodePublicKey, EncodePrivateKey, EncodePublicKey, LineEnding},
    rand_core::OsRng,
    traits::{PrivateKeyParts, PublicKeyParts},
    RsaPrivateKey, RsaPublicKey,
};
use rsa::{Oaep, Pkcs1v15Encrypt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256, Sha512};

type RunResult = Result<Option<ToolResult>, EngineError>;
enum Key {
    Private(RsaPrivateKey),
    Public(RsaPublicKey),
}
fn en(ctx: &RunContext<'_>) -> bool {
    ctx.locale.starts_with("en")
}
fn val(ctx: &RunContext<'_>, k: &str) -> String {
    match ctx.options.get(k) {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(v)) => v.trim().to_string(),
        Some(v) => v.to_string(),
    }
}
fn opt(ctx: &RunContext<'_>, k: &str, d: &str) -> String {
    let v = val(ctx, k);
    if v.is_empty() {
        d.into()
    } else {
        v
    }
}
fn err(ctx: &RunContext<'_>, field: &str, reason: &str) -> EngineError {
    EngineError::new(
        "bad_request",
        if en(ctx) {
            format!("Invalid {field}: {reason}")
        } else {
            format!("字段 {field} 无效：{reason}")
        },
    )
}
fn decode(s: &str) -> Result<Vec<u8>, String> {
    let x = s.trim().replace('-', "+").replace('_', "/");
    let pad = "=".repeat((4 - x.len() % 4) % 4);
    STANDARD
        .decode(format!("{x}{pad}"))
        .map_err(|e| e.to_string())
}
fn jwk_bytes(j: &Value, k: &str) -> Result<Vec<u8>, String> {
    decode(
        j.get(k)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("JWK is missing {k}"))?,
    )
}
fn public_jwk(k: &RsaPublicKey) -> Value {
    json!({"kty":"RSA","n":URL_SAFE_NO_PAD.encode(k.n().to_bytes_be()),"e":URL_SAFE_NO_PAD.encode(k.e().to_bytes_be())})
}
fn private_jwk(k: &RsaPrivateKey) -> Value {
    let p = k.primes();
    let d = k.d();
    let dp = d % (p[0].clone() - 1u8);
    let dq = d % (p[1].clone() - 1u8);
    let qi = p[1].modpow(&(&p[0] - 1u8), &p[0]);
    json!({"kty":"RSA","n":URL_SAFE_NO_PAD.encode(k.n().to_bytes_be()),"e":URL_SAFE_NO_PAD.encode(k.e().to_bytes_be()),"d":URL_SAFE_NO_PAD.encode(d.to_bytes_be()),"p":URL_SAFE_NO_PAD.encode(p[0].to_bytes_be()),"q":URL_SAFE_NO_PAD.encode(p[1].to_bytes_be()),"dp":URL_SAFE_NO_PAD.encode(dp.to_bytes_be()),"dq":URL_SAFE_NO_PAD.encode(dq.to_bytes_be()),"qi":URL_SAFE_NO_PAD.encode(qi.to_bytes_be())})
}
fn key(input: &str, private: bool, pass: &str) -> Result<Key, String> {
    let s = input.trim();
    if s.starts_with('{') {
        let j: Value = serde_json::from_str(s).map_err(|e| e.to_string())?;
        if j.get("kty").and_then(Value::as_str) != Some("RSA") {
            return Err("JWK kty must be RSA".into());
        }
        let n = rsa::BigUint::from_bytes_be(&jwk_bytes(&j, "n")?);
        let e = rsa::BigUint::from_bytes_be(&jwk_bytes(&j, "e")?);
        if private && j.get("d").is_some() {
            let d = rsa::BigUint::from_bytes_be(&jwk_bytes(&j, "d")?);
            if let (Ok(p), Ok(q)) = (jwk_bytes(&j, "p"), jwk_bytes(&j, "q")) {
                let mut k = RsaPrivateKey::from_components(
                    n,
                    e,
                    d,
                    vec![
                        rsa::BigUint::from_bytes_be(&p),
                        rsa::BigUint::from_bytes_be(&q),
                    ],
                )
                .map_err(|e| e.to_string())?;
                k.precompute().map_err(|e| e.to_string())?;
                return Ok(Key::Private(k));
            }
            return Err("RSA private JWK requires p and q".into());
        }
        return Ok(Key::Public(
            RsaPublicKey::new(n, e).map_err(|e| e.to_string())?,
        ));
    }
    if s.starts_with("-----BEGIN ENCRYPTED PRIVATE KEY-----") {
        let body = s
            .trim_start_matches("-----BEGIN ENCRYPTED PRIVATE KEY-----")
            .trim_end_matches("-----END ENCRYPTED PRIVATE KEY-----");
        let der = decode(body)?;
        let enc =
            pkcs8::EncryptedPrivateKeyInfo::try_from(der.as_slice()).map_err(|e| e.to_string())?;
        let doc = enc.decrypt(pass.as_bytes()).map_err(|e| e.to_string())?;
        return RsaPrivateKey::from_pkcs8_der(doc.as_bytes())
            .map(Key::Private)
            .map_err(|e| e.to_string());
    }
    if s.contains("-----BEGIN PRIVATE KEY-----") {
        return RsaPrivateKey::from_pkcs8_pem(s)
            .map(Key::Private)
            .map_err(|e| e.to_string());
    }
    if s.contains("-----BEGIN RSA PRIVATE KEY-----") {
        return RsaPrivateKey::from_pkcs1_pem(s)
            .map(Key::Private)
            .map_err(|e| e.to_string());
    }
    if s.contains("-----BEGIN PUBLIC KEY-----") {
        return RsaPublicKey::from_public_key_pem(s)
            .map(Key::Public)
            .map_err(|e| e.to_string());
    }
    if s.contains("-----BEGIN RSA PUBLIC KEY-----") {
        return RsaPublicKey::from_pkcs1_pem(s)
            .map(Key::Public)
            .map_err(|e| e.to_string());
    }
    let der = decode(s)?;
    if private {
        RsaPrivateKey::from_pkcs8_der(&der)
            .map(Key::Private)
            .or_else(|_| RsaPrivateKey::from_pkcs1_der(&der).map(Key::Private))
            .map_err(|e| e.to_string())
    } else {
        RsaPublicKey::from_public_key_der(&der)
            .map(Key::Public)
            .or_else(|_| RsaPublicKey::from_pkcs1_der(&der).map(Key::Public))
            .map_err(|e| e.to_string())
    }
}
fn pub_from(k: Key) -> Result<(RsaPublicKey, bool), String> {
    match k {
        Key::Public(k) => Ok((k, false)),
        Key::Private(k) => Ok((RsaPublicKey::from(&k), true)),
    }
}
fn encode_key(
    ctx: &RunContext<'_>,
    privkey: &RsaPrivateKey,
    pubkey: &RsaPublicKey,
    format: &str,
    pass: &str,
) -> Result<(String, String), EngineError> {
    if format == "jwk" {
        let mut a = private_jwk(privkey);
        a["alg"] = json!("PS256");
        let mut b = public_jwk(pubkey);
        b["alg"] = json!("RS256");
        return Ok((
            format!("{}\n", serde_json::to_string_pretty(&a).unwrap()),
            format!("{}\n", serde_json::to_string_pretty(&b).unwrap()),
        ));
    }
    let private = if pass.is_empty() {
        privkey
            .to_pkcs8_pem(LineEnding::LF)
            .map(|v| v.to_string())
            .map_err(|e| err(ctx, "privateKey", &e.to_string()))?
    } else {
        privkey
            .to_pkcs8_encrypted_pem(&mut OsRng, pass.as_bytes(), LineEnding::LF)
            .map(|v| v.to_string())
            .map_err(|e| err(ctx, "passphrase", &e.to_string()))?
    };
    let public = pubkey
        .to_public_key_pem(LineEnding::LF)
        .map_err(|e| err(ctx, "publicKey", &e.to_string()))?;
    Ok((private, public))
}
fn emit(text: String, extra: serde_json::Map<String, Value>) -> ToolResult {
    artifact("rsa.txt", text, extra)
}
fn signing_hash(name: &str, data: &[u8]) -> Vec<u8> {
    if name == "sha512" {
        Sha512::digest(data).to_vec()
    } else {
        Sha256::digest(data).to_vec()
    }
}
pub fn run(ctx: &RunContext<'_>) -> RunResult {
    if ctx.tool != "rsa" {
        return Ok(None);
    }
    let mode = opt(ctx, "mode", "generate");
    let bits = val(ctx, "bits")
        .parse::<usize>()
        .unwrap_or(2048)
        .clamp(1024, 8192);
    let format = opt(ctx, "format", "pem");
    let hash = opt(ctx, "hash", "sha256");
    let pass = val(ctx, "passphrase");
    let padding = opt(ctx, "padding", "oaep");
    if mode == "generate" {
        let private =
            RsaPrivateKey::new(&mut OsRng, bits).map_err(|e| err(ctx, "bits", &e.to_string()))?;
        let public = RsaPublicKey::from(&private);
        let (privtext, pubtext) = encode_key(ctx, &private, &public, &format, &pass)?;
        let fp = hex(
            &Sha256::digest(
                public
                    .to_public_key_der()
                    .map_err(|e| err(ctx, "publicKey", &e.to_string()))?
                    .as_bytes(),
            ),
            false,
        );
        let mut extra = serde_json::Map::new();
        extra.insert("mode".into(), json!(mode));
        extra.insert("bits".into(), json!(bits));
        extra.insert("format".into(), json!(format));
        extra.insert(
            "keyEncrypted".into(),
            json!(if pass.is_empty() { "no" } else { "yes" }),
        );
        extra.insert("publicPem".into(), json!(pubtext.replace(['\n', '\r'], "")));
        return Ok(Some(emit(format!("RSA key pair · {bits} bit · {}\n\nPublic key SHA-256: {fp}\n\nPrivate key\n{privtext}\nPublic key\n{pubtext}",format.to_uppercase()),extra)));
    }
    if mode == "pubkey" {
        let k =
            key(&val(ctx, "privateKey"), true, &pass).map_err(|e| err(ctx, "privateKey", &e))?;
        let private = match k {
            Key::Private(k) => k,
            Key::Public(_) => return Err(err(ctx, "privateKey", "private key required")),
        };
        let public = RsaPublicKey::from(&private);
        let p = if format == "jwk" {
            let mut j = public_jwk(&public);
            j["alg"] = json!("RS256");
            format!("{}\n", serde_json::to_string_pretty(&j).unwrap())
        } else {
            public
                .to_public_key_pem(LineEnding::LF)
                .map_err(|e| err(ctx, "privateKey", &e.to_string()))?
        };
        let fp = hex(
            &Sha256::digest(public.to_public_key_der().unwrap().as_bytes()),
            false,
        );
        let mut extra = serde_json::Map::new();
        extra.insert("mode".into(), json!(mode));
        extra.insert("format".into(), json!(format));
        extra.insert("bits".into(), json!(public.n().bits()));
        extra.insert("publicPem".into(), json!(p.replace(['\n', '\r'], "")));
        return Ok(Some(emit(
            format!(
                "Public key · {} bit · SHA-256 {fp}\n\n{p}",
                public.n().bits()
            ),
            extra,
        )));
    }
    if mode == "encrypt" || mode == "decrypt" {
        let message = val(ctx, "message");
        if message.is_empty() {
            return Err(err(ctx, "message", "must not be empty"));
        }
        let bits_hint = bits;
        let max = bits_hint.div_ceil(8)
            - if padding == "oaep" {
                if hash == "sha512" {
                    130
                } else {
                    66
                }
            } else {
                11
            };
        if mode == "encrypt" {
            let (k, derived) = pub_from(
                key(&val(ctx, "publicKey"), false, &pass).map_err(|e| err(ctx, "publicKey", &e))?,
            )
            .map_err(|e| err(ctx, "publicKey", &e))?;
            let bytes = message.as_bytes();
            if bytes.len() > max {
                return Err(err(
                    ctx,
                    "message",
                    &format!("{} bytes exceed the {max}-byte limit", bytes.len()),
                ));
            }
            let ciphertext = if padding == "pkcs1" {
                k.encrypt(&mut OsRng, Pkcs1v15Encrypt, bytes)
            } else if hash == "sha512" {
                k.encrypt(&mut OsRng, Oaep::new::<Sha512>(), bytes)
            } else {
                k.encrypt(&mut OsRng, Oaep::new::<Sha256>(), bytes)
            }
            .map_err(|e| err(ctx, "message", &e.to_string()))?;
            let encoded = STANDARD.encode(&ciphertext);
            let mut extra = serde_json::Map::new();
            extra.insert("mode".into(), json!(mode));
            extra.insert("padding".into(), json!(padding));
            extra.insert("hash".into(), json!(hash));
            extra.insert("bytes".into(), json!(ciphertext.len()));
            extra.insert("ciphertext".into(), json!(encoded));
            extra.insert(
                "keyDerived".into(),
                json!(if derived { "yes" } else { "no" }),
            );
            return Ok(Some(emit(
                format!(
                    "RSA encrypt · {}\n\n{encoded}\n\nPlaintext: {} bytes\nCiphertext: {} bytes",
                    padding.to_uppercase(),
                    bytes.len(),
                    ciphertext.len()
                ),
                extra,
            )));
        }
        let k = match key(&val(ctx, "privateKey"), true, &pass)
            .map_err(|e| err(ctx, "privateKey", &e))?
        {
            Key::Private(k) => k,
            Key::Public(_) => return Err(err(ctx, "privateKey", "private key required")),
        };
        let ciphertext = decode(&message).map_err(|e| err(ctx, "message", &e))?;
        let plain = if padding == "pkcs1" {
            k.decrypt(Pkcs1v15Encrypt, &ciphertext)
        } else if hash == "sha512" {
            k.decrypt(Oaep::new::<Sha512>(), &ciphertext)
        } else {
            k.decrypt(Oaep::new::<Sha256>(), &ciphertext)
        }
        .map_err(|e| err(ctx, "message", &e.to_string()))?;
        let decoded = String::from_utf8_lossy(&plain).into_owned();
        let mut extra = serde_json::Map::new();
        extra.insert("mode".into(), json!(mode));
        extra.insert("padding".into(), json!(padding));
        extra.insert("hash".into(), json!(hash));
        extra.insert("bytes".into(), json!(plain.len()));
        extra.insert("text".into(), json!(decoded));
        return Ok(Some(emit(
            format!(
                "RSA decrypt · {}\n\n{decoded}\n\nPlaintext: {} bytes",
                padding.to_uppercase(),
                plain.len()
            ),
            extra,
        )));
    }
    if mode == "sign" || mode == "verify" {
        let message = val(ctx, "message");
        if message.is_empty() {
            return Err(err(ctx, "message", "must not be empty"));
        }
        let digest = signing_hash(&hash, message.as_bytes());
        if mode == "sign" {
            let k = match key(&val(ctx, "privateKey"), true, &pass)
                .map_err(|e| err(ctx, "privateKey", &e))?
            {
                Key::Private(k) => k,
                Key::Public(_) => return Err(err(ctx, "privateKey", "private key required")),
            };
            let padding = if hash == "sha512" {
                Pkcs1v15Sign::new::<Sha512>()
            } else {
                Pkcs1v15Sign::new::<Sha256>()
            };
            let signature = k
                .sign(padding, &digest)
                .map_err(|e| err(ctx, "privateKey", &e.to_string()))?;
            let encoded = STANDARD.encode(&signature);
            let mut extra = serde_json::Map::new();
            extra.insert("mode".into(), json!(mode));
            extra.insert("hash".into(), json!(hash));
            extra.insert("bytes".into(), json!(signature.len()));
            extra.insert("signature".into(), json!(encoded));
            return Ok(Some(emit(format!("RSA signature · {}\n\n{encoded}\n\nSignature bytes: {}\n\nHex\n{}\n\nSigned message\nsignature: {encoded}\n{message}",hash.to_uppercase(),signature.len(),hex(&signature,false)),extra)));
        }
        let combined = message;
        let (mut sig_text, mut content) = (String::new(), String::new());
        if let Some((head, body)) = combined.split_once('\n') {
            if head.to_ascii_lowercase().starts_with("signature:") {
                sig_text = head[10..].trim().to_string();
                content = body.trim_end_matches('\n').into();
            } else if body.is_empty() {
                return Err(err(ctx, "message", "signature header missing"));
            } else {
                let last = combined.rsplit('\n').next().unwrap_or("").trim();
                sig_text = last.into();
                content = combined[..combined.rfind('\n').unwrap_or(0)]
                    .trim_end_matches('\n')
                    .into();
            }
        }
        let signature = decode(&sig_text).map_err(|e| err(ctx, "message", &e))?;
        if signature.is_empty() {
            return Err(err(ctx, "message", "signature is empty"));
        }
        let (pubkey, _derived) = pub_from(
            key(&val(ctx, "publicKey"), false, &pass).map_err(|e| err(ctx, "publicKey", &e))?,
        )
        .map_err(|e| err(ctx, "publicKey", &e))?;
        let padding = if hash == "sha512" {
            Pkcs1v15Sign::new::<Sha512>()
        } else {
            Pkcs1v15Sign::new::<Sha256>()
        };
        let ok = pubkey
            .verify(
                padding,
                &signing_hash(&hash, content.as_bytes()),
                &signature,
            )
            .is_ok();
        let mut extra = serde_json::Map::new();
        extra.insert("mode".into(), json!(mode));
        extra.insert("hash".into(), json!(hash));
        extra.insert("ok".into(), json!(if ok { "yes" } else { "no" }));
        extra.insert("keyBytes".into(), json!(pubkey.size()));
        return Ok(Some(emit(
            format!(
                "RSA verification · {}\n\n{}\n\nMessage\n{content}",
                hash.to_uppercase(),
                if ok { "✓ valid" } else { "✗ invalid" }
            ),
            extra,
        )));
    }
    Err(err(ctx, "mode", "unsupported RSA operation"))
}
