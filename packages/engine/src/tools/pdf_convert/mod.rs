//! Layout-aware PDF text conversions (`pdf-to-csv`, `pdf-to-rtf`,
//! `pdf-to-excel`, `pdf-to-markdown`, `pdf-to-word`, `pdf-to-epub`,
//! `pdf-to-html`), driven by PDF.js text runs and pre-cropped page images the
//! web adapter supplies through `runtimeData` — no PDF is parsed in the
//! conversion runners themselves. TS oracles: `tools/pdf-text-export-browser.ts`,
//! `tools/pdf-to-excel-browser.ts`, `tools/pdf-to-word-browser.ts`,
//! `tools/epub-browser.ts` and `lib/{textfmt,office,epub}.ts`; thresholds,
//! warning strings and output encodings are ported verbatim.
//!
//! The `rects` submodule is the exception: it parses PDFs with lopdf to back
//! the `pdfImageRects` wasm export (adapter crop contract, ported from
//! `lib/pagedata.ts`).

use super::{EngineError, InputFile, RunContext, ToolResult};
use crate::services::naming::{base_name, render_name, NameContext};
use serde_json::Value;

mod converters;
mod docx;
mod epub_writer;
mod exporters;
mod layout;
mod model;
// Only the `wasm` build consumes `rects` (the `pdfImageRects` export), so on
// native builds its items would read as dead code.
#[cfg_attr(not(feature = "wasm"), allow(dead_code))]
pub(crate) mod rects;
mod text;
mod writers;

// C3: presentation/OFD/PDF builders and their runners. `std14` carries the
// standard-14 AFM metrics shared by the PDF producers.
mod imgpdf;
mod md_parse;
mod md_pdf;
mod ofd;
mod ofd_export;
mod ofd_import;
mod ofd_read;
mod pdfdoc;
mod ppt;
mod pptx;
mod std14;
mod typesetter;

/// Shared flow model, ported from `lib/docmodel.ts` `FlowBlock`. Image blocks
/// are built from the adapter's `pdfImages` entries (`Region`) or, for word
/// scan pages, from full-page renders (`FullPage`).
#[derive(Clone, Debug)]
pub enum FlowBlock {
    Heading {
        level: usize,
        text: String,
        page: u32,
    },
    Paragraph {
        text: String,
        page: u32,
        bold: bool,
    },
    List {
        ordered: bool,
        items: Vec<String>,
        page: u32,
    },
    Image {
        page: u32,
        /// Drawn size in points (visual space).
        width_pt: f64,
        height_pt: f64,
        /// Where the payload bytes come from (see [`ImageSource`]).
        source: ImageSource,
        /// Output-side source: in-book name (epub), data URL or relative
        /// path (html); unused by markdown, which resolves via ordinal.
        src: Option<String>,
    },
    PageBreak,
}

/// Payload lookup key for an image block, standing in for the TS
/// `imageFor(block)` map.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ImageSource {
    /// Crop of a `pdfImages` entry: `(page, rect index)` from
    /// `pdfImageRects` (0-based within that page's rects).
    Region { page: u32, index: u32 },
    /// Full-page render from a `pdfPageImages` entry (word scan fallback).
    FullPage { page: u32 },
}

/// The page a block belongs to; page breaks carry none (TS `'page' in block`).
pub(crate) fn block_page(block: &FlowBlock) -> Option<u32> {
    match block {
        FlowBlock::Heading { page, .. }
        | FlowBlock::Paragraph { page, .. }
        | FlowBlock::List { page, .. }
        | FlowBlock::Image { page, .. } => Some(*page),
        FlowBlock::PageBreak => None,
    }
}

type EngineResult<T> = Result<T, EngineError>;

