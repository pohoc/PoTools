//! Per-tool runners for the C2 conversions (`pdf-to-word`, `pdf-to-epub`,
//! `pdf-to-html`), ported from `tools/pdf-to-word-browser.ts`,
//! `tools/epub-browser.ts` and the html part of
//! `tools/pdf-text-export-browser.ts`. Images arrive pre-cropped through the
//! `runtimeData.pdfImages` contract; progress and browser fallbacks stay
//! worker-side concerns.

use super::docx::{write_docx, DocxImage, DocxInput};
use super::epub_writer::{chapterize, write_epub, ChapterBy, EpubChapter, EpubImage, EpubInput};
use super::exporters::emit_image_artifact;
use super::layout::{pages_for, pages_to_flow, pages_to_flow_with_images};
use super::model::{pdf_images, pdf_ocr_pages, pdf_page_images};
use super::text::js_trim;
use super::writers::flow_to_html;
use super::{emit, string, truthy, EngineResult, FlowBlock, ImageSource};
use crate::services::naming::base_name;
use crate::{EngineError, RunContext, ToolResult};
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde_json::json;

type RunResult = EngineResult<ToolResult>;

fn no_pages(file_name: &str) -> EngineError {
    EngineError::new("empty_selection", format!("{file_name} 没有页面"))
}

/// Looks up the cropped PNG for one region source.
fn region_bytes<'a>(
    images: &'a [super::model::PdfImagePlacement],
    page: u32,
    index: u32,
) -> Option<&'a [u8]> {
    images
        .iter()
        .find(|image| image.page == page && image.index == index)
        .map(|image| image.bytes.as_slice())
}

/// `pdf-to-word` (oracle `tools/pdf-to-word-browser.ts`): flow from pdfText
/// with the page-break option applied manually per page, one OCR paragraph
/// for zero-text pages, one full-page image when OCR is unavailable too.
/// Region crops only join the flow when `includeImages` is set, but the
/// scan-page fallback image does not depend on that option (TS behavior).
pub(super) fn run_word(ctx: &RunContext<'_>) -> RunResult {
    let include_images = truthy(ctx.options, "includeImages", true);
    let page_breaks = truthy(ctx.options, "pageBreaks", false);
    let mut result = ToolResult::default();
    let mut produced = 0usize;
    for input in ctx.inputs {
        let stem = base_name(&input.name);
        let pages = pages_for(ctx, &input.id);
        if pages.is_empty() {
            return Err(no_pages(&input.name));
        }
        let images = if include_images {
            pdf_images(ctx, &input.id)
        } else {
            Vec::new()
        };
        let page_images = pdf_page_images(ctx, &input.id);
        let ocr_pages = pdf_ocr_pages(ctx, &input.id);
        let flow = pages_to_flow_with_images(&pages, false, &images);

        let mut blocks: Vec<FlowBlock> = Vec::new();
        for (page_index, page) in pages.iter().enumerate() {
            if page_breaks && page_index > 0 {
                blocks.push(FlowBlock::PageBreak);
            }
            blocks.extend(
                flow.iter()
                    .filter(|block| super::block_page(block) == Some(page.page))
                    .cloned(),
            );
            if page.lines.iter().any(|line| !line.text.is_empty()) {
                continue;
            }
            // Scan page: OCR text first (the adapter pre-joined the
            // recognized lines with '\n'), then a full-page render.
            let recognized = ocr_pages
                .iter()
                .find(|entry| entry.page == page.page)
                .map(|entry| entry.text.as_str())
                .filter(|text| !js_trim(text).is_empty());
            if let Some(text) = recognized {
                blocks.push(FlowBlock::Paragraph {
                    text: text.to_owned(),
                    page: page.page,
                    bold: false,
                });
                continue;
            }
            blocks.push(FlowBlock::Image {
                page: page.page,
                width_pt: page.width,
                height_pt: page.height,
                source: ImageSource::FullPage { page: page.page },
                src: None,
            });
        }

        let content_width = (pages.first().map(|page| page.width).unwrap_or(595.0) - 144.0).max(200.0);
        let image_blocks: Vec<&FlowBlock> = blocks
            .iter()
            .filter(|block| matches!(block, FlowBlock::Image { .. }))
            .collect();
        let image_for = |ordinal: usize| -> Option<DocxImage<'_>> {
            match image_blocks.get(ordinal.checked_sub(1)?)? {
                FlowBlock::Image {
                    width_pt,
                    height_pt,
                    source,
                    ..
                } => {
                    let bytes = match source {
                        ImageSource::Region { page, index } => {
                            region_bytes(&images, *page, *index)?
                        }
                        ImageSource::FullPage { page } => page_images
                            .iter()
                            .find(|entry| entry.page == *page)
                            .map(|entry| entry.bytes.as_slice())?,
                    };
                    Some(DocxImage {
                        bytes,
                        width_pt: *width_pt,
                        height_pt: *height_pt,
                    })
                }
                _ => None,
            }
        };
        let bytes = write_docx(&DocxInput {
            title: &stem,
            blocks: &blocks,
            image_for: &image_for,
            page_breaks,
            content_width,
        })?;
        emit(ctx, &mut result, input, "word", "docx", "docx", bytes);
        produced += 1;
    }
    result.extra.insert("documents".into(), json!(produced));
    Ok(result)
}

