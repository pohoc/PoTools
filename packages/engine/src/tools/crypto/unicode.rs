use super::hash::bad;
use crate::EngineError;
use serde_json::Value;

pub(super) fn unknown_html_entities(s: &str) -> usize {
    const KNOWN: &[&str] = &[
        "amp", "lt", "gt", "quot", "apos", "nbsp", "excl", "pound", "yen", "sect", "copy", "reg",
        "deg", "plusmn", "middot", "times", "divide", "ndash", "mdash", "lsquo", "rsquo", "ldquo",
        "rdquo", "dagger", "bull", "hellip", "permil", "euro", "trade",
    ];
    let mut count = 0;
    let mut rest = s;
    while let Some(start) = rest.find('&') {
        rest = &rest[start + 1..];
        let Some(end) = rest.find(';') else { break };
        let body = &rest[..end];
        // Numeric references (`&#38;` / `&#x26;`) are excluded by `named`
        // itself, which requires an ASCII-alphabetic first byte.
        let named = body.len() >= 2
            && body.len() <= 32
            && body.as_bytes()[0].is_ascii_alphabetic()
            && body.bytes().all(|b| b.is_ascii_alphanumeric());
        if named && !KNOWN.contains(&body) {
            count += 1
        }
        rest = &rest[end + 1..];
    }
    count
}

