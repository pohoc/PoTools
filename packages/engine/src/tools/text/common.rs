//! Shared parsing, timezone, and output helpers for text tools.

use super::calendar::add_calendar;
use crate::{Artifact, EngineError, RunContext, ToolResult};
use chrono::{
    DateTime, Datelike, Duration, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc,
};
use chrono_tz::Tz;
use serde_json::{Map, Value};
use std::str::FromStr;


fn opt<'a>(ctx: &'a RunContext<'_>, key: &str) -> Option<&'a Value> {
    ctx.options.get(key)
}
pub(super) fn string<'a>(ctx: &'a RunContext<'_>, key: &str, default: &'a str) -> &'a str {
    opt(ctx, key).and_then(Value::as_str).unwrap_or(default)
}
pub(super) fn boolean(ctx: &RunContext<'_>, key: &str, default: bool) -> bool {
    opt(ctx, key).and_then(Value::as_bool).unwrap_or(default)
}
pub(super) fn number(ctx: &RunContext<'_>, key: &str, default: f64) -> f64 {
    opt(ctx, key).and_then(Value::as_f64).unwrap_or(default)
}
pub(super) fn is_en(ctx: &RunContext<'_>) -> bool {
    ctx.locale.starts_with("en")
}
pub(super) fn err(message: impl Into<String>) -> EngineError {
    EngineError::new("bad_request", message)
}
pub(super) fn zone(ctx: &RunContext<'_>) -> Result<Tz, EngineError> {
    let name = string(ctx, "timezone", "Asia/Shanghai");
    Tz::from_str(name).map_err(|_| err(format!("Invalid timezone: {name}")))
}
pub(super) fn output(name: &str, text: String, extra: Map<String, Value>) -> ToolResult {
    // Mirrors the engine's emitText convention: trailing whitespace trimmed,
    // exactly one final newline, shared by `text` and the text artifact.
    let body = format!("{}\n", text.trim_end());
    let mut artifact = Artifact::new(name, "text", body.clone().into_bytes());
    artifact.source_file_id = None;
    ToolResult {
        text: Some(body),
        artifacts: vec![artifact],
        warnings: vec![],
        extra,
    }
}
pub(super) fn parse_at(raw: &str, tz: Tz) -> Result<DateTime<Utc>, EngineError> {
    validate_date_range(parse_at_unit(raw, tz, "auto")?, tz)
}
pub(super) fn validate_date_range(
    dt: DateTime<Utc>,
    _tz: Tz,
) -> Result<DateTime<Utc>, EngineError> {
    if dt.timestamp_millis().unsigned_abs() > 8_640_000_000_000_000_u64 {
        return Err(err("Date/time is outside the supported range"));
    }
    Ok(dt)
}
pub(super) fn parse_at_unit(raw: &str, tz: Tz, unit: &str) -> Result<DateTime<Utc>, EngineError> {
    let input = raw.trim();
    if input.is_empty() || input == "now" {
        return Ok(Utc::now());
    }
    if input == "today" {
        let today = local(Utc::now(), tz).date_naive();
        return resolve_local(
            tz,
            today.and_time(NaiveTime::from_hms_opt(0, 0, 0).unwrap()),
        );
    }
    if is_numeric(input) {
        return numeric_instant(input, unit);
    }
    if let Some(parsed) = parse_relative_phrase(input, tz)? {
        return Ok(parsed);
    }
    if let Ok(value) = DateTime::parse_from_rfc3339(input) {
        return Ok(value.with_timezone(&Utc));
    }
    if let Ok(value) = DateTime::parse_from_rfc2822(input) {
        return Ok(value.with_timezone(&Utc));
    }
    for format in [
        "%Y-%m-%d %H:%M:%S%.f %z",
        "%Y-%m-%d %H:%M %z",
        "%Y/%m/%d %H:%M:%S %z",
        "%m/%d/%Y %H:%M:%S %z",
    ] {
        if let Ok(value) = DateTime::parse_from_str(input, format) {
            return Ok(value.with_timezone(&Utc));
        }
    }
    let formats = [
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d",
        "%Y/%m/%d %H:%M:%S%.f",
        "%Y/%m/%d %H:%M",
        "%Y/%m/%d",
        "%d %b %Y %H:%M:%S",
        "%d %b %Y",
        "%B %e, %Y %H:%M:%S",
        "%B %e, %Y",
        "%m/%d/%Y",
        "%d/%m/%Y",
        "%d.%m.%Y",
        "%d-%m-%Y",
    ];
    for format in formats {
        if let Ok(value) = NaiveDateTime::parse_from_str(input, format) {
            return resolve_local(tz, value);
        }
        if let Ok(date) = NaiveDate::parse_from_str(input, format) {
            return resolve_local(tz, date.and_time(NaiveTime::from_hms_opt(0, 0, 0).unwrap()));
        }
    }
    Err(err(format!("Invalid date/time: {input}")))
}

