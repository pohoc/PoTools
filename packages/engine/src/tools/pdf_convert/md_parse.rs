//! Line-oriented Markdown reader and inline parser, ported exactly from
//! `lib/textfmt.ts` (`parseMarkdown` / `parseInline`): CRLF normalization,
//! fenced code toggles that fold into raw-newline paragraphs, ATX headings,
//! full-line images, bullets, quotes folded into paragraphs and `---`-style
//! page breaks. Inline marks (`**bold**`, `__bold__`, `*italic*`,
//! `` `code` ``, `[text](url)`) never nest, matching the TS alternation.

use super::text::{is_js_space, js_trim, utf16_slice};
use regex::Regex;
use std::sync::OnceLock;

/// One flow block with page fixed at 0 (the TS markdown reader's value).
#[derive(Clone, Debug)]
pub(crate) enum MdBlock {
    Heading {
        level: usize,
        text: String,
    },
    Paragraph {
        text: String,
    },
    List {
        ordered: bool,
        items: Vec<String>,
    },
    /// Full-line image: `![alt](src)`. `alt` completes the TS contract even
    /// though the typesetter consumes only `src`.
    Image {
        src: String,
        #[allow(dead_code)]
        alt: String,
    },
    PageBreak,
}

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub(crate) struct MdStyle {
    pub bold: bool,
    pub italic: bool,
    pub code: bool,
}

/// One inline run: literal text plus its style (link targets are dropped —
/// the TS typesetter draws `text` only).
#[derive(Clone, Debug)]
pub(crate) struct InlineRun {
    pub text: String,
    pub style: MdStyle,
}

pub(crate) struct MarkdownDoc {
    /// First H1 or the head of the first paragraph (the TS return value;
    /// the pdf runner itself only consumes `blocks`).
    #[allow(dead_code)]
    pub title: Option<String>,
    pub blocks: Vec<MdBlock>,
}

/// Ported `parseMarkdown`.
pub(crate) fn parse_markdown(source: &str) -> MarkdownDoc {
    let normalized = source.replace("\r\n", "\n").replace('\r', "\n");
    let mut blocks: Vec<MdBlock> = Vec::new();
    let mut title: Option<String> = None;
    let mut list: Option<(bool, Vec<String>)> = None;
    let mut paragraph: Vec<String> = Vec::new();
    let mut code: Option<Vec<String>> = None;

    let flush_paragraph =
        |paragraph: &mut Vec<String>, blocks: &mut Vec<MdBlock>, title: &mut Option<String>| {
            if paragraph.is_empty() {
                return;
            }
            let joined = js_trim(&paragraph.join(" "));
            paragraph.clear();
            if joined.is_empty() {
                return;
            }
            if title.is_none() {
                *title = Some(utf16_slice(&joined, 80));
            }
            blocks.push(MdBlock::Paragraph { text: joined });
        };
    let flush_list = |list: &mut Option<(bool, Vec<String>)>, blocks: &mut Vec<MdBlock>| {
        if let Some((ordered, items)) = list.take() {
            blocks.push(MdBlock::List { ordered, items });
        }
    };

    for raw in normalized.split('\n') {
        let line = raw.trim_end_matches(is_js_space);
        let trimmed = js_trim(line);
        if fence_regex().is_match(&trimmed) {
            if let Some(lines) = code.take() {
                blocks.push(MdBlock::Paragraph {
                    text: lines.join("\n"),
                });
            } else {
                flush_paragraph(&mut paragraph, &mut blocks, &mut title);
                flush_list(&mut list, &mut blocks);
                code = Some(Vec::new());
            }
            continue;
        }
        if let Some(lines) = code.as_mut() {
            lines.push(raw.to_owned());
            continue;
        }
        if trimmed.is_empty() {
            flush_paragraph(&mut paragraph, &mut blocks, &mut title);
            flush_list(&mut list, &mut blocks);
            continue;
        }
        if page_break_regex().is_match(&trimmed) {
            flush_paragraph(&mut paragraph, &mut blocks, &mut title);
            flush_list(&mut list, &mut blocks);
            blocks.push(MdBlock::PageBreak);
            continue;
        }
        if let Some(captures) = heading_regex().captures(line) {
            flush_paragraph(&mut paragraph, &mut blocks, &mut title);
            flush_list(&mut list, &mut blocks);
            let level = captures[1].len();
            let text_value = js_trim(&captures[2]);
            if level == 1 && title.is_none() {
                title = Some(text_value.clone());
            }
            blocks.push(MdBlock::Heading {
                level,
                text: text_value,
            });
            continue;
        }
        if let Some(captures) = image_regex().captures(&trimmed) {
            flush_paragraph(&mut paragraph, &mut blocks, &mut title);
            flush_list(&mut list, &mut blocks);
            blocks.push(MdBlock::Image {
                src: js_trim(&captures[2]),
                alt: captures[1].to_owned(),
            });
            continue;
        }
        if let Some(captures) = bullet_regex().captures(line) {
            flush_paragraph(&mut paragraph, &mut blocks, &mut title);
            let ordered = captures[1].starts_with(|c: char| c.is_ascii_digit());
            if list.as_ref().map(|(seen, _)| *seen) != Some(ordered) {
                flush_list(&mut list, &mut blocks);
                list = Some((ordered, Vec::new()));
            }
            if let Some((_, items)) = list.as_mut() {
                items.push(js_trim(&captures[2]));
            }
            continue;
        }
        if let Some(captures) = quote_regex().captures(line) {
            flush_list(&mut list, &mut blocks);
            paragraph.push(js_trim(&captures[1]));
            continue;
        }
        flush_list(&mut list, &mut blocks);
        paragraph.push(js_trim(line));
    }
    flush_paragraph(&mut paragraph, &mut blocks, &mut title);
    flush_list(&mut list, &mut blocks);
    if let Some(lines) = code {
        blocks.push(MdBlock::Paragraph {
            text: lines.join("\n"),
        });
    }
    MarkdownDoc { title, blocks }
}

