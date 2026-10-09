use super::super::super::common::*;
use super::super::description::{day_compact, dow};
use super::super::parser::{DayRule, Plan};
use chrono::{DateTime, Datelike, Offset, TimeZone, Utc};
use chrono_tz::Tz;
use std::collections::BTreeSet;

pub(super) fn english(locale: &str) -> bool {
    locale.starts_with("en")
}
pub(super) fn weekday(date: DateTime<Utc>, tz: Tz, en: bool) -> String {
    // The report spells weekdays with the long names (weekdayLong in the engine).
    let index = date.with_timezone(&tz).weekday().num_days_from_sunday() as usize;
    if en {
        crate::tools::text::fmt::WEEKDAYS_EN[index].to_string()
    } else {
        crate::tools::text::fmt::WEEKDAYS_ZH[index].to_string()
    }
}
pub(super) fn offset(dt: DateTime<Utc>, tz: Tz) -> i32 {
    dt.with_timezone(&tz).offset().fix().local_minus_utc() / 60
}
pub(super) fn offset_text(m: i32) -> String {
    format!(
        "{}{:02}:{:02}",
        if m < 0 { "-" } else { "+" },
        m.abs() / 60,
        m.abs() % 60
    )
}
pub(super) fn stamp(dt: DateTime<Utc>, tz: Tz) -> String {
    format!("{} (UTC{})", fmt_local(dt, tz), offset_text(offset(dt, tz)))
}
pub(super) fn section(name: &str) -> String {
    let head = format!("── {name} ");
    let width = head
        .chars()
        .map(|c| if is_wide(c) { 2 } else { 1 })
        .sum::<usize>();
    if width >= 60 {
        head.trim_end().into()
    } else {
        format!("{head}{}", "─".repeat(60 - width))
    }
}
fn is_wide(c: char) -> bool {
    matches!(c as u32, 0x1100..=0x115f | 0x2e80..=0x303e | 0x3041..=0x33ff | 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xa000..=0xa4cf | 0xac00..=0xd7a3 | 0xf900..=0xfaff | 0xfe30..=0xfe6f | 0xff00..=0xff60 | 0xffe0..=0xffe6)
}
pub(super) fn align(rows: &[(String, String)]) -> String {
    let width = rows
        .iter()
        .map(|(k, _)| {
            k.chars()
                .map(|c| if is_wide(c) { 2 } else { 1 })
                .sum::<usize>()
        })
        .max()
        .unwrap_or(0);
    rows.iter()
        .map(|(k, v)| {
            format!(
                "  {}{}{}",
                k,
                " ".repeat(
                    width.saturating_sub(
                        k.chars()
                            .map(|c| if is_wide(c) { 2 } else { 1 })
                            .sum::<usize>()
                    ) + 2
                ),
                v
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}
pub(super) fn join(blocks: Vec<String>) -> String {
    blocks
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}
pub(super) fn label(key: &str, en: bool) -> String {
    match (key, en) {
        ("expression", true) => "Expression",
        ("fields", true) => "Field layout",
        ("start", true) => "Start",
        ("planned", true) => "Requested runs",
        ("hits", true) => "Matches",
        ("sentence", true) => "Reads as",
        ("second", true) => "Second",
        ("minute", true) => "Minute",
        ("hour", true) => "Hour",
        ("day", true) => "Day",
        ("month", true) => "Month",
        ("weekday", true) => "Weekday",
        ("next", true) => "Next at",
        ("countdown", true) => "Countdown",
        ("gaps", true) => "Between neighbours",
        ("expression", false) => "表达式",
        ("fields", false) => "字段格式",
        ("start", false) => "起始",
        ("planned", false) => "计划次数",
        ("hits", false) => "命中时刻",
        ("sentence", false) => "口语化",
        ("second", false) => "秒",
        ("minute", false) => "分",
        ("hour", false) => "时",
        ("day", false) => "日",
        ("month", false) => "月",
        ("weekday", false) => "星期",
        ("next", false) => "下次时刻",
        ("countdown", false) => "倒计时",
        ("gaps", false) => "相邻间隔",
        _ => key,
    }
    .into()
}
pub(super) fn grouped(n: usize, en: bool) -> String {
    let s = n.to_string();
    if !en {
        return s;
    }
    let mut out = String::new();
    for (i, c) in s.chars().rev().enumerate() {
        if i > 0 && i % 3 == 0 {
            out.push(',')
        }
        out.push(c)
    }
    out.chars().rev().collect()
}
pub(super) fn values(v: &BTreeSet<u32>, min: u32, max: u32) -> String {
    if v.len() >= (max - min + 1) as usize {
        return "*".into();
    }
    let a: Vec<_> = v.iter().copied().collect();
    if a.len() > 2 && a[0] == min {
        let step = a[1] - a[0];
        if step > 1
            && a.iter()
                .enumerate()
                .all(|(i, n)| *n == min + i as u32 * step)
            && a.last().copied().unwrap_or(0) + step > max
        {
            return format!("*/{step}");
        }
    }
    let mut out = Vec::new();
    let mut i = 0;
    while i < a.len() {
        let mut j = i;
        while j + 1 < a.len() && a[j + 1] == a[j] + 1 {
            j += 1
        }
        out.push(if i == j {
            a[i].to_string()
        } else {
            format!("{}-{}", a[i], a[j])
        });
        i = j + 1
    }
    out.join(",")
}
pub(super) fn day_names(v: &BTreeSet<u32>, en: bool) -> String {
    v.iter()
        .map(|d| {
            if en {
                crate::tools::text::fmt::WEEKDAYS_EN_SHORT[(*d % 7) as usize].to_string()
            } else {
                dow(*d, false)
            }
        })
        .collect::<Vec<_>>()
        .join(if en { ", " } else { "、" })
}
pub(super) fn special(rule: &DayRule, en: bool) -> Option<String> {
    let gloss = match rule {
        DayRule::All => return None,
        DayRule::Values(_) => return None,
        DayRule::Last => {
            if en {
                "the last day of the month"
            } else {
                "当月最后一天"
            }
        }
        DayRule::LastWeekday => {
            if en {
                "the last weekday of the month"
            } else {
                "当月最后一个工作日"
            }
        }
        DayRule::Nearest(n) => {
            return Some(if en {
                format!("{n}W (weekday nearest day {n})")
            } else {
                format!("{n}W（距 {n} 日最近的工作日）")
            })
        }
        DayRule::LastDow(n) => {
            return Some(if en {
                format!("{}L (last {})", n, dow(*n, true))
            } else {
                format!("{}L（最后一个{}）", n, dow(*n, false))
            })
        }
        DayRule::Nth(d, n) => {
            return Some(if en {
                format!("{d}#{n} (the {n}th {})", dow(*d, true))
            } else {
                format!("{d}#{n}（第 {n} 个{}）", dow(*d, false))
            })
        }
    };
    Some(format!("{} ({gloss})", day_compact(rule)))
}
pub(super) fn expand(v: &BTreeSet<u32>, en: bool) -> String {
    if v.is_empty() {
        return if en {
            "no matching value".into()
        } else {
            "无匹配取值".into()
        };
    }
    let a: Vec<_> = v.iter().copied().collect();
    if a.len() <= 12 {
        return a.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
    }
    format!(
        "{}{}",
        a[..12]
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(","),
        if en {
            format!("... ({} values)", grouped(a.len(), true))
        } else {
            format!("…（共 {} 个）", grouped(a.len(), false))
        }
    )
}
fn compact(v: &[u32]) -> String {
    let mut out = Vec::new();
    let mut i = 0;
    while i < v.len() {
        let mut j = i;
        while j + 1 < v.len() && v[j + 1] == v[j] + 1 {
            j += 1;
        }
        out.push(if i == j {
            v[i].to_string()
        } else {
            format!("{}-{}", v[i], v[j])
        });
        i = j + 1;
    }
    out.join(",")
}

pub(super) fn named(v: &BTreeSet<u32>, en: bool, weekday_names: bool) -> String {
    let nums = compact(&v.iter().copied().collect::<Vec<_>>());
    let names = if weekday_names {
        day_names(v, en)
    } else {
        v.iter()
            .map(|m| {
                if en {
                    [
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
                    ][(*m - 1) as usize]
                        .into()
                } else {
                    format!("{m} 月")
                }
            })
            .collect::<Vec<_>>()
            .join(if en { ", " } else { "、" })
    };
    if en {
        format!("{nums} ({names})")
    } else {
        format!("{nums}（{names}）")
    }
}
pub(super) fn dst(dt: DateTime<Utc>, tz: Tz) -> bool {
    let year = dt.with_timezone(&tz).year();
    let current = offset(dt, tz);
    let jan = offset(
        Utc.with_ymd_and_hms(year, 1, 1, 0, 0, 0).single().unwrap(),
        tz,
    );
    let jul = offset(
        Utc.with_ymd_and_hms(year, 7, 1, 0, 0, 0).single().unwrap(),
        tz,
    );
    current > jan.min(jul)
}
pub(super) fn decimal(value: f64) -> String {
    let mut s = format!("{value:.3}");
    while s.contains('.') && s.ends_with('0') {
        s.pop();
    }
    if s.ends_with('.') {
        s.pop();
    }
    s
}
pub(super) fn countdown(milliseconds: i64, en: bool) -> String {
    let seconds = (milliseconds as f64 / 1000.0).round().max(0.0) as i64;
    if seconds < 1 {
        return if en {
            "less than 1 second".into()
        } else {
            "不足 1 秒".into()
        };
    }
    let d = seconds / 86400;
    let h = (seconds % 86400) / 3600;
    let m = (seconds % 3600) / 60;
    let s = seconds % 60;
    if en {
        format!("in {d} d {h:02} h {m:02} min {s:02} s")
    } else {
        format!("还有 {d} 天 {h:02} 小时 {m:02} 分 {s:02} 秒")
    }
}
pub(super) fn normalize(plan: &Plan, en: bool) -> Vec<(String, String)> {
    let second = if en {
        format!(
            "{} ({})",
            values(&plan.sec, 0, 59),
            if plan.seconds {
                "from expression"
            } else {
                "fixed to 0 with 5 fields"
            }
        )
    } else {
        format!(
            "{}（{}）",
            values(&plan.sec, 0, 59),
            if plan.seconds {
                "来自表达式"
            } else {
                "5 字段固定为 0"
            }
        )
    };
    let day = special(&plan.dom, en).unwrap_or_else(|| {
        if matches!(plan.dom, DayRule::All) {
            "*".into()
        } else if let DayRule::Values(v) = &plan.dom {
            values(v, 1, 31)
        } else {
            "*".into()
        }
    });
    let week = special(&plan.dow, en).unwrap_or_else(|| {
        if matches!(plan.dow, DayRule::All) {
            "*".into()
        } else if let DayRule::Values(v) = &plan.dow {
            let raw = values(v, 0, 6);
            if en {
                format!("{raw} ({})", day_names(v, true))
            } else {
                format!("{raw}（{}）", day_names(v, false))
            }
        } else {
            "*".into()
        }
    });
    vec![
        (label("second", en), second),
        (label("minute", en), values(&plan.min, 0, 59)),
        (label("hour", en), values(&plan.hour, 0, 23)),
        (label("day", en), day),
        (label("month", en), values(&plan.month, 1, 12)),
        (label("weekday", en), week),
    ]
}
