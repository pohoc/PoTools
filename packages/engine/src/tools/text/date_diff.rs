//! Date-diff tool: mirrors the product engine's date difference report.

use super::common::*;
use super::fmt::{self, row};
use super::{EngineError, RunContext, ToolResult};
use serde_json::Map;

const REST_LIST_SHOWN: usize = 4;

pub(super) fn run(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let ui = ctx.locale;
    let tz = zone(ctx)?;
    let locale = if is_en(ctx)
        || string(ctx, "locale", "zh-CN")
            .to_lowercase()
            .starts_with('e')
    {
        fmt::EN_US
    } else {
        fmt::ZH_CN
    };
    let unit_raw = string(ctx, "unit", "auto");
    let unit = if ["auto", "days", "hours", "minutes", "seconds", "ms", "weeks"].contains(&unit_raw)
    {
        unit_raw
    } else {
        "auto"
    };
    let breakdown = boolean(ctx, "breakdown", true);
    let include_end = boolean(ctx, "includeEnd", false);
    let count_workdays = boolean(ctx, "countWorkdays", true);
    let weekend = fmt::parse_weekend_set(string(ctx, "weekend", "0,6"), ui)?;
    let holidays = fmt::parse_holiday_map(string(ctx, "holidays", ""), tz, ui)?;
    let from_raw = string(ctx, "from", "now").trim().to_string();
    let from_raw = if from_raw.is_empty() {
        "now".to_string()
    } else {
        from_raw
    };
    let to_raw = string(ctx, "to", "now").trim().to_string();
    let to_raw = if to_raw.is_empty() {
        "now".to_string()
    } else {
        to_raw
    };
    let from = parse_at(&from_raw, tz)?;
    let to = parse_at(&to_raw, tz)?;
    let from_ms = from.timestamp_millis();
    let to_ms = to.timestamp_millis();
    let delta = to_ms - from_ms;
    let span = fmt::calendar_breakdown(from_ms, to_ms, tz)?;
    let first_index = fmt::day_index_of_instant(from, tz).min(fmt::day_index_of_instant(to, tz));
    let whole_days =
        (fmt::day_index_of_instant(to, tz) - fmt::day_index_of_instant(from, tz)).abs();
    let counted_days = whole_days + i64::from(include_end);
    let tally = if count_workdays {
        Some(fmt::tally_day_range(
            first_index,
            counted_days,
            &weekend,
            &holidays,
        ))
    } else {
        None
    };
    let direction = if delta == 0 {
        fmt::msg(ui, "同一时刻（0）", "Same instant (0)")
    } else if delta > 0 {
        fmt::msg(
            ui,
            "终点晚于起点，符号 +",
            "End is later than start, sign +",
        )
    } else {
        fmt::msg(
            ui,
            "终点早于起点，符号 −",
            "End is earlier than start, sign −",
        )
    };
    let span_value = format!(
        "{}{}",
        if delta < 0 { "−" } else { "" },
        fmt::span_text(&fmt::CalendarSpan { sign: 1, ..span }, locale == fmt::EN_US)
    );
    let mut result_rows = vec![
        row(
            fmt::msg(ui, "日历分解", "Calendar breakdown"),
            span_value.clone(),
        ),
        row(fmt::msg(ui, "方向", "Direction"), direction),
    ];
    if unit != "auto" {
        result_rows.push(row(
            by_unit_label(ui, unit),
            format!(
                "{} {}",
                fmt::signed(delta as f64 / divisor_of(unit)),
                unit_suffix(unit, locale == fmt::EN_US, ui)
            ),
        ));
    }
    let mut blocks = vec![
        fmt::section(fmt::msg(ui, "结果", "Result")),
        fmt::align_rows(&result_rows),
        fmt::section(fmt::msg(
            ui,
            &format!("日期差 · {}", tz.name()),
            &format!("Date difference · {}", tz.name()),
        )),
        fmt::align_rows(&[
            row(
                fmt::msg(ui, "起点", "Start"),
                format!(
                    "{} → {} · {}",
                    from_raw,
                    fmt::format_zone_stamp(from, tz),
                    fmt::instant_line(tz, from, ui)
                ),
            ),
            row(
                fmt::msg(ui, "终点", "End"),
                format!(
                    "{} → {} · {}",
                    to_raw,
                    fmt::format_zone_stamp(to, tz),
                    fmt::instant_line(tz, to, ui)
                ),
            ),
            row(fmt::msg(ui, "方向", "Direction"), direction),
            row(fmt::msg(ui, "日历分解", "Calendar breakdown"), span_value),
        ]),
        fmt::section(fmt::msg(ui, "总量（各单位）", "Totals (per unit)")),
        totals_rows((to_ms - from_ms).abs(), locale == fmt::EN_US, ui),
        fmt::section(fmt::msg(ui, "终点日计数", "End-day convention")),
        fmt::align_rows(&[
            row(
                fmt::msg(ui, "计数约定", "Counting rule"),
                fmt::msg(
                    ui,
                    if include_end {
                        "含终点日（起点日与终点日都计入）"
                    } else {
                        "不含终点日（终点日不计入）"
                    },
                    if include_end {
                        "The end day is counted (both the start day and the end day)."
                    } else {
                        "The end day is excluded."
                    },
                ),
            ),
            row(
                fmt::msg(ui, "不含终点日", "Excluding the end day"),
                format!(
                    "{} {}",
                    fmt::format_number(whole_days as f64),
                    unit_suffix("days", locale == fmt::EN_US, ui)
                ),
            ),
            row(
                fmt::msg(ui, "含终点日", "Including the end day"),
                format!(
                    "{} {}",
                    fmt::format_number((whole_days + 1) as f64),
                    unit_suffix("days", locale == fmt::EN_US, ui)
                ),
            ),
            row(
                fmt::msg(ui, "两者相差", "Difference"),
                fmt::msg(ui, "1 天", "1 day"),
            ),
        ]),
    ];
    if let Some(tally) = &tally {
        let sep = fmt::rest_sep(ui);
        let shown = tally
            .rest_list
            .iter()
            .take(REST_LIST_SHOWN)
            .map(|cell| format!("{} {}", cell.key, fmt::weekday_spelled(cell.weekday, ui)))
            .collect::<Vec<_>>()
            .join(sep);
        let hidden = tally.rest_days - tally.rest_days.min(REST_LIST_SHOWN as i64);
        let tally_rows = vec![
            row(
                fmt::msg(ui, "周末定义", "Weekend definition"),
                fmt::format_weekend_set(&weekend, ui),
            ),
            row(
                fmt::msg(ui, "节假日清单", "Holidays defined"),
                if holidays.is_empty() {
                    fmt::msg(ui, "未填写", "not set").to_string()
                } else {
                    let list = holidays
                        .keys()
                        .take(6)
                        .cloned()
                        .collect::<Vec<_>>()
                        .join(sep);
                    let more = if holidays.len() > 6 {
                        fmt::msg(ui, " …", " ...")
                    } else {
                        ""
                    };
                    format!(
                        "{}{list}{more}",
                        fmt::msg(
                            ui,
                            &format!("{} 天：", holidays.len()),
                            &format!("{} listed: ", holidays.len())
                        ),
                    )
                },
            ),
            row(
                fmt::msg(ui, "范围内天数", "Days in range"),
                format!(
                    "{} {}",
                    fmt::format_number(tally.total as f64),
                    unit_suffix("days", locale == fmt::EN_US, ui)
                ),
            ),
            row(
                fmt::msg(ui, "工作日", "Workdays"),
                format!(
                    "{} {}",
                    fmt::format_number(tally.workdays as f64),
                    unit_suffix("days", locale == fmt::EN_US, ui)
                ),
            ),
            row(
                fmt::msg(ui, "周末", "Weekend days"),
                format!(
                    "{} {}",
                    fmt::format_number(tally.weekend_days as f64),
                    unit_suffix("days", locale == fmt::EN_US, ui)
                ),
            ),
            row(
                fmt::msg(ui, "节假日", "Holidays"),
                format!(
                    "{} {}",
                    fmt::format_number(tally.holiday_days as f64),
                    unit_suffix("days", locale == fmt::EN_US, ui)
                ),
            ),
            row(
                fmt::msg(ui, "休息日明细", "Rest days"),
                if shown.is_empty() {
                    fmt::msg(ui, "无", "none").to_string()
                } else if hidden > 0 {
                    format!(
                        "{shown}{}",
                        fmt::msg(
                            ui,
                            &format!(" 等 {hidden} 项"),
                            &format!(" and {hidden} more")
                        )
                    )
                } else {
                    shown
                },
            ),
        ];
        blocks.push(fmt::section(fmt::msg(
            ui,
            "工作日 / 周末统计",
            "Weekday / weekend breakdown",
        )));
        blocks.push(fmt::align_rows(&tally_rows));
        if tally.truncated {
            blocks.push(fmt::msg(
                ui,
                &format!("· 范围超过 {} 天，周末与节假日只统计前 {} 天。", fmt::DAY_TALLY_CAP, fmt::DAY_TALLY_CAP),
                &format!("· The range is longer than {} days; weekends and holidays only cover the first {} days.", fmt::DAY_TALLY_CAP, fmt::DAY_TALLY_CAP),
            ).to_string());
        }
    }
    if unit != "auto" {
        blocks.push(fmt::section(fmt::msg(ui, "所选单位", "Selected unit")));
        blocks.push(fmt::align_rows(&[row(
            by_unit_label(ui, unit),
            format!(
                "{} {}",
                fmt::signed(delta as f64 / divisor_of(unit)),
                unit_suffix(unit, locale == fmt::EN_US, ui)
            ),
        )]));
    }
    if !breakdown {
        blocks.push(fmt::section(fmt::msg(ui, "分解", "Breakdown")));
        blocks.push(
            fmt::msg(
                ui,
                "  · 已关闭（breakdown = false），仅输出总量。",
                "  · Disabled (breakdown = false); only totals are shown.",
            )
            .to_string(),
        );
    }
    let mut notes: Vec<String> = Vec::new();
    if fmt::offset_minutes_of(from, tz) != fmt::offset_minutes_of(to, tz) {
        let state = if fmt::is_dst_active(to, tz) {
            fmt::msg(ui, "进入夏令时", "daylight time starts")
        } else {
            fmt::msg(ui, "退出夏令时", "daylight time ends")
        };
        notes.push(
            fmt::msg(
                ui,
                &format!(
                    "· {} 偏移由 UTC{} 变为 UTC{}（{state}），同日同时刻的间隔不是 24 小时。",
                    tz.name(),
                    fmt::offset_label(fmt::offset_minutes_of(from, tz), true),
                    fmt::offset_label(fmt::offset_minutes_of(to, tz), true)
                ),
                &format!(
                    "· The {} offset changes from UTC{} to UTC{} ({state}), so a same-clock gap is not 24 hours.",
                    tz.name(),
                    fmt::offset_label(fmt::offset_minutes_of(from, tz), true),
                    fmt::offset_label(fmt::offset_minutes_of(to, tz), true)
                ),
            )
            .to_string(),
        );
    }
    if unit != "auto" {
        let label = unit_option_label(unit, ui);
        notes.push(
            fmt::msg(
                ui,
                &format!("· unit={label}，总量已按该单位给出。"),
                &format!("· unit={label}; the totals are given in that unit."),
            )
            .to_string(),
        );
    }
    if tally.is_some() {
        let convention = fmt::msg(
            ui,
            if include_end {
                "含终点日"
            } else {
                "不含终点日"
            },
            if include_end {
                "Including the end day"
            } else {
                "Excluding the end day"
            },
        );
        notes.push(
            fmt::msg(
                ui,
                &format!("· 总量是精确的瞬时差；工作日按整日枚举（{convention}），口径与工作日工具一致。"),
                &format!("· The totals are exact instant deltas; the day tally enumerates whole days ({convention}) and matches the workdays tool."),
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
    put(&mut extra, "breakdown", breakdown.to_string());
    put(&mut extra, "milliseconds", delta.to_string());
    put(
        &mut extra,
        "phrase",
        fmt::span_text(&span, locale == fmt::EN_US),
    );
    put(&mut extra, "includeEnd", include_end.to_string());
    put(&mut extra, "daysExcludingEnd", whole_days.to_string());
    put(&mut extra, "daysIncludingEnd", (whole_days + 1).to_string());
    put(
        &mut extra,
        "workdays",
        tally.map(|t| t.workdays.to_string()).unwrap_or_default(),
    );
    Ok(output(
        "date-diff.txt",
        fmt::join_blocks(blocks.iter().map(String::as_str)),
        extra,
    ))
}

fn by_unit_label(ui: &str, unit: &str) -> String {
    format!(
        "{}{}",
        fmt::msg(ui, "按", "By "),
        unit_option_label(unit, ui)
    )
}

fn unit_option_label(unit: &str, ui: &str) -> String {
    match unit {
        "days" => fmt::msg(ui, "天", "Days").to_string(),
        "hours" => fmt::msg(ui, "小时", "Hours").to_string(),
        "minutes" => fmt::msg(ui, "分钟", "Minutes").to_string(),
        "seconds" => fmt::msg(ui, "秒", "Seconds").to_string(),
        "ms" => fmt::msg(ui, "毫秒", "Milliseconds").to_string(),
        "weeks" => fmt::msg(ui, "周", "Weeks").to_string(),
        other => other.to_string(),
    }
}

fn divisor_of(unit: &str) -> f64 {
    match unit {
        "ms" => fmt::SEC_MS as f64,
        "seconds" => fmt::SEC_MS as f64,
        "minutes" => fmt::MIN_MS as f64,
        "hours" => fmt::HOUR_MS as f64,
        "days" => fmt::DAY_MS as f64,
        "weeks" => fmt::WEEK_MS as f64,
        _ => fmt::DAY_MS as f64,
    }
}

fn totals_rows(abs_ms: i64, en_phrase: bool, ui: &str) -> String {
    let rows: Vec<(String, String)> = [
        ("ms", abs_ms as f64),
        ("seconds", abs_ms as f64 / fmt::SEC_MS as f64),
        ("minutes", abs_ms as f64 / fmt::MIN_MS as f64),
        ("hours", abs_ms as f64 / fmt::HOUR_MS as f64),
        ("days", abs_ms as f64 / fmt::DAY_MS as f64),
        ("weeks", abs_ms as f64 / fmt::WEEK_MS as f64),
    ]
    .iter()
    .map(|(unit, value)| {
        row(
            fmt::unit_name(unit, ui),
            format!(
                "{} {}",
                fmt::format_number(*value),
                unit_suffix(unit, en_phrase, ui)
            ),
        )
    })
    .collect();
    fmt::align_rows(&rows)
}

fn unit_suffix(unit: &str, en_phrase: bool, ui: &str) -> String {
    if en_phrase {
        fmt::en_unit_suffix(unit).into()
    } else {
        fmt::unit_name(unit, ui)
    }
}
