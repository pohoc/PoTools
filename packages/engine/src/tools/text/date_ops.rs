//! Implementations for the date ops text tool group.

use super::calendar::*;
use super::common::*;
use super::relative::{dominant_relative, relative_phrase};
use super::{EngineError, RunContext, ToolResult};
use chrono::{Datelike, Duration, NaiveDate, Timelike, Utc};
use serde_json::Map;

pub(super) fn run(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    match ctx.tool {
        "timestamp" => run_timestamp(ctx),
        "date-diff" => run_date_diff(ctx),
        "date-math" => run_date_math(ctx),
        _ => Err(err("Unsupported date operation")),
    }
}

pub(super) fn run_timestamp(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let tz = zone(ctx)?;
    let raw = string(ctx, "input", "");
    let lines: Vec<_> = raw
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if lines.is_empty() {
        return Err(err(if is_en(ctx) {
            "Input is required"
        } else {
            "请输入时间"
        }));
    }
    let unit = string(ctx, "unit", "auto");
    let style = string(ctx, "style", "both");
    let style = if [
        "full", "both", "iso", "date", "datetime", "relative", "chinese",
    ]
    .contains(&style)
    {
        style
    } else {
        "both"
    };
    let unit = if ["auto", "s", "ms", "us", "ns"].contains(&unit) {
        unit
    } else {
        "auto"
    };
    let now = Utc::now();
    let mut rendered = Vec::new();
    for line in &lines {
        let dt = validate_date_range(parse_at_unit(line, tz, unit)?, tz)?;
        let ms = dt.timestamp_millis();
        let ns = epoch_ns(dt);
        let value = match style {
            "iso" => local(dt, tz).to_rfc3339(),
            "date" => local(dt, tz).format("%Y-%m-%d").to_string(),
            "datetime" => fmt_local(dt, tz),
            "relative" => {
                let delta = (dt - now).num_milliseconds();
                let (n, relative_unit) = dominant_relative(delta);
                relative_phrase(
                    n,
                    relative_unit,
                    if is_en(ctx) { "en-US" } else { "zh-CN" },
                    false,
                )
            }
            "chinese" => {
                if is_en(ctx) {
                    local(dt, tz).format("%B %-d, %Y %I:%M:%S %p").to_string()
                } else {
                    local(dt, tz).format("%Y年%-m月%-d日 %H:%M:%S").to_string()
                }
            }
            "full" => {
                let mut report=format!("Local time: {}\nUnix seconds: {}\nUnix milliseconds: {}\nUnix microseconds: {}\nUnix nanoseconds: {}\nISO 8601: {}\nISO 8601 UTC: {}\nRFC 2822: {}\nInput: {line}\nTimezone: {}\nWeekday: {}\nDay of year: {}\nISO week: {}-W{:02}-{}\nRelative: {}",fmt_local(dt,tz),dt.timestamp(),ms,ns/1000,ns,local(dt,tz).to_rfc3339(),dt.to_rfc3339(),local(dt,tz).format("%a, %d %b %Y %H:%M:%S %z"),tz,local(dt,tz).format("%A"),local(dt,tz).ordinal(),local(dt,tz).iso_week().year(),local(dt,tz).iso_week().week(),local(dt,tz).weekday().number_from_monday(),relative_phrase(dominant_relative((dt-now).num_milliseconds()).0,dominant_relative((dt-now).num_milliseconds()).1,if is_en(ctx){"en-US"}else{"zh-CN"},false));
                if boolean(ctx, "showNow", true) {
                    report.push_str(&format!(
                        "\nNow: {} ({} ms)",
                        fmt_local(now, tz),
                        now.timestamp_millis()
                    ));
                }
                if boolean(ctx, "showRange", true) {
                    let date = local(dt, tz).date_naive();
                    let year_start = NaiveDate::from_ymd_opt(date.year(), 1, 1)
                        .ok_or_else(|| err("Date out of range"))?;
                    let month_start = NaiveDate::from_ymd_opt(date.year(), date.month(), 1)
                        .ok_or_else(|| err("Date out of range"))?;
                    let week_start =
                        date - Duration::days(date.weekday().num_days_from_monday() as i64);
                    let mut ranges = Vec::new();
                    for (label, start, length) in [
                        ("day", date, 1_i64),
                        ("week", week_start, 7),
                        ("month", month_start, 0),
                        ("year", year_start, 0),
                    ] {
                        let start_dt = resolve_local(tz, start.and_hms_opt(0, 0, 0).unwrap())?;
                        let end_dt = if length > 0 {
                            let end_date = start + Duration::days(length);
                            resolve_local(tz, end_date.and_hms_opt(0, 0, 0).unwrap())?
                                - Duration::milliseconds(1)
                        } else if label == "month" {
                            let next = if date.month() == 12 {
                                NaiveDate::from_ymd_opt(date.year() + 1, 1, 1)
                            } else {
                                NaiveDate::from_ymd_opt(date.year(), date.month() + 1, 1)
                            }
                            .ok_or_else(|| err("Date out of range"))?;
                            resolve_local(tz, next.and_hms_opt(0, 0, 0).unwrap())?
                                - Duration::milliseconds(1)
                        } else {
                            let next = NaiveDate::from_ymd_opt(date.year() + 1, 1, 1)
                                .ok_or_else(|| err("Date out of range"))?;
                            resolve_local(tz, next.and_hms_opt(0, 0, 0).unwrap())?
                                - Duration::milliseconds(1)
                        };
                        ranges.push(format!(
                            "{label}: {} to {}",
                            fmt_local(start_dt, tz),
                            fmt_local(end_dt, tz)
                        ));
                    }
                    report.push_str(&format!("\nRanges:\n{}", ranges.join("\n")));
                }
                report
            }
            _ if is_en(ctx) => format!(
                "Date/time: {}\nUnix seconds: {}\nUnix milliseconds: {}",
                fmt_local(dt, tz),
                dt.timestamp(),
                ms
            ),
            _ => format!(
                "日期时间：{}\nUnix 秒：{}\nUnix 毫秒：{}",
                fmt_local(dt, tz),
                dt.timestamp(),
                ms
            ),
        };
        rendered.push(value);
    }
    Ok(text_result(
        ctx,
        "timestamp.txt",
        rendered.join("\n"),
        &[
            ("inputs", lines.len().to_string()),
            ("timezone", tz.to_string()),
            ("style", style.into()),
            ("unit", unit.into()),
            (
                "showRange",
                if style == "full" {
                    boolean(ctx, "showRange", true).to_string()
                } else {
                    "false".into()
                },
            ),
            (
                "showNow",
                if style == "full" {
                    boolean(ctx, "showNow", true).to_string()
                } else {
                    "false".into()
                },
            ),
        ],
    ))
}

