//! Timezone board tool: mirrors the product engine's zone comparison board.

use super::common::*;
use super::fmt::{self, row};
use super::{EngineError, RunContext, ToolResult};
use chrono::{Datelike, Utc};
use serde_json::Map;
use std::str::FromStr;

pub(super) fn run(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    run_timezone_board(ctx)
}

fn dow_short(weekday: u32, ui: &str) -> &'static str {
    if fmt::is_zh(ui) {
        match weekday % 7 {
            0 => "周日",
            1 => "周一",
            2 => "周二",
            3 => "周三",
            4 => "周四",
            5 => "周五",
            _ => "周六",
        }
    } else {
        fmt::WEEKDAYS_EN_SHORT[(weekday % 7) as usize]
    }
}

fn board_cell(style: &str, tz: chrono_tz::Tz, at: chrono::DateTime<Utc>) -> String {
    let p = local(at, tz);
    match style {
        "date" => format!(
            "{}-{}-{}",
            p.year(),
            fmt::pad(p.month(), 2),
            fmt::pad(p.day(), 2)
        ),
        "datetime" => p.format("%Y-%m-%d %H:%M").to_string(),
        _ => fmt::format_in_zone(at, tz),
    }
}

fn style_label(style: &str, ui: &str) -> String {
    match style {
        "full" => fmt::msg(ui, "完整", "Full board").into(),
        "date" => fmt::msg(ui, "仅日期", "Date only").into(),
        _ => fmt::msg(ui, "日期 + 时间", "Date + time").into(),
    }
}

