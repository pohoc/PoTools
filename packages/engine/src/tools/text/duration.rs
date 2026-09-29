//! Duration tool: mirrors the product engine's duration conversion report.

use super::common::*;
use super::fmt::{self, row};
use super::{EngineError, RunContext, ToolResult};
use serde_json::Map;

pub(super) fn run(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    run_duration(ctx)
}

pub(super) fn run_duration(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let ui = ctx.locale;
    let zh = fmt::is_zh(ui);
    let raw = string(ctx, "value", "");
    if raw.is_empty() {
        return Err(err(fmt::msg(
            ui,
            "value（时长）不能为空，请只填数值，单位由 unit 选择。示例：3735、90、1.5、-45。",
            "value (duration) is required. Enter a plain number only; the unit comes from unit. Example: 3735, 90, 1.5, -45.",
        )));
    }
    let cleaned: String = raw.chars().filter(|c| !c.is_whitespace() && *c != '_').collect();
    if !valid_decimal_number(&cleaned) {
        return Err(err(fmt::msg(
            ui,
            &format!("value=\"{raw}\" 不是纯数字。本字段只接受数值，单位请用 unit 下拉选择（s/min/h/d/ms）。示例：3735、1.5、-45。"),
            &format!("value=\"{raw}\" is not a plain number. This field accepts numbers only; pick the unit from the unit list (s/min/h/d/ms). Example: 3735, 1.5, -45."),
        )));
    }
    let numeric: f64 = cleaned.parse().map_err(|_| err("Value must be a number"))?;
    if !numeric.is_finite() || numeric.abs() > 1e15 {
        return Err(err(fmt::msg(
            ui,
            &format!("value=\"{raw}\" 超出可处理范围（绝对值需 ≤ 1e15）。示例：3735。"),
            &format!("value=\"{raw}\" is outside the supported range (absolute value must be <= 1e15). Example: 3735."),
        )));
    }
    let unit = match string(ctx, "unit", "s") {
        "min" => "min",
        "h" => "h",
        "d" => "d",
        "ms" => "ms",
        _ => "s",
    };
    let style = match string(ctx, "style", "human") {
        "hhmmss" => "hhmmss",
        "iso" => "iso",
        "human" => "human",
        "chinese" => "chinese",
        _ => match string(ctx, "style", "human") {
            "all" => "all",
            _ => "human",
        },
    };
    let style = if string(ctx, "style", "human") == "all" { "all" } else { style };
    let year_length = match string(ctx, "yearLength", "365.25") {
        "365" => "365",
        "366" => "366",
        _ => "365.25",
    };
    let total_ms = (numeric * unit_factor(unit)).round() as i64;
    let abs_ms = total_ms.unsigned_abs() as i64;
    let sign = if total_ms < 0 { "−" } else { "" };
    let days = abs_ms / fmt::DAY_MS;
    let total_hours = abs_ms / fmt::HOUR_MS;
    let hours = total_hours % 24;
    let minutes = (abs_ms % fmt::HOUR_MS) / fmt::MIN_MS;
    let seconds = (abs_ms % fmt::MIN_MS) / fmt::SEC_MS;
    let millis = abs_ms % fmt::SEC_MS;
    let hhmmss = format!("{}:{}:{}", fmt::pad(total_hours, 2), fmt::pad(minutes, 2), fmt::pad(seconds, 2));
    let iso = iso_duration(total_ms);
    let unit_label = fmt::unit_name(unit, ui);

    let human_a_locale = if zh { "zh-CN" } else { "en-US" };
    let human = [
        (
            fmt::msg(ui, "口语 zh-CN", "Spoken (en-US)").to_string(),
            spoken_duration(abs_ms, human_a_locale),
        ),
        (
            fmt::msg(ui, "口语 en-US", "Spoken (word form)").to_string(),
            if zh {
                spoken_duration(abs_ms, "en-US")
            } else {
                word_duration(total_ms, ui, " ")
            },
        ),
    ];
    let chinese_rows = [
        (
            fmt::msg(ui, "中文读法", "Word form").to_string(),
            word_duration(total_ms, ui, ""),
        ),
        (
            fmt::msg(ui, "中文（分节）", "Word form (spaced)").to_string(),
            word_duration(total_ms, ui, " "),
        ),
    ];

    if style != "all" {
        let value = match style {
            "hhmmss" => format!("{sign}{hhmmss}"),
            "iso" => iso.clone(),
            "human" => human[0].1.clone(),
            _ => chinese_rows[0].1.clone(),
        };
        let mut extra = Map::new();
        put(&mut extra, "style", style);
        put(&mut extra, "unit", unit);
        put(&mut extra, "milliseconds", total_ms.to_string());
        put(&mut extra, "iso", iso);
        put(&mut extra, "chinese", chinese_rows[0].1.clone());
        return Ok(output("duration.txt", value, extra));
    }

    let mut hhmmss_rows = vec![row("HH:MM:SS", format!("{sign}{hhmmss}"))];
    hhmmss_rows.push(row(
        fmt::msg(ui, "含自然日", "With calendar days"),
        format!("{sign}{}", with_days(days, hours, minutes, seconds, millis, ui)),
    ));
    hhmmss_rows.push(row(
        fmt::msg(ui, "仅时:分", "Hours:minutes only"),
        format!("{sign}{}:{}", fmt::pad(total_hours, 2), fmt::pad(minutes, 2)),
    ));
    let mut iso_rows = vec![row("ISO 8601", iso.clone())];
    iso_rows.push(row(
        fmt::msg(ui, "ISO 8601（单一单位）", "ISO 8601 (single unit)"),
        format!("{sign}PT{}H", decimal_trim(abs_ms as f64 / fmt::HOUR_MS as f64, 2)),
    ));

    let days_per_year: f64 = year_length.parse().unwrap_or(365.25);
    let basis_label = match (year_length, zh) {
        ("365", false) => "365 days",
        ("366", false) => "366 days",
        (_, false) => "365.25 days",
        ("365", true) => "365 天",
        ("366", true) => "366 天",
        (_, true) => "365.25 天",
    };
    let ms_per_year = days_per_year * fmt::DAY_MS as f64;
    let ms_per_month = ms_per_year / 12.0;
    let abs_f = abs_ms as f64;
    let basis_years = (abs_f / ms_per_year).floor() as i64;
    let after_years = abs_f - basis_years as f64 * ms_per_year;
    let basis_months = (after_years / ms_per_month).floor() as i64;
    let after_months = after_years - basis_months as f64 * ms_per_month;
    let basis_days = (after_months / fmt::DAY_MS as f64).floor() as i64;
    let after_days = after_months - basis_days as f64 * fmt::DAY_MS as f64;
    let basis_hours = (after_days / fmt::HOUR_MS as f64).floor() as i64;
    let after_hours = after_days - basis_hours as f64 * fmt::HOUR_MS as f64;
    let basis_minutes = (after_hours / fmt::MIN_MS as f64).floor() as i64;
    let remain_ms = after_hours - basis_minutes as f64 * fmt::MIN_MS as f64;
    let basis_seconds = (remain_ms / fmt::SEC_MS as f64).floor() as i64;
    let basis_fraction = fraction_of_millis(remain_ms.round() as i64 % fmt::SEC_MS);
    let broken = if zh {
        format!(
            "{}{} 年 {} 个月 {} 天 {}:{}:{}{}",
            sign,
            fmt::format_number(basis_years as f64),
            fmt::format_number(basis_months as f64),
            fmt::format_number(basis_days as f64),
            fmt::pad(basis_hours, 2),
            fmt::pad(basis_minutes, 2),
            fmt::pad(basis_seconds, 2),
            basis_fraction
        )
    } else {
        format!(
            "{}{} y {} mo {} d {}:{}:{}{}",
            sign,
            fmt::format_number(basis_years as f64),
            fmt::format_number(basis_months as f64),
            fmt::format_number(basis_days as f64),
            fmt::pad(basis_hours, 2),
            fmt::pad(basis_minutes, 2),
            fmt::pad(basis_seconds, 2),
            basis_fraction
        )
    };
    let direction = if total_ms == 0 {
        fmt::msg(ui, "零时长", "Zero length")
    } else if total_ms < 0 {
        fmt::msg(ui, "负时长（倒数）", "Negative (countdown)")
    } else {
        fmt::msg(ui, "正向", "Positive")
    };
    let blocks = vec![
        fmt::section(&fmt::msg(
            ui,
            &format!("时长换算 · {} {}", decimal_trim(numeric.abs(), 9), unit_label),
            &format!("Duration conversion · {} {}", decimal_trim(numeric.abs(), 9), unit_label),
        )),
        fmt::align_rows(&[
            row(
                fmt::msg(ui, "输入", "Input"),
                if zh {
                    format!("{raw} {unit}（{unit_label}）")
                } else {
                    format!("{raw} {unit} ({unit_label})")
                },
            ),
            row(
                fmt::msg(ui, "总毫秒", "Total milliseconds"),
                format!("{sign}{}", fmt::format_number(abs_ms as f64)),
            ),
            row(
                fmt::msg(ui, "总秒", "Total seconds"),
                format!("{sign}{}", decimal_trim(abs_ms as f64 / fmt::SEC_MS as f64, 6)),
            ),
            row(fmt::msg(ui, "方向", "Direction"), direction),
        ]),
        fmt::section(fmt::msg(ui, "写法 · HH:MM:SS", "Form · HH:MM:SS")),
        fmt::align_rows(&hhmmss_rows),
        fmt::section(fmt::msg(ui, "写法 · ISO 8601", "Form · ISO 8601")),
        fmt::align_rows(&iso_rows),
        fmt::section(fmt::msg(ui, "写法 · 口语", "Form · Spoken")),
        fmt::align_rows(&human),
        fmt::section(fmt::msg(ui, "写法 · 中文", "Form · Words")),
        fmt::align_rows(&chinese_rows),
        fmt::section(fmt::msg(ui, "写法 · 年月日时分秒", "Form · years/months/days")),
        fmt::align_rows(&[
            row(
                fmt::msg(ui, "年长基准", "Year basis"),
                if zh {
                    format!("{basis_label}（{} 天/年，月长 = 年长 ÷ 12）", fmt::format_number(days_per_year))
                } else {
                    format!(
                        "{basis_label} ({} days per year, month = year / 12)",
                        fmt::format_number(days_per_year)
                    )
                },
            ),
            row(fmt::msg(ui, "历法分解", "Calendar breakdown"), broken),
        ]),
        fmt::section(fmt::msg(ui, "总量（各单位）", "Totals (per unit)")),
        fmt::align_rows(&[
            ("ms", abs_ms as f64),
            ("seconds", abs_ms as f64 / fmt::SEC_MS as f64),
            ("minutes", abs_ms as f64 / fmt::MIN_MS as f64),
            ("hours", abs_ms as f64 / fmt::HOUR_MS as f64),
            ("days", abs_ms as f64 / fmt::DAY_MS as f64),
            ("weeks", abs_ms as f64 / fmt::WEEK_MS as f64),
        ]
        .iter()
        .map(|(unit_name, value)| row(fmt::unit_name(unit_name, ui), fmt::format_number(*value)))
        .collect::<Vec<_>>()),
        fmt::section(fmt::msg(ui, "说明", "Notes")),
        [
            fmt::msg(
                ui,
                "· HH:MM:SS 为扩展小时制，超过 24 小时继续累加；含自然日写法另行给出。",
                "· HH:MM:SS uses extended hours and keeps counting past 24; the calendar-day form is listed separately.",
            ),
            fmt::msg(
                ui,
                "· ISO 8601 采用 PnDTnHnMnS，负时长在最前面加 “-”。",
                "· ISO 8601 follows PnDTnHnMnS; negative durations get a leading \"-\".",
            ),
            fmt::msg(
                ui,
                "· 年月日分解按固定年长折算（月 = 年长 ÷ 12），真实历法的月长与年长都不等，仅供量级参考。",
                "· The year/month/day breakdown divides by a fixed year length (month = year / 12); real calendar months and years vary, so treat it as an order of magnitude.",
            ),
        ]
        .join("\n"),
    ];
    let mut extra = Map::new();
    put(&mut extra, "style", style);
    put(&mut extra, "unit", unit);
    put(&mut extra, "milliseconds", total_ms.to_string());
    put(
        &mut extra,
        "seconds",
        decimal_trim(abs_ms as f64 / fmt::SEC_MS as f64, 6),
    );
    put(&mut extra, "hhmmss", format!("{sign}{hhmmss}"));
    put(&mut extra, "iso", iso);
    put(&mut extra, "chinese", chinese_rows[0].1.clone());
    Ok(output(
        "duration.txt",
        fmt::join_blocks(blocks.iter().map(String::as_str)),
        extra,
    ))
}