/// Ported `parseInline`: `**bold**` / `__bold__` / `*italic*` / `` `code` `` /
/// `[text](url)`, no nesting.
pub(crate) fn parse_inline(value: &str) -> Vec<InlineRun> {
    let mut out: Vec<InlineRun> = Vec::new();
    let mut cursor = 0usize;
    for captures in inline_regex().captures_iter(value) {
        let whole = captures.get(0).expect("group 0");
        if whole.start() > cursor {
            out.push(run_of(&value[cursor..whole.start()], MdStyle::default()));
        }
        if let Some(text) = captures.get(2).or_else(|| captures.get(4)) {
            out.push(run_of(
                text.as_str(),
                MdStyle {
                    bold: true,
                    ..MdStyle::default()
                },
            ));
        } else if let Some(text) = captures.get(6) {
            out.push(run_of(
                text.as_str(),
                MdStyle {
                    italic: true,
                    ..MdStyle::default()
                },
            ));
        } else if let Some(text) = captures.get(8) {
            out.push(run_of(
                text.as_str(),
                MdStyle {
                    code: true,
                    ..MdStyle::default()
                },
            ));
        } else if let Some(text) = captures.get(10) {
            // Links draw their label text without styling.
            out.push(run_of(text.as_str(), MdStyle::default()));
        }
        cursor = whole.end();
    }
    if cursor < value.len() {
        out.push(run_of(&value[cursor..], MdStyle::default()));
    }
    if out.is_empty() {
        out.push(run_of(value, MdStyle::default()));
    }
    out
}

fn run_of(text: &str, style: MdStyle) -> InlineRun {
    InlineRun {
        text: text.to_owned(),
        style,
    }
}

/// JS `\s` as a regex class (the `regex` crate's `\s` differs).
const WS: &str =
    r"[\t\n\v\f\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";

fn fence_regex() -> &'static Regex {
    static FENCE: OnceLock<Regex> = OnceLock::new();
    FENCE.get_or_init(|| Regex::new(r"^```([0-9A-Za-z_]*)$").expect("fence pattern is valid"))
}

