//! X.509 text report framing, mirroring the product engine's `sec.x509.*` output.

use super::x509::CertInfo;
use crate::tools::text::fmt::{align_rows, join_blocks, row, section};
use crate::{Artifact, RunContext, ToolResult};
use chrono::{Local, TimeZone, Utc};
use serde_json::{json, Map};
use sha2::Digest as _;

fn sec(en: bool, zh: &str, english: &str) -> String {
    if en {
        english.to_string()
    } else {
        zh.to_string()
    }
}

/// COLON-separated uppercase fingerprint, like the engine's fingerprint().
fn fingerprint(bytes: &[u8], kind: &str) -> String {
    let plain = match kind {
        "sha1" => super::hash::hex(&sha1::Sha1::digest(bytes), false),
        "sha512" => super::hash::hex(&sha2::Sha512::digest(bytes), false),
        _ => super::hash::hex(&sha2::Sha256::digest(bytes), false),
    };
    plain
        .as_bytes()
        .chunks(2)
        .map(|pair| std::str::from_utf8(pair).unwrap_or("").to_uppercase())
        .collect::<Vec<_>>()
        .join(":")
}

/// BigInt-free hex -> decimal (serials can exceed u128).
fn hex_to_decimal(hex: &str) -> String {
    let mut digits: Vec<u8> = vec![0];
    for character in hex.chars() {
        let mut value = character.to_digit(16).unwrap_or(0);
        for digit in digits.iter_mut() {
            let carry = *digit as u32 * 16 + value;
            *digit = (carry % 10) as u8;
            value = carry / 10;
        }
        while value > 0 {
            digits.push((value % 10) as u8);
            value /= 10;
        }
    }
    while digits.len() > 1 && digits.last() == Some(&0) {
        digits.pop();
    }
    digits.iter().rev().map(|d| (b'0' + d) as char).collect()
}

fn local_stamp(ts: i64, en: bool) -> String {
    Local
        .timestamp_opt(ts, 0)
        .single()
        .map(|dt| {
            if en {
                dt.format("%-m/%-d/%Y, %H:%M:%S").to_string()
            } else {
                dt.format("%Y/%-m/%-d %H:%M:%S").to_string()
            }
        })
        .unwrap_or_else(|| "invalid date".into())
}

fn zone_label() -> String {
    let minutes = Local::now().offset().local_minus_utc() / 60;
    let sign = if minutes < 0 { '-' } else { '+' };
    let abs = minutes.abs();
    format!("UTC{sign}{:02}:{:02}", abs / 60, abs % 60)
}

