//! Locale catalog for the encoding tools, mirroring the product engine's
//! `enc.*` messages (zh-CN entries use the `·` bullet, en entries use `-`).

use crate::RunContext;

pub(super) fn is_en(ctx: &RunContext<'_>) -> bool {
    ctx.locale.starts_with("en")
}

/// Anywhere the engine falls back to the section bullet, zh lines start with
/// "· " and en lines with "- "; the catalog strings already carry the bullet.
pub(super) fn t(en: bool, zh: &'static str, english: &'static str) -> &'static str {
    if en {
        english
    } else {
        zh
    }
}

pub(super) fn group_digits(value: usize) -> String {
    let digits = value.to_string();
    let mut out = String::new();
    let bytes = digits.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if index > 0 && (bytes.len() - index) % 3 == 0 {
            out.push(',');
        }
        out.push(*byte as char);
    }
    out
}

pub(super) fn code_points(text: &str) -> usize {
    text.chars().count()
}

pub(super) fn spaced_hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(" ")
}

pub(super) fn preview(en: bool, text: &str, limit: usize) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let chars: Vec<char> = flat.chars().collect();
    if chars.len() <= limit {
        return if flat.is_empty() {
            t(en, "(空白)", "(blank)").to_string()
        } else {
            flat
        };
    }
    let head: String = chars.iter().take(limit).collect();
    if en {
        format!("{head}... ({} characters)", chars.len())
    } else {
        format!("{head}…（共 {} 字符）", chars.len())
    }
}

/// Label templates that take a count: the zh/en wording lives here.
pub(super) enum Tmpl {
    Bytes,
    Pieces,
}

pub(super) fn fill(en: bool, tmpl: Tmpl, count: usize) -> String {
    let count = group_digits(count);
    match tmpl {
        Tmpl::Bytes => {
            if en {
                format!("{count} bytes")
            } else {
                format!("{count} 字节")
            }
        }
        Tmpl::Pieces => {
            if en {
                count
            } else {
                format!("{count} 个")
            }
        }
    }
}
