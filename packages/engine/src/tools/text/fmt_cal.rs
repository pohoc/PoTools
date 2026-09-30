//! Calendar-day arithmetic, weekday names and zone labels shared by the date
//! tools; split out of `fmt` to keep both files small.

use super::calendar::add_calendar;
use super::common::{err, local, resolve_local};
use super::fmt::{
    epoch_date, is_zh, msg, offset_label, pad, DAY_MS, DAY_TALLY_CAP, HOUR_MS, MIN_MS,
    MONTHS_EN_SHORT, SEC_MS, WEEKDAYS_EN, WEEKDAYS_EN_SHORT, WEEKDAYS_ZH,
};
use crate::EngineError;
use chrono::{
    DateTime, Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Timelike, Utc,
};
use chrono_tz::Tz;
use std::collections::BTreeMap;

pub fn iso_week_of(year: i32, month: u32, day: u32) -> (i32, u32, u32) {
    let midday = NaiveDate::from_ymd_opt(year, month, day).unwrap_or_else(epoch_date);
    let weekday = ((midday.weekday().num_days_from_sunday() as i64 + 6) % 7 + 1) as u32;
    let thursday = midday + Duration::days((4 - weekday as i64) as i64);
    let first_jan = NaiveDate::from_ymd_opt(thursday.year(), 1, 1).unwrap_or_else(epoch_date);
    let week = (thursday - first_jan).num_days() as u32 / 7 + 1;
    (thursday.year(), week, weekday)
}

pub fn days_in_month(year: i32, month: u32) -> u32 {
    let (next_year, next_month) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    NaiveDate::from_ymd_opt(next_year, next_month, 1)
        .unwrap_or_else(epoch_date)
        .pred_opt()
        .unwrap_or_else(epoch_date)
        .day()
}

pub fn day_index(year: i32, month: u32, day: u32) -> i64 {
    NaiveDate::from_ymd_opt(year, month, day)
        .unwrap_or_else(epoch_date)
        .and_time(NaiveTime::MIN)
        .and_utc()
        .timestamp_millis()
        .div_euclid(DAY_MS)
}

pub fn day_index_of_instant(at: DateTime<Utc>, tz: Tz) -> i64 {
    let p = local(at, tz);
    day_index(p.year(), p.month(), p.day())
}

pub struct DayCell {
    pub index: i64,
    pub key: String,
    pub weekday: u32,
}

pub fn day_cell(index: i64) -> DayCell {
    let date = epoch_date() + Duration::days(index);
    DayCell {
        index,
        key: date.format("%Y-%m-%d").to_string(),
        weekday: date.weekday().num_days_from_sunday(),
    }
}

pub struct DayTally {
    pub total: i64,
    pub workdays: i64,
    pub weekend_days: i64,
    pub holiday_days: i64,
    pub rest_days: i64,
    pub rest_list: Vec<DayCell>,
    pub truncated: bool,
}

pub fn tally_day_range(
    start_index: i64,
    day_count: i64,
    weekend: &[u32],
    holidays: &BTreeMap<String, String>,
) -> DayTally {
    let total = day_count.max(0);
    let scan = total.min(DAY_TALLY_CAP);
    let mut weekend_days = 0_i64;
    let mut holiday_days = 0_i64;
    let mut rest_list = Vec::new();
    for offset in 0..scan {
        let cell = day_cell(start_index + offset);
        let off = weekend.contains(&cell.weekday);
        let holiday = holidays.get(&cell.key);
        if off {
            weekend_days += 1;
        }
        if !off && holiday.is_some() {
            holiday_days += 1;
        }
        if (off || holiday.is_some()) && rest_list.len() < 8 {
            rest_list.push(DayCell {
                index: cell.index,
                key: cell.key,
                weekday: cell.weekday,
            });
        }
    }
    let rest_days = weekend_days + holiday_days;
    DayTally {
        total: scan,
        workdays: scan - rest_days,
        weekend_days,
        holiday_days,
        rest_days,
        rest_list,
        truncated: total > scan,
    }
}

pub fn parse_weekend_set(raw: &str, ui_locale: &str) -> Result<Vec<u32>, EngineError> {
    let mut result = Vec::new();
    for token in raw.split([',', '，', '、', ';', '；', ' ', '\t']) {
        let token = token.trim();
        if token.is_empty() {
            continue;
        }
        let day = token.parse::<u32>().ok().filter(|n| *n <= 6).ok_or_else(|| {
            err(msg(
                ui_locale,
                &format!(
                    "weekend=\"{raw}\" 含无法识别的取值 \"{token}\"。请用逗号分隔的星期序号，取值 0~6，0=周日、1=周一……6=周六。示例：0,6。"
                ),
                &format!(
                    "weekend=\"{raw}\" contains the unrecognized value \"{token}\". Use comma-separated weekday numbers 0-6, where 0=Sun, 1=Mon ... 6=Sat. Example: 0,6."
                ),
            ))
        })?;
        if !result.contains(&day) {
            result.push(day);
        }
    }
    Ok(result)
}

