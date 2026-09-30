use super::hash::{artifact, bad, boolean, number, required, string};
use super::{EngineError, RunContext, ToolResult};
use serde_json::json;
use std::collections::HashSet;

type RunResult = Result<Option<ToolResult>, EngineError>;

pub fn run(ctx: &RunContext<'_>) -> RunResult {
    if matches!(ctx.tool, "password-gen" | "password-strength" | "uuid-gen") {
        return password_tool(ctx).map(Some);
    }
    Ok(None)
}

fn password_strength(password: &str) -> (&'static str, u8, usize, Vec<&'static str>) {
    let length = password.chars().count();
    if password.is_empty() {
        return ("very-weak", 0, 0, vec!["length", "variety"]);
    }
    let lower = password.chars().any(|c| c.is_ascii_lowercase());
    let upper = password.chars().any(|c| c.is_ascii_uppercase());
    let digits = password.chars().any(|c| c.is_ascii_digit());
    let symbols = password.chars().any(|c| !c.is_alphanumeric());
    let unicode = !password.is_ascii();
    let classes = [lower, upper, digits, symbols, unicode]
        .iter()
        .filter(|x| **x)
        .count();
    let norm = password.to_lowercase();
    let common = [
        "password",
        "passw0rd",
        "admin",
        "welcome",
        "letmein",
        "qwerty",
        "iloveyou",
        "monkey",
        "dragon",
        "123456",
        "123456789",
        "abc123",
        "111111",
        "000000",
    ]
    .iter()
    .any(|p| norm.contains(p));
    let chars = password.chars().collect::<Vec<_>>();
    let repeated = (chars.len() > 1 && chars.iter().all(|c| *c == chars[0]))
        || password
            .chars()
            .collect::<Vec<_>>()
            .windows(4)
            .any(|w| w.iter().all(|c| *c == w[0]));
    let sequences = [
        "0123456789",
        "abcdefghijklmnopqrstuvwxyz",
        "qwertyuiop",
        "asdfghjkl",
        "zxcvbnm",
    ];
    let sequential = sequences.iter().any(|seq| {
        (4..=seq.len()).any(|n| {
            seq.as_bytes().windows(n).any(|w| {
                let p = String::from_utf8_lossy(w);
                norm.contains(p.as_ref()) || norm.contains(&p.chars().rev().collect::<String>())
            })
        })
    });
    let mut score = if length >= 20 {
        4
    } else if length >= 14 {
        3
    } else if length >= 10 {
        2
    } else if length >= 8 {
        1
    } else {
        0
    };
    if classes >= 4 && length >= 10 {
        score += 1
    }
    if classes == 1 {
        score -= 1
    }
    if common {
        score = 0
    } else if repeated || sequential {
        score = score.min(1)
    }
    score = score.clamp(0, 4);
    let mut tips = Vec::new();
    if length < 14 {
        tips.push("length")
    }
    if classes < 3 {
        tips.push("variety")
    }
    if common {
        tips.push("common")
    }
    if repeated || sequential {
        tips.push("repeated")
    };
    (
        ["very-weak", "weak", "fair", "strong", "very-strong"][score as usize],
        score as u8,
        length,
        tips,
    )
}