fn unit_factor(unit: &str) -> f64 {
    match unit {
        "min" => fmt::MIN_MS as f64,
        "h" => fmt::HOUR_MS as f64,
        "d" => fmt::DAY_MS as f64,
        "ms" => 1.0,
        _ => fmt::SEC_MS as f64,
    }
}

fn fraction_of_millis(millis: i64) -> String {
    if millis == 0 {
        String::new()
    } else {
        format!(".{:03}", millis).trim_end_matches('0').to_string()
    }
}

fn with_days(days: i64, hours: i64, minutes: i64, seconds: i64, millis: i64, ui: &str) -> String {
    if fmt::is_zh(ui) {
        format!(
            "{} 天 {}:{}:{}{}",
            days,
            fmt::pad(hours, 2),
            fmt::pad(minutes, 2),
            fmt::pad(seconds, 2),
            fraction_of_millis(millis)
        )
    } else {
        format!(
            "{} d {}:{}:{}{}",
            days,
            fmt::pad(hours, 2),
            fmt::pad(minutes, 2),
            fmt::pad(seconds, 2),
            fraction_of_millis(millis)
        )
    }
}

pub(super) fn decimal_trim(value: f64, digits: u32) -> String {
    if !value.is_finite() {
        return "0".into();
    }
    if value.fract() == 0.0 && value.abs() < 1e18 {
        return format!("{}", value as i64);
    }
    let text = format!("{:.*}", digits as usize, value);
    let text = text.trim_end_matches('0').trim_end_matches('.');
    text.to_string()
}