pub(super) fn parse_relative_phrase(
    raw: &str,
    tz: Tz,
) -> Result<Option<DateTime<Utc>>, EngineError> {
    let text = raw.trim().replace("  ", " ");
    let lower = text.to_lowercase();
    let keywords = [
        ("quarter-start", "quarter"),
        ("month-start", "month"),
        ("week-start", "week"),
        ("year-start", "year"),
        ("yesterday", "-1d"),
        ("tomorrow", "+1d"),
        ("today", "0d"),
        ("now", "now"),
        ("前天", "-2d"),
        ("后天", "+2d"),
        ("昨天", "-1d"),
        ("明天", "+1d"),
        ("今天", "0d"),
        ("现在", "now"),
    ];
    let matched = keywords
        .iter()
        .find(|(k, _)| lower.starts_with(*k) || text.starts_with(*k));
    let (mut cursor, mut at, mut recognized) = if let Some((key, kind)) = matched {
        let len = key.len();
        let now = Utc::now();
        let base = match *kind {
            "now" => now,
            "quarter" | "month" | "week" | "year" => {
                let p = local(now, tz);
                let date = match *kind {
                    "year" => NaiveDate::from_ymd_opt(p.year(), 1, 1),
                    "quarter" => {
                        NaiveDate::from_ymd_opt(p.year(), ((p.month() - 1) / 3) * 3 + 1, 1)
                    }
                    "month" => NaiveDate::from_ymd_opt(p.year(), p.month(), 1),
                    _ => {
                        let monday = p.date_naive()
                            - Duration::days(p.weekday().num_days_from_monday() as i64);
                        Some(monday)
                    }
                }
                .ok_or_else(|| err("Date out of range"))?;
                resolve_local(tz, date.and_hms_opt(0, 0, 0).unwrap())?
            }
            _ => {
                let delta = if kind.starts_with('-') {
                    -kind[1..kind.len() - 1].parse::<i64>().unwrap_or(0)
                } else {
                    kind[1..kind.len() - 1].parse::<i64>().unwrap_or(0)
                };
                let d = local(now, tz)
                    .date_naive()
                    .checked_add_signed(Duration::days(delta))
                    .ok_or_else(|| err("Date out of range"))?;
                resolve_local(tz, d.and_hms_opt(0, 0, 0).unwrap())?
            }
        };
        (len, base, true)
    } else {
        (0, Utc::now(), false)
    };
    if !recognized {
        for index in text.char_indices().filter_map(|(i, c)| {
            if i > 0 && c.is_whitespace() {
                Some(i)
            } else {
                None
            }
        }) {
            let base = text[..index].trim();
            let rest = text[index..].trim();
            if starts_offset(rest) {
                at = parse_at_unit(base, tz, "auto")?;
                cursor = index;
                recognized = true;
                break;
            }
        }
    }
    if !recognized {
        return Ok(None);
    }
    let mut years = 0_i64;
    let mut months = 0_i64;
    let mut days = 0_i64;
    let mut hours = 0_i64;
    let mut minutes = 0_i64;
    let mut seconds = 0_i64;
    let mut shifted = false;
    loop {
        let rest = text[cursor..].trim_start();
        let consumed = text[cursor..].len() - rest.len();
        cursor += consumed;
        if !starts_offset(rest) {
            break;
        }
        let bytes = rest.as_bytes();
        let sign = if bytes[0] == b'-' { -1_i64 } else { 1 };
        let mut i = 1;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == 1 || i >= bytes.len() {
            break;
        }
        let n = rest[1..i].parse::<i64>().unwrap_or(0) * sign;
        let unit = bytes[i] as char;
        match unit {
            'y' => years += n,
            'M' => months += n,
            'w' => days += n.saturating_mul(7),
            'd' => days += n,
            'h' => hours += n,
            'm' => minutes += n,
            's' => seconds += n,
            _ => break,
        }
        cursor += i + 1;
        shifted = true;
    }
    let tail = text[cursor..].trim();
    if !tail.is_empty() {
        let clock = tail.strip_prefix('T').unwrap_or(tail);
        let parts: Vec<_> = clock.split(':').collect();
        if parts.len() < 2 || parts.len() > 3 {
            return Ok(None);
        }
        let h = parts[0].parse::<u32>().ok();
        let m = parts[1].parse::<u32>().ok();
        let s = parts.get(2).and_then(|v| v.parse::<u32>().ok()).or(Some(0));
        if let (Some(h), Some(m), Some(s)) = (h, m, s) {
            if h > 23 || m > 59 || s > 59 {
                return Err(err("Invalid time in relative date phrase"));
            }
            let p = local(at, tz);
            let wall = p.date_naive().and_hms_opt(h, m, s).unwrap();
            at = resolve_local(tz, wall)?;
        } else {
            return Ok(None);
        }
    }
    if shifted {
        at = add_calendar(at, tz, "years", years)?;
        at = add_calendar(at, tz, "months", months)?;
        at = add_calendar(at, tz, "days", days)?;
        at = at + Duration::hours(hours) + Duration::minutes(minutes) + Duration::seconds(seconds);
    }
    Ok(Some(at))
}

