//! Cron expression parsing and schedule preview for the native engine.
use super::{common::*, EngineError, RunContext, ToolResult};
use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use serde_json::Value;
use std::str::FromStr;

#[path = "cron-description.rs"]
mod description;
#[path = "cron-parser.rs"]
mod parser;
#[path = "cron-report.rs"]
mod report;

const EXAMPLE: &str = "0 9 * * 1-5";
use parser::parse;
use parser::DayRule;
fn bad(message: String) -> EngineError {
    err(message)
}
fn matches_day(rule: &DayRule, date: NaiveDate, is_dom: bool) -> bool {
    let d = date.day();
    let wd = date.weekday().num_days_from_sunday();
    let dim = (date
        .with_day(1)
        .unwrap()
        .checked_add_months(chrono::Months::new(1))
        .unwrap_or(date)
        .pred_opt()
        .unwrap_or(date))
    .day();
    let last = d == dim;
    match rule {
        DayRule::All => true,
        DayRule::Values(v) => v.contains(&(if is_dom { d } else { wd })),
        DayRule::Last => last,
        DayRule::LastWeekday => {
            let dim = (date
                .with_day(1)
                .unwrap()
                .checked_add_months(chrono::Months::new(1))
                .unwrap_or(date)
                .pred_opt()
                .unwrap_or(date))
            .day();
            let mut x = NaiveDate::from_ymd_opt(date.year(), date.month(), dim).unwrap();
            while matches!(x.weekday().num_days_from_sunday(), 0 | 6) {
                x = x.pred_opt().unwrap()
            }
            d == x.day()
        }
        DayRule::Nearest(n) => {
            let dim = (date
                .with_day(1)
                .unwrap()
                .checked_add_months(chrono::Months::new(1))
                .unwrap_or(date)
                .pred_opt()
                .unwrap_or(date))
            .day();
            let t = (*n).min(dim);
            let w = NaiveDate::from_ymd_opt(date.year(), date.month(), t)
                .unwrap()
                .weekday()
                .num_days_from_sunday();
            d == if w == 6 {
                if t > 1 {
                    t - 1
                } else {
                    t + 2
                }
            } else if w == 0 {
                if t < dim {
                    t + 1
                } else {
                    t - 2
                }
            } else {
                t
            }
        }
        DayRule::LastDow(n) => wd == *n && d + 7 > dim,
        DayRule::Nth(n, k) => wd == *n && (d - 1) / 7 + 1 == *k,
    }
}
fn fmt(dt: DateTime<Utc>, tz: Tz) -> String {
    dt.with_timezone(&tz)
        .format("%Y-%m-%d %H:%M:%S")
        .to_string()
}
fn option_string(ctx: &RunContext<'_>, key: &str, fallback: &str) -> String {
    match ctx.options.get(key) {
        None | Some(Value::Null) => fallback.to_string(),
        Some(Value::String(v)) => v.trim().to_string(),
        Some(Value::Number(v)) => v.to_string(),
        Some(Value::Bool(v)) => v.to_string(),
        Some(Value::Array(v)) => v.iter().map(js_string).collect::<Vec<_>>().join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}
fn option_number(ctx: &RunContext<'_>, key: &str, fallback: f64) -> f64 {
    match ctx.options.get(key) {
        None => fallback,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(v)) => {
            if *v {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::Number(v)) => v.as_f64().unwrap_or(fallback),
        Some(Value::String(v)) if v.trim().is_empty() => 0.0,
        Some(Value::String(v)) => v
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|n| n.is_finite())
            .unwrap_or(fallback),
        Some(Value::Array(v)) if v.is_empty() => 0.0,
        Some(Value::Array(v)) if v.len() == 1 => {
            let item = js_string(&v[0]);
            if item.trim().is_empty() {
                0.0
            } else {
                item.trim()
                    .parse::<f64>()
                    .ok()
                    .filter(|n| n.is_finite())
                    .unwrap_or(fallback)
            }
        }
        Some(Value::Array(_)) | Some(Value::Object(_)) => fallback,
    }
}
fn option_bool(ctx: &RunContext<'_>, key: &str, fallback: bool) -> bool {
    match ctx.options.get(key) {
        None => fallback,
        Some(Value::Bool(v)) => *v,
        Some(Value::Number(v)) => v.as_f64() == Some(1.0),
        Some(Value::String(v)) => v == "true" || v == "1",
        _ => false,
    }
}
fn run_cron(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let expr_owned = option_string(ctx, "expression", "");
    let expr = expr_owned.trim();
    if expr.is_empty() {
        return Err(bad(if is_en(ctx) {
            format!("expression (cron expression) is required. Example: {EXAMPLE}, */15 8-18 * * 1-5, 0 0 L * *.")
        } else {
            format!("expression（cron 表达式）不能为空。示例：{EXAMPLE}、*/15 8-18 * * 1-5、0 0 L * *。")
        }));
    }
    let zone_owned = option_string(ctx, "timezone", "Asia/Shanghai");
    let zone_raw = zone_owned.trim();
    let zone_name = if zone_raw.is_empty() {
        "Asia/Shanghai"
    } else {
        zone_raw
    };
    let tz = Tz::from_str(zone_name).map_err(|_| {
        bad(if is_en(ctx) {
            format!("Time zone timezone=\"{zone_name}\" is invalid. Use an IANA time zone name, for example Asia/Shanghai, America/New_York, Europe/London, UTC.")
        } else {
            format!("时区 timezone=\"{zone_name}\" 无效。请使用 IANA 时区名称，例如 Asia/Shanghai、America/New_York、Europe/London、UTC。")
        })
    })?;
    let now = Utc::now();
    let count = option_number(ctx, "count", 5.0).round().clamp(1.0, 50.0) as usize;
    if expr.eq_ignore_ascii_case("@reboot") {
        return Ok(report::reboot(expr, zone_name, tz, now, is_en(ctx)));
    }
    let from_raw_value = option_string(ctx, "from", "now");
    let from_raw = if from_raw_value.trim().is_empty() {
        "now"
    } else {
        from_raw_value.as_str()
    };
    let from = if from_raw.trim() == "now" {
        now
    } else {
        parse_at(from_raw, tz)?
    };
    // UI locale wins; otherwise an explicit `locale` option selects English.
    let locale = if is_en(ctx)
        || option_string(ctx, "locale", "zh-CN")
            .to_ascii_lowercase()
            .starts_with("en")
    {
        "en-US"
    } else {
        "zh-CN"
    };
    let (plan, canonical) = parse(expr, locale)?;
    let mut hits = Vec::<DateTime<Utc>>::new();
    let start = from + Duration::milliseconds(1);
    let mut date = start.with_timezone(&tz).date_naive();
    let end = date
        .checked_add_months(chrono::Months::new(96))
        .unwrap_or(date);
    let mut skipped = Vec::new();
    while date <= end && hits.len() < count {
        if plan.month.contains(&date.month()) {
            let dom_all = matches!(plan.dom, DayRule::All);
            let dow_all = matches!(plan.dow, DayRule::All);
            let dm = matches_day(&plan.dom, date, true);
            let dw = matches_day(&plan.dow, date, false);
            let day_ok = if dom_all {
                dw
            } else if dow_all {
                dm
            } else {
                dm || dw
            };
            if day_ok {
                for h in &plan.hour {
                    for m in &plan.min {
                        for s in &plan.sec {
                            let naive = NaiveDateTime::new(
                                date,
                                NaiveTime::from_hms_opt(*h, *m, *s).unwrap(),
                            );
                            let result = tz.from_local_datetime(&naive);
                            let candidates: Vec<_> = match result {
                                chrono::LocalResult::Single(v) => vec![v],
                                chrono::LocalResult::Ambiguous(a, _) => vec![a],
                                chrono::LocalResult::None => {
                                    if skipped.len() < 8 {
                                        skipped.push(naive.format("%Y-%m-%d %H:%M:%S").to_string());
                                    }
                                    vec![]
                                }
                            };
                            for dt in candidates {
                                let utc = dt.with_timezone(&Utc);
                                if utc > from && hits.last().map(|p| utc > *p).unwrap_or(true) {
                                    hits.push(utc);
                                    if hits.len() >= count {
                                        break;
                                    }
                                }
                            }
                            if hits.len() >= count {
                                break;
                            }
                        }
                        if hits.len() >= count {
                            break;
                        }
                    }
                    if hits.len() >= count {
                        break;
                    }
                }
            }
        }
        date = date
            .succ_opt()
            .ok_or_else(|| bad("Date out of range".into()))?;
    }
    if hits.is_empty() {
        return Err(bad(if locale == "en-US" {
            format!("The expression \"{expr}\" has no match within 8 years after {}. Check the day/month/weekday combination (for example, February 30 does not exist). Example: {EXAMPLE}.",fmt(from,tz))
        } else {
            format!("表达式“{expr}”在 {} 之后 8 年内没有匹配时间，请检查 日/月/星期 组合（例如 2 月 30 日不存在）。示例：{EXAMPLE}。",fmt(from,tz))
        }));
    }
    Ok(report::render(
        expr,
        &canonical,
        from_raw,
        zone_name,
        tz,
        from,
        &hits,
        &plan,
        count,
        option_bool(ctx, "showFieldValues", true),
        option_bool(ctx, "showCountdown", true),
        &skipped,
        locale,
    ))
}
pub(super) fn run(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    run_cron(ctx)
}
