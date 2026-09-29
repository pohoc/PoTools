//! X.509 certificate chain inspection and JSON export.
use super::hash::{artifact, bad, hex};
use crate::{Artifact, EngineError, RunContext, ToolResult};
use base64::Engine;
use chrono::{Local, TimeZone, Utc};
use serde_json::{json, Map, Value};
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha512};
use x509_parser::{extensions::ParsedExtension, parse_x509_certificate};

type RunResult = Result<Option<ToolResult>, EngineError>;
struct CertInfo {
    der: Vec<u8>,
    subject: String,
    issuer: String,
    serial: String,
    version: u32,
    sig_alg: String,
    from: i64,
    to: i64,
    sans: Vec<(String, String)>,
    ca: bool,
    key_usage: Vec<String>,
    eku: Vec<String>,
    ski: String,
    aki: String,
    critical: Vec<String>,
}
fn en(ctx: &RunContext<'_>) -> bool {
    ctx.locale.starts_with("en")
}
fn opt(ctx: &RunContext<'_>, k: &str) -> String {
    match ctx.options.get(k) {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.trim().to_string(),
        Some(v) => v.to_string(),
    }
}
fn bool_opt(ctx: &RunContext<'_>, k: &str) -> bool {
    match ctx.options.get(k) {
        Some(Value::Bool(v)) => *v,
        Some(Value::String(s)) => s == "true" || s == "1",
        _ => false,
    }
}
fn decode(s: &str) -> Result<Vec<u8>, String> {
    let cleaned = s.chars().filter(|c| !c.is_whitespace()).collect::<String>();
    base64::engine::general_purpose::STANDARD
        .decode(cleaned)
        .map_err(|e| e.to_string())
}
fn parse(der: Vec<u8>) -> Result<CertInfo, String> {
    let (_, cert) = parse_x509_certificate(&der).map_err(|e| e.to_string())?;
    let mut sans = vec![];
    let (mut ca, mut key_usage, mut eku, mut ski, mut aki, mut critical) =
        (false, vec![], vec![], String::new(), String::new(), vec![]);
    for ext in cert.extensions() {
        if ext.critical {
            critical.push(ext.oid.to_string());
        }
        match ext.parsed_extension() {
            ParsedExtension::SubjectAlternativeName(san) => {
                for name in &san.general_names {
                    let (k, v) = match name {
                        x509_parser::extensions::GeneralName::DNSName(v) => ("DNS", v.to_string()),
                        x509_parser::extensions::GeneralName::RFC822Name(v) => {
                            ("email", v.to_string())
                        }
                        x509_parser::extensions::GeneralName::URI(v) => ("URI", v.to_string()),
                        x509_parser::extensions::GeneralName::IPAddress(v) => (
                            "IP",
                            v.iter()
                                .map(|b| b.to_string())
                                .collect::<Vec<_>>()
                                .join("."),
                        ),
                        other => ("other", format!("{other:?}")),
                    };
                    sans.push((k.into(), v));
                }
            }
            ParsedExtension::BasicConstraints(b) => ca = b.ca,
            ParsedExtension::KeyUsage(u) => {
                for (flag, name) in [
                    (u.digital_signature(), "digitalSignature"),
                    (u.non_repudiation(), "nonRepudiation"),
                    (u.key_encipherment(), "keyEncipherment"),
                    (u.data_encipherment(), "dataEncipherment"),
                    (u.key_agreement(), "keyAgreement"),
                    (u.key_cert_sign(), "keyCertSign"),
                    (u.crl_sign(), "cRLSign"),
                    (u.encipher_only(), "encipherOnly"),
                    (u.decipher_only(), "decipherOnly"),
                ] {
                    if flag {
                        key_usage.push(name.into());
                    }
                }
            }
            ParsedExtension::ExtendedKeyUsage(u) => {
                for (flag, name) in [
                    (u.server_auth, "serverAuth"),
                    (u.client_auth, "clientAuth"),
                    (u.code_signing, "codeSigning"),
                    (u.email_protection, "emailProtection"),
                    (u.time_stamping, "timeStamping"),
                    (u.ocsp_signing, "OCSPSigning"),
                ] {
                    if flag {
                        eku.push(name.into());
                    }
                }
                eku.extend(u.other.iter().map(|oid| oid.to_id_string()));
            }
            ParsedExtension::SubjectKeyIdentifier(id) => ski = hex(&id.0, true),
            ParsedExtension::AuthorityKeyIdentifier(id) => {
                if let Some(key) = &id.key_identifier {
                    aki = hex(&key.0, true);
                }
            }
            _ => {}
        }
    }
    let subject = cert.subject().to_string();
    let issuer = cert.issuer().to_string();
    let serial = cert
        .tbs_certificate
        .raw_serial_as_string()
        .replace(':', "")
        .to_ascii_lowercase();
    let version = cert.version().0 + 1;
    let sig_alg = cert.signature_algorithm.algorithm.to_id_string();
    let from = cert.validity().not_before.timestamp();
    let to = cert.validity().not_after.timestamp();
    Ok(CertInfo {
        der,
        subject,
        issuer,
        serial,
        version,
        sig_alg,
        from,
        to,
        sans,
        ca,
        key_usage,
        eku,
        ski,
        aki,
        critical,
    })
}
fn get_certificates(input: &str) -> Vec<Result<Vec<u8>, String>> {
    let mut out = Vec::new();
    let mut rest = input;
    const BEGIN: &str = "-----BEGIN CERTIFICATE-----";
    const END: &str = "-----END CERTIFICATE-----";
    while let Some(start) = rest.find(BEGIN) {
        let body = &rest[start + BEGIN.len()..];
        if let Some(end) = body.find(END) {
            out.push(decode(&body[..end]));
            rest = &body[end + END.len()..];
        } else {
            out.push(Err("certificate PEM end marker is missing".into()));
            break;
        }
    }
    out
}
fn digest(bytes: &[u8], kind: &str) -> String {
    match kind {
        "sha1" => hex(&Sha1::digest(bytes), false),
        "sha512" => hex(&Sha512::digest(bytes), false),
        _ => hex(&Sha256::digest(bytes), false),
    }
}
fn time(ts: i64) -> String {
    Local
        .timestamp_opt(ts, 0)
        .single()
        .map(|d| d.format("%Y-%m-%d %H:%M:%S %:z").to_string())
        .unwrap_or_else(|| "invalid date".into())
}
fn json_cert(c: &CertInfo) -> Value {
    let sans: Map<String, Value> = c
        .sans
        .iter()
        .enumerate()
        .map(|(i, (k, v))| {
            let key = if k == "DNS" {
                format!("DNS{}", i + 1)
            } else {
                format!("{k}{}", if k == "IP" { i + 1 } else { 0 })
            };
            (key, json!(v))
        })
        .collect();
    json!({"subject":c.subject,"issuer":c.issuer,"serialNumber":c.serial,"version":format!("X.509 v{}",c.version),"signatureAlgorithm":c.sig_alg,"subjectAltName":sans,"validFrom":time(c.from),"validTo":time(c.to),"validityIso":{"notBefore":Utc.timestamp_opt(c.from,0).single().map(|v|v.to_rfc3339()),"notAfter":Utc.timestamp_opt(c.to,0).single().map(|v|v.to_rfc3339())},"remainingDays":(c.to-Utc::now().timestamp()) as f64/86400.,"expired":Utc::now().timestamp()>c.to,"ca":c.ca,"basicConstraints":format!("CA:{}",if c.ca{"TRUE"}else{"FALSE"}),"keyUsage":c.key_usage.join(", "),"extendedKeyUsage":c.eku.join(", "),"subjectKeyIdentifier":c.ski,"authorityKeyIdentifier":c.aki,"infoAccess":[],"fingerprintSha1":digest(&c.der,"sha1"),"fingerprintSha256":digest(&c.der,"sha256"),"fingerprintSha512":digest(&c.der,"sha512"),"publicKeyPem":"","pem":""})
}
pub fn run(ctx: &RunContext<'_>) -> RunResult {
    if ctx.tool != "x509" {
        return Ok(None);
    }
    let input = opt(ctx, "pem");
    if input.is_empty() {
        return Err(bad(
            "pem",
            if en(ctx) {
                "certificate PEM is required"
            } else {
                "证书 PEM 不能为空"
            },
        ));
    }
    if input.contains("-----BEGIN CERTIFICATE REQUEST-----")
        || input.contains("-----BEGIN NEW CERTIFICATE REQUEST-----")
    {
        return Err(bad(
            "pem",
            if en(ctx) {
                "certificate requests are not certificates"
            } else {
                "证书请求不是证书"
            },
        ));
    }
    let blocks = get_certificates(&input);
    if blocks.is_empty() {
        return Err(bad(
            "pem",
            if en(ctx) {
                "no CERTIFICATE PEM block found"
            } else {
                "未找到 CERTIFICATE PEM 块"
            },
        ));
    }
    let mut certs = Vec::new();
    let mut warnings = Vec::new();
    for (i, b) in blocks.into_iter().enumerate() {
        match b.and_then(parse) {
            Ok(c) => certs.push(c),
            Err(e) if i == 0 => {
                return Err(bad(
                    "pem",
                    &format!(
                        "{}: {e}",
                        if en(ctx) {
                            "cannot parse first certificate"
                        } else {
                            "首个证书解析失败"
                        }
                    ),
                ))
            }
            Err(e) => warnings.push(format!(
                "{} {}: {e}",
                if en(ctx) { "Certificate" } else { "证书" },
                i + 1
            )),
        }
    }
    if certs.is_empty() {
        return Err(EngineError::new(
            "bad_request",
            if en(ctx) {
                "No certificate could be parsed"
            } else {
                "没有可解析的证书"
            },
        ));
    }
    let chain = bool_opt(ctx, "chain");
    let output = if opt(ctx, "output") == "full-json" {
        "full-json"
    } else {
        "summary"
    };
    let shown = if chain { &certs[..] } else { &certs[..1] };
    let mut lines = Vec::new();
    for (i, c) in shown.iter().enumerate() {
        lines.push(format!(
            "X.509 certificate {} of {} · {}",
            i + 1,
            certs.len(),
            if i == 0 {
                if en(ctx) {
                    "primary"
                } else {
                    "主证书"
                }
            } else if c.subject == c.issuer {
                if en(ctx) {
                    "self-signed"
                } else {
                    "自签名"
                }
            } else {
                if en(ctx) {
                    "chain certificate"
                } else {
                    "链证书"
                }
            }
        ));
        lines.push(format!("Subject: {}\nIssuer: {}\nSerial: {} (decimal {})\nVersion: X.509 v{}\nSignature algorithm: {}",c.subject,c.issuer,c.serial,u128::from_str_radix(&c.serial,16).unwrap_or(0),c.version,c.sig_alg));
        lines.push(format!(
            "DER size: {} bytes\nSHA-256: {}\nSHA-1: {}\nSHA-512: {}",
            c.der.len(),
            digest(&c.der, "sha256"),
            digest(&c.der, "sha1"),
            digest(&c.der, "sha512")
        ));
        lines.push(format!("Validity: {} ~ {}\nRemaining: {:.2} days\nCA: {}\nKey usage: {}\nCritical extensions: {}",time(c.from),time(c.to),(c.to-Utc::now().timestamp()) as f64/86400.,c.ca,c.key_usage.join(", "),c.critical.join(", ")));
        lines.push(format!(
            "Subject alternative names:\n{}",
            if c.sans.is_empty() {
                "(none)".into()
            } else {
                c.sans
                    .iter()
                    .map(|(k, v)| format!("  {k}: {v}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            }
        ));
        if chain {
            lines.push(input.to_string());
        }
    }
    let mut result = artifact("x509.txt", lines.join("\n\n"), serde_json::Map::new());
    if output == "full-json" {
        let vals = shown.iter().map(|c| json_cert(c)).collect::<Vec<_>>();
        let payload = if vals.len() == 1 {
            vals[0].clone()
        } else {
            json!(vals)
        };
        let bytes = format!(
            "{}\n",
            serde_json::to_string_pretty(&payload).unwrap_or_default()
        )
        .into_bytes();
        result
            .artifacts
            .push(Artifact::new("x509.json", "json", bytes));
    }
    if !warnings.is_empty() {
        result.warnings = warnings;
    }
    let primary = &certs[0];
    result.extra.insert("certs".into(), json!(shown.len()));
    result.extra.insert("total".into(), json!(certs.len()));
    result.extra.insert(
        "subject".into(),
        json!(primary
            .subject
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect::<String>()),
    );
    result.extra.insert("serial".into(), json!(primary.serial));
    result.extra.insert(
        "fingerprint256".into(),
        json!(digest(&primary.der, "sha256")),
    );
    result.extra.insert(
        "expired".into(),
        json!(if Utc::now().timestamp() > primary.to {
            "yes"
        } else {
            "no"
        }),
    );
    result.extra.insert("output".into(), json!(output));
    Ok(Some(result))
}
