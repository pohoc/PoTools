//! Layout pipeline ported from `tools/pdf-text-export-browser.ts`: row
//! grouping, line merging, body-size detection, flow classification and the
//! table row/cell split. Every threshold matches the TS oracle exactly.

use super::model::{pdf_text_pages, PdfImagePlacement, PdfTextPage};
use super::text::{bullet_regex, is_cjk, is_js_space, js_trim, numbered_regex};
use super::{FlowBlock, ImageSource};
use crate::services::xlsx::js_len;
use crate::RunContext;
use std::cmp::Ordering;

/// One raw PDF.js text run, reduced to the fields the layout uses.
#[derive(Clone, Debug)]
pub(crate) struct Run {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub size: f64,
    pub weight: String,
    /// Font name hint (empty when the adapter sent none); the ppt/ofd tools
    /// test it for embedded bold and "needs a font" coverage.
    pub font: String,
}

/// One merged visual line: a row bucket collapsed into a single string. The
/// geometry fields mirror the TS `BrowserLine`; the flow classification reads
/// text/size/weight/block, the rest stay for the C2 image-layout work.
/// `size_max` (largest run size in the bucket) stands in for the TS stext
/// line size consumed by the OFD text export.
#[allow(dead_code)]
#[derive(Clone, Debug)]
pub(crate) struct Line {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub size: f64,
    /// Largest run size within the merged line.
    pub size_max: f64,
    pub weight: String,
    pub font: String,
    pub block: usize,
}

/// A page's merged lines (flow input) plus its raw row buckets (table input).
/// `width`/`height` are the visual page size in points; the word writer reads
/// them for scan-page image blocks and the content width.
pub(crate) struct Page {
    pub page: u32,
    pub width: f64,
    pub height: f64,
    pub lines: Vec<Line>,
    pub rows: Vec<Vec<Run>>,
}

/// Reads an input's adapter pages and runs the grouping/merge pipeline.
pub(crate) fn pages_for(ctx: &RunContext<'_>, file_id: &str) -> Vec<Page> {
    pages_from_model(&pdf_text_pages(ctx, file_id))
}

pub(crate) fn pages_from_model(model_pages: &[PdfTextPage]) -> Vec<Page> {
    model_pages
        .iter()
        .map(|model| {
            let runs: Vec<Run> = model
                .runs
                .iter()
                .map(|run| Run {
                    text: run.text.clone(),
                    x: run.x,
                    y: run.y,
                    w: run.w,
                    h: run.h,
                    size: run.size,
                    weight: run.weight.clone().unwrap_or_else(|| "normal".into()),
                    font: run.font.clone().unwrap_or_default(),
                })
                .collect();
            let rows = group_runs(runs);
            let lines: Vec<Line> = rows
                .iter()
                .enumerate()
                .map(|(index, row)| merge_runs(row, index, &rows))
                .collect();
            Page {
                page: model.page,
                width: model.width,
                height: model.height,
                lines,
                rows,
            }
        })
        .collect()
}

/// Sorts by (y, x), buckets runs into rows when the y distance to the row
/// anchor is under `max(2, min(anchor.h, run.h) * 0.55)`, then orders rows by
/// y and members by x.
fn group_runs(runs: Vec<Run>) -> Vec<Vec<Run>> {
    let mut sorted: Vec<Run> = runs;
    sorted.sort_by(|a, b| {
        a.y.partial_cmp(&b.y)
            .unwrap_or(Ordering::Equal)
            .then(a.x.partial_cmp(&b.x).unwrap_or(Ordering::Equal))
    });
    let mut rows: Vec<Vec<Run>> = Vec::new();
    for run in sorted {
        let anchor = rows
            .iter_mut()
            .find(|items| (items[0].y - run.y).abs() < (items[0].h.min(run.h) * 0.55).max(2.0));
        match anchor {
            Some(row) => row.push(run),
            None => rows.push(vec![run]),
        }
    }
    rows.sort_by(|a, b| a[0].y.partial_cmp(&b[0].y).unwrap_or(Ordering::Equal));
    for row in rows.iter_mut() {
        row.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap_or(Ordering::Equal));
    }
    rows
}

