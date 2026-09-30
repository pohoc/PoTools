//! Timestamp tool: mirrors the product engine's timestamp converter framing.

use super::common::*;
use super::fmt::{self, row};
use super::{EngineError, RunContext, ToolResult};
use chrono::{DateTime, Datelike, NaiveDate, TimeZone, Utc};
use serde_json::Map;

pub(super) fn run(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    match ctx.tool {
        "timestamp" => run_timestamp(ctx),
        "date-diff" => super::date_diff::run(ctx),
        "date-math" => super::date_math::run(ctx),
        _ => Err(err("Unsupported date operation")),
    }
}

fn phrase_locale(ctx: &RunContext<'_>) -> fmt::LocaleCode {
    if is_en(ctx) {
        fmt::EN_US
    } else if string(ctx, "locale", "zh-CN")
        .to_lowercase()
        .starts_with('e')
    {
        fmt::EN_US
    } else {
        fmt::ZH_CN
    }
}

fn split_lines(raw: &str) -> Vec<String> {
    raw.split(['\r', '\n'])
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

fn timestamp_style_select(raw: &str) -> String {
    match raw {
        "full" | "iso" | "date" | "datetime" | "relative" | "chinese" => raw.to_string(),
        _ => "both".to_string(),
    }
}

fn style_label(style: &str, ui: &str) -> String {
    match style {
        "full" => fmt::msg(ui, "完整对照", "Full report").into(),
        "iso" => "ISO 8601".into(),
        "date" => fmt::msg(ui, "仅日期", "Date only").into(),
        "datetime" => fmt::msg(ui, "日期 + 时间", "Date + time").into(),
        "relative" => fmt::msg(ui, "相对时间", "Relative").into(),
        "chinese" => fmt::msg(ui, "中文写法", "Chinese style").into(),
        other => other.into(),
    }
}

pub(super) fn run_timestamp(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let ui = ctx.locale;
    let zh = fmt::is_zh(ui);
    let lines = split_lines(string(ctx, "input", ""));
    if lines.is_empty() {
        return Err(err(if zh {
            "input（时间戳）不能为空。支持：now、today、2026-03-08 12:00:00、2026-03-08T12:00:00+08:00、2026-03-08、1700000000（秒）、1700000000000000（微秒）、1700000000000000000（纳秒），可每行填一个值。"
        } else {
            "input (timestamp) is required. Supported: now, today, 2026-03-08 12:00:00, 2026-03-08T12:00:00+08:00, 2026-03-08, 1700000000 (seconds), 1700000000000000 (microseconds), 1700000000000000000 (nanoseconds). Enter one value per line."
        }));
    }
    let tz = zone(ctx)?;
    let unit_raw = string(ctx, "unit", "auto");
    let unit = if ["auto", "s", "ms", "us", "ns"].contains(&unit_raw) {
        unit_raw
    } else {
        "auto"
    };
    let style = timestamp_style_select(string(ctx, "style", "both")).leak() as &'static str;
    let locale = phrase_locale(ctx);
    let show_range = boolean(ctx, "showRange", true);
    let show_now = boolean(ctx, "showNow", true);
    let now = Utc::now();
    let mut extra = Map::new();
    if style != "full" {
        let mut rendered = Vec::new();
        for line in &lines {
            let at = validate_date_range(parse_at_unit(line, tz, unit)?, tz)?;
            rendered.push(render_style(style, at, tz, now, locale, ui));
        }
        put(&mut extra, "inputs", lines.len().to_string());
        put(&mut extra, "timezone", tz.name());
        put(&mut extra, "style", style);
        put(&mut extra, "unit", unit);
        put(&mut extra, "showRange", "false");
        put(&mut extra, "showNow", "false");
        return Ok(output("timestamp.txt", rendered.join("\n"), extra));
    }
    let unit_label = if unit == "auto" {
        fmt::msg(ui, "自动（按位数判断）", "Auto (detected from digit count)").to_string()
    } else {
        format!("Unix {}", fmt::unit_name(unit, ui))
    };
    let mut blocks = vec![
        fmt::section(&fmt::msg(
            ui,
            &format!("时间戳转换 · {} 条 · {}", lines.len(), tz.name()),
            &format!(
                "Timestamp conversion · {} entries · {}",
                lines.len(),
                tz.name()
            ),
        )),
        fmt::align_rows(&[
            row(fmt::msg(ui, "单位选项", "Unit option"), unit_label),
            row(
                fmt::msg(ui, "输出样式", "Output style"),
                style_label(style, ui),
            ),
            row(
                fmt::msg(ui, "对照“现在”", "Compared with \"now\""),
                fmt::format_zone_stamp(now, tz),
            ),
        ]),
    ];
    if show_now {
        blocks.push(fmt::section(fmt::msg(
            ui,
            "当前时间（实时）",
            "Current time (live)",
        )));
        blocks.push(fmt::align_rows(&[
            row(
                fmt::msg(ui, "Unix 秒", "Unix seconds"),
                now.timestamp().to_string(),
            ),
            row(
                fmt::msg(ui, "Unix 毫秒", "Unix milliseconds"),
                now.timestamp_millis().to_string(),
            ),
            row(
                fmt::msg(ui, "本地时间", "Local time"),
                fmt::format_in_zone(now, tz),
            ),
            row(
                fmt::msg(ui, "时区", "Time zone"),
                fmt::zone_line(tz, now, ui),
            ),
        ]));
    }
    for (index, line) in lines.iter().enumerate() {
        let at = validate_date_range(parse_at_unit(line, tz, unit)?, tz)?;
        let mut parts: Vec<String> = vec![fmt::section(&format!("#{} {line}", index + 1))];
        parts.push(full_rows(ctx, at, tz, now, locale, ui));
        if show_range {
            parts.push(fmt::section(&fmt::msg(
                ui,
                "周期边界（Unix 秒 · 周起始 周一）",
                "Period bounds (Unix seconds, week starts Monday)",
            )));
            parts.push(range_rows(at, tz, ui));
            parts.push(fmt::msg(
                ui,
                "· 周起始固定为周一（ISO 8601）；每个周期给出第一秒与最后一秒（含），均为该时区的本地时间。",
                "· The week always starts on Monday (ISO 8601); every bound is the first or the last second (inclusive) of that period in the selected zone.",
            ).to_string());
        }
        blocks.push(fmt::join_blocks(parts.iter().map(String::as_str)));
    }
    put(&mut extra, "inputs", lines.len().to_string());
    put(&mut extra, "timezone", tz.name());
    put(&mut extra, "style", style);
    put(&mut extra, "unit", unit);
    put(&mut extra, "showRange", show_range.to_string());
    put(&mut extra, "showNow", show_now.to_string());
    Ok(output(
        "timestamp.txt",
        fmt::join_blocks(blocks.iter().map(String::as_str)),
        extra,
    ))
}

fn render_style(
    style: &str,
    at: DateTime<Utc>,
    tz: chrono_tz::Tz,
    now: DateTime<Utc>,
    locale: fmt::LocaleCode,
    ui: &str,
) -> String {
    match style {
        "iso" => fmt::iso_in_zone(at, tz),
        "date" => local(at, tz).format("%Y-%m-%d").to_string(),
        "datetime" => fmt::format_in_zone(at, tz),
        "relative" => fmt::relative_phrase((at - now).num_milliseconds(), locale, false),
        "chinese" => fmt::long_date(at, tz, ui),
        _ => {
            if fmt::is_zh(ui) {
                format!(
                    "日期时间：{}\nUnix 秒：{}\nUnix 毫秒：{}",
                    fmt::format_in_zone(at, tz),
                    at.timestamp(),
                    at.timestamp_millis()
                )
            } else {
                format!(
                    "Date/time: {}\nUnix seconds: {}\nUnix milliseconds: {}",
                    fmt::format_in_zone(at, tz),
                    at.timestamp(),
                    at.timestamp_millis()
                )
            }
        }
    }
}

fn period_start(at: DateTime<Utc>, tz: chrono_tz::Tz, unit: &str) -> DateTime<Utc> {
    let p = local(at, tz);
    let date = if unit == "week" {
        p.date_naive() - chrono::Duration::days(p.weekday().num_days_from_monday() as i64)
    } else {
        let month = match unit {
            "year" => 1,
            "quarter" => (p.month0() / 3) * 3 + 1,
            _ => p.month(),
        };
        let day = if unit == "day" { p.day() } else { 1 };
        NaiveDate::from_ymd_opt(p.year(), month, day).unwrap_or(p.date_naive())
    };
    resolve_local(tz, date.and_hms_opt(0, 0, 0).unwrap_or_default()).unwrap_or(at)
}

fn period_end(at: DateTime<Utc>, tz: chrono_tz::Tz, unit: &str) -> DateTime<Utc> {
    let start = period_start(at, tz, unit);
    let shift = match unit {
        "day" => (0, 0, 0, 1),
        "week" => (0, 0, 1, 0),
        "month" => (0, 1, 0, 0),
        "quarter" => (0, 3, 0, 0),
        _ => (1, 0, 0, 0),
    };
    let (next, ..) = fmt::shift_calendar(
        start.timestamp_millis(),
        tz,
        shift.0,
        shift.1,
        shift.2,
        shift.3,
        0,
        0,
        0,
    )
    .unwrap_or((start.timestamp_millis(), false, 0, 0, false));
    Utc.timestamp_millis_opt(next - fmt::SEC_MS)
        .single()
        .unwrap_or(start)
}

fn range_rows(at: DateTime<Utc>, tz: chrono_tz::Tz, ui: &str) -> String {
    let periods = [
        ("day", fmt::msg(ui, "当日", "Day")),
        ("week", fmt::msg(ui, "当周", "Week")),
        ("month", fmt::msg(ui, "当月", "Month")),
        ("year", fmt::msg(ui, "当年", "Year")),
    ];
    let mut rows = Vec::new();
    for (unit, period) in periods {
        for (kind, bound) in [
            (fmt::msg(ui, "起点", "start"), period_start(at, tz, unit)),
            (fmt::msg(ui, "终点", "end"), period_end(at, tz, unit)),
        ] {
            let label = if fmt::is_zh(ui) {
                format!("{period} {kind}")
            } else {
                format!("{period} {kind}")
            };
            let seconds = bound.timestamp();
            rows.push(row(
                label,
                format!("{} · {}", seconds, fmt::format_in_zone(bound, tz)),
            ));
        }
    }
    fmt::align_rows(&rows)
}

fn full_rows(
    ctx: &RunContext<'_>,
    at: DateTime<Utc>,
    tz: chrono_tz::Tz,
    now: DateTime<Utc>,
    locale: fmt::LocaleCode,
    ui: &str,
) -> String {
    let p = local(at, tz);
    let ms = at.timestamp_millis();
    let ns = epoch_ns(at);
    let millis = p.timestamp_subsec_millis();
    let raw = string(ctx, "input", "").trim().to_string();
    let numeric_only = !raw.is_empty()
        && raw
            .strip_prefix(['+', '-'])
            .unwrap_or(&raw)
            .bytes()
            .all(|b| b.is_ascii_digit() || b == b'.');
    let (iso_year, iso_week, iso_weekday) = fmt::iso_week_of(p.year(), p.month(), p.day());
    let mut rows = vec![
        row(
            fmt::msg(ui, "本地时间", "Local time"),
            fmt::format_zone_stamp(at, tz),
        ),
        row(
            fmt::msg(ui, "Unix 秒", "Unix seconds"),
            at.timestamp().to_string(),
        ),
        row(
            fmt::msg(ui, "Unix 毫秒", "Unix milliseconds"),
            ms.to_string(),
        ),
        row(
            fmt::msg(ui, "Unix 微秒", "Unix microseconds"),
            (ns / 1_000).to_string(),
        ),
        row(
            fmt::msg(ui, "Unix 纳秒", "Unix nanoseconds"),
            ns.to_string(),
        ),
        row("ISO 8601", fmt::iso_in_zone(at, tz)),
        row("ISO 8601 (UTC)", utc_iso(at)),
        row("RFC 2822", fmt::rfc2822(at, tz)),
        row(fmt::msg(ui, "输入", "Input"), raw.clone()),
        row(
            fmt::msg(ui, "识别单位", "Detected unit"),
            if numeric_only {
                format!(
                    "Unix {}",
                    fmt::unit_name(detected_unit(&raw, string(ctx, "unit", "auto")), ui)
                )
            } else {
                fmt::msg(ui, "文本时间", "Text time").to_string()
            },
        ),
        row(
            fmt::msg(ui, "时区", "Time zone"),
            fmt::zone_line(tz, at, ui),
        ),
        row(
            fmt::msg(ui, "中文日期", "Date (long)"),
            fmt::long_date(at, tz, ui),
        ),
        row(
            fmt::msg(ui, "星期", "Weekday"),
            fmt::weekday_pair(p.weekday().num_days_from_sunday(), ui),
        ),
        row(
            fmt::msg(ui, "年内第几天", "Day of year"),
            format!(
                "{} / {}",
                p.ordinal(),
                if is_leap_year(p.year()) { 366 } else { 365 }
            ),
        ),
        row(
            fmt::msg(ui, "ISO 周", "ISO week"),
            format!("{}-W{}-{}", iso_year, fmt::pad(iso_week, 2), iso_weekday),
        ),
        row(
            fmt::msg(ui, "相对“现在”", "Relative to \"now\""),
            fmt::relative_phrase((at - now).num_milliseconds(), locale, false),
        ),
        row(
            fmt::msg(ui, "夏令时", "Daylight saving"),
            fmt::msg(
                ui,
                if fmt::is_dst_active(at, tz) {
                    "生效"
                } else {
                    "未生效"
                },
                if fmt::is_dst_active(at, tz) {
                    "Active"
                } else {
                    "Not active"
                },
            ),
        ),
    ];
    if millis > 0 {
        rows.insert(
            3,
            row(fmt::msg(ui, "毫秒", "milliseconds"), fmt::pad(millis, 3)),
        );
    }
    fmt::align_rows(&rows)
}

fn detected_unit(raw: &str, requested: &str) -> &'static str {
    match requested {
        "s" => "s",
        "ms" => "ms",
        "us" => "us",
        "ns" => "ns",
        _ => {
            let unsigned = raw.trim_start_matches(['+', '-']);
            let significant = unsigned.trim_start_matches('0');
            let len = significant
                .split('.')
                .next()
                .filter(|s| !s.is_empty())
                .map_or(1, str::len);
            if len <= 10 {
                "s"
            } else if len <= 13 {
                "ms"
            } else if len <= 16 {
                "us"
            } else {
                "ns"
            }
        }
    }
}

fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn utc_iso(at: DateTime<Utc>) -> String {
    let p = at.with_timezone(&chrono_tz::UTC);
    let fraction = p.timestamp_subsec_nanos();
    let base = p.format("%Y-%m-%dT%H:%M:%S").to_string();
    if fraction > 0 {
        let frac = format!("{:09}", fraction);
        let frac = frac.trim_end_matches('0');
        format!("{base}.{frac}Z")
    } else {
        format!("{base}Z")
    }
}