pub(super) fn run_date_diff(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let tz = zone(ctx)?;
    let from = parse_at(string(ctx, "from", "now"), tz)?;
    let to = parse_at(string(ctx, "to", "now"), tz)?;
    let delta = to.timestamp_millis() - from.timestamp_millis();
    let abs = delta.unsigned_abs();
    let days = abs / DAY_MS as u64;
    let (span, whole_days) = calendar_span(from, to, tz, is_en(ctx))?;
    let hours = abs / 3_600_000;
    let minutes = abs / 60_000;
    let seconds = abs / 1000;
    let direction = if delta == 0 {
        "same"
    } else if delta > 0 {
        "forward"
    } else {
        "backward"
    };
    let breakdown = boolean(ctx, "breakdown", true);
    let include_end = boolean(ctx, "includeEnd", false);
    let count_workdays = boolean(ctx, "countWorkdays", true);
    let mut lines = vec![
        format!("{} → {}", fmt_local(from, tz), fmt_local(to, tz)),
        format!("Direction: {direction}"),
    ];
    if breakdown {
        let sign = if delta < 0 { "−" } else { "" };
        lines.push(format!("Calendar span: {sign}{span}"));
        lines.push(format!(
            "Totals: {days} days, {hours} hours, {minutes} minutes, {seconds} seconds"
        ));
        lines.push(format!(
            "Calendar days: {whole_days}; including end: {}",
            whole_days.unsigned_abs() + 1
        ));
    }
    let unit = string(ctx, "unit", "auto");
    let unit = if ["auto", "days", "hours", "minutes", "seconds", "ms", "weeks"].contains(&unit) {
        unit
    } else {
        "auto"
    };
    if unit != "auto" {
        let divisor = match unit {
            "weeks" => 604_800_000.0,
            "days" => 86_400_000.0,
            "hours" => 3_600_000.0,
            "minutes" => 60_000.0,
            "seconds" => 1000.0,
            "ms" => 1000.0,
            _ => 1.0,
        };
        lines.push(format!("{unit}: {:+.6}", delta as f64 / divisor));
    }
    let mut workday_count = String::new();
    if count_workdays {
        let weekend = parse_weekend_set(string(ctx, "weekend", "0,6"))?;
        let holiday_set = parse_holidays(string(ctx, "holidays", ""), tz)?;
        let a = local(from, tz).date_naive();
        let b = local(to, tz).date_naive();
        let mut cursor = a.min(b);
        let end = a.max(b);
        let limit = if include_end {
            end
        } else if cursor == end {
            cursor.pred_opt().unwrap_or(cursor)
        } else {
            end.pred_opt().unwrap_or(end)
        };
        let mut work = 0_u64;
        let mut rest = 0_u64;
        if a != b || include_end {
            while cursor <= limit {
                if is_rest_day(cursor, &weekend, &holiday_set) {
                    rest += 1;
                } else {
                    work += 1;
                }
                cursor = cursor.succ_opt().ok_or_else(|| err("Date out of range"))?;
            }
        }
        workday_count = work.to_string();
        lines.push(format!("Workdays: {work}; weekends and holidays: {rest}"));
    }
    let mut extra = Map::new();
    put(&mut extra, "timezone", tz.to_string());
    put(&mut extra, "unit", unit.to_string());
    put(&mut extra, "milliseconds", delta.to_string());
    put(
        &mut extra,
        "phrase",
        format!("{}{}", if delta < 0 { "-" } else { "" }, span),
    );
    put(
        &mut extra,
        "daysExcludingEnd",
        whole_days.unsigned_abs().to_string(),
    );
    put(
        &mut extra,
        "daysIncludingEnd",
        (whole_days.unsigned_abs() + 1).to_string(),
    );
    put(&mut extra, "includeEnd", include_end.to_string());
    put(&mut extra, "breakdown", breakdown.to_string());
    put(&mut extra, "workdays", workday_count);
    Ok(output("date-diff.txt", lines.join("\n"), extra))
}

