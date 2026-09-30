//! Output framing shared by the text tools: section rules, aligned rows and
//! locale formatting. The layout mirrors the product's original engine byte for
//! byte (section headers pad to 60 display columns, labels align by display
//! width, blocks join with a blank line, trailing whitespace is trimmed and a
//! final newline appended).

use chrono::NaiveDate;

pub const SEC_MS: i64 = 1000;
pub const MIN_MS: i64 = 60_000;
pub const HOUR_MS: i64 = 3_600_000;
pub const DAY_MS: i64 = 86_400_000;
pub const WEEK_MS: i64 = 604_800_000;
pub const MONTH_MS: i64 = 2_629_800_000;
pub const YEAR_MS: i64 = 31_557_600_000;
pub const DAY_TALLY_CAP: i64 = 40_000;

pub fn epoch_date() -> NaiveDate {
    NaiveDate::from_ymd_opt(1970, 1, 1)
        .unwrap_or_else(|| NaiveDate::from_ymd_opt(2000, 1, 1).unwrap())
}

pub const WEEKDAYS_ZH: [&str; 7] = [
    "星期日",
    "星期一",
    "星期二",
    "星期三",
    "星期四",
    "星期五",
    "星期六",
];
pub const WEEKDAYS_EN: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];
pub const WEEKDAYS_EN_SHORT: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
pub const MONTHS_EN_SHORT: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
pub const MONTHS_EN_FULL: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

/// Locale tag the tools reason about: the UI locale is either zh or en.
pub use super::fmt_cal::{
    calendar_breakdown, chinese_date, day_cell, day_index, day_index_of_instant, days_in_month,
    format_in_zone, format_zone_stamp, instant_line, is_dst_active, iso_in_zone, iso_week_of,
    long_date, long_date_en, offset_minutes_of, parse_holiday_map, parse_weekend_set,
    resolve_wall_time, rfc2822, roll_to_working_day, shift_calendar, span_text, tally_day_range,
    weekday_pair, weekday_short, weekday_spelled, zone_abbrev, zone_line, CalendarSpan, DayCell,
    DayTally,
};

pub fn is_zh(locale: &str) -> bool {
    !locale.starts_with("en")
}

/// Message pick: index 0 = zh-CN, index 1 = en.
pub fn msg<'a>(ui_locale: &str, zh: &'a str, en: &'a str) -> &'a str {
    if is_zh(ui_locale) {
        zh
    } else {
        en
    }
}

pub fn pad(value: impl std::fmt::Display, width: usize) -> String {
    let text = value.to_string();
    if text.len() >= width {
        text
    } else {
        format!("{}{}", "0".repeat(width - text.len()), text)
    }
}

fn is_wide(code: u32) -> bool {
    (0x1100..=0x115f).contains(&code)
        || (0x2e80..=0x303e).contains(&code)
        || (0x3041..=0x33ff).contains(&code)
        || (0x3400..=0x4dbf).contains(&code)
        || (0x4e00..=0x9fff).contains(&code)
        || (0xa000..=0xa4cf).contains(&code)
        || (0xac00..=0xd7a3).contains(&code)
        || (0xf900..=0xfaff).contains(&code)
        || (0xfe30..=0xfe6f).contains(&code)
        || (0xff00..=0xff60).contains(&code)
        || (0xffe0..=0xffe6).contains(&code)
}

pub fn display_width(text: &str) -> usize {
    text.chars()
        .map(|c| if is_wide(c as u32) { 2 } else { 1 })
        .sum()
}

pub fn pad_to(text: &str, width: usize) -> String {
    let gap = width.saturating_sub(display_width(text));
    format!("{}{}", text, " ".repeat(gap))
}

/// One label/value row for [`align_rows`].
pub fn row(label: impl Into<String>, value: impl Into<String>) -> (String, String) {
    (label.into(), value.into())
}

pub fn align_rows(rows: &[(String, String)]) -> String {
    align_rows_indent(rows, 2, 2)
}

