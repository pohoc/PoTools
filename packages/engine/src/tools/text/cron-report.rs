use super::super::common::*;
use super::super::fmt;
use super::parser::{DayRule, Plan};
use super::ToolResult;
#[path = "cron-report-format.rs"]
mod formatting;
use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use formatting::*;
use std::collections::BTreeSet;

fn dow_long_list(v: &BTreeSet<u32>, en: bool) -> String {
    v.iter()
        .map(|d| {
            if en {
                crate::tools::text::fmt::WEEKDAYS_EN[(*d % 7) as usize].to_string()
            } else {
                super::description::dow(*d, false)
            }
        })
        .collect::<Vec<_>>()
        .join(if en { ", " } else { "、" })
}

fn dow_run_names(v: &BTreeSet<u32>, en: bool) -> String {
    let values: Vec<u32> = v.iter().copied().collect();
    let is_run = values.len() > 1
        && values
            .iter()
            .enumerate()
            .all(|(i, n)| *n == values[0] + i as u32);
    if is_run {
        if en {
            let long = crate::tools::text::fmt::WEEKDAYS_EN;
            format!(
                "{} to {}",
                long[(values[0] % 7) as usize],
                long[(values[values.len() - 1] % 7) as usize]
            )
        } else {
            format!(
                "{} 至 {}",
                super::description::dow(values[0], false),
                super::description::dow(values[values.len() - 1], false)
            )
        }
    } else {
        dow_long_list(v, en)
    }
}

fn field_values_rows(plan: &Plan, en: bool) -> Vec<(String, String)> {
    let week = match &plan.dow {
        DayRule::All => {
            if en {
                "all 7 values".into()
            } else {
                "全部 7 个取值".into()
            }
        }
        rule => match special(rule, en) {
            Some(text) => text,
            None => match rule {
                DayRule::Values(v) if v.len() == 7 => {
                    if en {
                        "all 7 values".into()
                    } else {
                        "全部 7 个取值".into()
                    }
                }
                DayRule::Values(v) => {
                    let nums = values(v, 0, 6);
                    let names = dow_run_names(v, en);
                    if en {
                        format!("{nums} ({names})")
                    } else {
                        format!("{nums}（{names}）")
                    }
                }
                _ => String::new(),
            },
        },
    };
    vec![
        (label("second", en), expand(&plan.sec, en)),
        (label("minute", en), expand(&plan.min, en)),
        (label("hour", en), expand(&plan.hour, en)),
        (
            label("day", en),
            match &plan.dom {
                DayRule::All => {
                    if en {
                        "all 31 values".into()
                    } else {
                        "全部 31 个取值".into()
                    }
                }
                DayRule::Values(v) => expand(v, en),
                rule => special(rule, en).unwrap_or_default(),
            },
        ),
        (label("month", en), named(&plan.month, en, false)),
        (label("weekday", en), week),
    ]
}