/// Joins one row bucket into a line. `block` counts backward row gaps larger
/// than `max(curH, prevH) * 1.45`; a space is inserted only between
/// non-whitespace boundaries, over a gap above `max(1, size * 0.16)`, and
/// never between CJK boundary characters.
fn merge_runs(pieces: &[Run], index: usize, rows: &[Vec<Run>]) -> Line {
    let mut block = 0usize;
    for prior in (0..index).rev() {
        let previous_row = &rows[prior];
        let current_row = &rows[prior + 1];
        if current_row[0].y - previous_row[0].y > current_row[0].h.max(previous_row[0].h) * 1.45 {
            block += 1;
        }
    }
    let first = &pieces[0];
    let mut text = String::new();
    let mut right = f64::NEG_INFINITY;
    let mut size_max = first.size;
    for piece in pieces {
        size_max = size_max.max(piece.size);
        let gap = piece.x - right;
        let needs_space = !text.is_empty()
            && !is_js_space(last_char(&text))
            && !is_js_space(first_char(&piece.text))
            && gap > (piece.size * 0.16).max(1.0)
            && !is_cjk(last_char(&text))
            && !is_cjk(first_char(&piece.text));
        if needs_space {
            text.push(' ');
        }
        text.push_str(&piece.text);
        right = right.max(piece.x + piece.w);
    }
    let end = pieces
        .iter()
        .map(|piece| piece.x + piece.w)
        .fold(f64::NEG_INFINITY, f64::max);
    Line {
        text: js_trim(&text),
        x: first.x,
        y: first.y,
        w: end - first.x,
        h: first.h,
        size: first.size,
        size_max,
        weight: first.weight.clone(),
        font: first.font.clone(),
        block,
    }
}

/// Char-count-weighted histogram of rounded font sizes; the most common size
/// wins (insertion order kept, so ties resolve like the TS stable sort) with a
/// fallback of 10.
fn body_size_of(pages: &[Page]) -> f64 {
    let mut sizes: Vec<(i64, f64)> = Vec::new();
    for page in pages {
        for line in &page.lines {
            let key = line.size.round() as i64;
            let weight = js_len(&line.text) as f64;
            match sizes.iter_mut().find(|(size, _)| *size == key) {
                Some((_, count)) => *count += weight,
                None => sizes.push((key, weight)),
            }
        }
    }
    sizes.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(Ordering::Equal));
    sizes.first().map(|(size, _)| *size as f64).unwrap_or(10.0)
}

/// Ported `browserPagesToFlow`: groups consecutive lines by `block` counter,
/// classifies headings by size ratio, bold paragraphs, bullet/numbered lists
/// and plain paragraphs, with optional page-break blocks between pages.
pub(crate) fn pages_to_flow(pages: &[Page], page_breaks: bool) -> Vec<FlowBlock> {
    pages_to_flow_with_images(pages, page_breaks, &[])
}