pub fn run(ctx: &RunContext<'_>) -> Result<Option<ToolResult>, EngineError> {
    match ctx.tool {
        "pdf-to-csv" => exporters::run_csv(ctx).map(Some),
        "pdf-to-rtf" => exporters::run_rtf(ctx).map(Some),
        "pdf-to-excel" => exporters::run_excel(ctx).map(Some),
        "pdf-to-markdown" => exporters::run_markdown(ctx).map(Some),
        "pdf-to-word" => converters::run_word(ctx).map(Some),
        "pdf-to-epub" => converters::run_epub(ctx).map(Some),
        "pdf-to-html" => converters::run_html(ctx).map(Some),
        "pdf-to-ppt" => ppt::run(ctx).map(Some),
        "pdf-to-ofd" => ofd_export::run(ctx).map(Some),
        "ofd-to-pdf" => ofd_import::run(ctx).map(Some),
        "markdown-to-pdf" => md_pdf::run(ctx).map(Some),
        _ => Ok(None),
    }
}

/// Emits one per-input artifact named from the shared naming pattern with the
/// TS tool tags (`markdown`/`csv`/`rtf`/`excel`/`word`/`epub`/`html`) and no
/// index/total, matching the TS `renderName(ctx.namePattern, { name, tool }, ext)`
/// calls.
fn emit(
    ctx: &RunContext<'_>,
    result: &mut ToolResult,
    input: &InputFile,
    tool_tag: &str,
    ext: &str,
    kind: &str,
    bytes: Vec<u8>,
) {
    let name = render_name(
        ctx.name_pattern,
        NameContext {
            name: base_name(&input.name),
            tool: tool_tag,
            index: None,
            total: None,
            range: None,
        },
        ext,
    );
    let mut artifact = crate::Artifact::new(name, kind, bytes);
    artifact.source_file_id = Some(input.id.clone());
    result.artifacts.push(artifact);
}

fn string<'a>(options: &'a Value, key: &str) -> &'a str {
    options.get(key).and_then(Value::as_str).unwrap_or("")
}

fn number(options: &Value, key: &str, default: f64) -> f64 {
    options.get(key).and_then(Value::as_f64).unwrap_or(default)
}

/// Matches the web option coercion for booleans (`true`/'true'/1/'1'); the
/// catalog default applies when the key is missing or null.
fn truthy(options: &Value, key: &str, default: bool) -> bool {
    match options.get(key) {
        None | Some(Value::Null) => default,
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(value)) => value.as_f64() == Some(1.0),
        Some(Value::String(value)) => matches!(value.as_str(), "true" | "1"),
        _ => false,
    }
}

/// The catalog-clamped table column gap: default 8, range 2–60.
fn column_gap(options: &Value) -> f64 {
    number(options, "columnGap", 8.0).clamp(2.0, 60.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truthy_matches_web_coercion() {
        let yes = serde_json::json!({"k": "true"});
        let one = serde_json::json!({"k": 1});
        let no = serde_json::json!({"k": "no"});
        assert!(truthy(&yes, "k", false));
        assert!(truthy(&one, "k", false));
        assert!(!truthy(&no, "k", false));
        assert!(truthy(&serde_json::json!({}), "k", true));
        assert!(!truthy(&serde_json::json!({}), "k", false));
    }

    #[test]
    fn column_gap_defaults_and_clamps() {
        assert_eq!(column_gap(&serde_json::json!({})), 8.0);
        assert_eq!(column_gap(&serde_json::json!({"columnGap": 0})), 2.0);
        assert_eq!(column_gap(&serde_json::json!({"columnGap": 99})), 60.0);
    }

    #[test]
    fn string_reads_or_falls_back_to_empty() {
        assert_eq!(string(&serde_json::json!({"d": "tab"}), "d"), "tab");
        assert_eq!(string(&serde_json::json!({}), "d"), "");
    }

    #[test]
    fn block_page_covers_all_non_break_blocks() {
        let blocks = [
            FlowBlock::Heading {
                level: 1,
                text: "t".into(),
                page: 3,
            },
            FlowBlock::Paragraph {
                text: "p".into(),
                page: 4,
                bold: false,
            },
            FlowBlock::List {
                ordered: false,
                items: vec![],
                page: 5,
            },
            FlowBlock::Image {
                page: 6,
                width_pt: 1.0,
                height_pt: 1.0,
                source: ImageSource::Region { page: 6, index: 0 },
                src: None,
            },
            FlowBlock::PageBreak,
        ];
        let pages: Vec<Option<u32>> = blocks.iter().map(block_page).collect();
        assert_eq!(pages, vec![Some(3), Some(4), Some(5), Some(6), None]);
    }
}
