use chrono::{Datelike, Local, Timelike};

const DEFAULT_PATTERN: &str = "{name}-{tool}";

pub struct NameContext<'a> {
    pub name: &'a str,
    pub tool: &'a str,
    pub index: Option<usize>,
    pub total: Option<usize>,
    pub range: Option<&'a str>,
}

pub fn safe_file_name(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|c| {
            if c.is_control() || "\\/:*?\"<>|".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned: String = cleaned.trim().chars().take(120).collect();
    if cleaned.is_empty() {
        "document".into()
    } else {
        cleaned
    }
}

pub fn base_name(file_name: &str) -> &str {
    let leaf = file_name.rsplit(['/', '\\']).next().unwrap_or(file_name);
    match leaf.rfind('.') {
        Some(dot) if dot > 0 => &leaf[..dot],
        _ => leaf,
    }
}

pub fn extension_of(file_name: &str) -> &str {
    let leaf = file_name.rsplit(['/', '\\']).next().unwrap_or(file_name);
    match leaf.rfind('.') {
        Some(dot) if dot > 0 => &leaf[dot + 1..],
        _ => "",
    }
}

pub fn render_name(pattern: Option<&str>, ctx: NameContext<'_>, ext: &str) -> String {
    let pattern = pattern
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(DEFAULT_PATTERN)
        .trim();
    let index = ctx.index.unwrap_or(1);
    let now = Local::now();
    let rendered = pattern
        .replace("{name}", ctx.name)
        .replace("{tool}", ctx.tool)
        .replace("{index}", &index.to_string())
        .replace("{i}", &format!("{index:02}"))
        .replace("{total}", &ctx.total.unwrap_or(1).to_string())
        .replace("{range}", ctx.range.unwrap_or(""))
        .replace(
            "{date}",
            &format!("{:04}{:02}{:02}", now.year(), now.month(), now.day()),
        )
        .replace(
            "{time}",
            &format!("{:02}{:02}{:02}", now.hour(), now.minute(), now.second()),
        );
    let collapsed = collapse_separators(&rendered);
    format!(
        "{}.{}",
        safe_file_name(if collapsed.is_empty() {
            ctx.name
        } else {
            &collapsed
        }),
        ext
    )
}

fn collapse_separators(value: &str) -> String {
    let mut out = String::new();
    let mut run = String::new();
    for character in value.chars().chain(std::iter::once('\0')) {
        if "-_.".contains(character) {
            run.push(character);
            continue;
        }
        if run.len() > 1 {
            out.push('-');
        } else {
            out.push_str(&run);
        }
        run.clear();
        if character != '\0' {
            out.push(character);
        }
    }
    out.trim_matches(['-', '_', '.']).to_owned()
}

pub fn dedupe(name: String, taken: impl Fn(&str) -> bool) -> String {
    if !taken(&name) {
        return name;
    }
    let dot = name.rfind('.').filter(|dot| *dot > 0).unwrap_or(name.len());
    let (stem, ext) = name.split_at(dot);
    let mut counter = 2;
    loop {
        let candidate = format!("{stem} ({counter}){ext}");
        if !taken(&candidate) {
            return candidate;
        }
        counter += 1;
    }
}
