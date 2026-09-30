//! Workdays tool: mirrors the product engine's workday calculator report.

use super::common::*;
use super::fmt::{self, row};
use super::workdays_scan::{
    cell_text, dow_short, rest_reason, weekday_long, Scan, LIST_CAP, SCAN_CAP,
};
use super::{EngineError, RunContext, ToolResult};
use chrono::{Datelike, NaiveDate, Timelike, Utc};
use serde_json::Map;

pub(super) fn run(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    run_workdays(ctx)
}

pub(super) fn run_workdays(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let ui = ctx.locale;
    let zh = fmt::is_zh(ui);
    let spoken_en = !fmt::is_zh(ui);
    let tz = zone(ctx)?;
    let now = Utc::now();
    let mode = match string(ctx, "mode", "add") {
        "count" => "count",
        _ => "add",
    };
    let weekend = fmt::parse_weekend_set(string(ctx, "weekend", "0,6"), ui)?;
    let holidays = fmt::parse_holiday_map(string(ctx, "holidays", ""), tz, ui)?;
    let start_raw = string(ctx, "start", "today").trim();
    let start_raw = if start_raw.is_empty() {
        "today"
    } else {
        start_raw
    };
    let start = parse_at(start_raw, tz)?;
    let start_p = local(start, tz);
    let start_index = fmt::day_index(start_p.year(), start_p.month(), start_p.day());
    let start_date = start_p.date_naive();
    let start_weekday = start_p.weekday().num_days_from_sunday();
    let start_rest = rest_reason(start_date, start_weekday, &weekend, &holidays, ui);
    let sep = fmt::rest_sep(ui);

    let mut scan = Scan {
        end_index: start_index,
        working: 0,
        rest_count: 0,
        skipped: Vec::new(),
        worked: Vec::new(),
        ranges: Vec::new(),
        scan_cap_hit: false,
    };
    let mut request = 0_i64;
    let direction;
    let mut previous_worked = i64::MIN;
    let mut take = |scan: &mut Scan, index: i64| {
        let cell = fmt::day_cell(index);
        let date = NaiveDate::parse_from_str(&cell.key, "%Y-%m-%d").unwrap_or(start_date);
        let reason = rest_reason(date, cell.weekday, &weekend, &holidays, ui);
        match reason {
            Some(reason) => {
                scan.rest_count += 1;
                if scan.skipped.len() < LIST_CAP {
                    scan.skipped.push(format!(
                        "· {} · {}",
                        cell_text(date, cell.weekday, ui),
                        reason
                    ));
                }
            }
            None => {
                scan.working += 1;
                if scan.worked.len() < LIST_CAP {
                    scan.worked
                        .push(format!("· {}", cell_text(date, cell.weekday, ui)));
                }
                if previous_worked.abs_diff(cell.index) == 1 {
                    if let Some(last) = scan.ranges.last_mut() {
                        last.1 = cell.index;
                    }
                } else {
                    scan.ranges.push((cell.index, cell.index));
                }
                previous_worked = cell.index;
            }
        }
    };

    if mode == "add" {
        request = number(ctx, "days", 10.0).round().clamp(-9999.0, 9999.0) as i64;
        direction = if request < 0 { -1 } else { 1 };
        let target = request.unsigned_abs() as i64;
        let mut guard = 0_i64;
        while scan.working < target && guard < SCAN_CAP {
            let cell = fmt::day_cell(scan.end_index + direction);
            if cell.index == i64::MIN / 2 || cell.index == i64::MAX / 2 {
                scan.scan_cap_hit = true;
                break;
            }
            scan.end_index = cell.index;
            take(&mut scan, cell.index);
            guard += 1;
        }
        if scan.working < target {
            scan.scan_cap_hit = true;
        }
    } else {
        let today_index = fmt::day_index_of_instant(now, tz);
        direction = if today_index < start_index { -1 } else { 1 };
        scan.end_index = today_index;
        for index in start_index.min(today_index)..=start_index.max(today_index) {
            take(&mut scan, index);
        }
    }

    let result_cell = fmt::day_cell(scan.end_index);
    let result_date = match NaiveDate::parse_from_str(&result_cell.key, "%Y-%m-%d") {
        Ok(date) => date,
        Err(_) => return Err(err("Date out of range")),
    };
    let (result_instant, result_adjusted) = fmt::resolve_wall_time(
        tz,
        result_date
            .and_hms_milli_opt(
                start_p.hour(),
                start_p.minute(),
                start_p.second(),
                start_p.timestamp_subsec_millis(),
            )
            .ok_or_else(|| err("Date out of range"))?,
    );
    let natural_days = (scan.end_index - start_index).abs();

    let start_row = row(
        fmt::msg(ui, "起始", "Start"),
        format!(
            "{} → {} {}",
            start_raw,
            start_date.format("%Y-%m-%d"),
            weekday_long(start_weekday, spoken_en)
        ),
    );
    let mut head_rows = vec![
        start_row,
        row(
            fmt::msg(ui, "起始日状态", "Start day state"),
            match &start_rest {
                Some(reason) => format!(
                    "{}{}{}",
                    fmt::msg(ui, "休息日（", "Rest day ("),
                    reason,
                    fmt::msg(ui, "）", ")")
                ),
                None => fmt::msg(ui, "工作日", "Workday").to_string(),
            },
        ),
        row(
            fmt::msg(ui, "模式", "Mode"),
            if mode == "add" {
                if direction < 0 {
                    fmt::msg(ui, "add · 向前推算", "add · counted backwards")
                } else {
                    fmt::msg(ui, "add · 向后推算", "add · counted forwards")
                }
            } else {
                fmt::msg(
                    ui,
                    "count · 统计区间内工作日",
                    "count · workdays inside the range",
                )
            },
        ),
    ];
    if mode == "add" {
        head_rows.push(row(
            fmt::msg(ui, "工作日数", "Workdays requested"),
            if request == 0 {
                fmt::msg(
                    ui,
                    "0 个（days=0，结果即起始日）",
                    "0 (days=0, the result is the start day)",
                )
                .to_string()
            } else {
                format!(
                    "{}{}{}",
                    if request < 0 { "−" } else { "" },
                    fmt::format_number(request.abs() as f64),
                    fmt::msg(ui, " 个（不含起始日）", " (start day excluded)")
                )
            },
        ));
    }
    head_rows.push(row(
        fmt::msg(ui, "统计区间", "Range"),
        if mode == "count" {
            let lo = fmt::day_cell(start_index.min(scan.end_index));
            let hi = fmt::day_cell(start_index.max(scan.end_index));
            if zh {
                format!("{} → {}（含两端，对比“今天”）", lo.key, hi.key)
            } else {
                format!(
                    "{} → {} (both ends included, compared with \"today\")",
                    lo.key, hi.key
                )
            }
        } else {
            format!("{} → {}", start_date.format("%Y-%m-%d"), result_cell.key)
        },
    ));
    head_rows.push(row(
        fmt::msg(ui, "周末定义", "Weekend definition"),
        if weekend.is_empty() {
            fmt::msg(
                ui,
                "无（weekend 为空，全部按工作日处理）",
                "none (weekend is empty, every day counts as a workday)",
            )
            .to_string()
        } else {
            let mut sorted = weekend.clone();
            sorted.sort_unstable();
            sorted
                .iter()
                .map(|day| format!("{}={}", day, dow_short(*day, ui)))
                .collect::<Vec<_>>()
                .join(sep)
        },
    ));
    head_rows.push(row(
        fmt::msg(ui, "节假日", "Holidays"),
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
                "{}{}{more}",
                fmt::msg(
                    ui,
                    &format!("{} 天：", holidays.len()),
                    &format!("{} listed: ", holidays.len())
                ),
                list
            )
        },
    ));

    let result_rows: Vec<(String, String)> = if mode == "add" {
        vec![
            row(
                fmt::msg(ui, "目标日期", "Target date"),
                format!(
                    "{} {}",
                    result_cell.key,
                    weekday_long(result_cell.weekday, spoken_en)
                ),
            ),
            row(
                fmt::msg(ui, "本地时间", "Local time"),
                fmt::format_zone_stamp(result_instant, tz),
            ),
            row("ISO 8601", fmt::iso_in_zone(result_instant, tz)),
            row(
                fmt::msg(ui, "中文日期", "Date (long)"),
                fmt::long_date(result_instant, tz, ui),
            ),
            row(
                fmt::msg(ui, "自然日跨度", "Calendar-day span"),
                format!(
                    "{}{}{}",
                    if direction < 0 { "−" } else { "" },
                    fmt::format_number(natural_days as f64),
                    fmt::msg(
                        ui,
                        &format!(
                            " 天（工作日 {} 个 · 休息日 {} 个）",
                            fmt::format_number(scan.working as f64),
                            fmt::format_number(scan.rest_count as f64)
                        ),
                        &format!(
                            " d total ({} working · {} resting)",
                            fmt::format_number(scan.working as f64),
                            fmt::format_number(scan.rest_count as f64)
                        ),
                    )
                ),
            ),
            row(
                fmt::msg(ui, "Unix 秒", "Unix seconds"),
                (result_instant.timestamp_millis() / fmt::SEC_MS).to_string(),
            ),
        ]
    } else {
        vec![
            row(
                fmt::msg(ui, "工作日", "Workday"),
                if zh {
                    format!("{} 天", fmt::format_number(scan.working as f64))
                } else {
                    format!(
                        "{} day{}",
                        fmt::format_number(scan.working as f64),
                        if scan.working == 1 { "" } else { "s" }
                    )
                },
            ),
            row(
                fmt::msg(ui, "休息日", "Rest days"),
                if zh {
                    format!("{} 天", fmt::format_number(scan.rest_count as f64))
                } else {
                    format!(
                        "{} day{}",
                        fmt::format_number(scan.rest_count as f64),
                        if scan.rest_count == 1 { "" } else { "s" }
                    )
                },
            ),
            row(
                fmt::msg(ui, "自然日", "Calendar days"),
                if zh {
                    format!(
                        "{} 天（含两端）",
                        fmt::format_number((natural_days + 1) as f64)
                    )
                } else {
                    format!(
                        "{} days (both ends included)",
                        fmt::format_number((natural_days + 1) as f64)
                    )
                },
            ),
        ]
        .into_iter()
        .chain({
            let lo = fmt::day_cell(start_index.min(scan.end_index));
            let hi = fmt::day_cell(start_index.max(scan.end_index));
            vec![
                row(
                    fmt::msg(ui, "区间起点", "Range start"),
                    format!("{} {}", lo.key, weekday_long(lo.weekday, spoken_en)),
                ),
                row(
                    fmt::msg(ui, "区间终点", "Range end"),
                    format!("{} {}", hi.key, weekday_long(hi.weekday, spoken_en)),
                ),
                row(
                    fmt::msg(ui, "占比", "Share"),
                    format!(
                        "{} %",
                        fmt::format_number(
                            (scan.working as f64 / (natural_days as f64 + 1.0)) * 100.0
                        )
                    ),
                ),
            ]
        })
        .collect::<Vec<_>>()
    };

    let result_title = if mode == "add" {
        fmt::msg(ui, "结果", "Result")
    } else {
        fmt::msg(ui, "统计结果", "Summary result")
    };
    // The engine hoists the result block directly under the title section.
    let mut blocks = vec![
        fmt::section(fmt::msg(
            ui,
            &format!("工作日计算 · {}", tz.name()),
            &format!("Workdays · {}", tz.name()),
        )),
        format!(
            "{}\n\n{}",
            fmt::section(result_title),
            fmt::align_rows(&result_rows)
        ),
        fmt::align_rows(&head_rows),
    ];

    let collapse = mode == "add" && natural_days > 30 && !scan.ranges.is_empty();
    if mode == "add" && !scan.worked.is_empty() {
        if collapse {
            let lines = scan
                .ranges
                .iter()
                .map(|(from, to)| {
                    let (lo, hi) = (*from.min(to), *from.max(to));
                    let lo_key = fmt::day_cell(lo).key;
                    let hi_key = fmt::day_cell(hi).key;
                    if lo == hi {
                        format!("  · {}{}", lo_key, fmt::msg(ui, "（1 天）", " (1 day)"))
                    } else if zh {
                        format!("  · {lo_key} ~ {hi_key}（{} 天）", hi - lo + 1)
                    } else {
                        format!("  · {lo_key} ~ {hi_key} ({} days)", hi - lo + 1)
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");
            blocks.push(fmt::section(fmt::msg(
                ui,
                &format!("工作日区间（{} 天，按连续段合并）", scan.working),
                &format!(
                    "Workday intervals ({} days, consecutive days merged)",
                    scan.working
                ),
            )));
            blocks.push(lines);
        } else {
            blocks.push(fmt::section(&format!(
                "{}{}{}",
                fmt::msg(ui, "工作日明细（", "Workday details ("),
                fmt::format_number(scan.working as f64),
                fmt::msg(ui, " 天）", " days)")
            )));
            blocks.push(scan.worked.join("\n"));
        }
    }
    if !scan.skipped.is_empty() {
        blocks.push(fmt::section(&format!(
            "{}{}{}",
            fmt::msg(ui, "跳过的休息日（", "Skipped rest days ("),
            fmt::format_number(scan.rest_count as f64),
            fmt::msg(ui, " 天）", " days)")
        )));
        blocks.push(scan.skipped.join("\n"));
    }

    let mut notes: Vec<String> = Vec::new();
    if mode == "count" {
        notes.push(
            fmt::msg(
                ui,
                "· mode=count 时 days 字段已在界面上隐藏，本工具不读取该值。",
                "· In mode=count the days field is hidden in the UI and is never read.",
            )
            .to_string(),
        );
        notes.push(
            fmt::msg(
                ui,
                "· count 为闭区间统计：起始日与“今天”都计入。",
                "· count is a closed interval: both the start day and \"today\" are included.",
            )
            .to_string(),
        );
    } else {
        notes.push(
            fmt::msg(
                ui,
                "· add 从起始日的次日开始计数，起始日本身不计入工作日。",
                "· add starts counting the day after the start day; the start day itself is not a workday here.",
            )
            .to_string(),
        );
        if request < 0 {
            notes.push(
                fmt::msg(
                    ui,
                    "· days 为负数，按向前（过去）推算处理。",
                    "· days is negative, so the result is counted backwards (into the past).",
                )
                .to_string(),
            );
        }
    }
    if let Some(reason) = &start_rest {
        if mode == "add" {
            notes.push(
                fmt::msg(
                    ui,
                    &format!(
                        "· 起始日 {} 为{reason}，推算从其之后第一个工作日起算。",
                        start_date.format("%Y-%m-%d")
                    ),
                    &format!(
                        "· The start day {} is a {reason}; counting begins at the next workday.",
                        start_date.format("%Y-%m-%d")
                    ),
                )
                .to_string(),
            );
        }
    }
    if result_adjusted {
        notes.push(
            fmt::msg(
                ui,
                &format!("· 目标时刻落在 {} 夏令时切换的空档/重叠区间，已按真实瞬时顺延。", tz.name()),
                &format!("· The target time falls into the gap or overlap of the {} daylight-saving switch; the real instant was shifted.", tz.name()),
            )
            .to_string(),
        );
    }
    if scan.scan_cap_hit {
        notes.push(
            fmt::msg(
                ui,
                "· 达到扫描上限仍未凑齐工作日，请缩小 days 或检查 weekend/节假日设置。",
                "· The scan limit was reached before enough workdays were found; reduce days or review the weekend/holiday settings.",
            )
            .to_string(),
        );
    }
    if collapse {
        notes.push(
            fmt::msg(
                ui,
                &format!("· 跨度 {} 个自然日（> 30），工作日明细已合并为连续区间；休息日仍逐日列出。", natural_days),
                &format!("· The span is {natural_days} calendar days (> 30), so the workday details are merged into intervals; rest days are still listed one by one."),
            )
            .to_string(),
        );
    }
    if !notes.is_empty() {
        blocks.push(fmt::section(fmt::msg(ui, "说明", "Notes")));
        blocks.push(notes.join("\n"));
    }

    let mut extra = Map::new();
    put(&mut extra, "mode", mode);
    put(&mut extra, "timezone", tz.name());
    put(
        &mut extra,
        "start",
        start_date.format("%Y-%m-%d").to_string(),
    );
    put(&mut extra, "result", result_cell.key);
    put(&mut extra, "workingDays", scan.working.to_string());
    put(&mut extra, "skippedDays", scan.rest_count.to_string());
    put(&mut extra, "naturalDays", natural_days.to_string());
    put(&mut extra, "holidays", holidays.len().to_string());
    put(&mut extra, "weekend", string(ctx, "weekend", "0,6"));
    Ok(output(
        "workdays.txt",
        fmt::join_blocks(blocks.iter().map(String::as_str)),
        extra,
    ))
}
