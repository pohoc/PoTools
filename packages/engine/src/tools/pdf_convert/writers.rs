//! Text writers ported from `lib/textfmt.ts`: Markdown/HTML flow rendering,
//! CSV quoting and the RTF writer. Output must match the TS byte-for-byte —
//! including the HTML head/CSS block, the UTF-8 BOM on CSV output and the RTF
//! `\uN` signed-16-bit escaping.

use super::text::js_trim;
use super::FlowBlock;
use regex::Regex;
use std::sync::OnceLock;

/// TS `escapeHtml`: `&`, `<`, `>`, `"` (apostrophes pass through here).
pub(crate) fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Ported `flowToMarkdown`. `image_for` receives the 1-based ordinal of the
/// image block (counted over every image block, exactly like the TS counter)
/// and returns the relative path to reference, or `None` to drop the block.
pub(crate) fn flow_to_markdown(
    flow: &[FlowBlock],
    image_for: &mut dyn FnMut(usize) -> Option<String>,
) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut image_index = 0usize;
    for block in flow {
        match block {
            FlowBlock::Heading { level, text, .. } => {
                lines.push(format!("{} {}", "#".repeat((*level).min(6)), text));
                lines.push(String::new());
            }
            FlowBlock::Paragraph { text, bold, .. } => {
                lines.push(if *bold {
                    format!("**{text}**")
                } else {
                    text.clone()
                });
                lines.push(String::new());
            }
            FlowBlock::List { ordered, items, .. } => {
                for (index, item) in items.iter().enumerate() {
                    lines.push(if *ordered {
                        format!("{}. {item}", index + 1)
                    } else {
                        format!("- {item}")
                    });
                }
                lines.push(String::new());
            }
            FlowBlock::Image { .. } => {
                image_index += 1;
                if let Some(path) = image_for(image_index) {
                    lines.push(format!("![图片 {image_index}]({path})"));
                    lines.push(String::new());
                }
            }
            FlowBlock::PageBreak => {
                lines.push("---".to_owned());
                lines.push(String::new());
            }
        }
    }
    format!("{}\n", js_trim(&collapse_blank_lines(&lines.join("\n"))))
}

/// The TS `.replace(/\n{3,}/g, '\n\n')` blank-line collapse.
fn collapse_blank_lines(value: &str) -> String {
    static RUNS: OnceLock<Regex> = OnceLock::new();
    RUNS.get_or_init(|| Regex::new(r"\n{3,}").expect("blank line pattern is valid"))
        .replace_all(value, "\n\n")
        .into_owned()
}

/// Ported `flowToHtml`, including the exact doctype/meta/title/CSS head and
/// list-keep-open markup. `image_for` receives the 1-based image ordinal and
/// returns the `src` (data URL or relative path); `None` drops the figure.
pub(crate) fn flow_to_html(
    flow: &[FlowBlock],
    title: &str,
    image_for: &mut dyn FnMut(usize) -> Option<String>,
) -> String {
    let mut body: Vec<String> = Vec::new();
    let mut open_list: Option<&'static str> = None;
    let mut image_index = 0usize;
    for block in flow {
        match block {
            FlowBlock::Heading { level, text, .. } => {
                close_list(&mut body, &mut open_list);
                let level = (*level).min(6);
                body.push(format!("<h{level}>{}</h{level}>", escape_html(text)));
            }
            FlowBlock::Paragraph { text, bold, .. } => {
                close_list(&mut body, &mut open_list);
                let content = escape_html(text);
                body.push(if *bold {
                    format!("<p><strong>{content}</strong></p>")
                } else {
                    format!("<p>{content}</p>")
                });
            }
            FlowBlock::List { ordered, items, .. } => {
                let tag = if *ordered { "ol" } else { "ul" };
                if open_list != Some(tag) {
                    close_list(&mut body, &mut open_list);
                    body.push(format!("<{tag}>"));
                    open_list = Some(tag);
                }
                for item in items {
                    body.push(format!("  <li>{}</li>", escape_html(item)));
                }
            }
            FlowBlock::Image { page, .. } => {
                close_list(&mut body, &mut open_list);
                image_index += 1;
                if let Some(src) = image_for(image_index) {
                    body.push(format!(
                        "<figure><img src=\"{}\" alt=\"第 {page} 页\"></figure>",
                        escape_html(&src)
                    ));
                }
            }
            FlowBlock::PageBreak => {
                close_list(&mut body, &mut open_list);
                body.push("<hr>".to_owned());
            }
        }
    }
    close_list(&mut body, &mut open_list);
    [
        "<!doctype html>".to_owned(),
        "<html lang=\"zh-CN\"><head><meta charset=\"utf-8\">".to_owned(),
        format!("<title>{}</title>", escape_html(title)),
        "<style>body{max-width:46em;margin:3em auto;padding:0 1.2em;font:15px/1.75 -apple-system,\"Segoe UI\",Roboto,\"PingFang SC\",\"Microsoft YaHei\",sans-serif;color:#1f2430}".to_owned(),
        "img{max-width:100%;height:auto}h1,h2,h3{line-height:1.35}hr{margin:2.5em 0;border:0;border-top:1px solid #dfe3ea}".to_owned(),
        "figure{margin:1.5em 0}code{background:#f2f4f8;padding:.1em .35em;border-radius:4px}</style></head><body>".to_owned(),
        body.join("\n"),
        "</body></html>".to_owned(),
        String::new(),
    ]
    .join("\n")
}

