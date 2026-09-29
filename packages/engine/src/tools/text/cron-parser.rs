use super::EngineError;
use std::collections::BTreeSet;

const EXAMPLE: &str = "0 9 * * 1-5";
#[derive(Clone)]
pub(super) enum DayRule {
    Values(BTreeSet<u32>),
    All,
    Last,
    LastWeekday,
    Nearest(u32),
    LastDow(u32),
    Nth(u32, u32),
}
pub(super) struct Plan {
    pub(super) sec: BTreeSet<u32>,
    pub(super) min: BTreeSet<u32>,
    pub(super) hour: BTreeSet<u32>,
    pub(super) month: BTreeSet<u32>,
    pub(super) dom: DayRule,
    pub(super) dow: DayRule,
    pub(super) seconds: bool,
}
fn err(message: String) -> EngineError {
    EngineError::new("bad_request", message)
}
fn en(locale: &str) -> bool {
    locale.starts_with("en")
}
fn field_name(key: &'static str, english: bool) -> &'static str {
    match (key, english) {
        ("second", true) => "Second",
        ("second", false) => "秒",
        ("minute", true) => "Minute",
        ("minute", false) => "分",
        ("hour", true) => "Hour",
        ("hour", false) => "时",
        ("day", true) => "Day",
        ("day", false) => "日",
        ("month", true) => "Month",
        ("month", false) => "月",
        ("weekday", true) => "Weekday",
        ("weekday", false) => "星期",
        _ => "field",
    }
}
fn field_error(
    locale: &str,
    expression: &str,
    label: &'static str,
    raw: &str,
    reason: &str,
) -> EngineError {
    let message = if en(locale) {
        format!("In the cron expression \"{expression}\" the {label} field \"{raw}\" is invalid: {reason}. Supported: * ? */n a-b a,b L W #. Example: {EXAMPLE}, */15 8-18 * * 1-5, 0 0 1 1 * 30 (with 6 fields the last one is seconds).")
    } else {
        format!("cron 表达式“{expression}”的{label}字段 \"{raw}\" 无效：{reason}。支持 * ? */n a-b a,b L W #，示例：{EXAMPLE}、*/15 8-18 * * 1-5、0 0 1 1 * 30（6 字段时末位为秒）。")
    };
    err(message)
}
fn reason(key: &str, locale: &str) -> &'static str {
    let e = en(locale);
    match (key, e) {
        ("empty", true) => "the field is empty",
        ("empty", false) => "字段为空",
        ("question", true) => "? is only allowed in the day or weekday field",
        ("question", false) => "? 只能用于“日”或“星期”字段",
        ("syntax", true) => "unrecognized notation",
        ("syntax", false) => "无法识别的写法",
        ("step", true) => "the step must be an integer of at least 1",
        ("step", false) => "步长需为不小于 1 的整数",
        ("integer", true) => "only integers are allowed",
        ("integer", false) => "只能使用整数",
        ("order", true) => "the interval start must not exceed its end",
        ("order", false) => "区间起点需不大于终点",
        ("none", true) => "no usable values",
        ("none", false) => "没有可用取值",
        ("mixed", true) => "L/W/# cannot be combined with other values",
        ("mixed", false) => "L/W/# 写法不能与其它取值混用",
        ("nearest", true) => "the W notation must look like 15W (1-31)",
        ("nearest", false) => "W 写法需形如 15W（1~31）",
        ("dow", true) => "the weekday notation must be L, 5L or 5#3",
        ("dow", false) => "星期写法应为 L、5L 或 5#3",
        _ => "invalid field",
    }
}
fn number_token(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}
fn parse_field(
    raw: &str,
    lo: u32,
    hi: u32,
    label: &'static str,
    expression: &str,
    question: bool,
    locale: &str,
) -> Result<(BTreeSet<u32>, bool), EngineError> {
    let text = raw.trim();
    let name = field_name(label, en(locale));
    if text.is_empty() {
        return Err(field_error(
            locale,
            expression,
            name,
            text,
            reason("empty", locale),
        ));
    }
    if text == "*" || (question && text == "?") {
        return Ok(((lo..=hi).collect(), true));
    }
    if text == "?" {
        return Err(field_error(
            locale,
            expression,
            name,
            text,
            reason("question", locale),
        ));
    }
    let mut values = BTreeSet::new();
    for piece in text.split(',') {
        let token = piece.trim();
        let mut slash = token.split('/');
        let base = slash.next().unwrap_or("");
        let step_raw = slash.next();
        if slash.next().is_some() || token.is_empty() {
            return Err(field_error(
                locale,
                expression,
                name,
                token,
                reason("syntax", locale),
            ));
        }
        let step = if let Some(raw_step) = step_raw {
            if !number_token(raw_step) {
                return Err(field_error(
                    locale,
                    expression,
                    name,
                    token,
                    reason("syntax", locale),
                ));
            }
            let Some(n) = raw_step.parse::<u32>().ok() else {
                return Err(field_error(
                    locale,
                    expression,
                    name,
                    token,
                    reason("step", locale),
                ));
            };
            if n < 1 {
                return Err(field_error(
                    locale,
                    expression,
                    name,
                    token,
                    reason("step", locale),
                ));
            }
            n
        } else {
            1
        };
        let (a, b) = if base == "*" {
            (lo, hi)
        } else if let Some((left, right)) = base.split_once('-') {
            if !number_token(left) || !number_token(right) {
                return Err(field_error(
                    locale,
                    expression,
                    name,
                    token,
                    reason("syntax", locale),
                ));
            }
            let (Some(a), Some(b)) = (left.parse::<u32>().ok(), right.parse::<u32>().ok()) else {
                return Err(field_error(
                    locale,
                    expression,
                    name,
                    token,
                    reason("integer", locale),
                ));
            };
            (a, b)
        } else {
            if !number_token(base) {
                return Err(field_error(
                    locale,
                    expression,
                    name,
                    token,
                    reason("syntax", locale),
                ));
            }
            let Some(a) = base.parse::<u32>().ok() else {
                return Err(field_error(
                    locale,
                    expression,
                    name,
                    token,
                    reason("integer", locale),
                ));
            };
            (a, if step_raw.is_some() { hi } else { a })
        };
        if a < lo || a > hi || b < lo || b > hi {
            let why = if en(locale) {
                format!("values must be between {lo} and {hi}")
            } else {
                format!("取值需在 {lo}~{hi} 之间")
            };
            return Err(field_error(locale, expression, name, token, &why));
        }
        if b < a {
            return Err(field_error(
                locale,
                expression,
                name,
                token,
                reason("order", locale),
            ));
        }
        let mut n = a;
        while n <= b {
            values.insert(n);
            match n.checked_add(step) {
                Some(next) => n = next,
                None => break,
            }
        }
    }
    if values.is_empty() {
        return Err(field_error(
            locale,
            expression,
            name,
            text,
            reason("none", locale),
        ));
    }
    Ok((values, false))
}
fn parse_day(raw: &str, dom: bool, expr: &str, locale: &str) -> Result<DayRule, EngineError> {
    let text = raw.trim();
    let upper = text.to_ascii_uppercase();
    if text == "*" || text == "?" {
        return Ok(DayRule::All);
    }
    let label = field_name(if dom { "day" } else { "weekday" }, en(locale));
    if upper.chars().any(|c| matches!(c, 'L' | 'W' | '#')) {
        if text.contains(',') {
            return Err(field_error(
                locale,
                expr,
                label,
                text,
                reason("mixed", locale),
            ));
        }
        if dom {
            if upper == "L" {
                return Ok(DayRule::Last);
            }
            if upper == "LW" {
                return Ok(DayRule::LastWeekday);
            }
            if let Some(n) = upper.strip_suffix('W') {
                if !number_token(n) {
                    return Err(field_error(
                        locale,
                        expr,
                        label,
                        text,
                        reason("nearest", locale),
                    ));
                }
                let Some(day) = n.parse::<u32>().ok() else {
                    return Err(field_error(
                        locale,
                        expr,
                        label,
                        text,
                        reason("nearest", locale),
                    ));
                };
                if !(1..=31).contains(&day) {
                    return Err(field_error(
                        locale,
                        expr,
                        label,
                        text,
                        reason("nearest", locale),
                    ));
                }
                return Ok(DayRule::Nearest(day));
            }
            return Err(field_error(
                locale,
                expr,
                label,
                text,
                reason("nearest", locale),
            ));
        }
        if upper == "L" {
            return Ok(DayRule::LastDow(6));
        }
        if let Some(dow) = upper.strip_suffix('L') {
            if number_token(dow) {
                if let Ok(d) = dow.parse::<u32>() {
                    if d <= 7 {
                        return Ok(DayRule::LastDow(d % 7));
                    }
                }
            }
            return Err(field_error(
                locale,
                expr,
                label,
                text,
                reason("dow", locale),
            ));
        }
        if let Some((d, n)) = upper.split_once('#') {
            if number_token(d) && number_token(n) {
                if let (Ok(d), Ok(n)) = (d.parse::<u32>(), n.parse::<u32>()) {
                    if d <= 7 && (1..=5).contains(&n) {
                        return Ok(DayRule::Nth(d % 7, n));
                    }
                }
            }
            return Err(field_error(
                locale,
                expr,
                label,
                text,
                reason("dow", locale),
            ));
        }
        return Err(field_error(
            locale,
            expr,
            label,
            text,
            reason("dow", locale),
        ));
    }
    let (mut values, all) = parse_field(
        text,
        if dom { 1 } else { 0 },
        if dom { 31 } else { 7 },
        if dom { "day" } else { "weekday" },
        expr,
        true,
        locale,
    )?;
    if !dom && values.remove(&7) {
        values.insert(0);
    }
    Ok(if all {
        DayRule::All
    } else {
        DayRule::Values(values)
    })
}
pub(super) fn parse(expr: &str, locale: &str) -> Result<(Plan, String), EngineError> {
    let key = expr.trim().to_ascii_lowercase();
    let macro_expr = match key.as_str() {
        "@yearly" | "@annually" => Some("0 0 1 1 *"),
        "@monthly" => Some("0 0 1 * *"),
        "@weekly" => Some("0 0 * * 0"),
        "@daily" => Some("0 0 * * *"),
        "@hourly" => Some("0 * * * *"),
        _ => None,
    };
    let canonical = macro_expr.unwrap_or(expr).to_string();
    let fields: Vec<_> = canonical.split_whitespace().collect();
    if fields.len() != 5 && fields.len() != 6 {
        let message = if en(locale) {
            format!("expression=\"{expr}\" needs 5 or 6 fields, found {}. Five fields: minute hour day month weekday; with six fields seconds are appended at the end. Example: {EXAMPLE}, */15 8-18 * * 1-5 30.",fields.len())
        } else {
            format!("expression=\"{expr}\" 需要 5 个或 6 个字段，当前为 {} 个。5 字段：分 时 日 月 周；6 字段时在末尾追加“秒”。示例：{EXAMPLE}、*/15 8-18 * * 1-5 30。",fields.len())
        };
        return Err(err(message));
    }
    let has_seconds = fields.len() == 6;
    let (sec, _) = if has_seconds {
        parse_field(fields[5], 0, 59, "second", &canonical, false, locale)?
    } else {
        (BTreeSet::from([0]), false)
    };
    let minute = parse_field(fields[0], 0, 59, "minute", &canonical, false, locale)?.0;
    let hour = parse_field(fields[1], 0, 23, "hour", &canonical, false, locale)?.0;
    let dom = parse_day(fields[2], true, &canonical, locale)?;
    let month = parse_field(fields[3], 1, 12, "month", &canonical, false, locale)?.0;
    let dow = parse_day(fields[4], false, &canonical, locale)?;
    Ok((
        Plan {
            sec,
            min: minute,
            hour,
            month,
            dom,
            dow,
            seconds: has_seconds,
        },
        canonical,
    ))
}