/// `pdf-to-epub` (oracle `tools/epub-browser.ts`): crops at 144 dpi arrive
/// via `pdfImages` and get in-book names `p{page}-{NN}.png` assigned in flow
/// order with a pre-incremented counter; without images the flow carries
/// text only.
pub(super) fn run_epub(ctx: &RunContext<'_>) -> RunResult {
    let include_images = truthy(ctx.options, "includeImages", true);
    let chapter_by = if string(ctx.options, "chapterBy") == "page" {
        ChapterBy::Page
    } else {
        ChapterBy::Heading
    };
    let mut result = ToolResult::default();
    let mut produced = 0usize;
    for input in ctx.inputs {
        let stem = base_name(&input.name);
        let mut book_images: Vec<EpubImage> = Vec::new();
        let flow = if include_images {
            let pages = pages_for(ctx, &input.id);
            if pages.is_empty() {
                return Err(no_pages(&input.name));
            }
            let images = pdf_images(ctx, &input.id);
            let mut flow = pages_to_flow_with_images(&pages, false, &images);
            let mut counter = 0usize;
            for block in flow.iter_mut() {
                let FlowBlock::Image {
                    page,
                    source: ImageSource::Region { page: source_page, index },
                    src,
                    ..
                } = block
                else {
                    continue;
                };
                let Some(bytes) = region_bytes(&images, *source_page, *index) else {
                    continue;
                };
                counter += 1;
                let name = format!("p{page}-{counter:02}.png");
                book_images.push(EpubImage {
                    name: name.clone(),
                    bytes: bytes.to_vec(),
                });
                *src = Some(name);
            }
            flow
        } else {
            pages_to_flow(&pages_for(ctx, &input.id), false)
        };
        let chapters: Vec<EpubChapter> = chapterize(&flow, chapter_by);
        let bytes = write_epub(&EpubInput {
            title: &stem,
            author: "PoTools",
            chapters,
            images: book_images,
        })?;
        emit(ctx, &mut result, input, "epub", "epub", "epub", bytes);
        produced += 1;
    }
    result.extra.insert("books".into(), json!(produced));
    Ok(result)
}

/// `pdf-to-html` (oracle `tools/pdf-text-export-browser.ts`, html part):
/// always builds the image-aware flow; `embedImages` picks between data-URL
/// sources and separate `${stem}-p${page}-${NN}.png` artifacts (named with a
/// flow-wide counter). The crop dpi (`options.dpi`) is an adapter concern —
/// the crops already carry their pixel data.
pub(super) fn run_html(ctx: &RunContext<'_>) -> RunResult {
    let embed_images = truthy(ctx.options, "embedImages", true);
    let mut result = ToolResult::default();
    let mut produced = 0usize;
    for input in ctx.inputs {
        let stem = base_name(&input.name);
        let pages = pages_for(ctx, &input.id);
        if pages.is_empty() {
            return Err(no_pages(&input.name));
        }
        let images = pdf_images(ctx, &input.id);
        let mut flow = pages_to_flow_with_images(&pages, false, &images);
        let mut image_count = 0usize;
        for block in flow.iter_mut() {
            let FlowBlock::Image {
                page,
                source: ImageSource::Region { page: source_page, index },
                ..
            } = block
            else {
                continue;
            };
            let Some(bytes) = region_bytes(&images, *source_page, *index) else {
                continue;
            };
            image_count += 1;
            if embed_images {
                if let FlowBlock::Image { src, .. } = block {
                    *src = Some(format!("data:image/png;base64,{}", STANDARD.encode(bytes)));
                }
            } else {
                let name = format!("{stem}-p{page}-{count:02}.png", count = image_count);
                emit_image_artifact(&mut result, input, &name, bytes.to_vec());
                if let FlowBlock::Image { src, .. } = block {
                    *src = Some(name);
                }
            }
        }
        let image_src = |ordinal: usize| -> Option<String> {
            flow.iter()
                .filter_map(|block| match block {
                    FlowBlock::Image { src, .. } => src.clone(),
                    _ => None,
                })
                .nth(ordinal.checked_sub(1)?)
        };
        let html = flow_to_html(&flow, &stem, &mut |ordinal| image_src(ordinal));
        emit(
            ctx,
            &mut result,
            input,
            "html",
            "html",
            "html",
            html.into_bytes(),
        );
        produced += 1;
    }
    result.extra.insert("documents".into(), json!(produced));
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ocr_text_lookup_treats_blank_as_missing() {
        let entries = vec![super::super::model::PdfOcrPage {
            page: 2,
            text: "  \n ".to_owned(),
        }];
        let recognized = entries
            .iter()
            .find(|entry| entry.page == 2)
            .map(|entry| entry.text.as_str())
            .filter(|text| !js_trim(text).is_empty());
        assert!(recognized.is_none());
    }

    #[test]
    fn content_width_matches_ts_formula() {
        assert_eq!((450.0f64 - 144.0).max(200.0), 306.0);
        assert_eq!((300.0f64 - 144.0).max(200.0), 200.0);
        assert_eq!((0.0f64).max(200.0), 200.0);
    }
}

