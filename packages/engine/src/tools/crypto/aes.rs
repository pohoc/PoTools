//! AES container encryption compatible with crypto-aes-browser.ts v1.
use super::hash::{artifact, b64_decode, b64_encode, bad, hex};
use crate::{EngineError, RunContext, ToolResult};
use aes::{Aes128, Aes256};
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use cbc::{Decryptor, Encryptor};
use ctr::cipher::StreamCipher;
use pbkdf2::pbkdf2_hmac;
use scrypt::{scrypt, Params as ScryptParams};
use serde_json::{json, Value};
use sha2::Sha256;

type RunResult = Result<Option<ToolResult>, EngineError>;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Cipher {
    Gcm256,
    Cbc256,
    Cbc128,
    Ctr256,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Kdf {
    Scrypt,
    Pbkdf2,
}
#[derive(Clone, Copy)]
enum Format {
    Base64,
    Base64Url,
    Hex,
}
struct Container {
    cipher: Cipher,
    kdf: Kdf,
    iterations: u32,
    salt: Vec<u8>,
    iv: Vec<u8>,
    tag: Vec<u8>,
    data: Vec<u8>,
}
fn en(ctx: &RunContext<'_>) -> bool {
    ctx.locale.starts_with("en")
}
fn option_string(ctx: &RunContext<'_>, key: &str) -> String {
    match ctx.options.get(key) {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(v)) => v.trim().to_string(),
        Some(Value::Bool(v)) => v.to_string(),
        Some(Value::Number(v)) => v.to_string(),
        Some(v) => v.to_string(),
    }
}
fn number(ctx: &RunContext<'_>, key: &str, default: f64) -> f64 {
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
fn badmsg(ctx: &RunContext<'_>, message: &str) -> EngineError {
    let _ = ctx;
    EngineError::new("bad_request", message.to_string())
}
fn cipher_name(c: Cipher) -> &'static str {
    match c {
        Cipher::Gcm256 => "aes-256-gcm",
        Cipher::Cbc256 => "aes-256-cbc",
        Cipher::Cbc128 => "aes-128-cbc",
        Cipher::Ctr256 => "aes-256-ctr",
    }
}
fn cipher_opt(s: &str) -> Cipher {
    match s {
        "aes-256-cbc" => Cipher::Cbc256,
        "aes-128-cbc" => Cipher::Cbc128,
        "aes-256-ctr" => Cipher::Ctr256,
        _ => Cipher::Gcm256,
    }
}
fn cipher_id(c: Cipher) -> u8 {
    match c {
        Cipher::Gcm256 => 1,
        Cipher::Cbc256 => 2,
        Cipher::Cbc128 => 3,
        Cipher::Ctr256 => 4,
    }
}
fn kdf_name(k: Kdf) -> &'static str {
    if k == Kdf::Scrypt {
        "scrypt"
    } else {
        "pbkdf2"
    }
}
fn kdf_opt(s: &str) -> Kdf {
    if s == "pbkdf2" {
        Kdf::Pbkdf2
    } else {
        Kdf::Scrypt
    }
}
fn format_opt(s: &str) -> Format {
    match s {
        "hex" => Format::Hex,
        "base64url" => Format::Base64Url,
        _ => Format::Base64,
    }
}
fn format_name(f: Format) -> &'static str {
    match f {
        Format::Hex => "hex",
        Format::Base64Url => "base64url",
        _ => "base64",
    }
}
fn encode(bytes: &[u8], f: Format) -> String {
    match f {
        Format::Hex => hex(bytes, false),
        Format::Base64 => b64_encode(bytes, false),
        Format::Base64Url => b64_encode(bytes, true).trim_end_matches('=').to_string(),
    }
}
fn decode(input: &str, f: Format, ctx: &RunContext<'_>) -> Result<Vec<u8>, EngineError> {
    let compact: String = input.chars().filter(|c| !c.is_whitespace()).collect();
    if matches!(f, Format::Hex) {
        if compact.is_empty()
            || !compact.len().is_multiple_of(2)
            || !compact.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(badmsg(
                ctx,
                if en(ctx) {
                    "Input is not valid hexadecimal data"
                } else {
                    "输入不是有效的十六进制数据"
                },
            ));
        }
        return (0..compact.len())
            .step_by(2)
            .map(|i| {
                u8::from_str_radix(&compact[i..i + 2], 16).map_err(|_| badmsg(ctx, "Invalid hex"))
            })
            .collect();
    }
    b64_decode(&compact).map_err(|_| {
        badmsg(
            ctx,
            if en(ctx) {
                "Input is not valid Base64 data"
            } else {
                "输入不是有效的 Base64 数据"
            },
        )
    })
}
fn pack(c: &Container) -> Vec<u8> {
    let mut o = vec![
        1,
        if c.kdf == Kdf::Scrypt { 1 } else { 2 },
        cipher_id(c.cipher),
    ];
    o.extend_from_slice(&c.iterations.to_be_bytes());
    for field in [&c.salt, &c.iv, &c.tag] {
        o.push(field.len() as u8);
        o.extend_from_slice(field);
    }
    o.extend_from_slice(&c.data);
    o
}
fn unpack(b: &[u8], ctx: &RunContext<'_>) -> Result<Container, EngineError> {
    let fail = || {
        badmsg(
            ctx,
            if en(ctx) {
                "Input is not a supported AES encrypted container"
            } else {
                "输入不是支持的 AES 加密容器"
            },
        )
    };
    if b.len() < 7 || b[0] != 1 || !(b[1] == 1 || b[1] == 2) {
        return Err(fail());
    }
    let cipher = match b[2] {
        1 => Cipher::Gcm256,
        2 => Cipher::Cbc256,
        3 => Cipher::Cbc128,
        4 => Cipher::Ctr256,
        _ => {
            return Err(badmsg(
                ctx,
                if en(ctx) {
                    "Encrypted container uses an unsupported algorithm"
                } else {
                    "加密容器使用了不支持的算法"
                },
            ))
        }
    };
    let iterations = u32::from_be_bytes(b[3..7].try_into().unwrap()).max(1);
    let mut offset = 7;
    let mut take = |name: &str, max: usize| -> Result<Vec<u8>, EngineError> {
        if offset >= b.len() {
            return Err(badmsg(
                ctx,
                &format!("Encrypted container {name} field is invalid"),
            ));
        }
        let n = b[offset] as usize;
        offset += 1;
        if n > max || offset + n > b.len() {
            return Err(badmsg(
                ctx,
                &format!("Encrypted container {name} field is invalid"),
            ));
        }
        let v = b[offset..offset + n].to_vec();
        offset += n;
        Ok(v)
    };
    let salt = take("salt", 64)?;
    let iv = take("IV", 32)?;
    let tag = take("authTag", 32)?;
    if salt.len() != 16
        || iv.len() != if cipher == Cipher::Gcm256 { 12 } else { 16 }
        || (cipher == Cipher::Gcm256 && tag.len() != 16)
    {
        return Err(badmsg(
            ctx,
            if en(ctx) {
                "Encrypted container parameters are invalid"
            } else {
                "加密容器参数无效"
            },
        ));
    }
    Ok(Container {
        cipher,
        kdf: if b[1] == 1 { Kdf::Scrypt } else { Kdf::Pbkdf2 },
        iterations,
        salt,
        iv,
        tag,
        data: b[offset..].to_vec(),
    })
}
fn derive(
    pass: &str,
    salt: &[u8],
    iterations: u32,
    cipher: Cipher,
    kdf: Kdf,
) -> Result<Vec<u8>, EngineError> {
    let len = if cipher == Cipher::Cbc128 { 16 } else { 32 };
    let mut out = vec![0u8; len];
    match kdf {
        Kdf::Pbkdf2 => pbkdf2_hmac::<Sha256>(pass.as_bytes(), salt, iterations, &mut out),
        Kdf::Scrypt => {
            let log = (iterations.max(1) as f64).log2().floor().clamp(14., 16.) as u8;
            let params = ScryptParams::new(log, 8, 1, len)
                .map_err(|e| EngineError::new("bad_request", e.to_string()))?;
            scrypt(pass.as_bytes(), salt, &params, &mut out)
                .map_err(|e| EngineError::new("bad_request", e.to_string()))?;
        }
    }
    Ok(out)
}
fn encrypt(
    c: Cipher,
    key: &[u8],
    iv: &[u8],
    plain: &[u8],
) -> Result<(Vec<u8>, Vec<u8>), EngineError> {
    match c {
        Cipher::Gcm256 => {
            let cipher =
                Aes256Gcm::new_from_slice(key).map_err(|_| bad("key", "invalid length"))?;
            let mut all = cipher
                .encrypt(Nonce::from_slice(iv), plain)
                .map_err(|_| bad("encrypt", "AES-GCM failed"))?;
            let tag = all.split_off(all.len() - 16);
            Ok((all, tag))
        }
        Cipher::Cbc256 => Ok((
            Encryptor::<Aes256>::new_from_slices(key, iv)
                .unwrap()
                .encrypt_padded_vec_mut::<Pkcs7>(plain),
            vec![],
        )),
        Cipher::Cbc128 => Ok((
            Encryptor::<Aes128>::new_from_slices(key, iv)
                .unwrap()
                .encrypt_padded_vec_mut::<Pkcs7>(plain),
            vec![],
        )),
        Cipher::Ctr256 => {
            type Ctr = Aes256Ctr;
            let mut data = plain.to_vec();
            let mut cipher =
                Ctr::new_from_slices(key, iv).map_err(|_| bad("key", "invalid length"))?;
            cipher.apply_keystream(&mut data);
            Ok((data, vec![]))
        }
    }
}
fn decrypt(
    c: Cipher,
    key: &[u8],
    iv: &[u8],
    tag: &[u8],
    data: &[u8],
) -> Result<Vec<u8>, EngineError> {
    match c {
        Cipher::Gcm256 => {
            let cipher =
                Aes256Gcm::new_from_slice(key).map_err(|_| bad("key", "invalid length"))?;
            let mut all = data.to_vec();
            all.extend_from_slice(tag);
            cipher
                .decrypt(Nonce::from_slice(iv), all.as_ref())
                .map_err(|_| bad("decrypt", "authentication failed"))
        }
        Cipher::Cbc256 => Decryptor::<Aes256>::new_from_slices(key, iv)
            .unwrap()
            .decrypt_padded_vec_mut::<Pkcs7>(data)
            .map_err(|_| bad("decrypt", "padding invalid")),
        Cipher::Cbc128 => Decryptor::<Aes128>::new_from_slices(key, iv)
            .unwrap()
            .decrypt_padded_vec_mut::<Pkcs7>(data)
            .map_err(|_| bad("decrypt", "padding invalid")),
        Cipher::Ctr256 => {
            type Ctr = Aes256Ctr;
            let mut out = data.to_vec();
            Ctr::new_from_slices(key, iv)
                .map_err(|_| bad("key", "invalid length"))?
                .apply_keystream(&mut out);
            Ok(out)
        }
    }
}
type Aes256Ctr = ctr::Ctr128BE<Aes256>;
fn random<const N: usize>() -> Result<[u8; N], EngineError> {
    let mut b = [0u8; N];
    getrandom::fill(&mut b)
        .map_err(|e| EngineError::new("internal", format!("Random source unavailable: {e}")))?;
    Ok(b)
}
fn output_text(text: String) -> ToolResult {
    artifact("aes.txt", text, serde_json::Map::new())
}
pub fn run(ctx: &RunContext<'_>) -> RunResult {
    if ctx.tool != "aes" {
        return Ok(None);
    }
    let en = en(ctx);
    let input = option_string(ctx, "input");
    let pass = option_string(ctx, "passphrase");
    if input.is_empty() {
        return Err(badmsg(
            ctx,
            if en {
                "Input content is required"
            } else {
                "待处理内容不能为空"
            },
        ));
    }
    if pass.is_empty() {
        return Err(badmsg(
            ctx,
            if en {
                "Passphrase must not be empty (it is the only key source)"
            } else {
                "口令不能为空（口令是密钥的唯一来源）"
            },
        ));
    }
    let mode = if option_string(ctx, "mode") == "decrypt" {
        "decrypt"
    } else {
        "encrypt"
    };
    let f = format_opt(&option_string(ctx, "format"));
    let iterations = number(ctx, "iterations", 150_000.)
        .round()
        .clamp(1000., 2_000_000.) as u32;
    if mode == "encrypt" {
        let c = cipher_opt(&option_string(ctx, "cipher"));
        let k = kdf_opt(&option_string(ctx, "kdf"));
        let salt = random::<16>()?.to_vec();
        let iv = if c == Cipher::Gcm256 {
            random::<12>()?.to_vec()
        } else {
            random::<16>()?.to_vec()
        };
        let key = derive(&pass, &salt, iterations, c, k)?;
        let (data, tag) = encrypt(c, &key, &iv, input.as_bytes())?;
        let container = pack(&Container {
            cipher: c,
            kdf: k,
            iterations,
            salt: salt.clone(),
            iv: iv.clone(),
            tag: tag.clone(),
            data: data.clone(),
        });
        let rendered = encode(&container, f);
        let mut r = output_text(if en {
            format!("AES encrypt - {} - {} - {}\n\nContainer string\n{}\n\nPlaintext bytes: {}\nCiphertext: {} bytes\nContainer size: {} bytes -> {} characters\nsalt: {}\nIV/nonce: {}\nauthTag: {}\nKDF strength: {} (iterations={})\n\nContainer layout (v1)",cipher_name(c),kdf_name(k),format_name(f),rendered,input.len(),data.len(),container.len(),rendered.len(),hex(&salt,false),hex(&iv,false),if tag.is_empty(){"not applicable".into()}else{hex(&tag,false)},if k==Kdf::Scrypt{format!("scrypt N={}",1u32<<((iterations.max(1) as f64).log2().floor().clamp(14.,16.) as u32))}else{format!("pbkdf2 {} rounds",iterations)},iterations)
        } else {
            format!("AES 加密 · {} · {} · {}\n\n容器串（mode=decrypt 时整串粘贴到 input）\n{}\n\n明文: {} 字节（UTF-8）\n密文: {} 字节\n容器总长: {} 字节 → {} 字符\nsalt: {}\nIV/nonce: {}\nauthTag: {}\nKDF 强度: {} · iterations={}\n\n容器格式（v1）",cipher_name(c),kdf_name(k),format_name(f),rendered,input.len(),data.len(),container.len(),rendered.len(),hex(&salt,false),hex(&iv,false),if tag.is_empty(){"不适用（CBC/CTR 无认证标签）".into()}else{hex(&tag,false)},kdf_name(k),iterations)
        });
        r.extra.insert("mode".into(), json!(mode));
        r.extra.insert("cipher".into(), json!(cipher_name(c)));
        r.extra.insert("kdf".into(), json!(kdf_name(k)));
        r.extra.insert("iterations".into(), json!(iterations));
        r.extra.insert("encoding".into(), json!(format_name(f)));
        r.extra
            .insert("containerBytes".into(), json!(container.len()));
        r.extra.insert("container".into(), json!(rendered));
        return Ok(Some(r));
    }
    let packed = unpack(&decode(&input, f, ctx)?, ctx)?;
    let key = derive(
        &pass,
        &packed.salt,
        packed.iterations,
        packed.cipher,
        packed.kdf,
    )?;
    let plain = match decrypt(packed.cipher, &key, &packed.iv, &packed.tag, &packed.data) {
        Ok(v) => v,
        Err(_) => {
            let msg = if packed.cipher == Cipher::Gcm256 {
                if en {
                    "GCM auth tag check failed: the container was tampered with or the passphrase is wrong"
                } else {
                    "GCM 认证标签校验失败：容器被篡改或口令错误"
                }
            } else {
                if en {
                    "Decrypt failed: wrong passphrase or damaged container (mode has no integrity protection)"
                } else {
                    "解密失败：口令错误或容器损坏（该模式无完整性保护）"
                }
            };
            let mut r = output_text(format!(
                "AES decrypt - {} - {} - failed\n✗ {msg}",
                cipher_name(packed.cipher),
                kdf_name(packed.kdf)
            ));
            r.extra.insert("mode".into(), json!(mode));
            r.extra
                .insert("cipher".into(), json!(cipher_name(packed.cipher)));
            r.extra.insert("kdf".into(), json!(kdf_name(packed.kdf)));
            r.extra.insert("ok".into(), json!("no"));
            r.extra.insert("reason".into(), json!(msg));
            return Ok(Some(r));
        }
    };
    let decoded = String::from_utf8_lossy(&plain).into_owned();
    let full = if en {
        format!("AES decrypt - {} - {} - succeeded\n\nResult\n{}\n\nContainer length: {} bytes\nCiphertext: {} bytes\nPlaintext: {} bytes\nContainer self-description: {} · {} · iterations={}\n\nDecryption completed.",cipher_name(packed.cipher),kdf_name(packed.kdf),decoded,decode(&input,f,ctx)?.len(),packed.data.len(),plain.len(),cipher_name(packed.cipher),kdf_name(packed.kdf),packed.iterations)
    } else {
        format!("AES 解密 · {} · {} · 成功\n\n结果\n{}\n\n容器长度: {} 字节\n密文: {} 字节\n明文: {} 字节\n容器自描述: {} · {} · iterations={}\n\n解密完成。",cipher_name(packed.cipher),kdf_name(packed.kdf),decoded,decode(&input,f,ctx)?.len(),packed.data.len(),plain.len(),cipher_name(packed.cipher),kdf_name(packed.kdf),packed.iterations)
    };
    let mut r = output_text(full);
    r.extra.insert("mode".into(), json!(mode));
    r.extra
        .insert("cipher".into(), json!(cipher_name(packed.cipher)));
    r.extra.insert("kdf".into(), json!(kdf_name(packed.kdf)));
    r.extra.insert("ok".into(), json!("yes"));
    r.extra.insert("bytes".into(), json!(plain.len()));
    r.extra.insert("text".into(), json!(decoded));
    Ok(Some(r))
}
