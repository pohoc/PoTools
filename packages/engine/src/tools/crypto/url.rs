use super::hash::bad;
use super::EngineError;
pub(super) fn percent_encode(s: &str, component: bool, form: bool) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric()
            || b"-_.!~*'()".contains(&b)
            || (!component && b";/?:@&=+$,#".contains(&b))
        {
            o.push(b as char)
        } else if form && b == b' ' {
            o.push('+')
        } else {
            o.push_str(&format!("%{b:02X}"))
        }
    }
    o
}
pub(super) fn percent_decode(s: &str, component: bool, form: bool) -> Result<String, EngineError> {
    let bytes = s.as_bytes();
    let mut out = String::new();
    let mut pending = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err(bad("input", "incomplete percent escape"));
            }
            let h = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap();
            let value =
                u8::from_str_radix(h, 16).map_err(|_| bad("input", "invalid percent escape"))?;
            if !component && b";/?:@&=+$,#".contains(&value) {
                if !pending.is_empty() {
                    out.push_str(
                        &String::from_utf8(std::mem::take(&mut pending))
                            .map_err(|_| bad("input", "percent bytes are not UTF-8"))?,
                    )
                }
                out.push_str(&s[i..i + 3]);
            } else {
                pending.push(value)
            }
            i += 3;
        } else {
            if !pending.is_empty() {
                out.push_str(
                    &String::from_utf8(std::mem::take(&mut pending))
                        .map_err(|_| bad("input", "percent bytes are not UTF-8"))?,
                )
            }
            if form && bytes[i] == b'+' {
                out.push(' ');
                i += 1
            } else {
                let ch = s[i..].chars().next().unwrap();
                out.push(ch);
                i += ch.len_utf8()
            }
        }
    }
    if !pending.is_empty() {
        out.push_str(
            &String::from_utf8(pending)
                .map_err(|_| bad("input", "percent decoded bytes are not UTF-8"))?,
        )
    }
    Ok(out)
}
#[derive(Clone)]
pub(super) struct QueryPair {
    pub(super) key: String,
    pub(super) value: String,
    pub(super) has_value: bool,
}
pub(super) fn split_url(input: &str) -> (&str, &str, &str, bool, bool) {
    let (head, fragment, had_fragment) = if let Some((a, b)) = input.split_once('#') {
        (a, b, true)
    } else {
        (input, "", false)
    };
    if let Some((base, query)) = head.split_once('?') {
        (base, query, fragment, had_fragment, true)
    } else {
        (head, "", fragment, had_fragment, false)
    }
}
pub(super) fn parse_pairs(query: &str) -> Result<Vec<QueryPair>, EngineError> {
    query
        .split('&')
        .filter(|x| !x.is_empty())
        .map(|token| {
            let (k, v, has) = if let Some((k, v)) = token.split_once('=') {
                (k, v, true)
            } else {
                (token, "", false)
            };
            Ok(QueryPair {
                key: percent_decode(k, true, true)?,
                value: percent_decode(v, true, true)?,
                has_value: has,
            })
        })
        .collect()
}
pub(super) fn build_query(s: &str, component: bool) -> Result<String, EngineError> {
    let mut out = Vec::new();
    for line in s.lines().filter(|x| !x.trim().is_empty()) {
        let l = line.trim().trim_start_matches('?');
        let (k, v) = l.split_once('=').unwrap_or((l, ""));
        if k.is_empty() {
            return Err(bad("input", "query key cannot be empty"));
        }
        out.push(format!(
            "{}={}",
            percent_encode(k, true, false),
            build_value(v, component)
        ));
    }
    if out.is_empty() {
        return Err(bad("input", "provide query key=value lines"));
    }
    Ok(out.join("&"))
}

fn build_value(value: &str, component: bool) -> String {
    if component {
        return percent_encode(value, true, false);
    }
    percent_encode(value, false, false)
        .replace('&', "%26")
        .replace('=', "%3D")
        .replace('+', "%2B")
        .replace('#', "%23")
}
