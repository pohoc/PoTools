//! Implementations for the relative text tool group.

use super::common::*;
use super::{EngineError, RunContext, ToolResult};

pub(super) fn run(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    run_relative(ctx)
}

pub(super) fn run_relative(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let tz = zone(ctx)?;
    let target = parse_at(string(ctx, "input", ""), tz)?;
    let base = parse_at(string(ctx, "base", "now"), tz)?;
    let delta = target.timestamp_millis() - base.timestamp_millis();
    let abs = delta.unsigned_abs();
    let phrase_locale = if is_en(ctx) {
        "en-US"
    } else {
        string(ctx, "locale", "zh-CN")
    };
    let numeric = string(ctx, "style", "auto");
    let numeric = if ["auto", "always"].contains(&numeric) {
        numeric
    } else {
        "auto"
    };
    let (value, unit) = dominant_relative(delta);
    let phrase = relative_phrase(value, unit, phrase_locale, numeric == "always");
    let alternate_locale = if is_en(ctx) {
        "zh-CN"
    } else if phrase_locale == "zh-CN" {
        "en-US"
    } else {
        "zh-CN"
    };
    let alt_style = if is_en(ctx) {
        numeric != "auto"
    } else {
        numeric == "always"
    };
    let alt_phrase = relative_phrase(value, unit, alternate_locale, alt_style);
    let days = abs / DAY_MS as u64;
    let hours = abs / 3_600_000;
    let minutes = abs / 60_000;
    let seconds = abs / 1000;
    let mut text=format!("Relative time: {phrase}\nDirection: {}\nTarget: {}\nBase: {}\nAlternative: {alt_phrase}\nExact: {} seconds, {} hours, {} days\nUnix seconds: {}\nUnix milliseconds: {}", if delta==0 {"same"} else if delta>0 {"future"} else {"past"},fmt_local(target,tz),fmt_local(base,tz),abs/1000,abs as f64/3_600_000.0,abs as f64/DAY_MS as f64,target.timestamp(),target.timestamp_millis());
    if boolean(ctx, "showCountdown", true) {
        text.push_str(&format!("\nCountdown: {} days {:02}:{:02}:{:02}\nTotals: {:.3} days, {:.3} hours, {:.3} minutes, {:.3} seconds",days,hours%24,minutes%60,seconds%60,abs as f64/DAY_MS as f64,abs as f64/3_600_000.0,abs as f64/60_000.0,abs as f64/1000.0));
    }
    Ok(text_result(
        ctx,
        "relative-time.txt",
        text,
        &[
            ("locale", phrase_locale.into()),
            ("style", numeric.into()),
            ("timezone", tz.to_string()),
            ("phrase", phrase),
            (
                "showCountdown",
                boolean(ctx, "showCountdown", true).to_string(),
            ),
        ],
    ))
}

pub(super) fn dominant_relative(delta_ms: i64) -> (i64, &'static str) {
    let abs = delta_ms.unsigned_abs();
    let (unit, divisor) = if abs >= 31_557_600_000 {
        ("year", 31_557_600_000_u64)
    } else if abs >= 2_629_800_000 {
        ("month", 2_629_800_000_u64)
    } else if abs >= 604_800_000 {
        ("week", 604_800_000_u64)
    } else if abs >= 86_400_000 {
        ("day", 86_400_000_u64)
    } else if abs >= 3_600_000 {
        ("hour", 3_600_000_u64)
    } else if abs >= 60_000 {
        ("minute", 60_000_u64)
    } else {
        ("second", 1000_u64)
    };
    let magnitude = if matches!(unit, "year" | "month" | "week" | "day") {
        (delta_ms as f64 / divisor as f64).trunc() as i64
    } else {
        (delta_ms as f64 / divisor as f64).round() as i64
    };
    (magnitude, unit)
}

pub(super) fn relative_phrase(value: i64, unit: &str, locale: &str, always: bool) -> String {
    let zh = locale.to_lowercase().starts_with("zh");
    if !always {
        if value == 0 {
            return if zh { "現在".into() } else { "now".into() };
        }
        if zh {
            return match (unit, value) {
                ("day", -1) => "昨天".into(),
                ("day", 1) => "明天".into(),
                ("week", -1) => "上周".into(),
                ("week", 1) => "下周".into(),
                ("month", -1) => "上个月".into(),
                ("month", 1) => "下个月".into(),
                ("year", -1) => "去年".into(),
                ("year", 1) => "明年".into(),
                _ => format!(
                    "{}{}{}",
                    value.abs(),
                    relative_zh_unit(unit),
                    if value < 0 { "前" } else { "后" }
                ),
            };
        }
        return match (unit, value) {
            ("day", -1) => "yesterday".into(),
            ("day", 1) => "tomorrow".into(),
            ("week", -1) => "last week".into(),
            ("week", 1) => "next week".into(),
            ("month", -1) => "last month".into(),
            ("month", 1) => "next month".into(),
            ("year", -1) => "last year".into(),
            ("year", 1) => "next year".into(),
            _ => {
                if value < 0 {
                    format!(
                        "{} {}{} ago",
                        value.abs(),
                        unit,
                        if value.abs() == 1 { "" } else { "s" }
                    )
                } else {
                    format!("in {value} {unit}{}", if value == 1 { "" } else { "s" })
                }
            }
        };
    }
    if zh {
        format!(
            "{}{}{}",
            value.abs(),
            relative_zh_unit(unit),
            if value < 0 { "前" } else { "后" }
        )
    } else if value < 0 {
        format!(
            "{} {}{} ago",
            value.abs(),
            unit,
            if value.abs() == 1 { "" } else { "s" }
        )
    } else {
        format!("in {value} {unit}{}", if value == 1 { "" } else { "s" })
    }
}

pub(super) fn relative_zh_unit(unit: &str) -> &'static str {
    match unit {
        "year" => "年",
        "month" => "个月",
        "week" => "周",
        "day" => "天",
        "hour" => "小时",
        "minute" => "分钟",
        _ => "秒",
    }
}

// RMB upper-case amount conversion mirrors the character set, limits and rounding behavior of finance.ts.
