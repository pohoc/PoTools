use super::shared::*;
use crate::{EngineError, RunContext, ToolResult};
use fancy_regex::{Captures, Error as RegexError, Regex, RegexBuilder, RuntimeError};
use serde_json::json;
use std::ops::Range;

const REGEX_BACKTRACK_LIMIT: usize = 100_000;
const REGEX_PATTERN_LIMIT: usize = 10_000;

pub fn run(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let pattern = string(ctx, "pattern", "");
    let source = required(ctx)?;
    let flags = string(ctx, "flags", "");
    let replace = string(ctx, "mode", "") == "replace";
    if pattern.is_empty() {
        return Err(error(ctx, "dev.error.regex"));
    }
    if source.encode_utf16().count() > 1_000_000 || pattern.len() > REGEX_PATTERN_LIMIT {
        return Err(error(ctx, "dev.error.tooLarge"));
    }
    validate_flags(ctx, flags)?;
    let mut builder = RegexBuilder::new(pattern);
    builder
        .case_insensitive(flags.contains('i'))
        .multi_line(flags.contains('m'))
        .dot_matches_new_line(flags.contains('s'))
        .backtrack_limit(REGEX_BACKTRACK_LIMIT);
    let regex = builder.build().map_err(|_| error(ctx, "dev.error.regex"))?;
    let replacement = string(ctx, "replacement", "");
    let (text, count) = if replace {
        let matches = collect_matches(
            &regex,
            source,
            flags.contains('y'),
            flags.contains('g'),
            usize::MAX,
        )
        .map_err(|error_value| runtime_error(ctx, error_value))?;
        (
            apply_replacements(source, replacement, &matches, flags.contains('g')),
            0,
        )
    } else {
        // The browser implementation always adds `g` in test mode.
        let matches = collect_matches(&regex, source, flags.contains('y'), true, 1000)
            .map_err(|error_value| runtime_error(ctx, error_value))?;
        let text = if matches.is_empty() {
            msg(ctx, "dev.regex.noMatches").to_string()
        } else {
            matches
                .iter()
                .enumerate()
                .map(|(index, matched)| format_match(source, matched, index + 1))
                .collect::<Vec<_>>()
                .join("\n")
        };
        let count = matches.len();
        (text, count)
    };
    Ok(output(
        "regex-result.txt",
        text,
        extra([
            (
                String::from("mode"),
                json!(if replace { "replace" } else { "test" }),
            ),
            (String::from("matches"), json!(count)),
        ]),
    ))
}

fn validate_flags(ctx: &RunContext<'_>, flags: &str) -> Result<(), EngineError> {
    let mut seen = [false; 8];
    for flag in flags.chars() {
        let index = match flag {
            'd' => 0,
            'g' => 1,
            'i' => 2,
            'm' => 3,
            's' => 4,
            'u' => 5,
            'y' => 6,
            'v' => 7,
            _ => return Err(error(ctx, "dev.error.regex")),
        };
        if seen[index]
            || (flag == 'u' && flags.contains('v'))
            || (flag == 'v' && flags.contains('u'))
        {
            return Err(error(ctx, "dev.error.regex"));
        }
        seen[index] = true;
    }
    Ok(())
}

fn runtime_error(ctx: &RunContext<'_>, error_value: RegexError) -> EngineError {
    match error_value {
        RegexError::RuntimeError(
            RuntimeError::BacktrackLimitExceeded | RuntimeError::StackOverflow,
        ) => error(ctx, "dev.error.regexTimeout"),
        _ => error(ctx, "dev.error.regex"),
    }
}

fn collect_matches(
    regex: &Regex,
    source: &str,
    sticky: bool,
    global: bool,
    limit: usize,
) -> Result<Vec<FoundMatch>, RegexError> {
    let mut matches = Vec::new();
    if sticky {
        let mut cursor = 0;
        while cursor <= source.len() && matches.len() < limit {
            let Some(captures) = regex.captures_from_pos(source, cursor)? else {
                break;
            };
            let Some(full_match) = captures.get(0) else {
                break;
            };
            if full_match.start() != cursor {
                break;
            }
            let end = full_match.end();
            matches.push(found_match(regex, &captures));
            if !global {
                break;
            }
            cursor = advance_string_index(source, end);
        }
    } else {
        for captures in regex.captures_iter(source).take(limit) {
            matches.push(found_match(regex, &captures?));
        }
    }
    Ok(matches)
}

