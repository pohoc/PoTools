use super::super::hash::hex;
use super::*;
use crate::{EngineError, RunContext, ToolResult};
use serde_json::json;
use sha2::{Digest, Sha256};
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
    let nowsec = at.div_euclid(1000);
    let counter = nowsec.div_euclid(period as i64);
    let elapsed = nowsec.rem_euclid(period as i64) as u32;
    let rem = period - elapsed;
    let (current, binary) = hotp(secret, counter, algo, digits)?;
    let en = en(ctx);
    let title = if en {
        format!(
            "TOTP {} - {} - {} digits - {}s",
            mode,
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
    let mut lines = vec![title];
    macro_rules! sec { ($zh:expr, $english:expr $(,)?) => { if en { $english } else { $zh } }; }
    if mode == "verify" {
        let candidate = code_arg.replace([' ', '\t', '\r', '\n', '-', '_'], "");
        if candidate.is_empty() {
            return Err(invalid(
                "code",
                sec!(
                    "mode=verify 必须填写待校验的动态口令",
                    "mode=verify requires the one-time code",
                ),
                &current,
                ctx,
            ));
        }
        if !candidate.chars().all(|c| c.is_ascii_digit()) {
            return Err(invalid(
                "code",
                &format!(
                    "{} {}",
                    sec!("只能包含数字，当前为", "may only contain digits:"),
                    candidate.chars().take(12).collect::<String>()
                ),
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
        let mut rows = Vec::new();
        let mut hits = Vec::new();
        for off in -(window as i64)..=(window as i64) {
            let step = counter + off;
            if step < 0 {
                rows.push(format!(
                    "{}{} | {}",
                    sec!("偏移 ", "offset "),
                    off,
                    sec!("计数器为负，跳过", "negative counter, skipped")
                ));
                continue;
            }
            let (v, _) = hotp(secret, step, algo, digits)?;
            let hit = v == normalized;
            if hit {
                hits.push((off, step, v.clone()));
            }
            rows.push(format!(
                "{}{} | {} · T={}{}",
                sec!("偏移 ", "offset "),
                if off > 0 {
                    format!("+{off}")
                } else {
                    off.to_string()
                },
                v,
                step,
                if hit { " ✓" } else { "" }
            ));
        }
        lines.push(format!(
            "{}: {}",
            sec!("待校验口令", "Code to check"),
            normalized
        ));
        lines.push(format!(
            "{}: {} · {}",
            sec!("基准时刻", "Reference time"),
            date(at, ctx),
            label
        ));
        lines.push(format!(
            "{}: {}（{} 秒）",
            sec!("当前步长 T", "Current step T"),
            counter,
            rem
        ));
        lines.push(format!(
            "{}: ±{} 步（{} 个候选）",
            sec!("容差窗口", "Tolerance window"),
            window,
            rows.len()
        ));
        lines.push(format!(
            "{}: {}",
            sec!("结果", "Result"),
            hits.first()
                .map(|(o, s, _)| format!("✓ offset {} · T={}", o, s))
                .unwrap_or_else(|| sec!("未命中", "no match").into())
        ));
        lines.push(format!("\n{}", sec!("逐步比对", "Step-by-step comparison")));
        lines.extend(rows);
        if !hits.is_empty() {
            lines.push(format!("\n{}", sec!("命中步长详情", "Matching steps")));
            for (off, step, c) in &hits {
                lines.push(format!(
                    "T={step} · {c} · {} ~ {} · {}",
                    date(step * period as i64 * 1000, ctx),
                    date((step + 1) * period as i64 * 1000 - 1, ctx),
                    if *off == 0 {
                        sec!("当前有效", "currently valid")
                    } else if *off < 0 {
                        sec!("已失效", "expired")
                    } else {
                        sec!("未来步长", "future step")
                    }
                ));
            }
        }
        lines.push(format!("\n{}", sec!("说明", "Notes")));
        lines.push(sec!("· 校验命中仅表示该口令在给定窗口有效；服务端应防止重放。","- A match only proves the code is valid inside this window; servers should prevent replay.").to_string());
        let mut extra = serde_json::Map::new();
        extra.insert("mode".into(), json!(mode));
        extra.insert(
            "ok".into(),
            json!(if hits.is_empty() { "no" } else { "yes" }),
        );
        extra.insert(
            "matchedStep".into(),
            json!(hits
                .first()
                .map(|x| x.1.to_string())
                .unwrap_or("none".into())),
        );
        extra.insert(
            "offset".into(),
            json!(hits
                .first()
                .map(|x| x.0.to_string())
                .unwrap_or("none".into())),
        );
        extra.insert("digits".into(), json!(digits));
        extra.insert("period".into(), json!(period));
        extra.insert("algorithm".into(), json!(algo));
        extra.insert("counter".into(), json!(counter));
        return Ok(artifact("totp.txt", lines.join("\n"), extra));
    }
    lines.push(format!("{}: {}", sec!("当前口令", "Current code"), current));
    lines.push(format!(
        "{}: {} 秒 · {} ~ {}",
        sec!("剩余有效", "Time left"),
        rem,
        date(counter * period as i64 * 1000, ctx),
        date((counter + 1) * period as i64 * 1000 - 1, ctx)
    ));
    lines.push(format!(
        "{}: {}",
        sec!("下一步口令", "Next code"),
        hotp(secret, counter + 1, algo, digits)?.0
    ));
    lines.push(format!(
        "{}: {} · {}",
        sec!("基准时刻", "Reference time"),
        date(at, ctx),
        label
    ));
    lines.push(format!(
        "{}: {} = floor({} / {})",
        sec!("计数器 T", "Counter T"),
        counter,
        nowsec,
        period
    ));
    let fp = hex(&Sha256::digest(secret), false);
    lines.push(format!(
        "{}: {} ({} bytes · SHA-256 {})",
        sec!("密钥", "Secret"),
        encode32(secret),
        secret.len(),
        fp
    ));
    lines.push(format!(
        "{}: binary={} → mod {} → {}",
        sec!("动态截断", "Dynamic truncation"),
        binary,
        10u64.pow(digits),
        current
    ));
    lines.push(format!(
        "\n{}",
        sec!("窗口内口令", "Codes in tolerance window")
    ));
    for off in -(window as i64)..=(window as i64) {
        let step = counter + off;
        lines.push(format!(
            "{}{} | {} · T={}",
            sec!("偏移 ", "offset "),
            if off > 0 {
                format!("+{off}")
            } else {
                off.to_string()
            },
            if step < 0 {
                sec!("（计数器为负）", "(negative counter)").into()
            } else {
                hotp(secret, step, algo, digits)?.0
            },
            step
        ));
    }
    if digits != 8 {
        let c8 = hotp(secret, counter, algo, 8)?.0;
        lines.push(format!(
            "\n{}: {} · {} 位口令低位 {}",
            sec!("RFC 6238 对照", "RFC 6238 reference"),
            c8,
            digits,
            &c8[8 - digits as usize..]
        ));
    }
    lines.push(format!("\n{}", sec!("说明", "Notes")));
    lines.push(sec!(
        "· 口令由 HMAC 动态截断后取模生成，前导零保留。",
        "- The code is generated by HMAC dynamic truncation and modulo; leading zeroes are kept.",
    ).to_string());
    if uri {
        lines.push(format!(
            "· otpauth URI 参数覆盖：{}",
            if overrides.is_empty() {
                "无".into()
            } else {
                overrides.join("，")
            }
        ));
    } else {
        lines.push(sec!(
            "· Base32 解码忽略空白、连字符、下划线与 padding。",
            "- Base32 decoding ignores whitespace, hyphens, underscores and padding.",
        ).to_string());
    }
    let mut extra = serde_json::Map::new();
    extra.insert("mode".into(), json!(mode));
    extra.insert("code".into(), json!(current));
    extra.insert("remaining".into(), json!(rem));
    extra.insert("digits".into(), json!(digits));
    extra.insert("period".into(), json!(period));
    extra.insert("algorithm".into(), json!(algo));
    extra.insert("counter".into(), json!(counter));
    extra.insert("secretBytes".into(), json!(secret.len()));
    Ok(artifact("totp.txt", lines.join("\n"), extra))
}
