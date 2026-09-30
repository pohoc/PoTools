//! Date-math tool: mirrors the product engine's date arithmetic report.

use super::common::*;
use super::fmt::{self, row};
use super::{EngineError, RunContext, ToolResult};
use chrono::{Datelike, TimeZone, Timelike, Utc};
use serde_json::Map;

pub(super) fn run(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let ui = ctx.locale;
    let tz = zone(ctx)?;
    let now = Utc::now();
    let locale = if is_en(ctx)
        || string(ctx, "locale", "zh-CN")
            .to_lowercase()
            .starts_with('e')
    {
        fmt::EN_US
    } else {
        fmt::ZH_CN
    };
    let base_raw = string(ctx, "base", "now").trim().to_string();
    let base_raw = if base_raw.is_empty() {
        "now".to_string()
    } else {
        base_raw
    };
    let base = parse_at(&base_raw, tz)?;
    let direction = match string(ctx, "direction", "add") {
        "subtract" => "subtract",
        _ => "add",
    };
    let unit = match string(ctx, "unit", "days") {
        "years" | "months" | "weeks" | "hours" | "minutes" | "seconds" => {
            string(ctx, "unit", "days")
        }
        _ => "days",
    };
    let magnitude = number(ctx, "value", 1.0).round().abs() as i64;
    let signed_value = if direction == "subtract" {
        -magnitude
    } else {
        magnitude
    };
    let (years, months, weeks, days, hours, minutes, seconds) = match unit {
        "years" => (signed_value, 0, 0, 0, 0, 0, 0),
        "months" => (0, signed_value, 0, 0, 0, 0, 0),
        "weeks" => (0, 0, signed_value, 0, 0, 0, 0),
        "days" => (0, 0, 0, signed_value, 0, 0, 0),
        "hours" => (0, 0, 0, 0, signed_value, 0, 0),
        "minutes" => (0, 0, 0, 0, 0, signed_value, 0),
        _ => (0, 0, 0, 0, 0, 0, signed_value),
    };
    let (shifted_ms, clamped, clamped_from, clamped_to, adjusted) = fmt::shift_calendar(
        base.timestamp_millis(),
        tz,
        years,
        months,
        weeks,
        days,
        hours,
        minutes,
        seconds,
    )?;
    let shifted = Utc
        .timestamp_millis_opt(shifted_ms)
        .single()
        .ok_or_else(|| err("Date out of range"))?;
    let skip_weekend = boolean(ctx, "skipWeekend", false);
    let weekend = fmt::parse_weekend_set(string(ctx, "weekend", "0,6"), ui)?;
    let holidays = fmt::parse_holiday_map(string(ctx, "holidays", ""), tz, ui)?;
    let mut roll = None;
    if skip_weekend {
        let (index, skipped) =
            fmt::roll_to_working_day(fmt::day_index_of_instant(shifted, tz), &weekend, &holidays);
        let result_p = local(shifted, tz);
        let wall = super::fmt::day_cell(index);
        let parts: Vec<u32> = wall.key.split('-').filter_map(|p| p.parse().ok()).collect();
        let wall_date = chrono::NaiveDate::from_ymd_opt(
            parts.first().copied().unwrap_or(1970) as i32,
            parts.get(1).copied().unwrap_or(1),
            parts.get(2).copied().unwrap_or(1),
        )
        .ok_or_else(|| err("Date out of range"))?;
        let (rolled_dt, _) = fmt::resolve_wall_time(
            tz,
            wall_date
                .and_hms_opt(result_p.hour(), result_p.minute(), result_p.second())
                .ok_or_else(|| err("Date out of range"))?,
        );
        let rolled_ms =
            rolled_dt.timestamp_millis() + i64::from(result_p.timestamp_subsec_millis());
        roll = Some((rolled_ms, skipped));
    }
    let rolled_ms = roll.as_ref().map(|(ms, _)| *ms).unwrap_or(shifted_ms);
    let rolled_at = Utc
        .timestamp_millis_opt(rolled_ms)
        .single()
        .unwrap_or(shifted);
    let en_phrase = locale == fmt::EN_US;
    let span = fmt::calendar_breakdown(base.timestamp_millis(), shifted_ms, tz)?;
    let action_unit = {
        let name = fmt::unit_name(unit, ui);
        if !fmt::is_zh(ui) && magnitude == 1 {
            name.strip_suffix('s').unwrap_or(&name).to_string()
        } else {
            name
        }
    };
    let action = format!(
        "{} {} {}",
        fmt::msg(
            ui,
            if direction == "add" { "加" } else { "减" },
            if direction == "add" {
                "Add"
            } else {
                "Subtract"
            }
        ),
        magnitude,
        action_unit
    );
    let result_value = format!(
        "{} · {}",
        fmt::format_zone_stamp(shifted, tz),
        fmt::instant_line(tz, shifted, ui)
    );
    let base_p = local(base, tz);
    let result_p = local(shifted, tz);
    let (iso_year, iso_week, iso_weekday) =
        fmt::iso_week_of(result_p.year(), result_p.month(), result_p.day());
    let mut blocks = vec![
        fmt::section(fmt::msg(ui, "结果", "Result")),
        fmt::align_rows(&[
            row(fmt::msg(ui, "结果", "Result"), result_value.clone()),
            row("ISO 8601", fmt::iso_in_zone(shifted, tz)),
            row(
                fmt::msg(ui, "Unix 秒", "Unix seconds"),
                (shifted_ms / fmt::SEC_MS).to_string(),
            ),
        ]),
        fmt::section(&fmt::msg(
            ui,
            &format!("日期加减 · {}", tz.name()),
            &format!("Date arithmetic · {}", tz.name()),
        )),
        fmt::align_rows(&[
            row(
                fmt::msg(ui, "基准", "Base"),
                format!(
                    "{} → {} · {}",
                    base_raw,
                    fmt::format_zone_stamp(base, tz),
                    fmt::instant_line(tz, base, ui)
                ),
            ),
            row(fmt::msg(ui, "操作", "Operation"), action),
            row(fmt::msg(ui, "结果", "Result"), result_value),
            row(
                fmt::msg(ui, "本地日期", "Local date"),
                format!(
                    "{}-{}-{}",
                    fmt::pad(result_p.year(), 4),
                    fmt::pad(result_p.month(), 2),
                    fmt::pad(result_p.day(), 2)
                ),
            ),
            row("ISO 8601", fmt::iso_in_zone(shifted, tz)),
            row(
                fmt::msg(ui, "中文日期", "Date (long)"),
                fmt::long_date(shifted, tz, ui),
            ),
            row(
                fmt::msg(ui, "星期", "Weekday"),
                fmt::weekday_pair(result_p.weekday().num_days_from_sunday(), ui),
            ),
            row(
                fmt::msg(ui, "ISO 周", "ISO week"),
                format!("{}-W{}-{}", iso_year, fmt::pad(iso_week, 2), iso_weekday),
            ),
            row(
                fmt::msg(ui, "年内第几天", "Day of year"),
                format!(
                    "{} / {}",
                    result_p.ordinal(),
                    if (result_p.year() % 4 == 0 && result_p.year() % 100 != 0)
                        || result_p.year() % 400 == 0
                    {
                        366
                    } else {
                        365
                    }
                ),
            ),
            row(
                fmt::msg(ui, "Unix 秒", "Unix seconds"),
                (shifted_ms / fmt::SEC_MS).to_string(),
            ),
            row(
                fmt::msg(ui, "Unix 毫秒", "Unix milliseconds"),
                shifted_ms.to_string(),
            ),
            row(
                fmt::msg(ui, "距基准", "From base"),
                format!(
                    "{}{}",
                    if signed_value < 0 { "−" } else { "+" },
                    fmt::span_text(
                        &fmt::CalendarSpan {
                            sign: 1,
                            ..span.clone()
                        },
                        en_phrase
                    )
                ),
            ),
        ]),
    ];
    let mut notes: Vec<String> = Vec::new();
    if let Some((rolled_ms, skipped)) = &roll {
        let rolled = Utc
            .timestamp_millis_opt(*rolled_ms)
            .single()
            .unwrap_or(rolled_at);
        let sep = fmt::rest_sep(ui);
        let skip_list = if skipped.is_empty() {
            fmt::msg(
                ui,
                "结果本就是工作日，无需顺延。",
                "The result already falls on a working day; nothing was skipped.",
            )
            .to_string()
        } else {
            skipped
                .iter()
                .map(|cell| {
                    let weekday = super::fmt::day_cell(cell.index).weekday;
                    format!(
                        "{}{}{}{}",
                        cell.key,
                        fmt::msg(ui, "（", " ("),
                        fmt::weekday_spelled(weekday, ui),
                        fmt::msg(ui, "）", ")")
                    )
                })
                .collect::<Vec<_>>()
                .join(sep)
        };
        let rolled_p = local(rolled, tz);
        blocks.push(fmt::section(fmt::msg(
            ui,
            "顺延至工作日",
            "Rolled to a working day",
        )));
        blocks.push(fmt::align_rows(&[
            row(
                fmt::msg(ui, "周末定义", "Weekend definition"),
                fmt::format_weekend_set(&weekend, ui),
            ),
            row(
                fmt::msg(ui, "跳过天数", "Days skipped"),
                fmt::format_number(skipped.len() as f64),
            ),
            row(fmt::msg(ui, "跳过明细", "Skipped days"), skip_list),
            row(
                fmt::msg(ui, "顺延后结果", "Result after rolling"),
                format!(
                    "{} · {}",
                    fmt::format_zone_stamp(rolled, tz),
                    fmt::instant_line(tz, rolled, ui)
                ),
            ),
            row(
                fmt::msg(ui, "星期", "Weekday"),
                fmt::weekday_pair(rolled_p.weekday().num_days_from_sunday(), ui),
            ),
            row("ISO 8601", fmt::iso_in_zone(rolled, tz)),
            row(
                fmt::msg(ui, "Unix 秒", "Unix seconds"),
                (rolled.timestamp_millis() / fmt::SEC_MS).to_string(),
            ),
        ]));
        notes.push(
            fmt::msg(
                ui,
                "· skipWeekend 只向后方顺延到下一个工作日，周末与节假日按整日枚举判断。",
                "· skipWeekend only rolls forward to the next working day; weekends and holidays are decided by enumerating whole days.",
            )
            .to_string(),
        );
    }
    if clamped {
        notes.push(
            fmt::msg(
                ui,
                &format!("· 目标月份没有 {clamped_from} 日，已收敛到该月最后一天：{clamped_from} 日 → {clamped_to} 日。"),
                &format!("· The target month has no day {clamped_from}; it was clamped to the last day of that month: day {clamped_from} → {clamped_to}."),
            )
            .to_string(),
        );
    }
    if adjusted {
        notes.push(
            fmt::msg(
                ui,
                &format!("· 目标本地时间落在 {tz} 夏令时切换的空档/重叠区间，已按真实瞬时顺延。", tz = tz.name()),
                &format!("· The target local time falls into the gap or overlap of the {tz} daylight-saving switch; the real instant was shifted.", tz = tz.name()),
            )
            .to_string(),
        );
    }
    if fmt::is_dst_active(base, tz) != fmt::is_dst_active(rolled_at, tz) {
        notes.push(
            fmt::msg(
                ui,
                &format!(
                    "· 跨越夏令时边界：偏移 UTC{} → UTC{}。",
                    fmt::offset_label(fmt::offset_minutes_of(base, tz), true),
                    fmt::offset_label(fmt::offset_minutes_of(rolled_at, tz), true)
                ),
                &format!(
                    "· A daylight-saving boundary was crossed: offset UTC{} → UTC{}.",
                    fmt::offset_label(fmt::offset_minutes_of(base, tz), true),
                    fmt::offset_label(fmt::offset_minutes_of(rolled_at, tz), true)
                ),
            )
            .to_string(),
        );
    }
    if !notes.is_empty() {
        blocks.push(fmt::section(fmt::msg(ui, "说明", "Notes")));
        blocks.push(notes.join("\n"));
    }
    let mut extra = Map::new();
    put(&mut extra, "timezone", tz.name());
    put(&mut extra, "unit", unit);
    put(&mut extra, "value", signed_value.to_string());
    put(&mut extra, "clamped", clamped);
    put(&mut extra, "result", fmt::format_in_zone(shifted, tz));
    let _ = (base_p, now);
    Ok(output(
        "date-math.txt",
        fmt::join_blocks(blocks.iter().map(String::as_str)),
        extra,
    ))
}