fn password_tool(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    match ctx.tool {
        "password-strength" => {
            let p = required(ctx, "password")?;
            let (level, score, length, tips) = password_strength(p);
            let text = format!(
                "Strength: {level}\nLength: {length}\nSuggestions: {}",
                if tips.is_empty() {
                    "none".into()
                } else {
                    tips.join(", ")
                }
            );
            let mut e = serde_json::Map::new();
            e.insert("level".into(), json!(level));
            e.insert("score".into(), json!(score));
            e.insert("length".into(), json!(length));
            Ok(artifact("password-strength.txt", text, e))
        }
        "password-gen" => {
            let length = number(ctx, "length", 20).clamp(4, 128) as usize;
            let count = number(ctx, "count", 5).clamp(1, 50) as usize;
            let classes = [
                ("upper", "ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
                ("lower", "abcdefghijklmnopqrstuvwxyz"),
                ("digits", "0123456789"),
                ("symbols", "!@#$%^&*()-_=+[]{};:,.<>?/~"),
            ];
            let exclude = string(ctx, "exclude", "")
                .replace("\r\n", "\n")
                .trim_end()
                .replace('\n', "");
            let excluded: HashSet<char> = exclude.chars().collect();
            let enabled: Vec<Vec<char>> = classes
                .iter()
                .filter(|(key, _)| boolean(ctx, key, true))
                .map(|(_, chars)| chars.chars().filter(|c| !excluded.contains(c)).collect())
                .filter(|v: &Vec<char>| !v.is_empty())
                .collect();
            if enabled.is_empty() {
                return Err(bad("character classes", "enable at least one class"));
            }
            let pool: Vec<char> = enabled.iter().flatten().copied().collect();
            let mut out = Vec::new();
            for _ in 0..count {
                let mut chars = Vec::new();
                if boolean(ctx, "ensureAll", true) && length >= enabled.len() {
                    for group in &enabled {
                        chars.push(random_char(group));
                    }
                }
                while chars.len() < length {
                    chars.push(random_char(&pool));
                }
                for i in (1..chars.len()).rev() {
                    let j = random_u32((i + 1) as u32) as usize;
                    chars.swap(i, j)
                }
                out.push(chars.into_iter().collect::<String>())
            }
            let mut e = serde_json::Map::new();
            e.insert("count".into(), json!(count));
            e.insert("length".into(), json!(length));
            let mut result = artifact("password-gen.txt", out.join("\n"), e);
            if boolean(ctx, "ensureAll", true) && length < enabled.len() {
                result.warnings.push(format!("Password length {length} is below the {} enabled character classes; not every class is guaranteed",enabled.len()))
            }
            if !exclude.is_empty() {
                result.warnings.push(format!(
                    "Excluded {} character(s): {}",
                    excluded.len(),
                    excluded.iter().collect::<String>()
                ))
            }
            Ok(result)
        }
        "uuid-gen" => {
            let version = match string(ctx, "version", "v4") {
                "v7" => "v7",
                "nil" => "nil",
                _ => "v4",
            };
            let count = number(ctx, "count", 5).clamp(1, 100) as usize;
            let format = string(ctx, "format", "lower");
            let no_hyphens = boolean(ctx, "noHyphens", false);
            let mut vals = Vec::new();
            for _ in 0..count {
                let raw = match version {
                    "nil" => "00000000-0000-0000-0000-000000000000".to_string(),
                    "v7" => uuid::Uuid::now_v7().to_string(),
                    _ => uuid::Uuid::new_v4().to_string(),
                };
                let mut shown = if no_hyphens {
                    raw.replace('-', "")
                } else {
                    raw.clone()
                };
                shown = match format {
                    "upper" => shown.to_ascii_uppercase(),
                    "braces" => format!("{{{shown}}}"),
                    "urn" => format!("urn:uuid:{shown}"),
                    _ => shown,
                };
                vals.push((raw, shown));
            }
            let text = vals
                .iter()
                .enumerate()
                .map(|(i, (_, s))| format!("{:>3}  {}", i + 1, s))
                .collect::<Vec<_>>()
                .join("\n");
            let mut e = serde_json::Map::new();
            e.insert("version".into(), json!(version));
            e.insert("count".into(), json!(count));
            e.insert("format".into(), json!(format));
            e.insert(
                "noHyphens".into(),
                json!(if no_hyphens { "on" } else { "off" }),
            );
            e.insert("first".into(), json!(vals[0].1));
            e.insert(
                "ordered".into(),
                json!(if version == "v7" { "yes" } else { "n/a" }),
            );
            Ok(artifact("uuid-gen.txt", text, e))
        }
        _ => unreachable!(),
    }
}
fn random_u32(max: u32) -> u32 {
    let range = u32::MAX - (u32::MAX % max);
    loop {
        let u = uuid::Uuid::new_v4();
        let sample = u32::from_be_bytes(u.as_bytes()[..4].try_into().unwrap());
        if sample < range {
            return sample % max;
        }
    }
}
fn random_char(chars: &[char]) -> char {
    chars[random_u32(chars.len() as u32) as usize]
}