fn page_break_regex() -> &'static Regex {
    static RULE: OnceLock<Regex> = OnceLock::new();
    RULE.get_or_init(|| {
        Regex::new(&format!(r"^(-{{3,}}|\*{{3,}}|_{{3,}}){ws}*$", ws = WS))
            .expect("page break pattern is valid")
    })
}

fn heading_regex() -> &'static Regex {
    static HEADING: OnceLock<Regex> = OnceLock::new();
    HEADING.get_or_init(|| {
        Regex::new(&format!(r"^(#{{1,6}}){ws}+(.*)$", ws = WS)).expect("heading pattern is valid")
    })
}

fn image_regex() -> &'static Regex {
    static IMAGE: OnceLock<Regex> = OnceLock::new();
    IMAGE.get_or_init(|| {
        Regex::new(&format!(r"^!\[([^\]]*)\]\(([^)]+)\){ws}*$", ws = WS))
            .expect("image pattern is valid")
    })
}

fn bullet_regex() -> &'static Regex {
    static BULLET: OnceLock<Regex> = OnceLock::new();
    BULLET.get_or_init(|| {
        Regex::new(&format!(
            r"^{ws}*([-*+\u{{2022}}]|[0-9]+[.)]){ws}+(.*)$",
            ws = WS
        ))
        .expect("bullet pattern is valid")
    })
}

fn quote_regex() -> &'static Regex {
    static QUOTE: OnceLock<Regex> = OnceLock::new();
    QUOTE.get_or_init(|| {
        Regex::new(&format!(r"^>{ws}?(.*)$", ws = WS)).expect("quote pattern is valid")
    })
}

fn inline_regex() -> &'static Regex {
    static INLINE: OnceLock<Regex> = OnceLock::new();
    INLINE.get_or_init(|| {
        Regex::new(
            r"(\*\*([^*]+)\*\*)|(__([^_]+)__)|(\*([^*]+)\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))",
        )
        .expect("inline pattern is valid")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_headings_lists_code_and_images() {
        let doc = parse_markdown("# 标题\r\n\r\n正文 **加粗** 和 `code`。\r\n- 项目一\r\n- 项目二\r\n\r\n```js\r\nlet a = 1;\r\n```\r\n![图片](a.png)\r\n---\r\n");
        assert_eq!(doc.title.as_deref(), Some("标题"));
        assert!(matches!(doc.blocks[0], MdBlock::Heading { level: 1, .. }));
        assert!(matches!(doc.blocks[1], MdBlock::Paragraph { .. }));
        assert!(
            matches!(&doc.blocks[2], MdBlock::List { ordered: false, items } if items.len() == 2)
        );
        assert!(matches!(doc.blocks[3], MdBlock::Paragraph { .. })); // fenced code
        assert!(matches!(&doc.blocks[4], MdBlock::Image { src, .. } if src == "a.png"));
        assert!(matches!(doc.blocks[5], MdBlock::PageBreak));
    }

    #[test]
    fn title_falls_back_to_first_paragraph_head() {
        let doc = parse_markdown("hello world");
        assert_eq!(doc.title.as_deref(), Some("hello world"));
        let long = parse_markdown(&"字".repeat(100));
        assert_eq!(
            long.title.as_deref().map(str::chars).map(Iterator::count),
            Some(80)
        );
    }

    #[test]
    fn inline_marks_match_ts_groups() {
        let runs = parse_inline("a **b** c *d* `e` [f](g)");
        assert_eq!(runs[0].text, "a ");
        assert_eq!(runs[1].text, "b");
        assert!(runs[1].style.bold);
        assert_eq!(runs[2].text, " c ");
        assert!(runs[3].style.italic);
        assert_eq!(runs[4].text, " ");
        assert!(runs[5].style.code);
        assert_eq!(runs[6].text, " ");
        assert_eq!(runs[7].text, "f");
    }

    #[test]
    fn quotes_fold_into_paragraphs_and_blank_lines_flush() {
        let doc = parse_markdown("> one\n> two\n\nthree");
        assert_eq!(doc.blocks.len(), 2);
        assert!(matches!(&doc.blocks[0], MdBlock::Paragraph { text } if text == "one two"));
    }
}