pub(super) fn reboot(
    expression: &str,
    zone_name: &str,
    tz: Tz,
    now: DateTime<Utc>,
    en: bool,
) -> ToolResult {
    let title = if en {
        format!("cron parse · {zone_name}")
    } else {
        format!("cron 解析 · {zone_name}")
    };
    let fields = if en {
        "@reboot · no calendar fields (boot-triggered by init)"
    } else {
        "@reboot · 无日历字段（由 init 开机触发）"
    };
    let sentence = if en {
        "@reboot: runs at system boot only"
    } else {
        "@reboot：仅在系统启动时执行"
    };
    let note = if en {
        "· @reboot is triggered by init at boot time; it has no calendar meaning, so it is excluded from the next-run and run-list computation."
    } else {
        "· @reboot 由 init 系统在开机时触发，没有日历含义，因此不参与下次执行时间与执行序列的推算。"
    };
    let dow_note = if en {
        "· Weekday field: both 0 and 7 mean Sunday, 1=Mon."
    } else {
        "· 星期字段：0 与 7 均表示周日，1=周一。"
    };
    let text = join(vec![
        section(&title),
        align(&[
            (label("expression", en), expression.into()),
            (label("fields", en), fields.into()),
            (label("sentence", en), sentence.into()),
        ]),
        section(if en { "Notes" } else { "说明" }),
        format!("{note}\n{dow_note}"),
    ]);
    let mut extra = serde_json::Map::new();
    put(&mut extra, "expression", expression);
    put(&mut extra, "timezone", zone_name);
    put(&mut extra, "fields", "0");
    put(&mut extra, "from", fmt_local(now, tz));
    put(&mut extra, "count", "0");
    put(&mut extra, "first", "");
    put(&mut extra, "last", "");
    put(&mut extra, "sentence", sentence);
    output("cron.txt", text, extra)
}
pub(super) fn render(
    expression: &str,
    canonical: &str,
    from_raw: &str,
    zone_name: &str,
    tz: Tz,
    from: DateTime<Utc>,
    runs: &[DateTime<Utc>],
    plan: &Plan,
    count: usize,
    show_values: bool,
    show_countdown: bool,
    skipped: &[String],
    locale: &str,
) -> ToolResult {
    let en = english(locale);
    let sentence = super::description::describe(plan, locale);
    let title = if en {
        format!("cron parse · {zone_name}")
    } else {
        format!("cron 解析 · {zone_name}")
    };
    let mut blocks = vec![section(&title)];
    let field_text = if canonical != expression {
        if en {
            format!(
                "{} → {} · {}",
                expression,
                canonical,
                if plan.seconds {
                    "6 fields (minute hour day month weekday second)"
                } else {
                    "5 fields (minute hour day month weekday)"
                }
            )
        } else {
            format!(
                "{} → {} · {}",
                expression,
                canonical,
                if plan.seconds {
                    "6 字段（分 时 日 月 周 秒）"
                } else {
                    "5 字段（分 时 日 月 周）"
                }
            )
        }
    } else if en {
        if plan.seconds {
            "6 fields (minute hour day month weekday second)".into()
        } else {
            "5 fields (minute hour day month weekday)".into()
        }
    } else if plan.seconds {
        "6 字段（分 时 日 月 周 秒）".into()
    } else {
        "5 字段（分 时 日 月 周）".into()
    };
    let stamp_value = stamp(from, tz);
    let stamp_plain = fmt_local(from, tz);
    let start = if from_raw.trim().is_empty() || from_raw.trim() == stamp_plain {
        format!("{} · {}", stamp_value, weekday(from, tz, en))
    } else if en {
        format!(
            "{} → {} · {}",
            from_raw,
            stamp_value,
            weekday(from, tz, true)
        )
    } else {
        format!(
            "{} → {} · {}",
            from_raw,
            stamp_value,
            weekday(from, tz, false)
        )
    };
    let hit_text = if en {
        format!("{} found", runs.len())
    } else {
        format!("{} 个", runs.len())
    };
    blocks.push(align(&[
        (label("expression", en), expression.into()),
        (label("fields", en), field_text),
        (label("start", en), start),
        (label("planned", en), grouped(count, en)),
        (label("hits", en), hit_text),
    ]));
    if show_countdown {
        blocks.push(section(if en { "Next run" } else { "下次执行" }));
        blocks.push(align(&[
            (
                label("next", en),
                if en {
                    format!("{} ({zone_name})", fmt_local(runs[0], tz))
                } else {
                    format!("{}（{zone_name}）", fmt_local(runs[0], tz))
                },
            ),
            (
                label("countdown", en),
                countdown((runs[0] - from).num_milliseconds(), en),
            ),
        ]));
    }
    blocks.push(section(if en {
        "Schedule in words"
    } else {
        "排程解读"
    }));
    let sentence_row = if canonical != expression {
        if en {
            format!("{} expands to {} ({sentence})", expression, canonical)
        } else {
            format!("{} 等价于 {}（{}）", expression, canonical, sentence)
        }
    } else {
        sentence.clone()
    };
    let sentence_label = if canonical != expression {
        if en {
            "Macro"
        } else {
            "宏展开"
        }
    } else {
        &*label("sentence", en)
    };
    blocks.push(align(&[(sentence_label.to_string(), sentence_row)]));
    blocks.push(section(if en {
        "Normalized fields"
    } else {
        "字段归一化"
    }));
    blocks.push(align(&normalize(plan, en)));
    if show_values {
        blocks.push(section(if en {
            "Field values"
        } else {
            "字段取值展开"
        }));
        blocks.push(align(&field_values_rows(plan, en)));
    }
    blocks.push(section(if en { "Run times" } else { "执行时刻" }));
    let rows: Vec<_> = runs
        .iter()
        .enumerate()
        .map(|(i, dt)| {
            let m = offset(*dt, tz);
            let dst = if dst(*dt, tz) {
                if en {
                    " daylight time"
                } else {
                    " 夏令时"
                }
            } else {
                ""
            };
            (
                format!("#{}", i + 1),
                format!(
                    "{}  {}  UTC{}  {}{}",
                    fmt_local(*dt, tz),
                    weekday(*dt, tz, en),
                    offset_text(m),
                    fmt::zone_abbrev(tz, *dt),
                    dst
                ),
            )
        })
        .collect();
    blocks.push(fmt::align_rows_indent(&rows, 2, 3));
    let gaps: Vec<_> = runs
        .windows(2)
        .map(|pair| decimal((pair[1] - pair[0]).num_milliseconds() as f64 / 1000.0))
        .collect();
    blocks.push(section(if en {
        "Gaps (seconds)"
    } else {
        "间隔（秒）"
    }));
    blocks.push(align(&[(
        label("gaps", en),
        if gaps.is_empty() {
            if en {
                "single run, no gap".into()
            } else {
                "仅一次执行，无间隔".into()
            }
        } else {
            gaps.join(" · ")
        },
    )]));
    let offsets: BTreeSet<_> = runs.iter().map(|dt| offset(*dt, tz)).collect();
    let dom_restricted = !matches!(plan.dom, DayRule::All);
    let dow_restricted = !matches!(plan.dow, DayRule::All);
    let mut notes = vec![if en {
        "· Weekday field: both 0 and 7 mean Sunday, 1=Mon.".to_string()
    } else {
        "· 星期字段：0 与 7 均表示周日，1=周一。".into()
    }];
    if !plan.seconds {
        notes.push(if en {
            "· With a 5-field expression the seconds value is fixed to 0.".into()
        } else {
            "· 5 字段表达式的秒固定为 0。".into()
        })
    }
    if dom_restricted && dow_restricted {
        notes.push(if en{"· When both day and weekday are restricted, classic cron takes the union (either one matches).".into()}else{"· “日”和“星期”同时受限时，按经典 cron 取并集（满足任一即执行）。".into()})
    }
    if offsets.len() > 1 {
        notes.push(if en {
            format!(
                "· {zone_name} offsets vary (UTC{} ~ UTC{}); each run shows its actual offset.",
                offset_text(*offsets.first().unwrap()),
                offset_text(*offsets.last().unwrap())
            )
        } else {
            format!(
                "· {zone_name} 在这些时刻的偏移不一致（UTC{} ~ UTC{}），已按各时刻的真实偏移输出。",
                offset_text(*offsets.first().unwrap()),
                offset_text(*offsets.last().unwrap())
            )
        })
    }
    if !skipped.is_empty() {
        notes.push(if en {
            format!(
                "· These local times fall into the daylight-saving gap and were skipped: {}.",
                skipped.join(", ")
            )
        } else {
            format!(
                "· 以下本地时刻落在夏令时切换空档，已跳过：{}。",
                skipped.join("、")
            )
        })
    }
    blocks.push(section(if en { "Notes" } else { "说明" }));
    blocks.push(notes.join("\n"));
    let mut extra = serde_json::Map::new();
    put(&mut extra, "expression", expression);
    put(&mut extra, "timezone", zone_name);
    put(&mut extra, "fields", if plan.seconds { "6" } else { "5" });
    put(&mut extra, "from", fmt_local(from, tz));
    put(&mut extra, "count", runs.len().to_string());
    put(&mut extra, "first", fmt_local(runs[0], tz));
    put(&mut extra, "last", fmt_local(*runs.last().unwrap(), tz));
    put(&mut extra, "sentence", sentence);
    output("cron.txt", join(blocks), extra)
}
