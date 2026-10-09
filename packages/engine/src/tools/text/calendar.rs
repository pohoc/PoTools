//! Calendar arithmetic helpers shared by date and workday tools.

use super::common::*;
use super::EngineError;
use chrono::{DateTime, Datelike, Duration, NaiveDate, Timelike, Utc};
use chrono_tz::Tz;

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
