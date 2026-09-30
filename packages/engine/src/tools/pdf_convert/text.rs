//! Shared JS text/regex semantics for the PDF conversions: `String.trim`
//! under JavaScript `\s`, the CJK boundary test and the bullet/numbered list
//! patterns, copied exactly from `tools/pdf-text-export-browser.ts`.

use regex::Regex;
use std::sync::OnceLock;

/// The TS `isCjk` ranges, copied exactly from pdf-text-export-browser.ts.
pub(super) fn is_cjk(char: char) -> bool {
    let code = char as u32;
    (0x3000..=0x30ff).contains(&code)
        || (0x3400..=0x9fff).contains(&code)
        || (0xac00..=0xd7af).contains(&code)
        || (0xff00..=0xff60).contains(&code)
}

/// JavaScript `\s` (used by the TS regexes and `String.prototype.trim`): adds
/// U+FEFF and drops U+0085 relative to Rust's `char::is_whitespace`.
pub(super) fn is_js_space(char: char) -> bool {
    matches!(
        char,
        '\u{09}'..='\u{0d}'
            | '\u{20}'
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// `String.prototype.trim` under JS `\s` semantics.
pub(super) fn js_trim(value: &str) -> String {
    value.trim_matches(is_js_space).to_owned()
}

/// JS `String.prototype.slice(0, units)`: UTF-16 code unit truncation.
pub(super) fn utf16_slice(text: &str, units: usize) -> String {
    let mut out = String::new();
    let mut used = 0usize;
    for character in text.chars() {
        let width = character.len_utf16();
        if used + width > units {
            break;
        }
        out.push(character);
        used += width;
    }
    out
}

/// JS `\s` as a regex class; the `regex` crate's own `\s` is
/// `\p{White_Space}`, a slightly different set, so the ported patterns spell
/// the class out to keep TS `u`-flag semantics.
const WS: &str =
    r"[\t\n\v\f\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";

/// `/^\s*([•·▪◦‣*o●-]|\((\d{1,3})\)|(\d{1,3}[.)])|([一二三四五六七八九十]+[、.]))\s+/u`
pub(super) fn bullet_regex() -> &'static Regex {
    static BULLET: OnceLock<Regex> = OnceLock::new();
    BULLET
        .get_or_init(|| {
            Regex::new(&format!(
                r"^{ws}*(?:[•·▪◦‣*o●-]|\([0-9]{{1,3}}\)|[0-9]{{1,3}}[.)]|[一二三四五六七八九十]+[、.]){ws}+",
                ws = WS
            ))
            .expect("bullet pattern is valid")
        })
}

/// `/^\s*(\((\d{1,3})\)|(\d{1,3}[.)])|([一二三四五六七八九十]+[、.]))\s+/u`
pub(super) fn numbered_regex() -> &'static Regex {
    static NUMBERED: OnceLock<Regex> = OnceLock::new();
    NUMBERED.get_or_init(|| {
        Regex::new(&format!(
            r"^{ws}*(?:\([0-9]{{1,3}}\)|[0-9]{{1,3}}[.)]|[一二三四五六七八九十]+[、.]){ws}+",
            ws = WS
        ))
        .expect("numbered pattern is valid")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_trim_matches_js_whitespace() {
        assert_eq!(js_trim("\u{feff}hi\u{a0}"), "hi");
        assert_eq!(js_trim("  x  "), "x");
    }

    #[test]
    fn bullet_patterns_match_ts_lists() {
        assert!(bullet_regex().is_match("1. first"));
        assert!(bullet_regex().is_match("• 点"));
        assert!(!bullet_regex().is_match("plain"));
        assert!(numbered_regex().is_match("(2) x"));
        assert!(!numbered_regex().is_match("- x"));
    }
}