pub(super) fn run_timezone_board(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let ui = ctx.locale;
    let zh = fmt::is_zh(ui);
    let raw_lines: Vec<&str> = string(ctx, "zones", "")
        .split(['\r', '\n'])
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    if raw_lines.is_empty() {
        return Err(err(fmt::msg(
            ui,
            "zones（时区列表）不能为空，请每行填写一个 IANA 时区名称。示例：Asia/Shanghai、UTC、America/New_York、Europe/London。",
            "zones (time zone list) is required. Enter one IANA time zone name per line. Example: Asia/Shanghai, UTC, America/New_York, Europe/London.",
        )));
    }
    let mut valid: Vec<(&str, chrono_tz::Tz)> = Vec::new();
    let mut invalid: Vec<(usize, &str)> = Vec::new();
    for (position, line) in raw_lines.iter().enumerate() {
        match chrono_tz::Tz::from_str(line) {
            Ok(tz) => valid.push((*line, tz)),
            Err(_) => invalid.push((position + 1, line)),
        }
    }
    let style_raw = string(ctx, "style", "datetime");
    let style = if ["full", "date", "datetime"].contains(&style_raw) {
        style_raw
    } else {
        "datetime"
    };
    let show_day_shift = boolean(ctx, "showDayShift", true);
    let show_offset_delta = boolean(ctx, "showOffsetDelta", true);
    let at_raw = string(ctx, "at", "now").trim();
    let at_raw = if at_raw.is_empty() { "now" } else { at_raw };
    let (reference, reference_zone) = valid.first().copied().unwrap_or(("UTC", chrono_tz::UTC));
    let at = parse_at(at_raw, reference_zone)?;
    let epoch = at;
    let reference_day = fmt::day_index_of_instant(epoch, reference_zone);
    let reference_offset = fmt::offset_minutes_of(epoch, reference_zone);

    let mut head = vec![
        "#".to_string(),
        fmt::msg(ui, "时区", "Time zone").to_string(),
        fmt::msg(ui, "本地时间", "Local time").to_string(),
        fmt::msg(ui, "星期", "Weekday").to_string(),
        fmt::msg(ui, "偏移", "Offset").to_string(),
        fmt::msg(ui, "缩写", "Abbreviation").to_string(),
        fmt::msg(ui, "夏令时", "Daylight saving").to_string(),
    ];
    if show_offset_delta {
        head.push(fmt::msg(ui, "相对偏移", "Offset vs base").to_string());
    }
    if show_day_shift {
        head.push(fmt::msg(ui, "跨日", "Day shift").to_string());
    }
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut offsets: Vec<i32> = Vec::new();
    let mut dst_zones: Vec<String> = Vec::new();
    for (position, (name, tz)) in valid.iter().enumerate() {
        let p = local(epoch, *tz);
        let shift = fmt::day_index_of_instant(epoch, *tz) - reference_day;
        let offset = fmt::offset_minutes_of(epoch, *tz);
        let delta = (offset - reference_offset) as f64 / 60.0;
        offsets.push(offset);
        if fmt::is_dst_active(epoch, *tz) {
            dst_zones.push((*name).to_string());
        }
        let mut values = vec![
            (position + 1).to_string(),
            (*name).to_string(),
            board_cell(style, *tz, epoch),
            dow_short(p.weekday().num_days_from_sunday(), ui).to_string(),
            format!("UTC{}", fmt::offset_label(offset, true)),
            fmt::zone_abbrev(*tz, epoch),
            fmt::msg(
                ui,
                if fmt::is_dst_active(epoch, *tz) {
                    "生效"
                } else {
                    "未生效"
                },
                if fmt::is_dst_active(epoch, *tz) {
                    "Active"
                } else {
                    "Not active"
                },
            )
            .to_string(),
        ];
        if show_offset_delta {
            values.push(if delta == 0.0 {
                fmt::msg(ui, "基准", "base").to_string()
            } else {
                format!(
                    "{}{} {}",
                    if delta > 0.0 { "+" } else { "−" },
                    fmt::format_number(delta.abs()),
                    fmt::msg(ui, "小时", "h")
                )
            });
        }
        if show_day_shift {
            values.push(if shift == 0 {
                fmt::msg(ui, "同日", "same day").to_string()
            } else if zh {
                format!("{}{}天", if shift > 0 { "+" } else { "−" }, shift.abs())
            } else {
                format!(
                    "{}{} day{}",
                    if shift > 0 { "+" } else { "−" },
                    shift.abs(),
                    if shift.abs() == 1 { "" } else { "s" }
                )
            });
        }
        rows.push(values);
    }
    let widths: Vec<usize> = head
        .iter()
        .enumerate()
        .map(|(column, title)| {
            rows.iter()
                .map(|values| {
                    fmt::display_width(values.get(column).map(String::as_str).unwrap_or(""))
                })
                .max()
                .unwrap_or(0)
                .max(fmt::display_width(title))
        })
        .collect();
    let render = |cells: &[String]| -> String {
        let joined = cells
            .iter()
            .enumerate()
            .map(|(column, cell)| {
                fmt::pad_to(
                    cell,
                    widths
                        .get(column)
                        .copied()
                        .unwrap_or(fmt::display_width(cell)),
                )
            })
            .collect::<Vec<_>>()
            .join("  ");
        format!("  {joined}").trim_end().to_string()
    };
    let separator_len = widths.iter().sum::<usize>() + 2 * widths.len() - 2;
    let mut table = vec![render(&head)];
    table.push(format!("  {}", "─".repeat(separator_len)));
    table.extend(rows.iter().map(|values| render(values)));
    let sep = fmt::rest_sep(ui);
    let mut blocks = vec![
        fmt::section(fmt::msg(
            ui,
            &format!(
                "时区对照表 · {} 个时区 · 基准 {}",
                valid.len(),
                fmt::format_zone_stamp(epoch, reference_zone)
            ),
            &format!(
                "Time zone board · {} zones · reference {}",
                valid.len(),
                fmt::format_zone_stamp(epoch, reference_zone)
            ),
        )),
        fmt::align_rows(&[
            row(
                fmt::msg(ui, "输入", "Input"),
                format!("{} → {}", at_raw, fmt::iso_in_zone(epoch, reference_zone)),
            ),
            row("UTC", fmt::format_zone_stamp(epoch, chrono_tz::UTC)),
            row(
                fmt::msg(ui, "参考时区", "Reference zone"),
                format!(
                    "{}{}",
                    reference,
                    fmt::msg(
                        ui,
                        "（列表首个有效时区）",
                        " (first valid zone in the list)"
                    )
                ),
            ),
            row(fmt::msg(ui, "样式", "Style"), style_label(style, ui)),
            row(
                fmt::msg(ui, "偏移范围", "Offset range"),
                if offsets.is_empty() {
                    "—".to_string()
                } else {
                    format!(
                        "UTC{} ~ UTC{}",
                        fmt::offset_label(*offsets.iter().min().unwrap(), true),
                        fmt::offset_label(*offsets.iter().max().unwrap(), true)
                    )
                },
            ),
            row(
                fmt::msg(ui, "夏令时中的时区", "Zones in daylight saving"),
                if dst_zones.is_empty() {
                    fmt::msg(ui, "无", "None").to_string()
                } else {
                    dst_zones.join(sep)
                },
            ),
        ]),
        fmt::section(fmt::msg(ui, "对照表", "Board")),
        table.join("\n"),
    ];
    let mut notes = vec![fmt::msg(
        ui,
        "· 星期/缩写为参考本地历日，跨日列为相对参考时区的日历日差。",
        "· Weekday and abbreviation follow the reference local calendar day; the day-shift column is the calendar-day difference relative to the reference zone.",
    )
    .to_string()];
    if show_day_shift || show_offset_delta {
        notes.push(
            fmt::msg(
                ui,
                "· “相对偏移”列为该时区相对基准时区（列表首个时区）的 UTC 偏移差，“跨日”列为相对基准时区当天日期的日历日差。",
                "· \"Offset vs base\" is the UTC offset difference relative to the base zone (first zone in the list); \"Day shift\" is the calendar-day difference relative to the base local date.",
            )
            .to_string(),
        );
    }
    if !invalid.is_empty() {
        notes.push(
            fmt::msg(
                ui,
                &format!("· 有 {} 行时区无法识别，已从表中剔除，详见下方。", invalid.len()),
                &format!(
                    "· {} line(s) held unrecognized time zones and were removed from the table, see below.",
                    invalid.len()
                ),
            )
            .to_string(),
        );
        blocks.push(fmt::section(fmt::msg(
            ui,
            &format!("无法识别的时区（{} 行）", invalid.len()),
            &format!("Unrecognized time zones, {} skipped", invalid.len()),
        )));
        blocks.push(
            invalid
                .iter()
                .map(|(line, raw)| {
                    fmt::msg(
                        ui,
                        &format!("· 第 {line} 行 · {raw}: 时区无法识别"),
                        &format!("· line {line} · {raw}: the time zone cannot be recognized"),
                    )
                    .to_string()
                })
                .collect::<Vec<_>>()
                .join("\n"),
        );
    }
    if valid.is_empty() {
        blocks.push(fmt::section(fmt::msg(ui, "提示", "Hint")));
        blocks.push(
            fmt::msg(
                ui,
                "· 列表中没有有效时区，请在 zones 中每行填写一个 IANA 名称，例如 Asia/Shanghai。",
                "· The list has no valid time zone; put one IANA name per line in zones, for example Asia/Shanghai.",
            )
            .to_string(),
        );
    }
    blocks.push(fmt::section(fmt::msg(ui, "说明", "Notes")));
    blocks.push(notes.join("\n"));
    let mut extra = Map::new();
    put(&mut extra, "zones", valid.len().to_string());
    put(&mut extra, "invalid", invalid.len().to_string());
    put(&mut extra, "style", style);
    put(&mut extra, "reference", reference);
    put(&mut extra, "at", fmt::iso_in_zone(epoch, chrono_tz::UTC));
    put(
        &mut extra,
        "utc",
        fmt::format_in_zone(epoch, chrono_tz::UTC),
    );
    Ok(output(
        "timezone-board.txt",
        fmt::join_blocks(blocks.iter().map(String::as_str)),
        extra,
    ))
}
