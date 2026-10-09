//! TOTP report framing, mirroring the product engine's `sec.totp.*` output.

use super::super::hash::hex;
use super::*;
use crate::tools::text::fmt::{align_rows, join_blocks, row, section};
use crate::{EngineError, RunContext, ToolResult};
use serde_json::json;
use sha2::{Digest, Sha256};

fn local_time(ms: i64, en: bool) -> String {
    let dt = Local
        .timestamp_millis_opt(ms)
        .single()
        .unwrap_or_else(|| Local.timestamp_millis_opt(0).unwrap());
    if en {
        dt.format("%-m/%-d/%Y, %H:%M:%S").to_string()
    } else {
        dt.format("%Y/%-m/%-d %H:%M:%S").to_string()
    }
}

fn offset_label(offset: i64, en: bool) -> String {
    let value = if offset == 0 {
        if en {
            " 0 (current)".to_string()
        } else {
            " 0（当前）".to_string()
        }
    } else if offset > 0 {
        format!("+{offset}")
    } else {
        offset.to_string()
    };
    format!("{}{}", if en { "offset " } else { "偏移 " }, value)
}

#[rustfmt::skip]
pub(super) fn report(
    ctx: &RunContext<'_>,
    uri: bool,
    overrides: &[String],
    mode: &str,
    secret: &[u8],
    algo: &str,
    digits: u32,
    period: u32,
    window: u32,
    at: i64,
    label: &str,
    code_arg: &str,
) -> Result<ToolResult, EngineError> {
    let en = en(ctx);
    let nowsec = at.div_euclid(1000);
    let counter = nowsec.div_euclid(period as i64);
    let elapsed = nowsec.rem_euclid(period as i64) as u32;
    let rem = period - elapsed;
    let (current, binary) = hotp(secret, counter, algo, digits)?;
    let title = if en {
        format!(
            "TOTP {} - {} - {} digits - {}s",
            if mode == "verify" { "verify" } else { "generation" },
            algo.to_uppercase(),
            digits,
            period
        )
    } else {
        format!(
            "TOTP {} · {} · {} 位 · {}s",
            if mode == "verify" { "校验" } else { "生成" },
            algo.to_uppercase(),
            digits,
            period
        )
    };
    if mode == "verify" {
        return verify_report(
            ctx, uri, overrides, secret, algo, digits, period, window, at, label, code_arg,
            counter, rem, title,
        );
    }
    let fingerprint = hex(&Sha256::digest(secret), true);
    let next = hotp(secret, counter + 1, algo, digits)?.0;
    let mut blocks = vec![
        section(&title),
        align_rows(&[
            row(sec(en, "当前口令", "Current code"), current.clone()),
            row(
                sec(en, "剩余有效", "Time left"),
                if en {
                    format!(
                        "{rem} seconds (this step runs {} to {})",
                        local_time(counter * period as i64 * 1000, en),
                        local_time((counter + 1) * period as i64 * 1000 - 1, en)
                    )
                } else {
                    format!(
                        "{rem} 秒（本步 {} 起，{} 止）",
                        local_time(counter * period as i64 * 1000, en),
                        local_time((counter + 1) * period as i64 * 1000 - 1, en)
                    )
                },
            ),
            row(sec(en, "下一步口令", "Next code"), next),
            row(
                sec(en, "基准时刻", "Reference time"),
                format!("{} · {}", local_time(at, en), label),
            ),
            row(
                sec(en, "计数器 T", "Counter T"),
                format!("{counter} = floor({nowsec} / {period})"),
            ),
            row(
                sec(en, "密钥", "Key"),
                if en {
                    format!(
                        "{} ({} bytes - SHA-256 fingerprint {fingerprint})",
                        encode32(secret),
                        secret.len()
                    )
                } else {
                    format!(
                        "{}（{} 字节 · SHA-256 指纹 {fingerprint}）",
                        encode32(secret),
                        secret.len()
                    )
                },
            ),
            row(
                sec(en, "动态截断", "Dynamic truncation"),
                format!("binary={binary} → mod {} → {current}", 10u32.pow(digits)),
            ),
        ]),
        section(&format!(
            "{}{}{}",
            sec(en, "窗口内容口令（±", "Codes inside the window (+/-"),
            window,
            sec(en, " 步）", " steps)")
        )),
        window_rows(secret, algo, digits, counter, window, en)?,
    ];
    if digits != 8 {
        let c8 = hotp(secret, counter, algo, 8)?.0;
        blocks.push(section(sec(
            en,
            "RFC 6238 对照（同一密钥的 8 位形式）",
            "RFC 6238 comparison (8-digit form of the same key)",
        )));
        blocks.push(align_rows(&[
            row(sec(en, "8 位口令", "8-digit code"), c8.clone()),
            row(
                if en {
                    format!("{digits}-digit relation")
                } else {
                    format!("{digits} 位关系")
                },
                if en {
                    format!(
                        "mod 10^{digits} is the low {digits} digits of the 8-digit value: {}",
                        &c8[(8 - digits as usize)..]
                    )
                } else {
                    format!(
                        "对 10^{digits} 取模即 8 位值的低 {digits} 位：{}",
                        &c8[(8 - digits as usize)..]
                    )
                },
            ),
        ]));
    }
    let reference_code = hotp(&decode32_static()?, 1, "sha1", 8)?.0;
    let overrides_text = overrides.join(if en { ", " } else { "、" });
    let mut notes = vec![
        if en {
            format!("- seconds left = (T+1)*period - now = {rem}s; the code changes the moment it crosses.")
        } else {
            format!("· 剩余秒数 = (T+1)×period − now = {rem}s，跨过后口令立即更换。")
        },
        sec(
            en,
            "· 计数器按 8 字节大端写入 HMAC，只要双方密钥与时钟一致就能对上。",
            "- The counter is written to the HMAC as 8 big-endian bytes, so both sides agree as long as the key and the clock match.",
        )
        .to_string(),
        if uri {
            if en {
                format!(
                    "- otpauth URI parsed: {}; query parameters win over the digits/period/algorithm fields.",
                    if overrides_text.is_empty() { "secret only" } else { &overrides_text }
                )
            } else {
                format!(
                    "· otpauth URI 已解析：{}；query 参数优先于 digits/period/algorithm 字段。",
                    if overrides_text.is_empty() { "仅含 secret" } else { &overrides_text }
                )
            }
        } else {
            sec(
                en,
                "· 密钥按 RFC 4648 base32 解码，忽略空格/连字符与 padding。",
                "- The key is decoded as RFC 4648 base32, ignoring spaces/hyphens and padding.",
            )
            .to_string()
        },
        if en {
            format!(
                "- The full RFC 6238 vector reproduces with digits=8 + at=<T> (secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ, SHA1, T=59 gives {reference_code})."
            )
        } else {
            format!(
                "· 完整 RFC 6238 用例可用 digits=8 + at=<T> 复现（如 secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ、SHA1、T=59 → {reference_code}）。"
            )
        },
    ];
    blocks.push(section(sec(en, "说明", "Notes")));
    blocks.append(&mut notes_to_block(&mut notes));
    let mut extra = serde_json::Map::new();
    extra.insert("mode".into(), json!(mode));
    extra.insert("code".into(), json!(current));
    extra.insert("remaining".into(), json!(rem));
    extra.insert("digits".into(), json!(digits));
    extra.insert("period".into(), json!(period));
    extra.insert("algorithm".into(), json!(algo));
    extra.insert("counter".into(), json!(counter));
    extra.insert("secretBytes".into(), json!(secret.len()));
    let body = format!("{}\n", join_blocks(blocks.iter().map(String::as_str)).trim_end());
    let result = artifact("totp.txt", body.clone(), extra);
    Ok(ToolResult { text: Some(body), ..result })
}

