//! Implementations for the amount text tool group.

use super::common::*;
use super::{EngineError, RunContext, ToolResult};

const DIGITS: [&str; 10] = ["零", "壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖"];
pub(super) fn int_upper(mut n: u128) -> Result<String, EngineError> {
    if n > 9_999_999_999_999_999 {
        return Err(err("Amount is outside the supported range"));
    }
    if n == 0 {
        return Ok("零".into());
    }
    let units = ["", "万", "亿", "兆"];
    let mut groups = Vec::new();
    while n > 0 {
        groups.push((n % 10_000) as u32);
        n /= 10_000;
    }
    let mut out = String::new();
    let mut skipped = false;
    for i in (0..groups.len()).rev() {
        let g = groups[i];
        if g == 0 {
            if !out.is_empty() && groups[..i].iter().any(|x| *x > 0) {
                skipped = true;
            }
            continue;
        }
        if !out.is_empty() && (skipped || g < 1000) && !out.ends_with("零") {
            out.push('零');
        }
        let ds = [g / 1000, (g / 100) % 10, (g / 10) % 10, g % 10];
        let us = ["仟", "佰", "拾", ""];
        let mut pending = false;
        for (j, d) in ds.iter().enumerate() {
            if *d == 0 {
                if !out.is_empty() && ds[j + 1..].iter().any(|x| *x > 0) {
                    pending = true;
                }
                continue;
            }
            if pending {
                out.push('零');
                pending = false;
            }
            out.push_str(DIGITS[*d as usize]);
            out.push_str(us[j]);
        }
        out.push_str(units[i]);
        skipped = false;
    }
    Ok(out)
}
pub(super) fn amount_upper(input: &str) -> Result<String, EngineError> {
    let cleaned = input
        .trim()
        .replace(['¥', '￥', ',', '，', ' '], "")
        .trim_start_matches("人民币")
        .to_string();
    let (neg, s) = if let Some(v) = cleaned.strip_prefix('-') {
        (true, v)
    } else if let Some(v) = cleaned.strip_prefix('+') {
        (false, v)
    } else {
        (false, cleaned.as_str())
    };
    let mut p = s.split('.');
    let whole = p.next().unwrap_or("");
    let frac = p.next().unwrap_or("");
    if p.next().is_some()
        || whole.is_empty()
        || !whole.chars().all(|c| c.is_ascii_digit())
        || !frac.chars().all(|c| c.is_ascii_digit())
        || frac.len() > 2
    {
        return Err(err("Invalid amount format"));
    }
    let n = whole
        .parse::<u128>()
        .map_err(|_| err("Amount is outside the supported range"))?;
    let mut out = int_upper(n)? + "元";
    let digits = format!("{frac:0<2}");
    let j = digits.as_bytes()[0] - b'0';
    let f = digits.as_bytes()[1] - b'0';
    if j == 0 && f == 0 {
        out.push('整')
    } else {
        if j > 0 {
            out.push_str(DIGITS[j as usize]);
            out.push('角');
        }
        if f > 0 {
            if j == 0 {
                out.push('零');
            }
            out.push_str(DIGITS[f as usize]);
            out.push('分');
        }
    }
    if neg {
        out.insert(0, '负');
    }
    Ok(out)
}