fn iso_stamp(ts: i64) -> String {
    Utc.timestamp_opt(ts, 0)
        .single()
        .map(|dt| dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
        .unwrap_or_default()
}

/// The engine's parseDn over dn(): attributes already joined by new lines,
/// split on commas, first "=" splits the label from the remainder.
fn dn_rows(subject: &str) -> String {
    // The engine's dn() prints one attribute per line; the Rust parser uses
    // ", " separators, so normalize to the line form first.
    let subject = subject.replace(", ", "\n");
    let chunks: Vec<&str> = subject.split(',').collect();
    let part = chunks.first().copied().unwrap_or("").trim();
    match part.find('=') {
        Some(at) => align_rows(&[row(
            format!("  {}", part[..at].trim()),
            part[at + 1..].trim(),
        )]),
        None => align_rows(&[row(sec(false, "  原文", "  Raw DN"), part)]),
    }
}

fn key_usage_names(c: &CertInfo, en: bool) -> String {
    const ZH: [&str; 9] = [
        "数字签名 digitalSignature",
        "不可否认 nonRepudiation",
        "密钥加密 keyEncipherment",
        "数据加密 dataEncipherment",
        "密钥协商 keyAgreement",
        "证书签发 keyCertSign",
        "CRL 签发 cRLSign",
        "仅加密 encipherOnly",
        "仅解密 decipherOnly",
    ];
    const KEYS: [&str; 9] = [
        "digitalSignature",
        "nonRepudiation",
        "keyEncipherment",
        "dataEncipherment",
        "keyAgreement",
        "keyCertSign",
        "cRLSign",
        "encipherOnly",
        "decipherOnly",
    ];
    KEYS
        .iter()
        .enumerate()
        .filter(|(index, _)| c.key_usage.iter().any(|name| name == KEYS[*index]))
        .map(|(index, _)| {
            if en {
                KEYS[index].to_string()
            } else {
                ZH[index].to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(if en { ", " } else { "、" })
}

fn eku_names(c: &CertInfo, en: bool) -> String {
    const MAP: [(&str, &str, &str); 8] = [
        ("serverAuth", "服务器认证 serverAuth", "serverAuth"),
        ("clientAuth", "客户端认证 clientAuth", "clientAuth"),
        ("codeSigning", "代码签名 codeSigning", "codeSigning"),
        ("emailProtection", "邮件保护 emailProtection", "emailProtection"),
        ("timeStamping", "时间戳 timeStamping", "timeStamping"),
        ("OCSPSigning", "安全电子邮件 secureEmail", "secureEmail"),
        ("2.23.140.1.2.1", "DV 证书 domainValidated", "DV certificate domainValidated"),
        ("2.23.140.1.2.2", "OV 证书 organizationValidated", "OV certificate organizationValidated"),
    ];
    c.eku
        .iter()
        .map(|name| {
            MAP.iter()
                .find(|(key, _, _)| key == name)
                .map(|(_, zh, english)| if en { english.to_string() } else { zh.to_string() })
                .unwrap_or_else(|| name.clone())
        })
        .collect::<Vec<_>>()
        .join(if en { ", " } else { "、" })
}

pub(super) fn render(
    ctx: &RunContext<'_>,
    certs: &[CertInfo],
    shown: &[CertInfo],
    chain: bool,
    warnings: &[String],
    pem_blocks: &str,
) -> ToolResult {
    let en = ctx.locale.starts_with("en");
    let now = Utc::now().timestamp();
    let mut out: Vec<String> = Vec::new();
    for (index, c) in shown.iter().enumerate() {
        let chain_label = if index == 0 {
            sec(en, "（叶证书）", " (leaf)")
        } else if c.subject == c.issuer {
            sec(en, "（自签根）", " (self-signed root)")
        } else { sec(en, "（链上级）", " (chain issuer)") };
        let remaining_days = (c.to - now) as f64 / 86_400.0;
        let total_days = (c.to - c.from) as f64 / 86_400.0;
        let key_bits = if c.key_bits > 0 {
            format!(" · {} bit", c.key_bits)
        } else {
            String::new()
        };
        let curve = c
            .curve
            .as_ref()
            .map(|name| {
                if en {
                    format!(" - curve {name}")
                } else {
                    format!(" · 曲线 {name}")
                }
            })
            .unwrap_or_default();
        let bc_value = if c.has_basic_constraints {
            format!(
                "CA:{}{}{}",
                if c.ca { "TRUE" } else { "FALSE" },
                c.pathlen.map(|len| format!(", pathlen:{len}")).unwrap_or_default(),
                if c.bc_critical { " · critical" } else { "" }
            )
        } else {
            sec(en, "证书未包含该扩展", "the certificate has no such extension")
        };
        let key_usage_value = if c.has_key_usage {
            let text = key_usage_names(c, en);
            let text = if text.is_empty() {
                sec(en, "（无命名位）", "(no named bits)").to_string()
            } else {
                text
            };
            format!("{text}{}", if c.ku_critical { " · critical" } else { "" })
        } else {
            sec(en, "证书未包含该扩展", "the certificate has no such extension")
        };
        let eku_value = if c.has_eku { eku_names(c, en) } else { sec(en, "证书未包含该扩展", "the certificate has no such extension") };
        let state = if now < c.from {
            sec(en, "未生效（notBefore 未到）", "not yet valid (notBefore not reached)")
        } else if now > c.to {
            sec(en, "已过期（notAfter 已过）", "expired (notAfter has passed)")
        } else {
            sec(en, "有效期内", "within its validity period")
        };
        let relative = crate::tools::text::fmt::relative_phrase(
            (c.to - now) * 1000,
            if en { "en-US" } else { "zh-CN" },
            false,
        );
        let zone = zone_label();
        let local = |ts: i64| local_stamp(ts, en);
        let mut blocks = vec![
            section(&format!(
                "{}{chain_label}",
                if en {
                    format!("Certificate {}/{}", index + 1, certs.len())
                } else {
                    format!("证书 {}/{}", index + 1, certs.len())
                }
            )),
            align_rows(&[
                row(sec(en, "序列号", "Serial number"), c.serial.clone()),
                row(
                    sec(en, "序列号（十进制）", "Serial number (decimal)"),
                    hex_to_decimal(&c.serial),
                ),
                row(
                    sec(en, "公钥算法", "Public key algorithm"),
                    format!("{}{key_bits}{curve}", c.key_algorithm),
                ),
                row(
                    sec(en, "证书 DER 长度", "Certificate DER length"),
                    format!(
                        "{}{}",
                        c.der.len(),
                        if en { " bytes" } else { " 字节" }
                    ),
                ),
                row(
                    sec(en, "公钥 SPKI SHA-256", "Public key SPKI SHA-256"),
                    fingerprint(&c.spki_der, "sha256"),
                ),
                row(sec(en, "指纹 SHA-1", "Fingerprint SHA-1"), fingerprint(&c.der, "sha1")),
                row(sec(en, "指纹 SHA-256", "Fingerprint SHA-256"), fingerprint(&c.der, "sha256")),
                row(sec(en, "指纹 SHA-512", "Fingerprint SHA-512"), fingerprint(&c.der, "sha512")),
            ]),
            section(&sec(en, "主体（subject）", "Subject")),
            dn_rows(&c.subject),
            section(&sec(en, "颁发者（issuer）", "Issuer")),
            dn_rows(&c.issuer),
            section(&sec(en, "有效期", "Validity")),
            align_rows(&[
                row(
                    "notBefore",
                    if en {
                        format!("{} (local {zone}) - {}", local(c.from), iso_stamp(c.from))
                    } else {
                        format!("{}（本地 {zone}） · {}", local(c.from), iso_stamp(c.from))
                    },
                ),
                row(
                    "notAfter",
                    if en {
                        format!("{} (local {zone}) - {}", local(c.to), iso_stamp(c.to))
                    } else {
                        format!("{}（本地 {zone}） · {}", local(c.to), iso_stamp(c.to))
                    },
                ),
                row(
                    sec(en, "剩余时间", "Time left"),
                    if en {
                        format!(
                            "{} {:.2} days - {relative}",
                            if remaining_days >= 0.0 { "valid for" } else { "overdue by" },
                            remaining_days.abs()
                        )
                    } else {
                        format!(
                            "{} {:.2} 天 · {relative}",
                            if remaining_days >= 0.0 { "还有" } else { "已过期" },
                            remaining_days.abs()
                        )
                    },
                ),
                row(
                    sec(en, "总有效期", "Total validity"),
                    format!(
                        "{:.2}{}{}",
                        total_days,
                        if en { " days" } else { " 天" },
                        if total_days > 398.0 {
                            sec(en, "（超出浏览器信任上限 398 天）", " (above the 398-day browser trust limit)")
                        } else {
                            sec(en, "（在 398 天内）", " (within 398 days)")
                        }
                    ),
                ),
                row(sec(en, "当前状态", "Current state"), state),
            ]),
            section(&sec(en, "使用者备用名（SAN）", "Subject alternative name (SAN)")),
            if c.sans.is_empty() {
                align_rows(&[row(
                    format!("  {}", sec(en, "结果", "Result")),
                    sec(
                        en,
                        "证书未包含 subjectAltName 扩展",
                        "the certificate has no subjectAltName extension",
                    ),
                )])
            } else {
                align_rows(
                    &c.sans
                        .iter()
                        .map(|(kind, value)| row(format!("  {kind}"), value.clone()))
                        .collect::<Vec<_>>(),
                )
            },
            section(&sec(en, "扩展与用途", "Extensions and usage")),
            align_rows(&[
                row(sec(en, "版本", "Version"), format!("X.509 v{}", c.version)),
                row(sec(en, "签名算法", "Signature algorithm"), c.sig_alg.clone()),
                row(
                    sec(en, "签名算法 OID", "Signature algorithm OID"),
                    c.sig_alg_oid.clone(),
                ),
                row("basicConstraints", bc_value),
                row(
                    sec(en, "CA 判定", "CA verdict"),
                    format!(
                        "{}{}{ca}",
                        sec(
                            en,
                            if c.ca { "CA 证书（可签发下级）" } else { "终端实体（不可签发下级）" },
                            if c.ca { "CA certificate (may issue sub-certificates)" } else { "end entity (may not issue sub-certificates)" }
                        ),
                        if en { " - node ca property = " } else { " · node ca 属性 = " },
                        ca = c.ca
                    ),
                ),
                row("keyUsage", key_usage_value),
                row("extendedKeyUsage", eku_value),
                row("subjectKeyIdentifier", c.ski.clone()),
                row("authorityKeyIdentifier", c.aki.clone()),
                row(
                    sec(en, "critical 扩展 OID", "critical extension OIDs"),
                    if c.critical.is_empty() {
                        sec(en, "无", "None")
                    } else {
                        c.critical.join(if en { ", " } else { "、" })
                    },
                ),
                row(
                    sec(en, "SAN 条目数", "SAN entries"),
                    c.sans.len().to_string(),
                ),
                row(
                    sec(en, "infoAccess（OCSP/CA Issuers）", "infoAccess (OCSP/CA Issuers)"),
                    sec(en, "无", "None"),
                ),
            ]),
            section(&sec(en, "链与信任", "Chain and trust")),
            align_rows(&[
                row(
                    sec(en, "自签名", "Self-signed"),
                    if c.subject == c.issuer {
                        sec(en, "是（颁发者 = 主体）", "yes (issuer = subject)")
                    } else {
                        sec(en, "否", "No")
                    },
                ),
                row(
                    sec(en, "可否签发下级", "Can issue sub-certificates"),
                    if !c.has_basic_constraints {
                        format!(
                            "{}{false}",
                            sec(en, "未声明，按 ca 属性判定：", "not declared, decided from the ca property: "),
                            false = c.ca
                        )
                    } else if c.ca {
                        sec(en, "是（basicConstraints CA:TRUE）", "yes (basicConstraints CA:TRUE)")
                    } else {
                        sec(en, "否（CA:FALSE）", "no (CA:FALSE)")
                    },
                ),
                row(
                    sec(en, "剩余天数", "Days left"),
                    format!(
                        "{:.2}{} · {relative}",
                        remaining_days.abs(),
                        if en { " days" } else { " 天" }
                    ),
                ),
                row(
                    sec(en, "同链上一张签发关系", "Issuance link inside the chain"),
                    "—".to_string(),
                ),
            ]),
        ];
        if chain {
            blocks.push(section(&sec(en, "PEM 块", "PEM block")));
            blocks.push(pem_blocks.to_string());
        }
        out.push(join_blocks(blocks.iter().map(String::as_str)));
    }
    let notes = vec![
        sec(
            en,
            "· 主体、issuer、序列号、公钥及扩展从证书 DER 解析；指纹使用 SHA-1/SHA-256/SHA-512 计算。本工具不验证证书链是否受系统信任。",
            "- Subject, issuer, serial, public key and extensions are parsed from the certificate DER; SHA-1/SHA-256/SHA-512 fingerprints are calculated locally. This tool does not verify the chain against system trust.",
        ),
        sec(
            en,
            "· 有效期同时给出本地时区（含 UTC 偏移）、UTC ISO 与相对描述，剩余天数按 notAfter−now 计算。",
            "- Validity is shown in the local zone (with the UTC offset), in UTC ISO and as a relative phrase; the remaining days are computed as notAfter minus now.",
        ),
        sec(
            en,
            "· 指纹为证书 DER 的摘要：SHA-1 用于兼容性比对，日常核验请用 SHA-256。",
            "- Fingerprints are digests of the certificate DER: SHA-1 is kept for compatibility checks, use SHA-256 for day-to-day verification.",
        ),
        sec(
            en,
            "· basicConstraints/keyUsage 等扩展在证书未携带时明确标注“未包含该扩展”，不会凭空补默认值。",
            "- When a certificate carries no basicConstraints/keyUsage extension the output says so explicitly instead of inventing a default.",
        ),
        if chain {
            sec(
                en,
                &format!("· chain=true：已逐个解析并打印全部 {} 个 PEM 块。", certs.len()),
                &format!("- chain=true: all {} PEM blocks were parsed and printed one by one.", certs.len()),
            )
        } else {
            sec(
                en,
                &format!("· chain=false：只展开第 1 张（共检测到 {} 张），需要看链请打开 chain。", certs.len()),
                &format!("- chain=false: only the first certificate is expanded ({} were detected); turn chain on to see the chain.", certs.len()),
            )
        },
        sec(
            en,
            "· output=summary：只看摘要，可用 full-json 导出结构化数据。",
            "- output=summary: summary only; use full-json to export structured data.",
        ),
    ];
    out.push(join_blocks([
        section(&sec(en, "说明", "Notes")).as_str(),
        notes.join("\n").as_str(),
    ]));
    if !warnings.is_empty() {
        out.push(join_blocks([
            section(&sec(en, "注意", "Warning")).as_str(),
            warnings
                .iter()
                .map(|warning| format!("· {warning}"))
                .collect::<Vec<_>>()
                .join("\n")
                .as_str(),
        ]));
    }
    let body = format!("{}\n", out.join("\n\n").trim_end());
    let mut extra = Map::new();
    let primary = &certs[0];
    extra.insert("certs".into(), json!(shown.len()));
    extra.insert("total".into(), json!(certs.len()));
    extra.insert("serial".into(), json!(primary.serial));
    extra.insert(
        "fingerprint256".into(),
        json!(fingerprint(&primary.der, "sha256")),
    );
    extra.insert(
        "expired".into(),
        json!(if now > primary.to { "yes" } else { "no" }),
    );
    let result = Artifact::new("x509.txt", "text", body.clone().into_bytes());
    ToolResult {
        text: Some(body),
        artifacts: vec![result],
        warnings: Vec::new(),
        extra,
    }
}
