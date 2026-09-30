//! X.509 certificate chain inspection and JSON export.
use super::hash::{bad, hex};
use crate::{Artifact, EngineError, RunContext, ToolResult};
use base64::Engine;
use chrono::{Local, TimeZone, Utc};
use serde_json::{json, Map, Value};
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha512};
use x509_parser::{extensions::ParsedExtension, parse_x509_certificate};

type RunResult = Result<Option<ToolResult>, EngineError>;
pub(super) struct CertInfo {
    pub(super) der: Vec<u8>,
    pub(super) subject: String,
    pub(super) issuer: String,
    pub(super) serial: String,
    pub(super) version: u32,
    pub(super) sig_alg: String,
    pub(super) sig_alg_oid: String,
    pub(super) from: i64,
    pub(super) to: i64,
    pub(super) sans: Vec<(String, String)>,
    pub(super) ca: bool,
    pub(super) has_basic_constraints: bool,
    pub(super) bc_critical: bool,
    pub(super) pathlen: Option<u32>,
    pub(super) has_key_usage: bool,
    pub(super) ku_critical: bool,
    pub(super) has_eku: bool,
    pub(super) key_usage: Vec<String>,
    pub(super) eku: Vec<String>,
    pub(super) ski: String,
    pub(super) aki: String,
    pub(super) critical: Vec<String>,
    pub(super) spki_der: Vec<u8>,
    pub(super) key_algorithm: String,
    pub(super) key_bits: u32,
    pub(super) curve: Option<String>,
}

/// Length of the DER TLV starting at `at`.
fn tlv_total(data: &[u8], at: usize) -> usize {
    let first = *data.get(at + 1).unwrap_or(&0) as usize;
    let (length, header) = if first & 0x80 == 0 {
        (first, 2)
    } else {
        let count = first & 0x7f;
        let mut length = 0usize;
        for offset in 0..count {
            length = (length << 8) | *data.get(at + 2 + offset).unwrap_or(&0) as usize;
        }
        (length, 2 + count)
    };
    header + length
}

/// Content start (after the header) of the DER TLV at `at`.
fn tlv_content(data: &[u8], at: usize) -> usize {
    let first = *data.get(at + 1).unwrap_or(&0) as usize;
    if first & 0x80 == 0 {
        at + 2
    } else {
        at + 2 + (first & 0x7f)
    }
}

/// The SubjectPublicKeyInfo TLV is the sixth field of the TBS certificate.
fn spki_der_of(cert_der: &[u8]) -> Vec<u8> {
    let tbs_start = tlv_content(cert_der, 0);
    let mut cursor = tlv_content(cert_der, tbs_start);
    if cert_der.get(cursor) == Some(&0xa0) {
        cursor += tlv_total(cert_der, cursor);
    }
    for _ in 0..5 {
        cursor += tlv_total(cert_der, cursor);
    }
    let total = tlv_total(cert_der, cursor);
    cert_der[cursor..(cursor + total).min(cert_der.len())].to_vec()
}

fn rsa_bit_length(key_data: &[u8]) -> u32 {
    // keyData = 0x00 || SEQUENCE { INTEGER modulus, INTEGER exponent }
    let body = if key_data.first() == Some(&0x00) {
        &key_data[1..]
    } else {
        key_data
    };
    let mut at = 1; // skip SEQUENCE tag
    let first = *body.get(at).unwrap_or(&0) as usize;
    at += if first & 0x80 == 0 {
        1
    } else {
        1 + (first & 0x7f)
    };
    if body.get(at) != Some(&0x02) {
        return (body.len() * 8) as u32;
    }
    at += 1;
    let first = *body.get(at).unwrap_or(&0) as usize;
    let (length, header) = if first & 0x80 == 0 {
        (first, 1)
    } else {
        let count = first & 0x7f;
        let mut length = 0usize;
        for offset in 0..count {
            length = (length << 8) | *body.get(at + 1 + offset).unwrap_or(&0) as usize;
        }
        (length, 1 + count)
    };
    at += header;
    let modulus = &body[at..(at + length).min(body.len())];
    let stripped = modulus
        .iter()
        .skip_while(|b| **b == 0)
        .copied()
        .collect::<Vec<_>>();
    if stripped.is_empty() {
        return 0;
    }
    let lead = stripped[0].leading_zeros();
    (stripped.len() as u32) * 8 - lead
}