pub fn align_rows_indent(rows: &[(String, String)], indent: usize, gap: usize) -> String {
    let width = rows
        .iter()
        .map(|(label, _)| display_width(label))
        .max()
        .unwrap_or(0);
    rows.iter()
        .map(|(label, value)| {
            format!(
                "{}{}{}",
                " ".repeat(indent),
                pad_to(label, width + gap),
                value
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn section(title: &str) -> String {
    section_width(title, 60)
}

pub fn section_width(title: &str, width: usize) -> String {
    let head = format!("── {title} ");
    if display_width(&head) >= width {
        head.trim_end().to_string()
    } else {
        format!("{}{}", head, "─".repeat(width - display_width(&head)))
    }
}

pub fn join_blocks<'a>(blocks: impl IntoIterator<Item = &'a str>) -> String {
    blocks
        .into_iter()
        .map(str::trim_end)
        .filter(|block| !block.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Intl.NumberFormat(locale, { maximumFractionDigits: 2 }) equivalent.
pub fn format_number(value: f64) -> String {
    if !value.is_finite() || value.abs() < 0.005 {
        return "0".into();
    }
    let negative = value < 0.0;
    let abs = value.abs();
    let scaled = (abs * 100.0).round() / 100.0;
    let mut text = format!("{scaled}");
    if let Some(dot) = text.find('.') {
        while text.ends_with('0') {
            text.pop();
        }
        if text.ends_with('.') {
            text.pop();
        }
        let _ = dot;
    }
    let (whole, fraction) = match text.split_once('.') {
        Some((w, f)) => (w.to_string(), Some(f.to_string())),
        None => (text, None),
    };
    let mut grouped = String::new();
    let digits = whole.as_bytes();
    for (index, byte) in digits.iter().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(*byte as char);
    }
    let sign = if negative && scaled != 0.0 { "-" } else { "" };
    match fraction {
        Some(fraction) => format!("{sign}{grouped}.{fraction}"),
        None => format!("{sign}{grouped}"),
    }
}

pub fn signed(value: f64) -> String {
    if !value.is_finite() {
        return format!("+ {}", format_number(0.0));
    }
    format!(
        "{} {}",
        if value < 0.0 { "−" } else { "+" },
        format_number(value.abs())
    )
}

pub fn offset_label(minutes: i32, colon: bool) -> String {
    let sign = if minutes < 0 { '-' } else { '+' };
    let abs = minutes.abs();
    format!(
        "{sign}{:02}{}{:02}",
        abs / 60,
        if colon { ":" } else { "" },
        abs % 60
    )
}

/// Intl.RelativeTimeFormat(locale, { numeric, style: 'long' }).format(amount, unit).
pub fn relative_phrase(delta_ms: i64, locale: LocaleCode, numeric_auto: bool) -> String {
    let abs = delta_ms.unsigned_abs();
    let steps: [(&str, u64); 7] = [
        ("second", SEC_MS as u64),
        ("minute", MIN_MS as u64),
        ("hour", HOUR_MS as u64),
        ("day", DAY_MS as u64),
        ("week", WEEK_MS as u64),
        ("month", MONTH_MS as u64),
        ("year", YEAR_MS as u64),
    ];
    let mut index = steps.len() - 1;
    for (i, ..) in steps.iter().enumerate().take(steps.len() - 1) {
        if abs < steps[i + 1].1 {
            index = i;
            break;
        }
    }
    let unit_ms = steps[index].1 as i64;
    let unit = steps[index].0;
    // Calendar units truncate toward zero ("2 年 10 个月" must not read as "3 年前").
    let amount = if unit_ms >= DAY_MS {
        delta_ms / unit_ms
    } else {
        (delta_ms as f64 / unit_ms as f64).round() as i64
    };
    let amount = if amount == 0 && delta_ms != 0 {
        if delta_ms < 0 {
            -1
        } else {
            1
        }
    } else {
        amount
    };
    format_relative(amount, unit, locale, numeric_auto)
}

pub type LocaleCode = &'static str;
pub const ZH_CN: LocaleCode = "zh-CN";
pub const EN_US: LocaleCode = "en-US";

pub fn zh_unit(unit: &str) -> &'static str {
    match unit {
        "year" => "年",
        "month" => "个月",
        "week" => "周",
        "day" => "天",
        "hour" => "小时",
        "minute" => "分钟",
        _ => "秒",
    }
}

fn en_unit_long(unit: &str, amount: i64) -> &'static str {
    let plural = amount.abs() != 1;
    match (unit, plural) {
        ("second", false) => "second",
        ("minute", false) => "minute",
        ("hour", false) => "hour",
        ("day", false) => "day",
        ("week", false) => "week",
        ("month", false) => "month",
        ("year", false) => "year",
        ("second", true) => "seconds",
        ("minute", true) => "minutes",
        ("hour", true) => "hours",
        ("day", true) => "days",
        ("week", true) => "weeks",
        ("month", true) => "months",
        ("year", true) => "years",
        _ => "seconds",
    }
}

pub fn format_relative(amount: i64, unit: &str, locale: LocaleCode, numeric_auto: bool) -> String {
    if locale == ZH_CN {
        if numeric_auto {
            match (unit, amount) {
                ("day", -1) => return "昨天".into(),
                ("day", 0) => return "今天".into(),
                ("day", 1) => return "明天".into(),
                ("week", -1) => return "上周".into(),
                ("week", 1) => return "下周".into(),
                ("month", -1) => return "上个月".into(),
                ("month", 1) => return "下个月".into(),
                ("year", -1) => return "去年".into(),
                ("year", 1) => return "明年".into(),
                ("second", 0) => return "现在".into(),
                _ => {}
            }
        }
        let magnitude = amount.abs();
        let suffix = if amount < 0 { "前" } else { "后" };
        return format!("{}{}{}", magnitude, zh_unit(unit), suffix);
    }
    if numeric_auto {
        match (unit, amount) {
            ("day", -1) => return "yesterday".into(),
            ("day", 0) => return "today".into(),
            ("day", 1) => return "tomorrow".into(),
            ("week", -1) => return "last week".into(),
            ("week", 1) => return "next week".into(),
            ("month", -1) => return "last month".into(),
            ("month", 1) => return "next month".into(),
            ("year", -1) => return "last year".into(),
            ("year", 1) => return "next year".into(),
            ("second", 0) => return "now".into(),
            _ => {}
        }
    }
    let name = en_unit_long(unit, amount);
    if amount < 0 {
        format!("{} {} ago", amount.abs(), name)
    } else {
        format!("in {} {}", amount, name)
    }
}

/// Unit name used by totals rows: zh falls back to the shared catalog wording.
pub fn unit_name(unit: &str, ui_locale: &str) -> String {
    let zh = is_zh(ui_locale);
    match unit {
        "s" | "second" | "seconds" => zh
            .then(|| "秒".to_string())
            .unwrap_or_else(|| "seconds".into()),
        "min" | "minute" | "minutes" => zh
            .then(|| "分钟".to_string())
            .unwrap_or_else(|| "minutes".into()),
        "h" | "hour" | "hours" => zh
            .then(|| "小时".to_string())
            .unwrap_or_else(|| "hours".into()),
        "d" | "day" | "days" => zh
            .then(|| "天".to_string())
            .unwrap_or_else(|| "days".into()),
        "w" | "week" | "weeks" => zh
            .then(|| "周".to_string())
            .unwrap_or_else(|| "weeks".into()),
        "ms" => zh
            .then(|| "毫秒".to_string())
            .unwrap_or_else(|| "milliseconds".into()),
        "us" => zh
            .then(|| "微秒".to_string())
            .unwrap_or_else(|| "microseconds".into()),
        "ns" => zh
            .then(|| "纳秒".to_string())
            .unwrap_or_else(|| "nanoseconds".into()),
        "years" => zh
            .then(|| "年".to_string())
            .unwrap_or_else(|| "years".into()),
        "months" => zh
            .then(|| "个月".to_string())
            .unwrap_or_else(|| "months".into()),
        other => other.into(),
    }
}

pub fn en_unit_suffix(unit: &str) -> &'static str {
    match unit {
        "ms" => "ms",
        "seconds" => "s",
        "minutes" => "min",
        "hours" => "h",
        "days" => "d",
        "weeks" => "w",
        "us" => "µs",
        "ns" => "ns",
        other => match other {
            "s" => "s",
            "min" => "min",
            "h" => "h",
            "d" => "d",
            "w" => "w",
            _ => "s",
        },
    }
}

pub fn unit_suffix(unit: &str, en_phrase: bool, ui_locale: &str) -> String {
    if en_phrase {
        en_unit_suffix(unit).into()
    } else {
        unit_name(unit, ui_locale)
    }
}

pub fn rest_sep(ui_locale: &str) -> &'static str {
    if is_zh(ui_locale) {
        "、"
    } else {
        ", "
    }
}