pub(super) fn amount_number(input: &str) -> Result<String, EngineError> {
    let s = input
        .trim()
        .trim_start_matches("人民币")
        .trim_start_matches(['¥', '￥'])
        .replace(' ', "");
    let (neg, s) = if let Some(v) = s.strip_prefix('负') {
        (true, v)
    } else if let Some(v) = s.strip_prefix('-') {
        (true, v)
    } else {
        (false, s.as_str())
    };
    let parts: Vec<_> = s.split(['元', '圆', '圓']).collect();
    if parts.len() > 2 {
        return Err(err("Invalid amount format"));
    }
    let int = parse_upper_integer(parts[0])?;
    if int > 999_999_999_999_999 {
        return Err(err("Amount is outside the supported range"));
    }
    let mut j = 0;
    let mut f = 0;
    let dec = parts.get(1).copied().unwrap_or("");
    let mut chars = dec.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '整' {
            continue;
        }
        if c == '零'
            && chars
                .peek()
                .is_some_and(|next| chinese_digit(*next).is_some())
        {
            continue;
        }
        if c == '角' {
            return Err(err("Invalid amount format"));
        }
        let d = chinese_digit(c).ok_or_else(|| err("Invalid amount format"))?;
        match chars.next() {
            Some('角') => j = d,
            Some('分') => f = d,
            None => return Err(err("Invalid amount format")),
            _ => return Err(err("Invalid amount format")),
        }
    }
    Ok(format!("{}{}.{j}{f}", if neg { "-" } else { "" }, int))
}
pub(super) fn chinese_digit(c: char) -> Option<u8> {
    match c {
        '零' | '〇' => Some(0),
        '壹' | '一' => Some(1),
        '贰' | '弍' | '二' => Some(2),
        '叁' | '參' | '三' => Some(3),
        '肆' | '四' => Some(4),
        '伍' | '五' => Some(5),
        '陆' | '陸' | '六' => Some(6),
        '柒' | '七' => Some(7),
        '捌' | '八' => Some(8),
        '玖' | '九' => Some(9),
        _ => None,
    }
}
pub(super) fn parse_upper_integer(s: &str) -> Result<u128, EngineError> {
    if s.is_empty() {
        return Ok(0);
    }
    let mut total = 0u128;
    let mut section = 0u128;
    let mut digit = 0u128;
    for c in s.chars() {
        if let Some(d) = chinese_digit(c) {
            digit = d as u128;
            continue;
        }
        let small = match c {
            '拾' | '十' => Some(10),
            '佰' | '百' => Some(100),
            '仟' | '千' => Some(1000),
            _ => None,
        };
        if let Some(unit) = small {
            if digit == 0 && unit != 10 {
                return Err(err("Invalid amount format"));
            }
            section += (if digit == 0 { 1 } else { digit }) * unit;
            digit = 0;
            continue;
        }
        let large = match c {
            '万' | '萬' => Some(10_000),
            '亿' | '億' => Some(100_000_000),
            '兆' => Some(1_000_000_000_000),
            _ => None,
        }
        .ok_or_else(|| err("Invalid amount format"))?;
        section += digit;
        total += (if section == 0 { 1 } else { section }) * large;
        section = 0;
        digit = 0;
    }
    Ok(total + section + digit)
}
pub(super) fn run(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    run_amount(ctx)
}

pub(super) fn run_amount(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let input = string(ctx, "input", "").trim();
    if input.is_empty() {
        return Err(err(if is_en(ctx) {
            "Enter an amount to convert."
        } else {
            "请输入要转换的金额。"
        }));
    }
    let dir = string(ctx, "direction", "to-uppercase");
    let converted = (if dir == "to-number" {
        amount_number(input)
    } else {
        amount_upper(input)
    })
    .map_err(|error| {
        let range = error.message.contains("outside the supported range");
        err(match (is_en(ctx), range) {
            (true, true) => "The amount is outside the supported range. Up to 16 integer digits are supported.",
            (true, false) => "The amount format was not recognized. Enter an Arabic-number or Chinese uppercase amount for the selected direction.",
            (false, true) => "金额超出支持范围，整数部分最多支持 16 位。",
            (false, false) => "金额格式无法识别。请按所选方向输入阿拉伯数字金额或中文大写金额。",
        })
    })?;
    let label = if is_en(ctx) {
        if dir == "to-number" {
            "Numeric amount"
        } else {
            "Uppercase RMB amount"
        }
    } else if dir == "to-number" {
        "数字金额"
    } else {
        "人民币大写金额"
    };
    Ok(text_result(
        ctx,
        "amount-convert.txt",
        format!("{label}\n{converted}"),
        &[("direction", dir.into()), ("output", converted)],
    ))
}