#[allow(dead_code)]
fn close_list(body: &mut Vec<String>, open_list: &mut Option<&'static str>) {
    if let Some(tag) = open_list {
        body.push(format!("</{tag}>"));
    }
    *open_list = None;
}

/// Ported `rowsToCsv`: cells containing `"`, `,`, newline, `;` or tab are
/// quoted with `""` doubling; output is BOM-prefixed (Excel needs it to read
/// UTF-8) with CRLF joins and a trailing CRLF.
pub(crate) fn rows_to_csv(rows: &[Vec<String>], delimiter: &str) -> String {
    let body = rows
        .iter()
        .map(|row| {
            row.iter()
                .map(|cell| {
                    if cell
                        .chars()
                        .any(|c| matches!(c, '"' | ',' | '\n' | ';' | '\t'))
                    {
                        format!("\"{}\"", cell.replace('"', "\"\""))
                    } else {
                        cell.clone()
                    }
                })
                .collect::<Vec<_>>()
                .join(delimiter)
        })
        .collect::<Vec<_>>()
        .join("\r\n");
    format!("\u{feff}{body}\r\n")
}

/// RTF escaping, iterating UTF-16 units exactly like the TS `charCodeAt` loop:
/// `\uN?` carries a signed 16-bit value (`code - 65536` above 32767), so
/// surrogate halves and high BMP characters escape as written.
fn rtf_escape(value: &str) -> String {
    let mut out = String::new();
    for unit in value.encode_utf16() {
        match unit {
            0x5c => out.push_str("\\\\"),
            0x7b => out.push_str("\\{"),
            0x7d => out.push_str("\\}"),
            0x0a => out.push_str("\\par\n"),
            other if other > 126 => {
                let code = other as i32;
                out.push_str(&format!(
                    "\\u{}?",
                    if code > 32767 { code - 65536 } else { code }
                ));
            }
            other => out.push(other as u8 as char),
        }
    }
    out
}

