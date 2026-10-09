use super::shared::*;
use crate::{EngineError, RunContext, ToolResult};
use serde_json::json;

pub fn run(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    match ctx.tool {
        "binary-codec" => binary(ctx),
        "case-convert" => case_convert(ctx),
        "user-agent" => user_agent(ctx),
        "ipv4-convert" => ipv4_convert(ctx),
        "ipv4-subnet" => ipv4_subnet(ctx),
        "color-convert" => color(ctx),
        _ => Err(err("Unsupported developer text tool")),
    }
}
fn binary(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let source = required(ctx)?;
    let direction = string(ctx, "direction", "");
    let text = if direction == "binary-text" {
        let parts: Vec<_> = source
            .trim()
            .split(|c: char| c.is_whitespace() || c == ',')
            .filter(|s| !s.is_empty())
            .collect();
        if parts.is_empty()
            || parts
                .iter()
                .any(|p| p.len() != 8 || !p.bytes().all(|b| b == b'0' || b == b'1'))
        {
            return Err(error(ctx, "dev.error.binary"));
        }
        let bytes: Vec<u8> = parts
            .iter()
            .map(|p| u8::from_str_radix(p, 2).unwrap())
            .collect();
        String::from_utf8(bytes).map_err(|_| error(ctx, "dev.error.binaryUtf8"))?
    } else {
        source
            .as_bytes()
            .iter()
            .map(|b| format!("{b:08b}"))
            .collect::<Vec<_>>()
            .join(" ")
    };
    let chars = text.chars().count();
    Ok(output(
        "binary-conversion.txt",
        text,
        extra([
            (String::from("direction"), json!(direction)),
            (String::from("characters"), json!(chars)),
        ]),
    ))
}
fn words(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let chars = s.chars().peekable();
    for c in chars {
        if c.is_alphanumeric() {
            if c.is_uppercase()
                && !cur.is_empty()
                && cur
                    .chars()
                    .last()
                    .is_some_and(|p| p.is_lowercase() || p.is_ascii_digit())
            {
                out.push(std::mem::take(&mut cur));
            }
            cur.push(c);
        } else if !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        out.push(cur)
    }
    out
}
fn case_convert(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let source = required(ctx)?;
    let words = words(source);
    if words.is_empty() {
        return Err(error(ctx, "dev.error.empty"));
    }
    let lower: Vec<String> = words.iter().map(|w| w.to_lowercase()).collect();
    let cap = |s: &str| {
        let mut c = s.chars();
        c.next()
            .map(|x| x.to_uppercase().to_string() + c.as_str())
            .unwrap_or_default()
    };
    let style = string(ctx, "style", "");
    let output_style = if style.is_empty() { "camel" } else { style };
    let text = match output_style {
        "upper" => source.to_uppercase(),
        "lower" => source.to_lowercase(),
        "title" => lower.iter().map(|w| cap(w)).collect::<Vec<_>>().join(" "),
        "pascal" => lower.iter().map(|w| cap(w)).collect(),
        "snake" => lower.join("_"),
        "kebab" => lower.join("-"),
        _ => {
            lower.first().cloned().unwrap_or_default()
                + &lower.iter().skip(1).map(|w| cap(w)).collect::<String>()
        }
    };
    Ok(output(
        "converted-case.txt",
        text,
        extra([
            (String::from("style"), json!(style)),
            (String::from("words"), json!(words.len())),
        ]),
    ))
}
fn user_agent(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let ua = required(ctx)?.trim();
    let lower = ua.to_ascii_lowercase();
    let detect = |pat: &str, label: &str| -> Option<String> {
        let re = regexless_version(&lower, pat);
        re.map(|v| format!("{label} {v}"))
    };
    let browser = detect("edge", "Microsoft Edge")
        .or_else(|| detect("edga", "Microsoft Edge"))
        .or_else(|| detect("edgios", "Microsoft Edge"))
        .or_else(|| detect("edg", "Microsoft Edge"))
        .or_else(|| detect("opr", "Opera"))
        .or_else(|| detect("opera", "Opera"))
        .or_else(|| detect("firefox", "Firefox"))
        .or_else(|| detect("crios", "Chrome"))
        .or_else(|| detect("chrome", "Chrome"))
        .or_else(|| detect("version", "Safari").filter(|_| lower.contains("safari")))
        .unwrap_or_else(|| "Unknown".into());
    let os = if lower.contains("windows nt 10") {
        "Windows 10/11".into()
    } else if lower.contains("windows nt 6.1") {
        "Windows 7".into()
    } else if let Some(version) = version_token(&lower, "android ", '.') {
        format!("Android {version}")
    } else if ["iphone", "ipad", "ipod"].iter().any(|s| lower.contains(s)) {
        "iOS / iPadOS".into()
    } else if let Some(version) = version_token(&lower, "mac os x ", '_') {
        format!("macOS {}", version.replace('_', "."))
    } else if lower.contains("linux") {
        "Linux".into()
    } else {
        "Unknown".into()
    };
    let device = if lower.contains("ipad") {
        "Tablet"
    } else if lower.contains("mobile") || lower.contains("iphone") || lower.contains("android") {
        "Mobile"
    } else if ["windows", "macintosh", "x11", "linux"]
        .iter()
        .any(|s| lower.contains(s))
    {
        "Desktop"
    } else {
        "Unknown"
    };
    let text = format!(
        "{}: {browser}\n{}: {os}\n{}: {device}\n\n{}:\n{ua}",
        msg(ctx, "dev.ua.browser"),
        msg(ctx, "dev.ua.os"),
        msg(ctx, "dev.ua.device"),
        msg(ctx, "dev.ua.raw")
    );
    Ok(output(
        "user-agent.txt",
        text,
        extra([
            (String::from("browser"), json!(browser)),
            (String::from("os"), json!(os)),
            (String::from("device"), json!(device)),
        ]),
    ))
}
fn version_token<'a>(s: &'a str, token: &str, separator: char) -> Option<&'a str> {
    let after = s.split_once(token)?.1;
    let version = after
        .split(|c: char| !(c.is_ascii_digit() || c == separator))
        .next()?;
    if version.is_empty() || !version.bytes().any(|b| b.is_ascii_digit()) {
        None
    } else {
        Some(version)
    }
}
fn regexless_version(s: &str, token: &str) -> Option<String> {
    let after = s.split_once(token)?.1;
    let version = after.strip_prefix('/')?;
    let v: String = version
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}
fn ipv4_convert(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let source = required(ctx)?.trim();
    let n = ipv4(ctx, source)?;
    let h = format!("{n:08X}");
    let bits = (0..4)
        .rev()
        .map(|i| format!("{:08b}", (n >> (i * 8)) & 255))
        .collect::<Vec<_>>()
        .join(".");
    let text = format!(
        "{}: {source}\n{}: {n}\n{}: 0x{h}\n{}: {bits}",
        msg(ctx, "dev.ipv4.address"),
        msg(ctx, "dev.ipv4.decimal"),
        msg(ctx, "dev.ipv4.hex"),
        msg(ctx, "dev.ipv4.binary")
    );
    Ok(output(
        "ipv4-conversion.txt",
        text,
        extra([
            (String::from("decimal"), json!(n)),
            (String::from("hex"), json!(format!("{n:08x}"))),
        ]),
    ))
}
fn ipv4_subnet(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let raw = required(ctx)?.trim();
    let mut it = raw.split('/');
    let ip = ipv4(ctx, it.next().unwrap_or(""))?;
    let prefix = match it.next() {
        Some(p) => {
            let value = js_number(&json!(p)).ok_or_else(|| error(ctx, "dev.error.cidr"))?;
            if value.fract() != 0.0 || !(0.0..=32.0).contains(&value) {
                return Err(error(ctx, "dev.error.cidr"));
            }
            value as u32
        }
        None => 24,
    };
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    };
    let network = ip & mask;
    let broadcast = network | !mask;
    let count = if prefix == 32 {
        1u64
    } else if prefix == 31 {
        2
    } else {
        (1u64 << (32 - prefix)).saturating_sub(2)
    };
    let first = if prefix >= 31 { network } else { network + 1 };
    let last = if prefix >= 31 {
        broadcast
    } else {
        broadcast.saturating_sub(1)
    };
    let text = format!(
        "{}: {}/{}\n{}: {}\n{}: {}\n{}: {}\n{}: {} – {}\n{}: {}",
        msg(ctx, "dev.ipv4.input"),
        ipv4_text(ip),
        prefix,
        msg(ctx, "dev.ipv4.network"),
        ipv4_text(network),
        msg(ctx, "dev.ipv4.mask"),
        ipv4_text(mask),
        msg(ctx, "dev.ipv4.broadcast"),
        ipv4_text(broadcast),
        msg(ctx, "dev.ipv4.usable"),
        ipv4_text(first),
        ipv4_text(last),
        msg(ctx, "dev.ipv4.hostCount"),
        count
    );
    Ok(output(
        "ipv4-subnet.txt",
        text,
        extra([
            (String::from("prefix"), json!(prefix)),
            (String::from("network"), json!(ipv4_text(network))),
            (String::from("broadcast"), json!(ipv4_text(broadcast))),
            (String::from("hostCount"), json!(count)),
        ]),
    ))
}
fn color(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let input = required(ctx)?.trim();
    let (r, g, b) = if let Some(h) = input.strip_prefix('#') {
        if h.len() != 3 && h.len() != 6 {
            return Err(error(ctx, "dev.error.color"));
        }
        if !h.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err(error(ctx, "dev.error.color"));
        }
        let full = if h.len() == 3 {
            h.chars().flat_map(|c| [c, c]).collect::<String>()
        } else {
            h.to_string()
        };
        (
            u8::from_str_radix(&full[0..2], 16).unwrap(),
            u8::from_str_radix(&full[2..4], 16).unwrap(),
            u8::from_str_radix(&full[4..6], 16).unwrap(),
        )
    } else if input.len() == 3 || input.len() == 6 {
        if !input.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err(error(ctx, "dev.error.color"));
        }
        let full = if input.len() == 3 {
            input.chars().flat_map(|c| [c, c]).collect::<String>()
        } else {
            input.to_string()
        };
        (
            u8::from_str_radix(&full[0..2], 16).unwrap(),
            u8::from_str_radix(&full[2..4], 16).unwrap(),
            u8::from_str_radix(&full[4..6], 16).unwrap(),
        )
    } else if input.to_ascii_lowercase().starts_with("rgb(") && input.ends_with(')') {
        let v: Vec<u16> = input[4..input.len() - 1]
            .split(',')
            .map(|s| {
                let s = s.trim();
                if s.is_empty() || s.len() > 3 || !s.bytes().all(|b| b.is_ascii_digit()) {
                    999
                } else {
                    s.parse().unwrap_or(999)
                }
            })
            .collect();
        if v.len() != 3 || v.iter().any(|n| *n > 255) {
            return Err(error(ctx, "dev.error.color"));
        }
        (v[0] as u8, v[1] as u8, v[2] as u8)
    } else {
        return Err(error(ctx, "dev.error.color"));
    };
    let (rf, gf, bf) = (r as f64 / 255., g as f64 / 255., b as f64 / 255.);
    let max = rf.max(gf).max(bf);
    let min = rf.min(gf).min(bf);
    let d = max - min;
    let l = (max + min) / 2.;
    let s = if d == 0. {
        0.
    } else {
        d / (1. - (2. * l - 1.).abs())
    };
    let mut h = if d == 0. {
        0.
    } else if max == rf {
        ((gf - bf) / d) % 6.
    } else if max == gf {
        (bf - rf) / d + 2.
    } else {
        (rf - gf) / d + 4.
    };
    h *= 60.;
    if h < 0. {
        h += 360.
    }
    let (h, s, l) = (
        h.round() as u32,
        (s * 100.).round() as u32,
        (l * 100.).round() as u32,
    );
    let hex = format!("#{r:02X}{g:02X}{b:02X}");
    let text = format!("HEX: {hex}\nRGB: rgb({r}, {g}, {b})\nHSL: hsl({h}, {s}%, {l}%)");
    Ok(output(
        "color-values.txt",
        text,
        extra([
            (String::from("hex"), json!(hex)),
            (String::from("red"), json!(r)),
            (String::from("green"), json!(g)),
            (String::from("blue"), json!(b)),
        ]),
    ))
}
