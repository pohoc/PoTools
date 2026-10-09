//! Implementations for the date format text tool group.

use super::common::*;
use super::{EngineError, RunContext, ToolResult};
use chrono::{DateTime, Datelike, Timelike, Utc};
use chrono_tz::Tz;
use serde_json::Map;

pub(super) fn render_date_pattern(pattern: &str, dt: DateTime<Tz>, locale: &str) -> String {
    let mut output = String::new();
    let chars: Vec<char> = pattern.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        let mut j = i + 1;
        while j < chars.len() && chars[j] == ch {
            j += 1;
        }
        let run: String = chars[i..j].iter().collect();
        let weekday = dt.weekday().num_days_from_sunday() as usize;
        let value = match run.as_str() {
            "YYYY" => Some(dt.format("%Y").to_string()),
            "MM" => Some(dt.format("%m").to_string()),
            "DD" => Some(dt.format("%d").to_string()),
            "HH" => Some(dt.format("%H").to_string()),
            "mm" => Some(dt.format("%M").to_string()),
            "ss" => Some(dt.format("%S").to_string()),
            "SSS" => Some(format!("{:03}", dt.timestamp_subsec_millis())),
            "ZZ" => Some(dt.format("%z").to_string()),
            "A" => Some(if locale.to_lowercase().starts_with("zh") {
                if dt.hour() >= 12 { "下午" } else { "上午" }.into()
            } else if locale.to_lowercase().starts_with("ja") {
                if dt.hour() >= 12 {
                    "午後".into()
                } else {
                    "午前".into()
                }
            } else if dt.hour() >= 12 {
                "PM".into()
            } else {
                "AM".into()
            }),
            "ddd" => Some(if locale.to_lowercase().starts_with("zh") {
                ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][weekday].into()
            } else if locale.to_lowercase().starts_with("ja") {
                ["日", "月", "火", "水", "木", "金", "土"][weekday].into()
            } else {
                dt.format("%a").to_string()
            }),
            "dddd" => Some(if locale.to_lowercase().starts_with("zh") {
                [
                    "星期日",
                    "星期一",
                    "星期二",
                    "星期三",
                    "星期四",
                    "星期五",
                    "星期六",
                ][weekday]
                    .into()
            } else if locale.to_lowercase().starts_with("ja") {
                [
                    "日曜日",
                    "月曜日",
                    "火曜日",
                    "水曜日",
                    "木曜日",
                    "金曜日",
                    "土曜日",
                ][weekday]
                    .into()
            } else {
                dt.format("%A").to_string()
            }),
            _ => None,
        };
        output.push_str(value.as_deref().unwrap_or(&run));
        i = j;
    }
    output
}

pub(super) fn run(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    run_date_format(ctx)
}

pub(super) fn run_date_format(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let tz = zone(ctx)?;
    let pattern = string(ctx, "pattern", "YYYY-MM-DD HH:mm:ss");
    if pattern.is_empty() {
        return Err(err("Date format pattern is required"));
    }
    let raw = string(ctx, "input", "now");
    let lines: Vec<_> = raw
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if lines.is_empty() {
        return Err(err("Date input is required"));
    }
    let requested = string(ctx, "locale", "zh-CN");
    let requested_locale = if is_en(ctx) && requested == "zh-CN" {
        "en-US"
    } else {
        requested
    };
    let show_common = boolean(ctx, "showCommon", true);
    let show_epochs = boolean(ctx, "showEpochs", true);
    let mut rendered = Vec::new();
    let mut reports = Vec::new();
    let mut first: Option<DateTime<Utc>> = None;
    for input in &lines {
        let dt = parse_at(input, tz)?;
        let p = local(dt, tz);
        let formatted = render_date_pattern(pattern, p, requested_locale);
        rendered.push(formatted.clone());
        first.get_or_insert(dt);
        let mut detail = format!(
            "# {}\nOutput: {}\nLocal time: {}\nISO 8601: {}\nTimezone: {}",
            input,
            formatted,
            p.format("%Y-%m-%d %H:%M:%S"),
            p.to_rfc3339(),
            p.format("%Z %:z")
        );
        if show_epochs {
            let ns = epoch_ns(dt);
            detail.push_str(&format!("\nUnix seconds: {}\nEpoch milliseconds: {}\nEpoch microseconds: {}\nEpoch nanoseconds: {}", dt.timestamp(), dt.timestamp_millis(), ns / 1000, ns));
        }
        reports.push(detail);
    }
    if show_common {
        let dt = first.unwrap_or_else(Utc::now);
        let p = local(dt, tz);
        reports.push(format!("Common formats\nISO date: {}\nDate and time: {}\nMinute: {}\nWeekday: {}\n12-hour: {}\nWith offset: {}\nFile safe: {}\nUS style: {}\nEU style: {}\nRFC 2822: {}\nISO week: {}-W{:02}-{}\nUnix: {}",p.format("%Y-%m-%d"),p.format("%Y-%m-%d %H:%M:%S"),p.format("%Y-%m-%d %H:%M"),p.format("%A"),p.format("%Y-%m-%d %I:%M:%S %p"),p.format("%Y-%m-%d %H:%M:%S %:z"),p.format("%Y%m%d-%H%M%S"),p.format("%m/%d/%Y %H:%M"),p.format("%d.%m.%Y %H:%M"),p.format("%a, %d %b %Y %H:%M:%S %z"),p.iso_week().year(),p.iso_week().week(),p.weekday().number_from_monday(),dt.timestamp()));
        let tokens = [
            "YYYY", "MM", "DD", "HH", "mm", "ss", "SSS", "ddd", "dddd", "A", "ZZ",
        ];
        reports.push(format!(
            "Pattern tokens\n{}",
            tokens
                .iter()
                .map(|token| format!(
                    "{token}: {}",
                    render_date_pattern(token, p, requested_locale)
                ))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    let mut extra = Map::new();
    put(&mut extra, "inputs", lines.len() as i64);
    put(&mut extra, "locale", requested_locale.to_string());
    put(&mut extra, "timezone", tz.to_string());
    put(&mut extra, "pattern", pattern.to_string());
    put(&mut extra, "showCommon", show_common);
    put(&mut extra, "showEpochs", show_epochs);
    put(
        &mut extra,
        "rendered",
        rendered.first().cloned().unwrap_or_default(),
    );
    Ok(output("date-format.txt", reports.join("\n\n"), extra))
}