/// Image-aware variant of [`pages_to_flow`]: mirrors `lib/docmodel.ts`
/// `toFlow`, which appends the page's image blocks after all of the page's
/// text blocks. Image blocks come from the adapter's `pdfImages` entries
/// (already cropped); entries with a zero-sized box are skipped because the
/// TS pipeline only cropped/placed `box.w && box.h` images.
pub(crate) fn pages_to_flow_with_images(
    pages: &[Page],
    page_breaks: bool,
    images: &[PdfImagePlacement],
) -> Vec<FlowBlock> {
    let body_size = body_size_of(pages);
    let mut flow: Vec<FlowBlock> = Vec::new();
    for page in pages {
        if page_breaks && !flow.is_empty() {
            flow.push(FlowBlock::PageBreak);
        }
        let mut groups: Vec<Vec<&Line>> = Vec::new();
        for line in &page.lines {
            match groups.last_mut() {
                Some(last) if last[0].block == line.block => last.push(line),
                _ => groups.push(vec![line]),
            }
        }
        for group in groups {
            let first = group[0];
            let text = join_lines(group.iter().map(|line| line.text.as_str()));
            let ratio = first.size / body_size.max(1.0);
            let length = js_len(&text);
            let heading = if length <= 120 {
                if ratio >= 1.7 {
                    1
                } else if ratio >= 1.35 {
                    2
                } else if ratio >= 1.12 {
                    3
                } else if first.weight == "bold" && ratio >= 0.95 && length <= 60 {
                    4
                } else {
                    0
                }
            } else {
                0
            };
            if heading > 0 && group.len() == 1 {
                flow.push(FlowBlock::Heading {
                    level: heading,
                    text: first.text.clone(),
                    page: page.page,
                });
            } else if group.iter().all(|line| line.weight == "bold") {
                flow.push(FlowBlock::Paragraph {
                    text,
                    page: page.page,
                    bold: true,
                });
            } else {
                let bullets: Vec<&str> = group
                    .iter()
                    .map(|line| line.text.as_str())
                    .filter(|text| bullet_regex().is_match(text))
                    .collect();
                if (bullets.len() as f64) >= ((group.len() as f64) * 0.6).max(1.0) {
                    let ordered = bullets.iter().any(|text| numbered_regex().is_match(text));
                    let items = bullets
                        .iter()
                        .map(|text| js_trim(&bullet_regex().replace(text, "")))
                        .collect();
                    flow.push(FlowBlock::List {
                        ordered,
                        items,
                        page: page.page,
                    });
                } else {
                    flow.push(FlowBlock::Paragraph {
                        text,
                        page: page.page,
                        bold: false,
                    });
                }
            }
        }
        if !images.is_empty() {
            let mut page_images: Vec<&PdfImagePlacement> = images
                .iter()
                .filter(|image| image.page == page.page)
                .collect();
            page_images.sort_by_key(|image| image.index);
            for image in page_images {
                if image.width_pt == 0.0 || image.height_pt == 0.0 {
                    continue;
                }
                flow.push(FlowBlock::Image {
                    page: page.page,
                    width_pt: image.width_pt,
                    height_pt: image.height_pt,
                    source: ImageSource::Region {
                        page: page.page,
                        index: image.index,
                    },
                    src: None,
                });
            }
        }
    }
    flow
}

/// Joins a group's line texts: a trailing hyphen is dropped, CJK boundaries
/// concatenate without a space, anything else joins with a single space.
fn join_lines<'a>(parts: impl Iterator<Item = &'a str>) -> String {
    let mut out = String::new();
    for part in parts {
        if out.is_empty() {
            out.push_str(part);
            continue;
        }
        let tail = last_char(&out);
        let head = first_char(part);
        if tail == '-' {
            out.pop();
            out.push_str(part);
        } else if is_cjk(tail) || is_cjk(head) {
            out.push_str(part);
        } else {
            out.push(' ');
            out.push_str(part);
        }
    }
    out
}

/// Ported `rowsOf`: within each grouped row (already y-bucketed, sorted by x),
/// start a new cell when the gap to the previous piece's right edge exceeds
/// `gap_limit`, otherwise join with a single space.
pub(crate) fn rows_of(page: &Page, gap_limit: f64) -> Vec<Vec<String>> {
    page.rows
        .iter()
        .map(|row| {
            let mut sorted: Vec<&Run> = row.iter().collect();
            sorted.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap_or(Ordering::Equal));
            let mut cells: Vec<String> = Vec::new();
            let mut buffer = String::new();
            let mut previous_end: Option<f64> = None;
            for line in sorted {
                if previous_end.map_or(false, |end| line.x - end > gap_limit) {
                    cells.push(js_trim(&buffer));
                    buffer.clear();
                } else if !buffer.is_empty() {
                    buffer.push(' ');
                }
                buffer.push_str(&line.text);
                previous_end = Some(line.x + line.w);
            }
            cells.push(js_trim(&buffer));
            cells
        })
        .collect()
}

fn last_char(value: &str) -> char {
    value.chars().last().unwrap_or('\0')
}