/// holidays raw lines -> ordered map of local ISO day -> raw input text.
pub fn parse_holiday_map(
    raw: &str,
    tz: Tz,
    ui_locale: &str,
) -> Result<BTreeMap<String, String>, EngineError> {
    let mut map = BTreeMap::new();
    for line in raw.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let instant = super::common::parse_at(line, tz).map_err(|error| {
            err(msg(
                ui_locale,
                &format!(
                    "{} holidays 每行只能填一个日期，示例：2026-10-01、2026/10/02。",
                    error.message
                ),
                &format!(
                    "{} Each holidays line must hold a single date, for example 2026-10-01, 2026-10-02.",
                    error.message
                ),
            ))
        })?;
        let p = local(instant, tz);
        map.insert(
            format!(
                "{}-{}-{}",
                pad(p.year(), 4),
                pad(p.month(), 2),
                pad(p.day(), 2)
            ),
            line.to_string(),
        );
    }
    Ok(map)
}

pub fn roll_to_working_day(
    start_index: i64,
    weekend: &[u32],
    holidays: &BTreeMap<String, String>,
) -> (i64, Vec<DayCell>) {
    let mut cursor = start_index;
    let mut skipped = Vec::new();
    if weekend.is_empty() && holidays.is_empty() {
        return (cursor, skipped);
    }
    for _ in 0..=28 {
        let cell = day_cell(cursor);
        if !weekend.contains(&cell.weekday) && !holidays.contains_key(&cell.key) {
            return (cursor, skipped);
        }
        skipped.push(cell);
        cursor += 1;
    }
    (start_index, Vec::new())
}

/// chrono-Tz stand-in for the engine's `resolveWallTime`: returns epoch ms plus
/// whether the wall clock had to shift (DST gap/overlap).
pub fn resolve_wall_time(tz: Tz, wall: NaiveDateTime) -> (DateTime<Utc>, bool) {
    let resolved = resolve_local(tz, wall).unwrap_or_else(|_| {
        Utc.timestamp_millis_opt(0)
            .single()
            .unwrap_or_else(|| Utc::now())
    });
    let back = local(resolved, tz);
    let same = back.date_naive() == wall.date()
        && back.hour() == wall.hour()
        && back.minute() == wall.minute()
        && back.second() == wall.second();
    (resolved, !same)
}

pub fn shift_calendar(
    epoch_ms: i64,
    tz: Tz,
    years: i64,
    months: i64,
    weeks: i64,
    days: i64,
    hours: i64,
    minutes: i64,
    seconds: i64,
) -> Result<(i64, bool, u32, u32, bool), EngineError> {
    let base = Utc
        .timestamp_millis_opt(epoch_ms)
        .single()
        .ok_or_else(|| err("Date out of range"))?;
    let p = local(base, tz);
    let total_months = years * 12 + months;
    let target_index = p.year() as i64 * 12 + (p.month() as i64 - 1) + total_months;
    let target_year = target_index.div_euclid(12) as i32;
    let target_month = target_index.rem_euclid(12) as u32 + 1;
    let last = days_in_month(target_year, target_month);
    let target_day = p.day().min(last);
    let clamped = target_day != p.day() && total_months != 0;
    let whole = NaiveDate::from_ymd_opt(target_year, target_month, target_day)
        .ok_or_else(|| err("Date out of range"))?
        .and_hms_milli_opt(
            p.hour(),
            p.minute(),
            p.second(),
            p.timestamp_subsec_millis(),
        )
        .ok_or_else(|| err("Date out of range"))?;
    let (whole_ms, whole_adjusted) = resolve_wall_time(tz, whole);
    let calendar_days = weeks * 7 + days;
    let shifted = whole_ms + Duration::milliseconds(calendar_days * DAY_MS);
    let back = local(shifted, tz);
    let reanchored_wall = back
        .date_naive()
        .and_hms_milli_opt(
            back.hour(),
            back.minute(),
            back.second(),
            back.timestamp_subsec_millis(),
        )
        .ok_or_else(|| err("Date out of range"))?;
    let (reanchored, reanchored_adjusted) = resolve_wall_time(tz, reanchored_wall);
    let clock = hours * HOUR_MS + minutes * MIN_MS + seconds * SEC_MS;
    Ok((
        reanchored.timestamp_millis() + clock,
        clamped,
        p.day(),
        target_day,
        whole_adjusted || reanchored_adjusted,
    ))
}

