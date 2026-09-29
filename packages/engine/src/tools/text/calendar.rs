//! Calendar arithmetic helpers shared by date and workday tools.

use super::common::*;
use super::EngineError;
use chrono::{DateTime, Datelike, Duration, NaiveDate, Timelike, Utc};
use chrono_tz::Tz;

pub(super) fn calendar_span(
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    tz: Tz,
    english: bool,
) -> Result<(String, i64), EngineError> {
    let (mut cursor, end) = if from <= to { (from, to) } else { (to, from) };
    let first_day = local(cursor, tz).date_naive();
    let last_day = local(end, tz).date_naive();
    let whole_days = (last_day - first_day).num_days();
    let mut units = [0_i64; 8];
    for (slot, unit, cap) in [(0, "years", 10_000), (1, "months", 120_000)] {
        while units[slot] < cap {
            let next = add_calendar(cursor, tz, unit, 1)?;
            if next > end {
                break;
            }
            cursor = next;
            units[slot] += 1;
        }
    }
    let remaining = (end - cursor).num_milliseconds().unsigned_abs();
    let days = remaining / DAY_MS as u64;
    units[2] = (days / 7) as i64;
    units[3] = (days % 7) as i64;
    let remainder = remaining % DAY_MS as u64;
    units[4] = (remainder / 3_600_000) as i64;
    units[5] = ((remainder % 3_600_000) / 60_000) as i64;
    units[6] = ((remainder % 60_000) / 1000) as i64;
    units[7] = (remainder % 1000) as i64;
    let names = if english {
        ["y", "mo", "w", "d", "h", "m", "s", "ms"]
    } else {
        ["年", "个月", "周", "天", "小时", "分钟", "秒", "毫秒"]
    };
    let pieces: Vec<String> = units
        .iter()
        .zip(names)
        .filter(|(n, _)| **n > 0)
        .map(|(n, name)| format!("{n}{name}"))
        .collect();
    Ok((
        if pieces.is_empty() {
            if english {
                "0s".into()
            } else {
                "0秒".into()
            }
        } else {
            pieces.join(" ")
        },
        whole_days,
    ))
}

pub(super) fn parse_weekend_set(raw: &str) -> Result<Vec<u32>, EngineError> {
    let mut result = Vec::new();
    for token in raw.split([',', '，', '、', ';', '；', ' ', '\t']) {
        if token.is_empty() {
            continue;
        }
        let day = token
            .parse::<u32>()
            .ok()
            .filter(|n| *n <= 6)
            .ok_or_else(|| err(format!("Invalid weekend day: {token}")))?;
        if !result.contains(&day) {
            result.push(day);
        }
    }
    Ok(result)
}

pub(super) fn parse_holidays(
    raw: &str,
    tz: Tz,
) -> Result<std::collections::HashSet<NaiveDate>, EngineError> {
    raw.lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|line| parse_at(line, tz).map(|dt| local(dt, tz).date_naive()))
        .collect()
}

pub(super) fn is_rest_day(
    day: NaiveDate,
    weekend: &[u32],
    holidays: &std::collections::HashSet<NaiveDate>,
) -> bool {
    weekend.contains(&day.weekday().num_days_from_sunday()) || holidays.contains(&day)
}

pub(super) fn add_calendar(
    dt: DateTime<Utc>,
    tz: Tz,
    unit: &str,
    amount: i64,
) -> Result<DateTime<Utc>, EngineError> {
    let p = local(dt, tz);
    let mut y = p.year();
    let mut m = p.month() as i64;
    let mut day = p.day();
    match unit {
        "years" => y = y.saturating_add(amount as i32),
        "months" => {
            let total = y as i64 * 12 + (m - 1) + amount;
            y = total.div_euclid(12) as i32;
            m = total.rem_euclid(12) + 1;
        }
        "weeks" | "days" => {
            let shift = if unit == "weeks" {
                amount.saturating_mul(7)
            } else {
                amount
            };
            let shifted = p
                .date_naive()
                .checked_add_signed(Duration::days(shift))
                .ok_or_else(|| err("Date out of range"))?;
            let wall = shifted
                .and_hms_milli_opt(
                    p.hour(),
                    p.minute(),
                    p.second(),
                    p.timestamp_subsec_millis(),
                )
                .ok_or_else(|| err("Date out of range"))?;
            return resolve_local(tz, wall);
        }
        "hours" => return Ok(dt + Duration::hours(amount)),
        "minutes" => return Ok(dt + Duration::minutes(amount)),
        _ => return Ok(dt + Duration::seconds(amount)),
    }
    let m_u = m as u32;
    let next_month = if m_u == 12 {
        NaiveDate::from_ymd_opt(y + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(y, m_u + 1, 1)
    }
    .ok_or_else(|| err("Date out of range"))?;
    let last_day = next_month
        .pred_opt()
        .ok_or_else(|| err("Date out of range"))?
        .day();
    day = day.min(last_day);
    let wall = NaiveDate::from_ymd_opt(y, m_u, day)
        .ok_or_else(|| err("Date out of range"))?
        .and_hms_milli_opt(
            p.hour(),
            p.minute(),
            p.second(),
            p.timestamp_subsec_millis(),
        )
        .ok_or_else(|| err("Date out of range"))?;
    resolve_local(tz, wall)
}
