use super::parser::{DayRule, Plan};
use std::collections::BTreeSet;

pub(super) fn compact(values: &BTreeSet<u32>) -> String {
    values
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",")
}
pub(super) fn day_compact(rule: &DayRule) -> String {
    match rule {
        DayRule::All => "*".into(),
        DayRule::Values(values) => compact(values),
        DayRule::Last => "L".into(),
        DayRule::LastWeekday => "LW".into(),
        DayRule::Nearest(day) => format!("{day}W"),
        DayRule::LastDow(dow) => format!("{dow}L"),
        DayRule::Nth(dow, nth) => format!("{dow}#{nth}"),
    }
}
fn describe_values(values: &BTreeSet<u32>, min: u32, max: u32) -> String {
    if values.len() >= (max - min + 1) as usize {
        return "*".into();
    }
    let sorted: Vec<_> = values.iter().copied().collect();
    let mut groups = Vec::new();
    let mut i = 0;
    while i < sorted.len() {
        let mut j = i;
        while j + 1 < sorted.len() && sorted[j + 1] == sorted[j] + 1 {
            j += 1;
        }
        groups.push(if i == j {
            sorted[i].to_string()
        } else {
            format!("{}-{}", sorted[i], sorted[j])
        });
        i = j + 1;
    }
    groups.join(",")
}
fn recurring_step(values: &BTreeSet<u32>, min: u32, max: u32) -> Option<u32> {
    let nums: Vec<_> = values.iter().copied().collect();
    if nums.len() < 2 || nums[0] != min {
        return None;
    }
    let step = nums[1] - nums[0];
    if step > 1
        && nums
            .iter()
            .enumerate()
            .all(|(i, n)| *n == min + i as u32 * step)
        && nums.last().copied().unwrap_or(0) + step > max
    {
        Some(step)
    } else {
        None
    }
}
fn single(values: &BTreeSet<u32>) -> Option<u32> {
    if values.len() == 1 {
        values.first().copied()
    } else {
        None
    }
}
fn dow_name(day: u32, english: bool) -> &'static str {
    if english {
        [
            "Sunday",
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday",
        ][day as usize % 7]
    } else {
        ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][day as usize % 7]
    }
}
fn clock(h: u32, m: u32, s: u32, seconds: bool, twelve: bool) -> String {
    let tail = if seconds {
        format!(":{s:02}")
    } else {
        String::new()
    };
    if !twelve {
        format!("{h:02}:{m:02}{tail}")
    } else {
        let period = if h >= 12 { "PM" } else { "AM" };
        let hour = if h % 12 == 0 { 12 } else { h % 12 };
        format!("{hour}:{m:02}{tail} {period}")
    }
}
fn clock_list(plan: &Plan, english: bool, twelve: bool) -> Option<String> {
    let mut items = Vec::new();
    for h in &plan.hour {
        for m in &plan.min {
            for s in if plan.seconds {
                plan.sec.iter().copied().collect::<Vec<_>>()
            } else {
                vec![0]
            } {
                if items.len() >= 12 {
                    return None;
                }
                items.push(clock(*h, *m, s, plan.seconds, twelve));
            }
        }
    }
    if items.is_empty() {
        None
    } else {
        Some(items.join(if english { ", " } else { "、" }))
    }
}
fn time_frequency(plan: &Plan, english: bool) -> Option<String> {
    let minute_all = plan.min.len() == 60;
    let hour_all = plan.hour.len() == 24;
    let phrase = if minute_all && hour_all {
        if plan.seconds {
            if let Some(n) = recurring_step(&plan.sec, 0, 59) {
                Some(if english {
                    format!("Every {n} seconds.")
                } else {
                    format!("每 {n} 秒")
                })
            } else if plan.sec.len() == 60 {
                Some(if english {
                    "Every second.".into()
                } else {
                    "每秒".into()
                })
            } else {
                None
            }
        } else {
            Some(if english {
                "Every minute.".into()
            } else {
                "每分钟".into()
            })
        }
    } else if let Some(n) = recurring_step(&plan.min, 0, 59).filter(|_| hour_all) {
        if plan.seconds && single(&plan.sec).is_some_and(|s| s != 0) {
            let s = single(&plan.sec).unwrap();
            Some(if english {
                format!("Every {n} minutes at second {s}.")
            } else {
                format!("每 {n} 分钟的第 {s} 秒")
            })
        } else {
            Some(if english {
                format!("Every {n} minutes.")
            } else {
                format!("每 {n} 分钟")
            })
        }
    } else if minute_all {
        recurring_step(&plan.hour, 0, 23)
            .map(|n| {
                if english {
                    format!("Every {n} hours.")
                } else {
                    format!("每 {n} 小时")
                }
            })
            .or_else(|| {
                single(&plan.hour).map(|h| {
                    if english {
                        format!("Every minute past hour {h}.")
                    } else {
                        format!("{h} 时的每分钟")
                    }
                })
            })
    } else if let (Some(h), Some(n)) = (single(&plan.hour), recurring_step(&plan.min, 0, 59)) {
        Some(if english {
            format!("Every {n} minutes past hour {h}.")
        } else {
            format!("{h} 时每 {n} 分钟")
        })
    } else if let Some(m) = single(&plan.min) {
        if hour_all {
            Some(if english {
                format!("At minute {m} past every hour.")
            } else {
                format!("每小时第 {m} 分钟")
            })
        } else {
            recurring_step(&plan.hour, 0, 23).map(|n| {
                if english {
                    format!("Every {n} hours at minute {m}.")
                } else {
                    format!("每 {n} 小时第 {m} 分钟")
                }
            })
        }
    } else {
        None
    };
    phrase
}
fn dom_clause(rule: &DayRule, months: &BTreeSet<u32>, english: bool) -> String {
    match rule {
        DayRule::All => String::new(),
        DayRule::Values(v) => {
            if english {
                format!(
                    "on day {} of {}",
                    describe_values(v, 1, 31),
                    month_phrase(months, english)
                )
            } else {
                format!(
                    "{} {} 日",
                    month_phrase(months, english),
                    describe_values(v, 1, 31)
                )
            }
        }
        DayRule::Last => {
            if english {
                "the last day of every month".into()
            } else {
                "每月最后一天".into()
            }
        }
        DayRule::LastWeekday => {
            if english {
                "the last weekday of every month".into()
            } else {
                "每月最后一个工作日".into()
            }
        }
        DayRule::Nearest(d) => {
            if english {
                format!("the weekday nearest day {d} of every month")
            } else {
                format!("每月 {d} 日最近的工作日")
            }
        }
        DayRule::LastDow(d) => {
            if english {
                format!("the last {} of every month", dow_name(*d, true))
            } else {
                format!("每月最后一个{}", dow_name(*d, false))
            }
        }
        DayRule::Nth(d, n) => {
            if english {
                format!(
                    "the {} {} of every month",
                    ordinal(*n, true),
                    dow_name(*d, true)
                )
            } else {
                format!("每月第 {n} 个{}", dow_name(*d, false))
            }
        }
    }
}
fn month_phrase(months: &BTreeSet<u32>, english: bool) -> String {
    if months.len() == 12 {
        if english {
            "every month".into()
        } else {
            "每月".into()
        }
    } else {
        let names: Vec<_> = months
            .iter()
            .map(|m| {
                if english {
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
                } else {
                    match m {
                        1 => "1 月",
                        2 => "2 月",
                        3 => "3 月",
                        4 => "4 月",
                        5 => "5 月",
                        6 => "6 月",
                        7 => "7 月",
                        8 => "8 月",
                        9 => "9 月",
                        10 => "10 月",
                        11 => "11 月",
                        _ => "12 月",
                    }
                }
            })
            .collect();
        let joined = names.join(if english { ", " } else { "、" });
        if english {
            joined
        } else {
            // mpOf: "每年 {months}"
            format!("每年 {joined}")
        }
    }
}
fn dow_clause(rule: &DayRule, english: bool) -> String {
    match rule {
        DayRule::All => String::new(),
        DayRule::Values(v) => {
            if v.len() == 5 && v.iter().copied().eq(1..=5) {
                if english {
                    "Every weekday (Monday to Friday)".into()
                } else {
                    "周一至周五".into()
                }
            } else if v.len() == 1 {
                if english {
                    format!("Every {}", dow_name(*v.first().unwrap(), true))
                } else {
                    format!("每{}", dow_name(*v.first().unwrap(), false))
                }
            } else {
                let names: Vec<_> = v.iter().map(|d| dow_name(*d, english)).collect();
                if english {
                    format!("On {}", names.join(", "))
                } else {
                    names.join("、")
                }
            }
        }
        DayRule::LastDow(d) => {
            if english {
                format!("The last {} of every month", dow_name(*d, true))
            } else {
                format!("每月最后一个{}", dow_name(*d, false))
            }
        }
        DayRule::Nth(d, n) => {
            if english {
                format!(
                    "The {} {} of every month",
                    ordinal(*n, true),
                    dow_name(*d, true)
                )
            } else {
                format!("每月第 {n} 个{}", dow_name(*d, false))
            }
        }
        _ => String::new(),
    }
}
fn ordinal(n: u32, english: bool) -> String {
    if !english {
        return format!("第 {n}");
    }
    match n {
        1 => "1st".into(),
        2 => "2nd".into(),
        3 => "3rd".into(),
        _ => format!("{n}th"),
    }
}
pub(super) fn dow(day: u32, english: bool) -> String {
    dow_name(day, english).into()
}
pub(super) fn describe(plan: &Plan, locale: &str) -> String {
    let english = locale.to_ascii_lowercase().starts_with("en");
    let twelve = english;
    let restricted_dom = !matches!(plan.dom, DayRule::All);
    let restricted_dow = !matches!(plan.dow, DayRule::All);
    let restricted = restricted_dom || restricted_dow || plan.month.len() != 12;
    let descriptive = if english {
        format!(
            "minute {} of hour {}",
            describe_values(&plan.min, 0, 59),
            describe_values(&plan.hour, 0, 23)
        )
    } else {
        format!(
            "第 {} 小时的第 {} 分钟",
            describe_values(&plan.hour, 0, 23),
            describe_values(&plan.min, 0, 59)
        )
    };
    if !restricted {
        if let Some(freq) = time_frequency(plan, english) {
            return freq;
        }
    }
    let clocks = clock_list(plan, english, twelve);
    let time = clocks.unwrap_or_else(|| descriptive.clone());
    if !restricted {
        if let Some(list) = clock_list(plan, english, false) {
            if single(&plan.min) == Some(0) && single(&plan.hour).is_some() && !plan.seconds {
                return if english {
                    format!(
                        "Every day at {}.",
                        clock_list(plan, true, true).unwrap_or(list)
                    )
                } else {
                    format!("每天 {}", list)
                };
            }
            return if english {
                format!("At {list}.")
            } else {
                format!("每天 {list}")
            };
        }
        return if english {
            format!("{descriptive}.")
        } else {
            descriptive
        };
    }
    let dom = dom_clause(&plan.dom, &plan.month, english);
    let dow = dow_clause(&plan.dow, english);
    let when = if restricted_dom && restricted_dow {
        if english {
            format!("{dom} or {}", dow.strip_prefix("On ").unwrap_or(&dow))
        } else {
            format!("{dom} 或 {dow}")
        }
    } else if restricted_dom {
        dom
    } else if restricted_dow {
        dow
    } else if english {
        format!("Every day of {}", month_phrase(&plan.month, true))
    } else {
        format!("{} 每天", month_phrase(&plan.month, false))
    };
    if english {
        format!("{when} at {time}.")
    } else {
        format!("{when} {time}")
    }
}