#[derive(Clone, Copy)]
pub struct CalendarSpan {
    pub sign: i32,
    pub years: i64,
    pub months: i64,
    pub weeks: i64,
    pub days: i64,
    pub hours: i64,
    pub minutes: i64,
    pub seconds: i64,
    pub milliseconds: i64,
}

pub fn calendar_breakdown(from_ms: i64, to_ms: i64, tz: Tz) -> Result<CalendarSpan, EngineError> {
    let sign = if to_ms > from_ms {
        1
    } else if to_ms < from_ms {
        -1
    } else {
        0
    };
    let mut start = from_ms.min(to_ms);
    let end = from_ms.max(to_ms);
    let mut span = CalendarSpan {
        sign,
        years: 0,
        months: 0,
        weeks: 0,
        days: 0,
        hours: 0,
        minutes: 0,
        seconds: 0,
        milliseconds: 0,
    };
    let step = |field: &str, span: &mut CalendarSpan, start: &mut i64| -> Result<(), EngineError> {
        loop {
            let start_dt = Utc
                .timestamp_millis_opt(*start)
                .single()
                .ok_or_else(|| err("Date out of range"))?;
            let next = add_calendar(start_dt, tz, field, 1)?.timestamp_millis();
            if next > end || next <= *start {
                break;
            }
            *start = next;
            if field == "years" {
                span.years += 1;
            } else {
                span.months += 1;
            }
        }
        Ok(())
    };
    step("years", &mut span, &mut start)?;
    step("months", &mut span, &mut start)?;
    let rem = end - start;
    span.days = rem.div_euclid(DAY_MS);
    let mut rest = rem - span.days * DAY_MS;
    span.hours = rest.div_euclid(HOUR_MS);
    rest -= span.hours * HOUR_MS;
    span.minutes = rest.div_euclid(MIN_MS);
    rest -= span.minutes * MIN_MS;
    span.seconds = rest.div_euclid(SEC_MS);
    span.milliseconds = rest - span.seconds * SEC_MS;
    span.weeks = span.days.div_euclid(7);
    span.days %= 7;
    Ok(span)
}

pub fn span_text(span: &CalendarSpan, en: bool) -> String {
    let mut pieces = Vec::new();
    let mut push = |value: i64, unit: &str| {
        if value.abs() > 0 {
            pieces.push(format!("{}{}", value.abs(), unit));
        }
    };
    let names: [&str; 8] = if en {
        ["y", "mo", "w", "d", "h", "m", "s", "ms"]
    } else {
        ["年", "个月", "周", "天", "小时", "分钟", "秒", "毫秒"]
    };
    push(span.years, names[0]);
    push(span.months, names[1]);
    push(span.weeks, names[2]);
    push(span.days, names[3]);
    push(span.hours, names[4]);
    push(span.minutes, names[5]);
    push(span.seconds, names[6]);
    push(span.milliseconds, names[7]);
    let text = if pieces.is_empty() {
        if en {
            "0s".into()
        } else {
            "0秒".into()
        }
    } else {
        pieces.join(" ")
    };
    if span.sign < 0 {
        format!("-{text}")
    } else {
        text
    }
}

pub fn weekday_pair(weekday: u32, ui_locale: &str) -> String {
    let index = (weekday % 7) as usize;
    if is_zh(ui_locale) {
        format!("{} ({})", WEEKDAYS_ZH[index], WEEKDAYS_EN[index])
    } else {
        format!("{} ({})", WEEKDAYS_EN[index], WEEKDAYS_EN_SHORT[index])
    }
}

pub fn weekday_spelled(weekday: u32, ui_locale: &str) -> String {
    let index = (weekday % 7) as usize;
    if is_zh(ui_locale) {
        WEEKDAYS_ZH[index].into()
    } else {
        WEEKDAYS_EN[index].into()
    }
}

pub fn weekday_short(weekday: u32) -> &'static str {
    WEEKDAYS_EN_SHORT[(weekday % 7) as usize]
}

pub fn format_in_zone(at: DateTime<Utc>, tz: Tz) -> String {
    local(at, tz).format("%Y-%m-%d %H:%M:%S").to_string()
}

pub fn format_zone_stamp(at: DateTime<Utc>, tz: Tz) -> String {
    let p = local(at, tz);
    let minutes = offset_minutes_of(at, tz);
    format!(
        "{} (UTC{})",
        p.format("%Y-%m-%d %H:%M:%S"),
        offset_label(minutes, true)
    )
}

pub fn iso_in_zone(at: DateTime<Utc>, tz: Tz) -> String {
    let p = local(at, tz);
    let minutes = offset_minutes_of(at, tz);
    format!(
        "{}T{}{}",
        p.format("%Y-%m-%d"),
        p.format("%H:%M:%S"),
        offset_label(minutes, true)
    )
}

