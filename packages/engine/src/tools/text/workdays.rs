//! Implementations for the workdays text tool group.

use super::calendar::*;
use super::common::*;
use super::{EngineError, RunContext, ToolResult};
use chrono::{NaiveDate, Utc};
use serde_json::Map;

pub(super) fn run(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    run_workdays(ctx)
}

pub(super) fn run_workdays(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let tz = zone(ctx)?;
    let start = parse_at(string(ctx, "start", "today"), tz)?;
    let mode = string(ctx, "mode", "add");
    let mode = if ["add", "count"].contains(&mode) {
        mode
    } else {
        "add"
    };
    let weekend = parse_weekend_set(string(ctx, "weekend", "0,6"))?;
    let holidays = parse_holidays(string(ctx, "holidays", ""), tz)?;
    let start_day = local(start, tz).date_naive();
    let mut cursor = start_day;
    let mut work = 0_i64;
    let mut rest = 0_i64;
    let requested = number(ctx, "days", 10.0).round().clamp(-9999.0, 9999.0) as i64;
    let mut worked = Vec::new();
    let mut skipped = Vec::new();
    if mode == "count" {
        let now = local(Utc::now(), tz).date_naive();
        let end = now.max(start_day);
        cursor = now.min(start_day);
        loop {
            let off = is_rest_day(cursor, &weekend, &holidays);
            if off {
                rest += 1;
                if skipped.len() < 120 {
                    skipped.push(cursor.to_string());
                }
            } else {
                work += 1;
                if worked.len() < 10_000 {
                    worked.push(cursor.to_string());
                }
            }
            if cursor == end {
                break;
            }
            cursor = cursor.succ_opt().ok_or_else(|| err("Date out of range"))?;
        }
    } else {
        let step = if requested < 0 { -1 } else { 1 };
        let target = requested.unsigned_abs() as i64;
        let mut guard = 0;
        while work < target && guard < 366_000 {
            cursor = if step > 0 {
                cursor.succ_opt()
            } else {
                cursor.pred_opt()
            }
            .ok_or_else(|| err("Date out of range"))?;
            let off = is_rest_day(cursor, &weekend, &holidays);
            if off {
                rest += 1;
                if skipped.len() < 120 {
                    skipped.push(cursor.to_string());
                }
            } else {
                work += 1;
                if worked.len() < 10_000 {
                    worked.push(cursor.to_string());
                }
            }
            guard += 1;
        }
        if guard >= 366_000 && work < target {
            return Err(err("Workday scan limit exceeded"));
        }
    }
    let mut text = if mode == "count" {
        format!(
            "Working days: {work}\nRest days: {rest}\nRange: {} to {}",
            start_day, cursor
        )
    } else {
        format!("Target date: {cursor}\nWorking days added: {work}\nRest days skipped: {rest}")
    };
    if mode == "add" && !worked.is_empty() {
        let natural_days = (cursor - start_day).num_days().unsigned_abs();
        if natural_days > 30 {
            let mut dates = worked.clone();
            dates.sort();
            let mut ranges: Vec<(String, String)> = Vec::new();
            for date in dates {
                if let Some((_, end)) = ranges.last_mut() {
                    let previous = NaiveDate::parse_from_str(end, "%Y-%m-%d").unwrap();
                    let current = NaiveDate::parse_from_str(&date, "%Y-%m-%d").unwrap();
                    if current == previous.succ_opt().unwrap() {
                        *end = date;
                        continue;
                    }
                }
                ranges.push((date.clone(), date));
            }
            let formatted = ranges
                .into_iter()
                .map(|(a, b)| if a == b { a } else { format!("{a} to {b}") })
                .collect::<Vec<_>>()
                .join(", ");
            text.push_str(&format!("\nWorking date intervals: {formatted}"));
        } else {
            let displayed = worked
                .iter()
                .take(120)
                .cloned()
                .collect::<Vec<_>>()
                .join(", ");
            text.push_str(&format!(
                "\nWorking dates: {displayed}{}",
                if worked.len() > 120 {
                    " (truncated)"
                } else {
                    ""
                }
            ));
        }
    }
    if !skipped.is_empty() {
        text.push_str(&format!(
            "\nSkipped dates: {}{}",
            skipped.join(", "),
            if rest > skipped.len() as i64 {
                " (truncated)"
            } else {
                ""
            }
        ));
    }
    let mut extra = Map::new();
    put(&mut extra, "timezone", tz.to_string());
    put(&mut extra, "mode", mode.to_string());
    put(&mut extra, "result", cursor.to_string());
    put(&mut extra, "workingDays", work.to_string());
    put(&mut extra, "restDays", rest.to_string());
    put(&mut extra, "requested", requested.to_string());
    Ok(output("workdays.txt", text, extra))
}