fn notes_to_block(notes: &mut Vec<String>) -> Vec<String> {
    vec![std::mem::take(notes).join("\n")]
}

fn window_rows(
    secret: &[u8],
    algo: &str,
    digits: u32,
    counter: i64,
    window: u32,
    en: bool,
) -> Result<String, EngineError> {
    let mut rows = Vec::new();
    for offset in -(window as i64)..=(window as i64) {
        let step = counter + offset;
        let value = if step < 0 {
            sec(en, "（计数器为负）", "(counter is negative)").to_string()
        } else {
            hotp(secret, step, algo, digits)?.0
        };
        rows.push(row(offset_label(offset, en), format!("{value} · T={step}")));
    }
    Ok(align_rows(&rows))
}

#[allow(clippy::too_many_arguments)]
fn verify_report(
    ctx: &RunContext<'_>,
    uri: bool,
    overrides: &[String],
    secret: &[u8],
    algo: &str,
    digits: u32,
    period: u32,
    window: u32,
    at: i64,
    label: &str,
    code_arg: &str,
    counter: i64,
    rem: u32,
    title: String,
) -> Result<ToolResult, EngineError> {
    let en = en(ctx);
    let candidate = code_arg.replace([' ', '\t', '\r', '\n', '-', '_'], "");
    if candidate.is_empty() {
        return Err(invalid(
            "code",
            "mode=verify requires the one-time code",
            "",
            ctx,
        ));
    }
    if !candidate.chars().all(|c| c.is_ascii_digit()) {
        return Err(invalid(
            "code",
            "the code may only contain digits",
            "123456",
            ctx,
        ));
    }
    let normalized = if candidate.len() == digits as usize {
        candidate.clone()
    } else {
        format!(
            "{:0>width$}",
            &candidate[candidate.len().saturating_sub(digits as usize)..],
            width = digits as usize
        )
    };
    let mut table = Vec::new();
    let mut hits = Vec::new();
    for offset in -(window as i64)..=(window as i64) {
        let step = counter + offset;
        if step < 0 {
            table.push(row(
                offset_label(offset, en),
                sec(en, "计数器为负，跳过", "counter is negative, skipped").to_string(),
            ));
            continue;
        }
        let value = hotp(secret, step, algo, digits)?.0;
        let hit = value == normalized;
        if hit {
            hits.push((offset, step, value.clone()));
        }
        table.push(row(
            offset_label(offset, en),
            format!(
                "{value} · T={step}{}",
                if hit {
                    sec(en, "  ✓ 命中", "  matched")
                } else {
                    ""
                }
            ),
        ));
    }
    let mut blocks = vec![
        section(&title),
        align_rows(&[
            row(sec(en, "待校验口令", "Code to check"), normalized),
            row(
                sec(en, "基准时刻", "Reference time"),
                format!("{} · {}", local_time(at, en), label),
            ),
            row(
                sec(en, "当前步长 T", "Current step T"),
                if en {
                    format!("{counter} ({rem} seconds left in this step)")
                } else {
                    format!("{counter}（本步剩余 {rem} 秒）")
                },
            ),
            row(
                sec(en, "容差窗口", "Tolerance window"),
                if en {
                    format!("+/-{window} steps ({} candidates compared)", table.len())
                } else {
                    format!("±{window} 步（共比对 {} 个候选）", table.len())
                },
            ),
            row(
                sec(en, "结果", "Result"),
                match hits.first() {
                    Some((offset, step, _)) if en => {
                        format!("✓ matched at offset {offset} (T={step})")
                    }
                    Some((offset, step, _)) => format!("✓ 命中（偏移 {offset} 步 · T={step}）"),
                    None => sec(
                        en,
                        "✗ 未在窗口内命中任何步长",
                        "no step inside the window matched",
                    )
                    .to_string(),
                },
            ),
        ]),
        section(sec(en, "逐步比对", "Step-by-step comparison")),
        align_rows(&table),
    ];
    if !hits.is_empty() {
        let rows = hits
            .iter()
            .map(|(offset, step, code)| {
                let state = if *step == counter {
                    sec(en, "当前有效", "currently valid").to_string()
                } else if *step < counter {
                    if en {
                        "already expired".to_string()
                    } else {
                        "已失效".to_string()
                    }
                } else {
                    sec(
                        en,
                        "未来步长（时钟可能超前）",
                        "future step (the local clock may run ahead)",
                    )
                    .to_string()
                };
                row(
                    offset_label(*offset, en),
                    if en {
                        format!(
                            "T={step} - code {code} - valid {} ~ {} - {state}",
                            local_time(step * period as i64 * 1000, en),
                            local_time((step + 1) * period as i64 * 1000 - 1, en)
                        )
                    } else {
                        format!(
                            "T={step} · 口令 {code} · 有效区间 {} ~ {} · {state}",
                            local_time(step * period as i64 * 1000, en),
                            local_time((step + 1) * period as i64 * 1000 - 1, en)
                        )
                    },
                )
            })
            .collect::<Vec<_>>();
        blocks.push(section(sec(en, "命中步长详情", "Matching steps")));
        blocks.push(align_rows(&rows));
    }
    let overrides_text = overrides.join(if en { ", " } else { "、" });
    let mut notes = vec![
        if en {
            format!("- code = truncation of HMAC-{}(key, 8-byte big-endian counter) mod 10^{digits}, leading zeroes kept.", algo.to_uppercase())
        } else {
            format!(
                "· 口令 = HMAC-{}(密钥, 8 字节大端计数器) 动态截断后 mod 10^{digits}，前导零保留。",
                algo.to_uppercase()
            )
        },
        if uri {
            if en {
                format!(
                    "- The input is an otpauth URI, whose query parameters win over the form fields: {}.",
                    if overrides_text.is_empty() { "no overrides" } else { &overrides_text }
                )
            } else {
                format!(
                    "· 输入为 otpauth URI，query 参数优先于表单字段：{}。",
                    if overrides_text.is_empty() {
                        "无覆盖"
                    } else {
                        &overrides_text
                    }
                )
            }
        } else {
            sec(en, "· 输入为 base32 密钥：忽略空格、连字符、下划线与 padding。", "- The input is a base32 key: spaces, hyphens, underscores and padding are ignored.").to_string()
        },
        if en {
            format!("- The matching step need not be the current one: a non-zero offset means the local clock differs from the authenticator by about {period} seconds.")
        } else {
            format!("· 命中步长可能不是当前步：偏移非 0 说明本机时钟与认证源有 {period} 秒级偏差。")
        },
        if hits.is_empty() {
            sec(en, "· 未命中时请确认密钥、digits/period/algorithm 是否与签发端一致，以及双方时钟。", "- When nothing matches, check that the key, digits/period/algorithm agree with the issuer and that both clocks are in sync.").to_string()
        } else {
            sec(en, "· 校验通过只说明该口令在此窗口内合法；服务端应记录已用口令以防重放。", "- A match only proves the code is valid inside this window; a server should record used codes to stop replays.").to_string()
        },
    ];
    blocks.push(section(sec(en, "说明", "Notes")));
    blocks.append(&mut notes_to_block(&mut notes));
    let mut extra = serde_json::Map::new();
    extra.insert("mode".into(), json!("verify"));
    extra.insert(
        "ok".into(),
        json!(if hits.is_empty() { "no" } else { "yes" }),
    );
    extra.insert(
        "matchedStep".into(),
        json!(hits
            .first()
            .map(|x| x.1.to_string())
            .unwrap_or_else(|| "none".into())),
    );
    extra.insert(
        "offset".into(),
        json!(hits
            .first()
            .map(|x| x.0.to_string())
            .unwrap_or_else(|| "none".into())),
    );
    extra.insert("digits".into(), json!(digits));
    extra.insert("period".into(), json!(period));
    extra.insert("algorithm".into(), json!(algo));
    extra.insert("counter".into(), json!(counter));
    let body = format!(
        "{}\n",
        join_blocks(blocks.iter().map(String::as_str)).trim_end()
    );
    let result = artifact("totp.txt", body.clone(), extra);
    Ok(ToolResult {
        text: Some(body),
        ..result
    })
}

fn sec(en: bool, zh: &'static str, english: &'static str) -> &'static str {
    if en {
        english
    } else {
        zh
    }
}

fn decode32_static() -> Result<Vec<u8>, EngineError> {
    static NULL: serde_json::Value = serde_json::Value::Null;
    decode32(
        "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
        &RunContext {
            tool: "totp",
            options: &NULL,
            locale: "zh-CN",
            inputs: &[],
            name_pattern: None,
            runtime_data: None,
        },
    )
}
