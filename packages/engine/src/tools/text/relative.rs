//! Relative-time tool: mirrors the product engine's relative-time report.

use super::common::*;
use super::fmt::{self, row};
use super::{EngineError, RunContext, ToolResult};
use chrono::Datelike;
use serde_json::Map;

fn span_with_positive_sign(span: &fmt::CalendarSpan) -> fmt::CalendarSpan {
    fmt::CalendarSpan { sign: 1, ..*span }
}

pub(super) fn run(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let ui = ctx.locale;
    let tz = zone(ctx)?;
    // UI locale wins; otherwise an explicit `locale` option selects English.
    // (`!is_zh` rather than `is_en` here, matching the original predicate.)
    let locale: fmt::LocaleCode = if !fmt::is_zh(ui)
        || string(ctx, "locale", "zh-CN")
            .to_lowercase()
            .starts_with('e')
    {
        fmt::EN_US
    } else {
        fmt::ZH_CN
    };
    let numeric_auto = string(ctx, "style", "auto") != "always";
    let show_countdown = boolean(ctx, "showCountdown", true);
    let target = parse_at(string(ctx, "input", ""), tz)?;
    let base_raw = string(ctx, "base", "now").trim();
    let base_raw = if base_raw.is_empty() { "now" } else { base_raw };
    let base = parse_at(base_raw, tz)?;
    let target_ms = target.timestamp_millis();
    let base_ms = base.timestamp_millis();
    let delta = target_ms - base_ms;
    let span = fmt::calendar_breakdown(base_ms, target_ms, tz)?;
    let phrase = fmt::relative_phrase(delta, locale, numeric_auto);
    let other: fmt::LocaleCode = if locale == fmt::ZH_CN {
        fmt::EN_US
    } else {
        fmt::ZH_CN
    };
    let alt_locale: fmt::LocaleCode = if !fmt::is_zh(ui) { locale } else { other };
    let alt_auto = if !fmt::is_zh(ui) {
        !numeric_auto
    } else {
        numeric_auto
    };
    let en_phrase = locale == fmt::EN_US;
    let ui_en = !fmt::is_zh(ui);
    let target_p = local(target, tz);
    let abs_ms = delta.unsigned_abs() as i64;
    let whole_days = abs_ms / fmt::DAY_MS;
    let mut rest_ms = abs_ms - whole_days * fmt::DAY_MS;
    let hours = rest_ms / fmt::HOUR_MS;
    rest_ms -= hours * fmt::HOUR_MS;
    let minutes = rest_ms / fmt::MIN_MS;
    let seconds = (rest_ms - minutes * fmt::MIN_MS) / fmt::SEC_MS;
    let colon = if fmt::is_zh(ui) { "：" } else { ": " };
    let rows = vec![
        row(fmt::msg(ui, "口语", "Colloquial"), phrase.clone()),
        row(
            fmt::msg(ui, "方向", "Direction"),
            if delta == 0 {
                fmt::msg(ui, "与基准同一时刻", "Same instant as the base")
            } else if delta > 0 {
                fmt::msg(ui, "未来（晚于基准）", "Future (later than the base)")
            } else {
                fmt::msg(ui, "过去（早于基准）", "Past (earlier than the base)")
            },
        ),
        row(
            fmt::msg(ui, "目标", "Target"),
            format!(
                "{} → {} · {}",
                string(ctx, "input", "").trim(),
                fmt::format_zone_stamp(target, tz),
                fmt::instant_line(tz, target, ui)
            ),
        ),
        row(
            fmt::msg(ui, "基准", "Base"),
            format!(
                "{} → {} · {}",
                base_raw,
                fmt::format_zone_stamp(base, tz),
                fmt::instant_line(tz, base, ui)
            ),
        ),
        row(
            fmt::msg(ui, "口语对照", "Colloquial (cross-reference)"),
            format!(
                "{alt_locale}{colon}{}",
                fmt::relative_phrase(delta, alt_locale, alt_auto)
            ),
        ),
        row(
            fmt::msg(ui, "精确跨度", "Exact span"),
            format!(
                "{}{}",
                if delta < 0 { "−" } else { "" },
                fmt::span_text(&span_with_positive_sign(&span), en_phrase)
            ),
        ),
        row(
            fmt::msg(ui, "目标绝对值", "Target absolute"),
            format!(
                "{} · {}",
                fmt::iso_in_zone(target, tz),
                fmt::weekday_spelled(target_p.weekday().num_days_from_sunday(), ui)
            ),
        ),
        row(
            fmt::msg(ui, "基准绝对值", "Base absolute"),
            fmt::iso_in_zone(base, tz),
        ),
        row(
            fmt::msg(ui, "总时长", "Total length"),
            if ui_en {
                format!(
                    "{} s · {} h · {} d",
                    fmt::format_number(abs_ms as f64 / fmt::SEC_MS as f64),
                    fmt::format_number(abs_ms as f64 / fmt::HOUR_MS as f64),
                    fmt::format_number(abs_ms as f64 / fmt::DAY_MS as f64),
                )
            } else {
                format!(
                    "{} 秒 · {} 小时 · {} 天",
                    fmt::format_number(abs_ms as f64 / fmt::SEC_MS as f64),
                    fmt::format_number(abs_ms as f64 / fmt::HOUR_MS as f64),
                    fmt::format_number(abs_ms as f64 / fmt::DAY_MS as f64),
                )
            },
        ),
        row(
            "Unix",
            if ui_en {
                format!(
                    "{} seconds / {} milliseconds",
                    target.timestamp(),
                    target_ms
                )
            } else {
                format!("{} 秒 / {} 毫秒", target.timestamp(), target_ms)
            },
        ),
    ];
    let mut blocks = vec![fmt::section(&format!(
        "{} · {locale} · {}",
        fmt::msg(ui, "相对时间", "Relative time"),
        tz.name()
    ))];
    blocks.push(fmt::align_rows(&rows));
    if show_countdown {
        let totals = if ui_en {
            format!(
                "{} d · {} h · {} min · {} s",
                fmt::format_number(abs_ms as f64 / fmt::DAY_MS as f64),
                fmt::format_number(abs_ms as f64 / fmt::HOUR_MS as f64),
                fmt::format_number(abs_ms as f64 / fmt::MIN_MS as f64),
                fmt::format_number(abs_ms as f64 / fmt::SEC_MS as f64),
            )
        } else {
            format!(
                "{} 天 · {} 小时 · {} 分钟 · {} 秒",
                fmt::format_number(abs_ms as f64 / fmt::DAY_MS as f64),
                fmt::format_number(abs_ms as f64 / fmt::HOUR_MS as f64),
                fmt::format_number(abs_ms as f64 / fmt::MIN_MS as f64),
                fmt::format_number(abs_ms as f64 / fmt::SEC_MS as f64),
            )
        };
        blocks.push(fmt::section(fmt::msg(ui, "倒计时", "Countdown")));
        blocks.push(fmt::align_rows(&[
            row(
                fmt::msg(ui, "状态", "State"),
                if delta == 0 {
                    fmt::msg(ui, "与基准同一时刻", "Same instant as the base")
                } else if delta > 0 {
                    fmt::msg(ui, "还剩", "Remaining")
                } else {
                    fmt::msg(ui, "已过", "Elapsed")
                },
            ),
            row(
                fmt::msg(ui, "拆分", "Breakdown"),
                if ui_en {
                    format!("{whole_days} d {hours} h {minutes} min {seconds} s")
                } else {
                    format!("{whole_days} 天 {hours} 小时 {minutes} 分 {seconds} 秒")
                },
            ),
            row(fmt::msg(ui, "总计", "Totals"), totals),
        ]));
    }
    let mut extra = Map::new();
    put(&mut extra, "locale", locale);
    put(
        &mut extra,
        "style",
        if numeric_auto { "auto" } else { "always" },
    );
    put(&mut extra, "timezone", tz.name());
    put(&mut extra, "phrase", phrase);
    put(&mut extra, "showCountdown", show_countdown.to_string());
    Ok(output(
        "relative-time.txt",
        fmt::join_blocks(blocks.iter().map(String::as_str)),
        extra,
    ))
}