pub fn format_weekend_set(weekend: &[u32], ui_locale: &str) -> String {
    if weekend.is_empty() {
        return msg(
            ui_locale,
            "无（weekend 为空，全部按工作日处理）",
            "none (weekend is empty, every day counts as a workday)",
        )
        .into();
    }
    let mut sorted = weekend.to_vec();
    sorted.sort_unstable();
    sorted
        .iter()
        .map(|day| format!("{}={}", day, weekday_spelled(*day, ui_locale)))
        .collect::<Vec<_>>()
        .join(rest_sep(ui_locale))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn section_fills_to_60_display_columns() {
        let line = section("摘要结果");
        assert_eq!(display_width(&line), 60);
        assert!(line.starts_with("── 摘要结果 "));
        let long = section("时区对照表 · 2 个时区 · 基准 2023-11-15 20:00:00 (UTC+08:00)");
        assert!(long.starts_with("── 时区对照表"));
    }

    #[test]
    fn format_number_groups_thousands_and_trims() {
        assert_eq!(format_number(5_356_800_000.0), "5,356,800,000");
        assert_eq!(format_number(8.859), "8.86");
        assert_eq!(format_number(46.296), "46.3");
        assert_eq!(format_number(62.25), "62.25");
        assert_eq!(format_number(3_735_000.0), "3,735,000");
        assert_eq!(format_number(2_419.997), "2,420");
    }

    #[test]
    fn align_rows_pads_by_display_width() {
        let rows = vec![
            row("方向", "终点晚于起点，符号 +"),
            row("日历分解", "10个月 2周"),
        ];
        let text = align_rows(&rows);
        assert_eq!(
            text,
            "  方向      终点晚于起点，符号 +\n  日历分解  10个月 2周"
        );
    }

    #[test]
    fn span_text_uses_locale_units() {
        let span = CalendarSpan {
            sign: 1,
            years: 0,
            months: 2,
            weeks: 2,
            days: 0,
            hours: 0,
            minutes: 0,
            seconds: 0,
            milliseconds: 0,
        };
        assert_eq!(span_text(&span, false), "2个月 2周");
        let negative = CalendarSpan { sign: -1, ..span };
        assert_eq!(span_text(&negative, true), "-2mo 2w");
    }

    #[test]
    fn relative_phrase_matches_intl_wording() {
        assert_eq!(relative_phrase(-86_400_000, ZH_CN, true), "昨天");
        assert_eq!(relative_phrase(-86_400_000, EN_US, true), "yesterday");
        assert_eq!(relative_phrase(8_711_999_000, ZH_CN, true), "3个月后");
        assert_eq!(relative_phrase(8_711_999_000, EN_US, true), "in 3 months");
        assert_eq!(relative_phrase(-8_711_999_000, EN_US, true), "3 months ago");
    }
}