#[derive(Clone)]
struct FoundMatch {
    range: Range<usize>,
    captures: Vec<Option<Range<usize>>>,
    named_groups: Vec<(String, Option<Range<usize>>)>,
}

fn found_match(regex: &Regex, captures: &Captures<'_, str>) -> FoundMatch {
    let groups = captures
        .iter()
        .map(|capture| capture.map(|value| value.range()))
        .collect::<Vec<_>>();
    let range = groups.first().and_then(Clone::clone).unwrap_or(0..0);
    let named_groups = regex
        .capture_names()
        .enumerate()
        .filter_map(|(index, name)| {
            name.map(|name| (name.to_owned(), groups.get(index).cloned().flatten()))
        })
        .collect();
    FoundMatch {
        range,
        captures: groups,
        named_groups,
    }
}

fn advance_string_index(source: &str, index: usize) -> usize {
    if index >= source.len() {
        return source.len().saturating_add(1);
    }
    index
        + source[index..]
            .chars()
            .next()
            .map(char::len_utf8)
            .unwrap_or(1)
}

fn format_match(source: &str, matched: &FoundMatch, ordinal: usize) -> String {
    let value = &source[matched.range.clone()];
    let index = source[..matched.range.start].encode_utf16().count();
    let groups = matched
        .captures
        .iter()
        .skip(1)
        .map(|capture| {
            capture
                .as_ref()
                .map(|range| json_quote(&source[range.clone()]))
                .unwrap_or_else(|| "undefined".into())
        })
        .collect::<Vec<_>>();
    format!(
        "{ordinal}. {} @ {index}{}",
        json_quote(value),
        if groups.is_empty() {
            String::new()
        } else {
            format!("  ({})", groups.join(", "))
        }
    )
}

fn json_quote(source: &str) -> String {
    serde_json::to_string(source).unwrap_or_else(|_| "\"\"".into())
}

fn apply_replacements(
    source: &str,
    replacement: &str,
    matches: &[FoundMatch],
    global: bool,
) -> String {
    let mut output = String::with_capacity(source.len());
    let mut last_end = 0;
    for matched in matches.iter().take(if global { usize::MAX } else { 1 }) {
        output.push_str(&source[last_end..matched.range.start]);
        expand_replacement(&mut output, source, replacement, matched);
        last_end = matched.range.end;
    }
    output.push_str(&source[last_end..]);
    output
}

fn expand_replacement(output: &mut String, source: &str, replacement: &str, matched: &FoundMatch) {
    let chars: Vec<char> = replacement.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] != '$' || index + 1 == chars.len() {
            output.push(chars[index]);
            index += 1;
            continue;
        }
        match chars[index + 1] {
            '$' => {
                output.push('$');
                index += 2;
            }
            '&' => {
                output.push_str(&source[matched.range.clone()]);
                index += 2;
            }
            '`' => {
                output.push_str(&source[..matched.range.start]);
                index += 2;
            }
            '\'' => {
                output.push_str(&source[matched.range.end..]);
                index += 2;
            }
            '<' => {
                if matched.named_groups.is_empty() {
                    output.push('$');
                    index += 1;
                } else if let Some(end) = chars[index + 2..].iter().position(|ch| *ch == '>') {
                    let name: String = chars[index + 2..index + 2 + end].iter().collect();
                    if let Some((_, Some(range))) = matched
                        .named_groups
                        .iter()
                        .find(|(group_name, _)| group_name == &name)
                    {
                        output.push_str(&source[range.clone()]);
                    }
                    index += end + 3;
                } else {
                    output.push('$');
                    index += 1;
                }
            }
            digit if digit.is_ascii_digit() => {
                let first = digit.to_digit(10).unwrap_or(0) as usize;
                if first == 0 {
                    output.push('$');
                    output.push('0');
                    index += 2;
                    continue;
                }
                let second = chars
                    .get(index + 2)
                    .and_then(|ch| ch.to_digit(10))
                    .map(|value| first * 10 + value as usize);
                let (group, consumed) = match second {
                    Some(group) if group > 0 && group < matched.captures.len() => (group, 3),
                    _ if first < matched.captures.len() => (first, 2),
                    _ => {
                        output.push('$');
                        output.push(digit);
                        index += 2;
                        continue;
                    }
                };
                if let Some(range) = &matched.captures[group] {
                    output.push_str(&source[range.clone()]);
                }
                index += consumed;
            }
            _ => {
                output.push('$');
                index += 1;
            }
        }
    }
}