pub(super) fn valid_decimal_number(raw: &str) -> bool {
    let s = raw.strip_prefix(['+', '-']).unwrap_or(raw);
    let mut parts = s.split('.');
    let whole = parts.next().unwrap_or("");
    let fraction = parts.next();
    !whole.is_empty()
        && whole.bytes().all(|b| b.is_ascii_digit())
        && fraction.map_or(true, |f| {
            !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit())
        })
        && parts.next().is_none()
}

pub(super) fn iso_duration(total_ms: i64) -> String {
    let abs = total_ms.unsigned_abs() as i64;
    if abs == 0 {
        return "PT0S".into();
    }
    let days = abs / fmt::DAY_MS;
    let hours = (abs % fmt::DAY_MS) / fmt::HOUR_MS;
    let minutes = (abs % fmt::HOUR_MS) / fmt::MIN_MS;
    let seconds = (abs % fmt::MIN_MS) / fmt::SEC_MS;
    let millis = abs % fmt::SEC_MS;
    let fraction = fraction_of_millis(millis);
    let date_part = if days == 0 { String::new() } else { format!("{days}D") };
    let mut time_part = String::new();
    if hours > 0 {
        time_part.push_str(&format!("{hours}H"));
    }
    if minutes > 0 {
        time_part.push_str(&format!("{minutes}M"));
    }
    if seconds > 0 || !fraction.is_empty() || date_part.is_empty() {
        time_part.push_str(&format!("{seconds}{fraction}S"));
    }
    format!(
        "{}P{}{}",
        if total_ms < 0 { "-" } else { "" },
        date_part,
        if time_part.is_empty() { String::new() } else { format!("T{time_part}") }
    )
}