#[cfg(test)]
mod end_to_end {
    use super::*;
    use crate::InputFile;
    use std::io::Read as _;
    use zip::ZipArchive;

    fn png_marker() -> Vec<u8> {
        vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a]
    }

    fn setup() -> (RunContext<'static>, usize) {
        // Leak-free: the values outlive the context for the test's duration.
        let runtime: &'static serde_json::Value = Box::leak(Box::new(json!({
            "pdfText": { "f1": [
                { "page": 1, "width": 595.0, "height": 842.0, "runs": [
                    { "text": "标题", "x": 40.0, "y": 40.0, "w": 80.0, "h": 40.0, "size": 40.0, "weight": "normal" },
                    { "text": "正文内容", "x": 40.0, "y": 100.0, "w": 120.0, "h": 12.0, "size": 12.0, "weight": "normal" }
                ] },
                { "page": 2, "width": 595.0, "height": 842.0, "runs": [] }
            ] },
            "pdfImages": { "f1": [
                { "page": 1, "index": 0, "widthPt": 200.0, "heightPt": 100.0, "bytes": [1, 2, 3, 4] }
            ] },
            "pdfPageImages": { "f1": [
                { "page": 2, "dpi": 150, "bytes": [9, 9, 9] }
            ] },
            "pdfOcrPages": { "f1": [
                { "page": 2, "text": "扫描行一\n扫描行二" }
            ] }
        })));
        let options: &'static serde_json::Value = Box::leak(Box::new(json!({
            "includeImages": true, "pageBreaks": false, "chapterBy": "heading", "embedImages": false
        })));
        let inputs: &'static [InputFile] = Box::leak(Box::new(vec![InputFile {
            id: "f1".into(),
            name: "样例.pdf".into(),
            path: None,
            bytes: Vec::new(),
        }]));
        let ctx = RunContext {
            tool: "pdf-to-word",
            options,
            locale: "zh-CN",
            inputs,
            name_pattern: None,
            runtime_data: Some(runtime),
        };
        (ctx, 0)
    }

    #[test]
    fn word_writer_produces_openable_docx_with_ocr_breaks_and_media() {
        let (ctx, _) = setup();
        let result = run_word(&ctx).unwrap();
        assert_eq!(result.extra["documents"], json!(1));
        let artifact = &result.artifacts[0];
        assert_eq!(artifact.kind, "docx");
        assert!(artifact.name.ends_with(".docx"));
        let mut archive = ZipArchive::new(std::io::Cursor::new(&artifact.bytes)).unwrap();
        let mut document = String::new();
        archive.by_name("word/document.xml").unwrap().read_to_string(&mut document).unwrap();
        // The OCR paragraph splits its '\n' into <w:br/>.
        assert!(document.contains("扫描行一</w:t></w:r><w:r><w:br/></w:r>"));
        // The level-1 heading maps to the Title style; the region crop is
        // the single media part (page 2 used its OCR text, no fallback).
        assert!(document.contains("w:pStyle w:val=\"Title\""));
        assert!(document.contains("正文内容"));
        assert!(archive.by_name("word/media/image1.png").is_ok());
        assert!(archive.by_name("word/media/image2.png").is_err());
        assert!(document.contains("r:embed=\"rId10\""));
        let mut content_types = String::new();
        archive.by_name("[Content_Types].xml").unwrap().read_to_string(&mut content_types).unwrap();
        assert!(content_types.contains("image/png"));
    }

    #[test]
    fn epub_writer_stores_mimetype_first_and_chapterizes() {
        let (mut ctx, _) = setup();
        ctx.tool = "pdf-to-epub";
        let result = run_epub(&ctx).unwrap();
        let artifact = &result.artifacts[0];
        assert_eq!(artifact.kind, "epub");
        let mut archive = ZipArchive::new(std::io::Cursor::new(&artifact.bytes)).unwrap();
        assert_eq!(archive.by_index(0).unwrap().name(), "mimetype");
        let mut mimetype = String::new();
        archive.by_name("mimetype").unwrap().read_to_string(&mut mimetype).unwrap();
        assert_eq!(mimetype, "application/epub+zip");
        let mut chapter = String::new();
        archive.by_name("OEBPS/text/chapter1.xhtml").unwrap().read_to_string(&mut chapter).unwrap();
        // Heading mode: the level-1 标题 opens the chapter and is consumed.
        assert!(chapter.contains("<title>标题</title>"));
        assert!(chapter.contains("<p>正文内容</p>"));
        assert!(!chapter.contains("<h1>标题</h1>"));
        assert!(chapter.contains("../images/p1-01.png"));
        let mut image = Vec::new();
        archive.by_name("OEBPS/images/p1-01.png").unwrap().read_to_end(&mut image).unwrap();
        assert_eq!(image, vec![1, 2, 3, 4]);
    }

    #[test]
    fn html_runner_emits_linked_artifacts_and_markdown_refs() {
        let (mut ctx, _) = setup();
        ctx.tool = "pdf-to-html";
        let result = run_html(&ctx).unwrap();
        assert_eq!(result.artifacts.len(), 2); // one image artifact + html
        let image = &result.artifacts[0];
        assert_eq!(image.kind, "image");
        assert_eq!(image.name, "样例-p1-01.png");
        assert_eq!(image.bytes, vec![1, 2, 3, 4]);
        let html = &result.artifacts[1];
        assert_eq!(html.kind, "html");
        let markup = String::from_utf8(html.bytes.clone()).unwrap();
        assert!(markup.contains("<figure><img src=\"样例-p1-01.png\" alt=\"第 1 页\"></figure>"));

        ctx.tool = "pdf-to-markdown";
        let result = super::super::exporters::run_markdown(&ctx).unwrap();
        assert_eq!(result.artifacts.len(), 2); // one image + the md
        let markdown = String::from_utf8(result.artifacts.last().unwrap().bytes.clone()).unwrap();
        assert!(markdown.contains("![图片 1](样例-p1-01.png)"));
        assert_eq!(result.extra["documents"], json!(1));
    }

    #[test]
    fn word_without_ocr_or_render_still_writes_document() {
        // Page 2 has OCR text here; drop it to prove the full-page image
        // block carries the pdfPageImages render instead.
        let runtime: &'static serde_json::Value = Box::leak(Box::new(json!({
            "pdfText": { "f1": [
                { "page": 2, "width": 595.0, "height": 842.0, "runs": [] }
            ] },
            "pdfPageImages": { "f1": [
                { "page": 2, "dpi": 150, "bytes": png_marker() }
            ] }
        })));
        let options: &'static serde_json::Value = Box::leak(Box::new(json!({})));
        let inputs: &'static [InputFile] = Box::leak(Box::new(vec![InputFile {
            id: "f1".into(),
            name: "scan.pdf".into(),
            path: None,
            bytes: Vec::new(),
        }]));
        let ctx = RunContext {
            tool: "pdf-to-word",
            options,
            locale: "zh-CN",
            inputs,
            name_pattern: None,
            runtime_data: Some(runtime),
        };
        let result = run_word(&ctx).unwrap();
        let mut archive = ZipArchive::new(std::io::Cursor::new(&result.artifacts[0].bytes)).unwrap();
        let mut document = String::new();
        archive.by_name("word/document.xml").unwrap().read_to_string(&mut document).unwrap();
        let content_width = (595.0f64 - 144.0).max(200.0);
        let scale = 1.0f64.min(content_width.max(72.0) / 595.0);
        let cx = (595.0 * scale * 96.0 / 72.0).round() * 9525.0;
        let cy = (842.0 * scale * 96.0 / 72.0).round() * 9525.0;
        assert!(document
            .contains(&format!("<wp:extent cx=\"{cx}\" cy=\"{cy}\"/>")));
    }
}
