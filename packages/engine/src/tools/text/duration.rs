//! Implementations for the duration text tool group.

use super::common::*;
use super::{EngineError, RunContext, ToolResult};
use serde_json::Map;

pub(super) fn run(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    run_duration(ctx)
}

pub(super) fn run_duration(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let raw = string(ctx, "value", "3735");
    let cleaned: String = raw
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '_')
        .collect();
    if !valid_decimal_number(&cleaned) {
        return Err(err(format!("Invalid duration number: {raw}")));
    }
    let value = cleaned
        .parse::<f64>()
        .map_err(|_| err("Value must be a number"))?;
    if !value.is_finite() || value.abs() > 1e15 {
        return Err(err("Value is outside the supported range"));
    }
    let unit = string(ctx, "unit", "s");
    let unit = if ["s", "min", "h", "d", "ms"].contains(&unit) {
        unit
    } else {
        "s"
    };
    let factor = match unit {
        "s" => 1000.0,
        "min" => 60_000.0,
        "h" => 3_600_000.0,
        "d" => 86_400_000.0,
        "ms" => 1.0,
        _ => return Err(err("Unknown duration unit")),
    };
    let total = (value * factor).round() as i128;
    let abs = total.unsigned_abs();
    let sign = if total < 0 { "−" } else { "" };
    let seconds = abs / 1000;
    let hours = seconds / 3600;
    let mins = (seconds / 60) % 60;
    let secs = seconds % 60;
    let basic = format!("{sign}{hours:02}:{mins:02}:{secs:02}");
    let style = string(ctx, "style", "human");
    let style = if ["all", "hhmmss", "iso", "human", "chinese"].contains(&style) {
        style
    } else {
        "human"
    };
    let iso = iso_duration(total);
    let lang = if is_en(ctx) {
        "en-US"
    } else {
        string(ctx, "locale", "zh-CN")
    };
    let words = word_duration(abs, total < 0, lang, "");
    let spoken = spoken_duration(abs, lang);
    let value_out = match style {
        "iso" => iso.clone(),
        "chinese" => words.clone(),
        "human" => spoken.clone(),
        _ => basic.clone(),
    };
    let text = if style == "all" {
        let days = abs / DAY_MS as u128;
        let total_hours = abs / 3_600_000;
        let year_days: f64 = match string(ctx, "yearLength", "365.25") {
            "365" => 365.0,
            "366" => 366.0,
            _ => 365.25,
        };
        let basis_year_ms = year_days * DAY_MS as f64;
        let years = (abs as f64 / basis_year_ms).floor() as u64;
        let after_years = abs as f64 - years as f64 * basis_year_ms;
        let months = (after_years / (basis_year_ms / 12.0)).floor() as u64;
        let after_months = after_years - months as f64 * basis_year_ms / 12.0;
        let basis_days = (after_months / DAY_MS as f64).floor() as u64;
        let after_days = after_months - basis_days as f64 * DAY_MS as f64;
        let basis_hours = (after_days / 3_600_000.0).floor() as u64;
        let basis_minutes = ((after_days % 3_600_000.0) / 60_000.0).floor() as u64;
        let basis_seconds = ((after_days % 60_000.0) / 1000.0).floor() as u64;
        format!("Input: {raw} {unit}\nTotal milliseconds: {sign}{abs}\nTotal seconds: {sign}{:.3}\nHH:MM:SS: {basic}\nISO 8601: {iso}\nHuman: {spoken}\nChinese: {words}\nCalendar basis: {year_days} days/year\nBasis breakdown: {sign}{years} years {months} months {basis_days} days {basis_hours:02}:{basis_minutes:02}:{basis_seconds:02}\nTotals: {days} days, {total_hours} hours, {} minutes, {} seconds",abs as f64/1000.0,abs/60_000,abs/1000)
    } else {
        value_out
    };
    let mut extra = Map::new();
    put(&mut extra, "style", style.to_string());
    put(&mut extra, "unit", unit.to_string());
    if style == "all" {
        put(&mut extra, "milliseconds", total.to_string());
        put(&mut extra, "seconds", format!("{:.6}", abs as f64 / 1000.0));
        put(&mut extra, "hhmmss", basic.clone());
        put(&mut extra, "iso", iso);
        put(&mut extra, "chinese", words);
    }
    Ok(output("duration.txt", text, extra))
}