pub fn chinese_date(at: DateTime<Utc>, tz: Tz) -> String {
    local(at, tz).format("%Y年%-m月%-d日 %H:%M:%S").to_string()
}

/// Intl.DateTimeFormat('en', { dateStyle: 'long', timeStyle: 'medium' }).
pub fn long_date_en(at: DateTime<Utc>, tz: Tz) -> String {
    local(at, tz)
        .format("%B %-d, %Y at %-I:%M:%S %p")
        .to_string()
}

pub fn long_date(at: DateTime<Utc>, tz: Tz, ui_locale: &str) -> String {
    if is_zh(ui_locale) {
        chinese_date(at, tz)
    } else {
        long_date_en(at, tz)
    }
}

pub fn rfc2822(at: DateTime<Utc>, tz: Tz) -> String {
    let p = local(at, tz);
    let minutes = offset_minutes_of(at, tz);
    format!(
        "{}, {} {} {} {}:{}:{} {}",
        WEEKDAYS_EN_SHORT[p.weekday().num_days_from_sunday() as usize],
        pad(p.day(), 2),
        MONTHS_EN_SHORT[p.month0() as usize],
        pad(p.year(), 4),
        pad(p.hour(), 2),
        pad(p.minute(), 2),
        pad(p.second(), 2),
        if minutes == 0 {
            "GMT".to_string()
        } else {
            offset_label(minutes, false)
        }
    )
}

pub fn offset_minutes_of(at: DateTime<Utc>, tz: Tz) -> i32 {
    let naive: NaiveDateTime = local(at, tz).naive_local();
    (naive.and_utc() - at).num_minutes() as i32
}

pub fn is_dst_active(at: DateTime<Utc>, tz: Tz) -> bool {
    let year = local(at, tz).year();
    let jan1 = epoch_date()
        .with_year(year)
        .unwrap_or_else(epoch_date)
        .and_time(NaiveTime::MIN)
        .and_utc();
    let jul1 = NaiveDate::from_ymd_opt(year, 7, 1)
        .unwrap_or_else(epoch_date)
        .and_time(NaiveTime::MIN)
        .and_utc();
    let current = offset_minutes_of(at, tz);
    let winter = offset_minutes_of(jan1, tz);
    let summer = offset_minutes_of(jul1, tz);
    current > winter.min(summer)
}

/// Intl 'short' time zone abbreviation for the zones the product surfaces.
pub fn zone_abbrev(tz: Tz, at: DateTime<Utc>) -> String {
    let name = tz.name();
    let dst = is_dst_active(at, tz);
    let offset = offset_minutes_of(at, tz);
    let us = match name {
        "America/New_York" | "US/Eastern" => Some(("EST", "EDT")),
        "America/Chicago" | "US/Central" => Some(("CST", "CDT")),
        "America/Denver" | "US/Mountain" => Some(("MST", "MDT")),
        "America/Los_Angeles" | "US/Pacific" => Some(("PST", "PDT")),
        "America/Anchorage" => Some(("AKST", "AKDT")),
        "Pacific/Honolulu" => Some(("HST", "HST")),
        "America/Halifax" => Some(("AST", "ADT")),
        _ => None,
    };
    if let Some((off, on)) = us {
        return if dst { on.into() } else { off.into() };
    }
    if name == "UTC" || name == "Etc/UTC" || name == "Etc/Universal" {
        return "UTC".into();
    }
    let sign = if offset < 0 { '-' } else { '+' };
    let abs = offset.abs();
    if abs % 60 == 0 {
        format!("GMT{sign}{}", abs / 60)
    } else {
        format!("GMT{sign}{}:{:02}", abs / 60, abs % 60)
    }
}

pub fn zone_line(tz: Tz, at: DateTime<Utc>, ui_locale: &str) -> String {
    let abbrev = zone_abbrev(tz, at);
    let state = msg(
        ui_locale,
        if is_dst_active(at, tz) {
            "夏令时"
        } else {
            "标准时"
        },
        if is_dst_active(at, tz) {
            "Daylight time"
        } else {
            "Standard time"
        },
    );
    format!(
        "{} · UTC{} · {} {}",
        tz.name(),
        offset_label(offset_minutes_of(at, tz), true),
        abbrev,
        state
    )
}

pub fn instant_line(tz: Tz, at: DateTime<Utc>, ui_locale: &str) -> String {
    let abbrev = zone_abbrev(tz, at);
    let state = msg(
        ui_locale,
        if is_dst_active(at, tz) {
            " 夏令时"
        } else {
            " 标准时"
        },
        if is_dst_active(at, tz) {
            " daylight time"
        } else {
            " standard time"
        },
    );
    format!("{abbrev}{state}")
}