fn first_char(value: &str) -> char {
    value.chars().next().unwrap_or('\0')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(text: &str, size: f64, weight: &str, block: usize) -> Line {
        Line {
            text: text.into(),
            x: 0.0,
            y: 0.0,
            w: 0.0,
            h: size,
            size,
            size_max: size,
            weight: weight.into(),
            font: String::new(),
            block,
        }
    }

    fn run(text: &str, x: f64, y: f64, w: f64) -> Run {
        Run {
            text: text.into(),
            x,
            y,
            w,
            h: 10.0,
            size: 10.0,
            weight: "normal".into(),
            font: String::new(),
        }
    }

    fn page(lines: Vec<Line>, rows: Vec<Vec<Run>>) -> Page {
        Page {
            page: 1,
            width: 595.0,
            height: 842.0,
            lines,
            rows,
        }
    }

    #[test]
    fn rows_bucket_by_y_and_sort_by_x() {
        let rows = group_runs(vec![
            run("b", 30.0, 10.4, 10.0),
            run("a", 10.0, 10.0, 10.0),
            run("c", 10.0, 30.0, 10.0),
        ]);
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[0].iter().map(|r| r.text.as_str()).collect::<Vec<_>>(),
            vec!["a", "b"]
        );
    }

    #[test]
    fn merge_counts_block_gaps_and_inserts_space_by_gap() {
        let rows = vec![
            vec![run("a", 0.0, 0.0, 5.0)],
            vec![run("b", 0.0, 20.0, 5.0)],
        ];
        assert_eq!(merge_runs(&rows[1], 1, &rows).block, 1);
        let tight = vec![run("a", 0.0, 0.0, 5.0), run("b", 5.2, 0.0, 5.0)];
        assert_eq!(merge_runs(&tight, 0, &[]).text, "ab");
        let wide = vec![run("a", 0.0, 0.0, 5.0), run("b", 7.0, 0.0, 5.0)];
        assert_eq!(merge_runs(&wide, 0, &[]).text, "a b");
    }

    #[test]
    fn join_lines_drops_hyphen_and_joins_cjk_without_space() {
        assert_eq!(join_lines(["ab-", "cd"].into_iter()), "abcd");
        assert_eq!(join_lines(["中文", "续"].into_iter()), "中文续");
        assert_eq!(join_lines(["ab", "cd"].into_iter()), "ab cd");
    }

    #[test]
    fn flow_headings_use_size_ratio_and_body_fallback() {
        let model_page = page(
            vec![
                line("Title", 24.0, "normal", 0),
                line("body text here", 10.0, "normal", 1),
            ],
            Vec::new(),
        );
        let flow = pages_to_flow(&[model_page], false);
        assert!(matches!(&flow[0], FlowBlock::Heading { level: 1, text, .. } if text == "Title"));
        assert!(matches!(&flow[1], FlowBlock::Paragraph { bold: false, .. }));
    }

    #[test]
    fn flow_detects_numbered_lists() {
        let model_page = page(
            vec![
                line("1. first", 10.0, "normal", 0),
                line("2. second", 10.0, "normal", 1),
            ],
            Vec::new(),
        );
        let flow = pages_to_flow(&[model_page], false);
        assert!(
            matches!(&flow[0], FlowBlock::List { ordered: true, items, .. } if items[0] == "first")
        );
    }

    #[test]
    fn image_blocks_append_after_page_text_sorted_by_index() {
        let images = vec![
            PdfImagePlacement {
                page: 1,
                index: 1,
                width_pt: 30.0,
                height_pt: 20.0,
                bytes: vec![],
            },
            PdfImagePlacement {
                page: 1,
                index: 0,
                width_pt: 0.0,
                height_pt: 50.0,
                bytes: vec![],
            },
            PdfImagePlacement {
                page: 1,
                index: 2,
                width_pt: 10.0,
                height_pt: 10.0,
                bytes: vec![],
            },
            PdfImagePlacement {
                page: 2,
                index: 0,
                width_pt: 40.0,
                height_pt: 40.0,
                bytes: vec![],
            },
        ];
        let flow = pages_to_flow_with_images(&[page(vec![], Vec::new())], false, &images);
        let placed: Vec<(u32, f64)> = flow
            .iter()
            .filter_map(|block| match block {
                FlowBlock::Image { page, width_pt, .. } => Some((*page, *width_pt)),
                _ => None,
            })
            .collect();
        assert_eq!(placed, vec![(1, 30.0), (1, 10.0)]);
    }

    #[test]
    fn rows_split_cells_on_gap_limit() {
        let model_page = page(
            Vec::new(),
            vec![vec![run("ab", 0.0, 0.0, 5.0), run("cd", 15.0, 0.0, 5.0)]],
        );
        assert_eq!(
            rows_of(&model_page, 8.0),
            vec![vec!["ab".to_owned(), "cd".to_owned()]]
        );
        assert_eq!(rows_of(&model_page, 20.0), vec![vec!["ab cd".to_owned()]]);
    }
}