pub(super) fn starts_offset(text: &str) -> bool {
    let s = text.trim_start().as_bytes();
    if s.len() < 3 || !(s[0] == b'+' || s[0] == b'-') {
        return false;
    }
    let mut i = 1;
    while i < s.len() && s[i].is_ascii_digit() {
        i += 1;
    }
    i > 1 && i < s.len() && b"yMwdhms".contains(&s[i])
}

pub(super) fn is_numeric(raw: &str) -> bool {
    let value = raw.strip_prefix(['+', '-']).unwrap_or(raw);
    let mut split = value.split('.');
    let whole = split.next().unwrap_or("");
    let fraction = split.next();
    !whole.is_empty()
        && whole.bytes().all(|b| b.is_ascii_digit())
        && fraction.map_or(true, |f| {
            !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit())
        })
        && split.next().is_none()
}

pub(super) fn numeric_instant(
    raw: &str,
    requested_unit: &str,
) -> Result<DateTime<Utc>, EngineError> {
    let (negative, unsigned) = if let Some(v) = raw.strip_prefix('-') {
        (true, v)
    } else {
        (false, raw.strip_prefix('+').unwrap_or(raw))
    };
    let mut parts = unsigned.split('.');
    let whole = parts.next().unwrap_or("0");
    let fraction = parts.next().unwrap_or("");
    let significant = whole.trim_start_matches('0');
    let length = significant.len().max(1);
    let unit = if requested_unit == "auto" {
        if length <= 10 {
            "s"
        } else if length <= 13 {
            "ms"
        } else if length <= 16 {
            "us"
        } else {
            "ns"
        }
    } else {
        requested_unit
    };
    let exponent = match unit {
        "s" => 9_i32,
        "ms" => 6,
        "us" => 3,
        "ns" => 0,
        _ => return Err(err("Unknown timestamp unit")),
    };
    let digits = format!("{whole}{fraction}");
    let magnitude = digits
        .parse::<i128>()
        .map_err(|_| err("Timestamp is outside the supported date range"))?;
    let numerator = if negative { -magnitude } else { magnitude };
    let shift = exponent - fraction.len() as i32;
    let power = 10_i128
        .checked_pow(shift.unsigned_abs())
        .ok_or_else(|| err("Timestamp is outside the supported date range"))?;
    let ns = if shift >= 0 {
        numerator
            .checked_mul(power)
            .ok_or_else(|| err("Timestamp is outside the supported date range"))?
    } else {
        div_round_i128(numerator, power)
    };
    let seconds = ns.div_euclid(1_000_000_000);
    let nanos = ns.rem_euclid(1_000_000_000) as u32;
    let seconds =
        i64::try_from(seconds).map_err(|_| err("Timestamp is outside the supported date range"))?;
    let dt = DateTime::from_timestamp(seconds, nanos)
        .ok_or_else(|| err("Timestamp is outside the supported date range"))?;
    validate_date_range(dt, chrono_tz::UTC)
}

pub(super) fn div_round_i128(value: i128, divisor: i128) -> i128 {
    let q = value / divisor;
    let r = value % divisor;
    if r.abs() * 2 >= divisor {
        q + if value < 0 { -1 } else { 1 }
    } else {
        q
    }
}
pub(super) fn epoch_ns(dt: DateTime<Utc>) -> i128 {
    dt.timestamp() as i128 * 1_000_000_000 + dt.timestamp_subsec_nanos() as i128
}
pub(super) fn resolve_local(tz: Tz, local: NaiveDateTime) -> Result<DateTime<Utc>, EngineError> {
    match tz.from_local_datetime(&local) {
        LocalResult::Single(dt) => Ok(dt.with_timezone(&Utc)),
        LocalResult::Ambiguous(a, b) => Ok(a.min(b).with_timezone(&Utc)),
        LocalResult::None => {
            // Match browser date handling across a DST gap by moving forward to the first valid wall time.
            for minute in 1..=180 {
                let candidate = local + Duration::minutes(minute);
                if let LocalResult::Single(dt) = tz.from_local_datetime(&candidate) {
                    return Ok(dt.with_timezone(&Utc));
                }
                if let LocalResult::Ambiguous(a, b) = tz.from_local_datetime(&candidate) {
                    return Ok(a.min(b).with_timezone(&Utc));
                }
            }
            Err(err("Local date/time does not exist in this timezone"))
        }
    }
}
pub(super) fn local(dt: DateTime<Utc>, tz: Tz) -> DateTime<Tz> {
    dt.with_timezone(&tz)
}
pub(super) fn fmt_local(dt: DateTime<Utc>, tz: Tz) -> String {
    local(dt, tz).format("%Y-%m-%d %H:%M:%S").to_string()
}
pub(super) fn put(extra: &mut Map<String, Value>, key: &str, value: impl Into<Value>) {
    extra.insert(key.to_string(), value.into());
}
pub(super) fn text_result(
    _ctx: &RunContext<'_>,
    filename: &str,
    text: String,
    pairs: &[(&str, String)],
) -> ToolResult {
    let mut extra = Map::new();
    for (key, value) in pairs {
        put(&mut extra, key, value.clone());
    }
    output(filename, text, extra)
}