const SIGNATURE_ALG_NAMES: [(&str, &str); 6] = [
    ("1.2.840.113549.1.1.5", "sha1WithRSAEncryption"),
    ("1.2.840.113549.1.1.11", "sha256WithRSAEncryption"),
    ("1.2.840.113549.1.1.12", "sha384WithRSAEncryption"),
    ("1.2.840.113549.1.1.13", "sha512WithRSAEncryption"),
    ("1.2.840.10045.4.3.2", "ecdsa-with-SHA256"),
    ("1.2.840.10045.4.3.3", "ecdsa-with-SHA384"),
];

const EC_CURVE_NAMES: [(&str, &str); 8] = [
    ("1.2.840.10045.3.1.1", "prime192v1"),
    ("1.2.840.10045.3.1.7", "prime256v1"),
    ("1.3.132.0.10", "secp256k1"),
    ("1.3.132.0.31", "secp192k1"),
    ("1.3.132.0.33", "secp224r1"),
    ("1.3.132.0.34", "secp384r1"),
    ("1.3.132.0.35", "secp521r1"),
    ("1.3.36.3.3.2.8.1.1.7", "brainpoolP256r1"),
];
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
    let (mut has_basic_constraints, mut bc_critical, mut pathlen) = (false, false, None);
    let (mut has_key_usage, mut ku_critical, mut has_eku) = (false, false, false);
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
            ParsedExtension::BasicConstraints(b) => {
                ca = b.ca;
                has_basic_constraints = true;
                bc_critical = ext.critical;
                pathlen = b.path_len_constraint;
            }
            ParsedExtension::KeyUsage(u) => {
                has_key_usage = true;
                ku_critical = ext.critical;
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
                has_eku = true;
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
        .trim_start_matches('0')
        .to_ascii_uppercase();
    let serial = if serial.is_empty() {
        "0".into()
    } else {
        serial
    };
    let version = cert.version().0 + 1;
    let sig_alg_oid = cert.signature_algorithm.algorithm.to_id_string();
    let sig_alg = SIGNATURE_ALG_NAMES
        .iter()
        .find(|(oid, _)| *oid == sig_alg_oid)
        .map(|(_, name)| name.to_string())
        .unwrap_or_else(|| sig_alg_oid.clone());
    let spki = &cert.tbs_certificate.subject_pki;
    let spki_der = spki_der_of(&der);
    let key_algorithm_oid = spki.algorithm.algorithm.to_id_string();
    let key_data = spki.subject_public_key.data.to_vec();
    let parameters = spki
        .algorithm
        .parameters
        .as_ref()
        .map(|p| p.as_oid().map(|oid| oid.to_id_string()).unwrap_or_default())
        .unwrap_or_default();
    let (key_algorithm, key_bits, curve) = match key_algorithm_oid.as_str() {
        "1.2.840.113549.1.1.1" => ("rsa".to_string(), rsa_bit_length(&key_data), None),
        "1.2.840.10045.2.1" => {
            let curve = EC_CURVE_NAMES
                .iter()
                .find(|(oid, _)| *oid == parameters)
                .map(|(_, name)| name.to_string());
            ("ec".to_string(), 256, curve)
        }
        "1.3.101.112" => ("ed25519".to_string(), 256, None),
        "1.3.101.113" => ("ed448".to_string(), 456, None),
        other => (other.to_string(), 0, None),
    };
    let from = cert.validity().not_before.timestamp();
    let to = cert.validity().not_after.timestamp();
    Ok(CertInfo {
        der,
        subject,
        issuer,
        serial,
        version,
        sig_alg,
        sig_alg_oid,
        from,
        to,
        sans,
        ca,
        has_basic_constraints,
        bc_critical,
        pathlen,
        has_key_usage,
        ku_critical,
        has_eku,
        key_usage,
        eku,
        ski,
        aki,
        critical,
        spki_der,
        key_algorithm,
        key_bits,
        curve,
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
    let report = super::x509_report::render(ctx, &certs, shown, chain, &warnings, &input);
    let mut result = report;

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