pub(super) fn valid_decimal_number(raw: &str) -> bool {
    let s = raw.strip_prefix(['+', '-']).unwrap_or(raw);
    let mut parts = s.split('.');
    let whole = parts.next().unwrap_or("");
    let fraction = parts.next();
    !whole.is_empty()
        && whole.bytes().all(|b| b.is_ascii_digit())
        && fraction.map_or(true, |f| {
            !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit())
        })
        && parts.next().is_none()
}

pub(super) fn iso_duration(total_ms: i128) -> String {
    let abs = total_ms.unsigned_abs();
    if abs == 0 {
        return "PT0S".into();
    }
    let days = abs / DAY_MS as u128;
    let hours = (abs % DAY_MS as u128) / 3_600_000;
    let minutes = (abs % 3_600_000) / 60_000;
    let seconds = (abs % 60_000) / 1000;
    let millis = abs % 1000;
    let fraction = if millis == 0 {
        String::new()
    } else {
        format!(".{:03}", millis).trim_end_matches('0').to_string()
    };
    let date_part = if days == 0 {
        String::new()
    } else {
        format!("{days}D")
    };
    let mut time_part = String::new();
    if hours > 0 {
        time_part.push_str(&format!("{hours}H"));
    }
    if minutes > 0 {
        time_part.push_str(&format!("{minutes}M"));
    }
    if seconds > 0 || !fraction.is_empty() || days == 0 {
        time_part.push_str(&format!("{seconds}{fraction}S"));
    }
    format!(
        "{}P{}{}",
        if total_ms < 0 { "-" } else { "" },
        date_part,
        if time_part.is_empty() {
            String::new()
        } else {
            format!("T{time_part}")
        }
    )
}

pub(super) fn word_duration(abs_ms: u128, negative: bool, locale: &str, gap: &str) -> String {
    let days = abs_ms / DAY_MS as u128;
    let hours = (abs_ms % DAY_MS as u128) / 3_600_000;
    let minutes = (abs_ms % 3_600_000) / 60_000;
    let seconds = (abs_ms % 60_000) / 1000;
    let millis = abs_ms % 1000;
    let english = locale.starts_with("en");
    let mut parts = Vec::new();
    for (value, zh, en) in [
        (days, "天", "day"),
        (hours, "小时", "hour"),
        (minutes, "分钟", "minute"),
        (seconds, "秒", "second"),
        (millis, "毫秒", "millisecond"),
    ] {
        if value > 0 {
            parts.push(if english {
                format!("{value} {en}{}", if value == 1 { "" } else { "s" })
            } else {
                format!("{value}{zh}")
            });
        }
    }
    if parts.is_empty() {
        parts.push(if english {
            "0 seconds".into()
        } else {
            "零秒".into()
        });
    }
    let join = if gap.is_empty() && english { " " } else { gap };
    format!(
        "{}{}",
        if negative {
            if english {
                "minus "
            } else {
                "负"
            }
        } else {
            ""
        },
        parts.join(join)
    )
}

pub(super) fn spoken_duration(abs_ms: u128, locale: &str) -> String {
    let (unit, ms) = if abs_ms >= 604_800_000 {
        ("week", 604_800_000.0)
    } else if abs_ms >= 86_400_000 {
        ("day", 86_400_000.0)
    } else if abs_ms >= 3_600_000 {
        ("hour", 3_600_000.0)
    } else if abs_ms >= 60_000 {
        ("minute", 60_000.0)
    } else {
        ("second", 1000.0)
    };
    let value = (abs_ms as f64 / ms).round() as u64;
    if locale.starts_with("en") {
        format!("{value} {unit}{}", if value == 1 { "" } else { "s" })
    } else {
        format!(
            "{value}{}",
            match unit {
                "week" => "周",
                "day" => "天",
                "hour" => "小时",
                "minute" => "分钟",
                _ => "秒",
            }
        )
    }
}