pub(super) fn unicode_encode(s: &str, style: &str) -> String {
    match style {
        "json" => {
            let quoted = serde_json::to_string(s).unwrap_or_default();
            let mut out = String::new();
            for c in quoted.chars() {
                if c as u32 > 0x7e {
                    let mut pair = [0u16; 2];
                    for u in c.encode_utf16(&mut pair) {
                        out.push_str(&format!("\\u{u:04x}"));
                    }
                } else {
                    out.push(c);
                }
            }
            out
        }
        "html-numeric" => s
            .chars()
            .map(|c| {
                if !(0x20..=0x7e).contains(&(c as u32)) {
                    format!("&#{};", c as u32)
                } else {
                    c.to_string()
                }
            })
            .collect(),
        "html-entity" => s.chars().map(html_entity).collect(),
        _ => s
            .encode_utf16()
            .map(|u| {
                if (0x20..=0x7e).contains(&u) && u != 0x5c {
                    (u as u8 as char).to_string()
                } else {
                    format!("\\u{u:04x}")
                }
            })
            .collect(),
    }
}
pub(super) fn html_entity(c: char) -> String {
    let entity = match c {
        '&' => "&amp;",
        '<' => "&lt;",
        '>' => "&gt;",
        '"' => "&quot;",
        '\'' => "&apos;",
        '\u{a0}' => "&nbsp;",
        '\u{a1}' => "&excl;",
        '£' => "&pound;",
        '¥' => "&yen;",
        '§' => "&sect;",
        '©' => "&copy;",
        '®' => "&reg;",
        '°' => "&deg;",
        '±' => "&plusmn;",
        '·' => "&middot;",
        '×' => "&times;",
        '÷' => "&divide;",
        '–' => "&ndash;",
        '—' => "&mdash;",
        '‘' => "&lsquo;",
        '’' => "&rsquo;",
        '“' => "&ldquo;",
        '”' => "&rdquo;",
        '†' => "&dagger;",
        '•' => "&bull;",
        '…' => "&hellip;",
        '‰' => "&permil;",
        '€' => "&euro;",
        '™' => "&trade;",
        _ => {
            return if !(0x20..=0x7e).contains(&(c as u32)) {
                format!("&#{};", c as u32)
            } else {
                c.to_string()
            }
        }
    };
    entity.to_string()
}
pub(super) fn unicode_decode(s: &str, style: &str) -> Result<String, EngineError> {
    if style == "json" {
        let body = s.trim();
        if body.is_empty() {
            return Err(bad("input", "empty JSON escape input"));
        }
        let candidate = if body.starts_with('"') || body.starts_with('{') || body.starts_with('[') {
            body.to_string()
        } else {
            format!("\"{body}\"")
        };
        let value: Value =
            serde_json::from_str(&candidate).map_err(|e| bad("input", &e.to_string()))?;
        return if let Some(text) = value.as_str() {
            Ok(text.to_string())
        } else {
            serde_json::to_string_pretty(&value).map_err(|e| bad("input", &e.to_string()))
        };
    }
    if style.starts_with("html-") {
        let mut out = String::new();
        let mut rest = s;
        while let Some(start) = rest.find('&') {
            out.push_str(&rest[..start]);
            rest = &rest[start..];
            if let Some(end) = rest.find(';') {
                let token = &rest[..=end];
                let body = &rest[1..end];
                let decoded =
                    if let Some(n) = body.strip_prefix("#x").or_else(|| body.strip_prefix("#X")) {
                        if n.bytes().all(|b| b.is_ascii_hexdigit()) && !n.is_empty() {
                            let cp = u32::from_str_radix(n, 16).unwrap();
                            if cp == 0 || cp > 0x10ffff {
                                return Err(bad("input", "HTML entity code point is out of range"));
                            }
                            if (0xd800..=0xdfff).contains(&cp) {
                                return Err(bad("input", "HTML entity cannot contain a surrogate"));
                            }
                            char::from_u32(cp)
                        } else {
                            None
                        }
                    } else if let Some(n) = body.strip_prefix('#') {
                        if n.bytes().all(|b| b.is_ascii_digit()) && !n.is_empty() {
                            let cp = n.parse::<u32>().map_err(|_| {
                                bad("input", "HTML entity code point is out of range")
                            })?;
                            if cp == 0 || cp > 0x10ffff {
                                return Err(bad("input", "HTML entity code point is out of range"));
                            }
                            if (0xd800..=0xdfff).contains(&cp) {
                                return Err(bad("input", "HTML entity cannot contain a surrogate"));
                            }
                            char::from_u32(cp)
                        } else {
                            None
                        }
                    } else {
                        match body {
                            "amp" => Some('&'),
                            "lt" => Some('<'),
                            "gt" => Some('>'),
                            "quot" => Some('"'),
                            "apos" => Some('\''),
                            "nbsp" => Some('\u{a0}'),
                            "excl" => Some('\u{a1}'),
                            "pound" => Some('£'),
                            "yen" => Some('¥'),
                            "sect" => Some('§'),
                            "copy" => Some('©'),
                            "reg" => Some('®'),
                            "deg" => Some('°'),
                            "plusmn" => Some('±'),
                            "middot" => Some('·'),
                            "times" => Some('×'),
                            "divide" => Some('÷'),
                            "ndash" => Some('–'),
                            "mdash" => Some('—'),
                            "lsquo" => Some('‘'),
                            "rsquo" => Some('’'),
                            "ldquo" => Some('“'),
                            "rdquo" => Some('”'),
                            "dagger" => Some('†'),
                            "bull" => Some('•'),
                            "hellip" => Some('…'),
                            "permil" => Some('‰'),
                            "euro" => Some('€'),
                            "trade" => Some('™'),
                            _ => None,
                        }
                    };
                if let Some(c) = decoded {
                    out.push(c);
                } else {
                    out.push_str(token);
                }
                rest = &rest[end + 1..];
            } else {
                out.push('&');
                rest = &rest[1..];
            }
        }
        out.push_str(rest);
        return Ok(out);
    }
    let mut units = Vec::<u16>::new();
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c != '\\' {
            let mut pair = [0; 2];
            units.extend_from_slice(c.encode_utf16(&mut pair));
            continue;
        }
        match it.next() {
            Some('u') => {
                let h: String = it.by_ref().take(4).collect();
                if h.len() != 4 {
                    return Err(bad("input", "\\u requires four hex digits"));
                }
                units.push(
                    u16::from_str_radix(&h, 16).map_err(|_| bad("input", "invalid \\u escape"))?,
                );
            }
            Some('x') => {
                let h: String = it.by_ref().take(2).collect();
                if h.len() != 2 {
                    return Err(bad("input", "\\x requires two hex digits"));
                }
                units.push(
                    u8::from_str_radix(&h, 16).map_err(|_| bad("input", "invalid \\x escape"))?
                        as u16,
                )
            }
            Some('n') => units.push('\n' as u16),
            Some('r') => units.push('\r' as u16),
            Some('t') => units.push('\t' as u16),
            Some('b') => units.push(8),
            Some('f') => units.push(12),
            Some('"') => units.push('"' as u16),
            Some('\'') => units.push('\'' as u16),
            Some('\\') => units.push('\\' as u16),
            Some('/') => units.push('/' as u16),
            Some(c) => return Err(bad("input", &format!("unknown escape \\{c}"))),
            None => return Err(bad("input", "trailing backslash")),
        }
    }
    String::from_utf16(&units).map_err(|_| bad("input", "unpaired UTF-16 surrogate"))
}