fn word_duration(total_ms: i64, ui: &str, gap: &str) -> String {
    let zh = fmt::is_zh(ui);
    let abs = total_ms.unsigned_abs() as i64;
    let days = abs / fmt::DAY_MS;
    let hours = (abs % fmt::DAY_MS) / fmt::HOUR_MS;
    let minutes = (abs % fmt::HOUR_MS) / fmt::MIN_MS;
    let seconds = (abs % fmt::MIN_MS) / fmt::SEC_MS;
    let millis = abs % fmt::SEC_MS;
    let plural = |value: i64| if value == 1 { "" } else { "s" };
    let mut pieces = Vec::new();
    if days > 0 {
        pieces.push(if zh { format!("{days}天") } else { format!("{days} day{}", plural(days)) });
    }
    if hours > 0 {
        pieces.push(if zh { format!("{hours}小时") } else { format!("{hours} hour{}", plural(hours)) });
    }
    if minutes > 0 {
        pieces.push(if zh { format!("{minutes}分") } else { format!("{minutes} minute{}", plural(minutes)) });
    }
    if seconds > 0 {
        pieces.push(if zh { format!("{seconds}秒") } else { format!("{seconds} seconds") });
    }
    if millis > 0 {
        pieces.push(if zh { format!("{millis}毫秒") } else { format!("{millis} millisecond{}", plural(millis)) });
    }
    let joiner = if gap.is_empty() {
        if zh { "" } else { ", " }
    } else {
        gap
    };
    let body = if pieces.is_empty() {
        if zh { "0秒".to_string() } else { "0 seconds".to_string() }
    } else {
        pieces.join(joiner)
    };
    format!(
        "{}{}",
        if total_ms < 0 {
            if zh { "负 " } else { "-" }
        } else {
            ""
        },
        body
    )
}

fn spoken_duration(abs_ms: i64, locale: &str) -> String {
    let steps: [(&str, i64); 5] = [
        ("second", fmt::SEC_MS),
        ("minute", fmt::MIN_MS),
        ("hour", fmt::HOUR_MS),
        ("day", fmt::DAY_MS),
        ("week", fmt::WEEK_MS),
    ];
    let mut chosen = steps[0];
    for step in steps {
        if abs_ms >= step.1 {
            chosen = step;
        }
    }
    let value = ((abs_ms as f64) / (chosen.1 as f64)).round() as i64;
    let zh = !locale.starts_with("en");
    if zh {
        let unit = match chosen.0 {
            "week" => "周",
            "day" => "天",
            "hour" => "小时",
            "minute" => "分钟",
            _ => "秒",
        };
        format!("{value}{unit}")
    } else {
        format!("{value} {}{}", chosen.0, if value == 1 { "" } else { "s" })
    }
}