/// Ported `flowToRtf`, including the exact header/fonttbl preamble, the
/// heading/paragraph spacing controls and the `\page` break.
pub(crate) fn flow_to_rtf(flow: &[FlowBlock]) -> String {
    let mut parts: Vec<String> = Vec::new();
    for block in flow {
        match block {
            FlowBlock::Heading { level, text, .. } => {
                let size = (44 - *level as i32 * 6).max(20);
                parts.push(format!(
                    "\\pard\\sb240\\sa120\\b\\fs{size} {}\\b0\\par",
                    rtf_escape(text)
                ));
            }
            FlowBlock::Paragraph { text, bold, .. } => parts.push(format!(
                "\\pard\\sa120{} {}{}\\par",
                if *bold { "\\b" } else { "" },
                rtf_escape(text),
                if *bold { "\\b0" } else { "" }
            )),
            FlowBlock::List { ordered, items, .. } => {
                let marker = if *ordered { "-" } else { "\u{2022}" };
                for item in items {
                    parts.push(format!(
                        "\\pard\\fi-360\\li360 {marker} {}\\par",
                        rtf_escape(item)
                    ));
                }
            }
            FlowBlock::Image { .. } => {}
            FlowBlock::PageBreak => parts.push("\\page".to_owned()),
        }
    }
    format!(
        "{{\\rtf1\\ansi\\ansicpg1252\\deff0\\deflang1033\n{{\\fonttbl{{\\f0\\froman\\fcharset0 Times New Roman;}}{{\\f1\\fnil\\fcharset134 SimSun;}}}}\n\\viewkind4\\uc1\n{}\n}}\n",
        parts.join("\n")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::pdf_convert::ImageSource;

    #[test]
    fn csv_quotes_and_bom_match_ts() {
        let rows = vec![
            vec!["a".into(), "b,c".into()],
            vec!["say \"hi\"".into(), "line\nbreak;tab\there".into()],
        ];
        let csv = rows_to_csv(&rows, ",");
        assert!(csv.starts_with('\u{feff}'));
        assert!(csv.ends_with("\r\n"));
        assert!(csv.contains("\"b,c\""));
        assert!(csv.contains("\"say \"\"hi\"\"\""));
        assert!(csv.contains("line\nbreak;tab\there"));
    }

    #[test]
    fn rtf_escapes_controls_and_signed_units() {
        assert_eq!(rtf_escape("a\\b{c}\nd"), "a\\\\b\\{c\\}\\par\nd");
        assert_eq!(rtf_escape("一"), "\\u19968?");
        assert_eq!(rtf_escape("阿"), "\\u-27073?");
        assert_eq!(rtf_escape("hi"), "hi");
    }

    #[test]
    fn markdown_renders_headings_lists_and_breaks() {
        let flow = vec![
            FlowBlock::Heading {
                level: 1,
                text: "T".into(),
                page: 1,
            },
            FlowBlock::List {
                ordered: true,
                items: vec!["x".into()],
                page: 1,
            },
            FlowBlock::PageBreak,
        ];
        assert_eq!(
            flow_to_markdown(&flow, &mut |_| None),
            "# T\n\n1. x\n\n---\n"
        );
    }

    #[test]
    fn markdown_images_reference_paths_by_ordinal() {
        let flow = vec![
            FlowBlock::Image {
                page: 1,
                width_pt: 10.0,
                height_pt: 10.0,
                source: ImageSource::Region { page: 1, index: 0 },
                src: None,
            },
            FlowBlock::Image {
                page: 2,
                width_pt: 10.0,
                height_pt: 10.0,
                source: ImageSource::Region { page: 2, index: 0 },
                src: None,
            },
        ];
        let markdown = flow_to_markdown(&flow, &mut |ordinal| {
            (ordinal == 1).then(|| "a-p1-01.png".to_owned())
        });
        assert_eq!(markdown, "![图片 1](a-p1-01.png)\n");
    }

    #[test]
    fn html_embeds_figures_with_page_alt() {
        let flow = vec![FlowBlock::Image {
            page: 3,
            width_pt: 10.0,
            height_pt: 10.0,
            source: ImageSource::Region { page: 3, index: 0 },
            src: None,
        }];
        let html = flow_to_html(&flow, "doc", &mut |_| {
            Some("data:image/png;base64,AAA".into())
        });
        assert!(html
            .contains("<figure><img src=\"data:image/png;base64,AAA\" alt=\"第 3 页\"></figure>"));
    }

    #[test]
    fn rtf_header_matches_ts_preamble() {
        let rtf = flow_to_rtf(&[FlowBlock::PageBreak]);
        assert!(rtf.starts_with("{\\rtf1\\ansi\\ansicpg1252\\deff0\\deflang1033\n"));
        assert!(rtf.contains("{\\fonttbl{\\f0\\froman\\fcharset0 Times New Roman;}{\\f1\\fnil\\fcharset134 SimSun;}}"));
        assert!(rtf.ends_with("\\page\n}\n"));
    }
}