pub(super) fn run_date_math(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let tz = zone(ctx)?;
    let base = parse_at(string(ctx, "base", "now"), tz)?;
    let direction = string(ctx, "direction", "add");
    let direction = if ["add", "subtract"].contains(&direction) {
        direction
    } else {
        "add"
    };
    let unit = string(ctx, "unit", "days");
    let unit = if [
        "years", "months", "weeks", "days", "hours", "minutes", "seconds",
    ]
    .contains(&unit)
    {
        unit
    } else {
        "days"
    };
    let amount = number(ctx, "value", 1.0).round().abs() as i64
        * if direction == "subtract" { -1 } else { 1 };
    let result = add_calendar(base, tz, unit, amount)?;
    let base_local = local(base, tz);
    let result_local = local(result, tz);
    let clamped = matches!(unit, "years" | "months") && base_local.day() != result_local.day();
    let skip_weekend = boolean(ctx, "skipWeekend", false);
    let weekend = parse_weekend_set(string(ctx, "weekend", "0,6"))?;
    let holidays = parse_holidays(string(ctx, "holidays", ""), tz)?;
    let mut rolled = result;
    let mut skipped = Vec::new();
    if skip_weekend {
        for _ in 0..28 {
            let p = local(rolled, tz);
            let day = p.date_naive();
            if !is_rest_day(day, &weekend, &holidays) {
                break;
            }
            skipped.push(day.to_string());
            let next = day.succ_opt().ok_or_else(|| err("Date out of range"))?;
            rolled = resolve_local(
                tz,
                next.and_hms_milli_opt(
                    p.hour(),
                    p.minute(),
                    p.second(),
                    p.timestamp_subsec_millis(),
                )
                .ok_or_else(|| err("Date out of range"))?,
            )?;
        }
        if is_rest_day(local(rolled, tz).date_naive(), &weekend, &holidays) {
            return Err(err("Could not roll date to a working day"));
        }
    }
    let mut extra = Map::new();
    put(&mut extra, "timezone", tz.to_string());
    put(&mut extra, "unit", unit.to_string());
    put(&mut extra, "value", amount.to_string());
    put(&mut extra, "clamped", clamped);
    put(&mut extra, "result", fmt_local(result, tz));
    let mut report = format!(
        "Base: {}\nAction: {} {} {}\nResult: {}\nISO 8601: {}\nUnix seconds: {}",
        fmt_local(base, tz),
        direction,
        amount.unsigned_abs(),
        unit,
        fmt_local(rolled, tz),
        local(rolled, tz).to_rfc3339(),
        rolled.timestamp()
    );
    if !skipped.is_empty() {
        report.push_str(&format!("\nSkipped rest days: {}", skipped.join(", ")));
    }
    Ok(output("date-math.txt", report, extra))
}
