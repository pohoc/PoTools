//! Workday scan primitives (rest-day reasons and the day-walk accumulator),
//! split out of `workdays` to keep both files small.

#[allow(unused_imports)]
use super::common::err;
use super::fmt;
use chrono::NaiveDate;

pub(super) const LIST_CAP: usize = 120;
pub(super) const SCAN_CAP: i64 = 9999 * 40;

pub(super) fn dow_short(weekday: u32, ui: &str) -> &'static str {
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

pub(super) fn weekday_long(weekday: u32, spoken_en: bool) -> &'static str {
    if spoken_en {
        fmt::WEEKDAYS_EN[(weekday % 7) as usize]
    } else {
        fmt::WEEKDAYS_ZH[(weekday % 7) as usize]
    }
}

pub(super) fn cell_text(date: NaiveDate, weekday: u32, ui: &str) -> String {
    format!("{} {}", date.format("%Y-%m-%d"), dow_short(weekday, ui))
}

pub(super) fn rest_reason(
    date: NaiveDate,
    weekday: u32,
    weekend: &[u32],
    holidays: &std::collections::BTreeMap<String, String>,
    ui: &str,
) -> Option<String> {
    let key = date.format("%Y-%m-%d").to_string();
    let off = weekend.contains(&(weekday % 7));
    let holiday = holidays.get(&key);
    if let Some(holiday) = holiday.filter(|_| off) {
        return Some(
            fmt::msg(
                ui,
                &format!("周末 + 节假日（{holiday}）"),
                &format!("weekend + holiday ({holiday})"),
            )
            .to_string(),
        );
    }
    if off {
        return Some(fmt::msg(ui, "周末", "weekend").to_string());
    }
    if let Some(holiday) = holiday {
        return Some(
            fmt::msg(
                ui,
                &format!("节假日（{holiday}）"),
                &format!("holiday ({holiday})"),
            )
            .to_string(),
        );
    }
    None
}

pub(super) struct Scan {
    pub(super) end_index: i64,
    pub(super) working: i64,
    pub(super) rest_count: i64,
    pub(super) skipped: Vec<String>,
    pub(super) worked: Vec<String>,
    pub(super) ranges: Vec<(i64, i64)>,
    pub(super) scan_cap_hit: bool,
}
