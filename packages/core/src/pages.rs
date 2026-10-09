//! Page range parsing shared by tool options and engine operations.

use std::fmt;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PageRangeError(pub String);

impl fmt::Display for PageRangeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for PageRangeError {}

pub fn parse_page_ranges(input: &str, page_count: usize) -> Result<Vec<usize>, PageRangeError> {
    let text = input.trim();
    if text.is_empty()
        || ["all", "*", "全部", "所有"]
            .iter()
            .any(|token| text.eq_ignore_ascii_case(token))
    {
        return Ok((1..=page_count).collect());
    }
    if text.eq_ignore_ascii_case("odd") || text == "奇数" {
        return Ok((1..=page_count).step_by(2).collect());
    }
    if text.eq_ignore_ascii_case("even") || text == "偶数" {
        return Ok((2..=page_count).step_by(2).collect());
    }
    let mut pages = Vec::new();
    for raw in text.split([',', ';', '，', '、']) {
        let token = raw.trim();
        if token.is_empty() {
            continue;
        }
        if let Some((left, right)) = token.split_once('-') {
            if right.contains('-') {
                return Err(PageRangeError(format!("invalid range: {token}")));
            }
            let from = parse_side(left, 1, page_count)?;
            let to = parse_side(right, page_count, page_count)?;
            if from > to {
                return Err(PageRangeError(format!("invalid range: {token}")));
            }
            pages.extend(from..=to);
        } else {
            let page = token
                .parse::<usize>()
                .map_err(|_| PageRangeError(format!("invalid page token: {token}")))?;
            if page == 0 || page > page_count {
                return Err(PageRangeError(format!(
                    "page {token} is out of range (1-{page_count})"
                )));
            }
            pages.push(page);
        }
    }
    if pages.is_empty() {
        return Err(PageRangeError("empty page range".into()));
    }
    Ok(pages)
}

fn parse_side(value: &str, fallback: usize, page_count: usize) -> Result<usize, PageRangeError> {
    if value.trim().is_empty() {
        return Ok(fallback);
    }
    let page = value
        .trim()
        .parse::<usize>()
        .map_err(|_| PageRangeError(format!("invalid page number: {}", value.trim())))?;
    if page == 0 {
        return Err(PageRangeError(format!(
            "invalid page number: {}",
            value.trim()
        )));
    }
    Ok(page.min(page_count))
}

pub fn format_page_ranges(pages: &[usize]) -> String {
    let mut sorted = pages.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    let mut parts = Vec::new();
    let mut iter = sorted.into_iter();
    let Some(mut start) = iter.next() else {
        return String::new();
    };
    let mut end = start;
    for page in iter {
        if page == end + 1 {
            end = page;
        } else {
            parts.push(if start == end {
                start.to_string()
            } else {
                format!("{start}-{end}")
            });
            start = page;
            end = page;
        }
    }
    parts.push(if start == end {
        start.to_string()
    } else {
        format!("{start}-{end}")
    });
    parts.join(",")
}

/// Validates page-range syntax without expanding ranges into page numbers.
pub fn is_valid_page_ranges(input: &str) -> bool {
    let text = input.trim();
    if text.is_empty()
        || ["all", "*", "全部", "所有", "odd", "even", "奇数", "偶数"]
            .iter()
            .any(|token| text.eq_ignore_ascii_case(token))
    {
        return true;
    }
    let mut has_token = false;
    for raw in text.split([',', ';', '，', '、']) {
        let token = raw.trim();
        if token.is_empty() {
            continue;
        }
        has_token = true;
        if let Some((left, right)) = token.split_once('-') {
            if right.contains('-') {
                return false;
            }
            let from = if left.trim().is_empty() {
                Some(Some(1))
            } else {
                left.trim()
                    .parse::<usize>()
                    .ok()
                    .filter(|value| *value > 0)
                    .map(Some)
            };
            let to = if right.trim().is_empty() {
                Some(None)
            } else {
                right
                    .trim()
                    .parse::<usize>()
                    .ok()
                    .filter(|value| *value > 0)
                    .map(Some)
            };
            let (Some(from), Some(to)) = (from, to) else {
                return false;
            };
            if let (Some(from), Some(to)) = (from, to) {
                if from > to {
                    return false;
                }
            }
        } else {
            match token.parse::<usize>() {
                Ok(page) if page > 0 => {}
                _ => return false,
            }
        }
    }
    has_token
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(input: &str, count: usize) -> Vec<usize> {
        parse_page_ranges(input, count).unwrap()
    }

    #[test]
    fn keywords_expand_to_selections() {
        assert_eq!(parse("all", 3), vec![1, 2, 3]);
        assert_eq!(parse("*", 3), vec![1, 2, 3]);
        assert_eq!(parse("全部", 3), vec![1, 2, 3]);
        assert_eq!(parse("ODD", 5), vec![1, 3, 5]);
        assert_eq!(parse("even", 5), vec![2, 4]);
        assert_eq!(parse("奇数", 4), vec![1, 3]);
        assert_eq!(parse("偶数", 4), vec![2, 4]);
    }

    #[test]
    fn tokens_lists_and_open_ranges() {
        assert_eq!(parse("1-3,5", 9), vec![1, 2, 3, 5]);
        assert_eq!(parse("2; 4，6、8", 9), vec![2, 4, 6, 8]);
        assert_eq!(parse("-3", 9), vec![1, 2, 3]);
        assert_eq!(parse("7-", 9), vec![7, 8, 9]);
        assert_eq!(parse("1,1,2", 9), vec![1, 1, 2]);
    }

    #[test]
    fn range_sides_clamp_to_document() {
        assert_eq!(parse("1-99", 4), vec![1, 2, 3, 4]);
        assert_eq!(parse("99-", 4), vec![4]);
    }

    #[test]
    fn invalid_inputs_error() {
        assert!(parse_page_ranges("0", 3).is_err());
        assert!(parse_page_ranges("4", 3).is_err());
        assert!(parse_page_ranges("3-1", 9).is_err());
        assert!(parse_page_ranges("1-2-3", 9).is_err());
        assert!(parse_page_ranges("x", 9).is_err());
        // Empty input is NOT an error: it expands to the full document.
        assert_eq!(parse("", 3), vec![1, 2, 3]);
    }

    #[test]
    fn format_collapses_runs_and_sorts() {
        assert_eq!(format_page_ranges(&[5, 1, 2, 3, 5]), "1-3,5");
        assert_eq!(format_page_ranges(&[7]), "7");
        assert_eq!(format_page_ranges(&[]), "");
    }

    #[test]
    fn syntax_validation_matches_parser_shapes() {
        assert!(is_valid_page_ranges(""));
        assert!(is_valid_page_ranges("all"));
        assert!(is_valid_page_ranges("1,3-5,"));
        assert!(!is_valid_page_ranges("1-2-3"));
        assert!(!is_valid_page_ranges("0"));
        assert!(!is_valid_page_ranges("3-1"));
        assert!(!is_valid_page_ranges("x"));
    }
}
