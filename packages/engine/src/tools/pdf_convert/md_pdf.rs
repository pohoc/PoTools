//! `markdown-to-pdf` runner (oracle `markdown-to-pdf-browser.ts`): binary
//! guard, `parseMarkdown`, page-size preset, then the typesetter with the
//! tool's style overrides (`{size, lineHeight: 1.5, paragraphGap: 8,
//! headingGap: 12, indent: 18}`). Image bytes arrive pre-resolved through
//! `runtimeData.markdownAssets` (keyed `` `${inputId}\0${src}` ``); the
//! configured font comes through `runtimeData.markdownFontBytes`.

use super::md_parse::{parse_markdown, MdBlock};
use super::pdfdoc::PdfDoc;
use super::typesetter::{FontSource, TypesetStyle, Typesetter};
use super::{emit, number, string};
use crate::tools::pdf_extra::markup::font::HostFont;
use crate::{EngineError, RunContext, ToolResult};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;

type EngineResult<T> = Result<T, EngineError>;

/// `lib/pdf.ts` `PAGE_SIZES`.
const PAGE_SIZES: [(&str, f64, f64); 5] = [
    ("a3", 841.89, 1190.55),
    ("a4", 595.28, 841.89),
    ("a5", 419.53, 595.28),
    ("letter", 612.0, 792.0),
    ("legal", 612.0, 1008.0),
];

pub(super) fn run(ctx: &RunContext<'_>) -> EngineResult<ToolResult> {
    let page_size = string(ctx.options, "pageSize");
    let margin = number(ctx.options, "margin", 56.0).clamp(0.0, 120.0);
    let font_size = number(ctx.options, "fontSize", 11.0).clamp(8.0, 18.0);
    let assets = super::model::markdown_assets(ctx);
    let font_bytes = super::model::markdown_font_bytes(ctx);
    let host_fonts: Vec<HostFont> = super::model::font_resources(ctx)
        .into_iter()
        .map(|font| HostFont {
            name: font.name,
            bytes: font.bytes,
        })
        .collect();
    let source = match font_bytes {
        Some(bytes) => FontSource::Configured(Arc::new(bytes)),
        None => FontSource::HostSystem(Arc::new(host_fonts)),
    };

    let mut result = ToolResult::default();
    let mut pages_out = 0usize;
    for input in ctx.inputs {
        // The TS decodes the first 8 bytes as UTF-8 and rejects PDF/zip magic.
        let head: String = String::from_utf8_lossy(&input.bytes[..input.bytes.len().min(8)])
            .into_owned();
        if head.starts_with("%PDF") || head.starts_with("PK") {
            return Err(EngineError::new(
                "unreadable_file",
                format!("{} 是二进制文件，Markdown 导入只接受纯文本 .md", input.name),
            )
            .with_hint("error.notMarkdown"));
        }
        let doc = parse_markdown(&String::from_utf8_lossy(&input.bytes));
        if doc.blocks.is_empty() {
            return Err(EngineError::new(
                "empty_selection",
                format!("{} 是空文档", input.name),
            ));
        }
        let (box_w, box_h) = page_box(page_size);
        // Image payloads resolved up front (one warning per missing source,
        // like the TS pre-pass) so the typesetter can borrow them freely.
        let mut resolved: HashMap<String, Option<Vec<u8>>> = HashMap::new();
        for block in &doc.blocks {
            let MdBlock::Image { src, .. } = block else {
                continue;
            };
            let key = format!("{}\u{0}{src}", input.id);
            match assets.get(&key) {
                Some(bytes) => {
                    resolved.insert(src.clone(), Some(bytes.clone()));
                }
                None => {
                    result.warnings.push(format!("找不到图片 {src}"));
                    resolved.insert(src.clone(), None);
                }
            }
        }
        let mut out = PdfDoc::new();
        let mut typesetter = Typesetter::new(
            &mut out,
            box_w,
            box_h,
            margin,
            TypesetStyle {
                size: font_size,
                line_height: 1.5,
                paragraph_gap: 8.0,
                heading_gap: 12.0,
                indent: 18.0,
            },
            source.clone(),
        );
        typesetter.block(&doc.blocks, true, &|src| {
            resolved.get(src).and_then(|slot| slot.as_deref())
        })?;
        out.finalize();
        let pages = out.page_count();
        let bytes = out.save()?;
        emit(ctx, &mut result, input, "md-pdf", "pdf", "pdf", bytes);
        pages_out += pages;
    }
    result.extra.insert("pageCountOut".into(), json!(pages_out));
    Ok(result)
}

/// `sizePreset(key) ?? a4` — unknown keys fall back to A4.
fn page_box(key: &str) -> (f64, f64) {
    PAGE_SIZES
        .iter()
        .find(|(name, _, _)| *name == key)
        .map(|(_, w, h)| (*w, *h))
        .unwrap_or((595.28, 841.89))
}

#[cfg(test)]
mod end_to_end {
    use super::*;
    use crate::InputFile;
    use image::RgbaImage;
    use lopdf::{Document, Object};
    use std::io::Cursor;

    fn png_bytes() -> Vec<u8> {
        let image = RgbaImage::from_fn(8, 6, |x, y| image::Rgba([(x * 20) as u8, (y * 30) as u8, 90, 255]));
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        bytes.into_inner()
    }

    fn setup(markdown: &str, runtime: serde_json::Value) -> RunContext<'static> {
        let runtime: &'static serde_json::Value = Box::leak(Box::new(runtime));
        let options: &'static serde_json::Value = Box::leak(Box::new(json!({})));
        let inputs: &'static [InputFile] = Box::leak(Box::new(vec![InputFile {
            id: "f1".into(),
            name: "note.md".into(),
            path: None,
            bytes: markdown.as_bytes().to_vec(),
        }]));
        RunContext {
            tool: "markdown-to-pdf",
            options,
            locale: "zh-CN",
            inputs,
            name_pattern: None,
            runtime_data: Some(runtime),
        }
    }

    #[test]
    fn renders_markdown_with_styles_list_and_resolved_image() {
        let markdown = "# Report\n\nHello **world** and `code`.\n\n![pic](img/a.png)\n\n- one\n- two\n\n1. first\n\n---\n\ntail\n";
        let ctx = setup(
            markdown,
            json!({ "markdownAssets": { "f1\u{0}img/a.png": png_bytes() } }),
        );
        let result = run(&ctx).unwrap();
        assert!(result.warnings.is_empty());
        assert_eq!(result.extra["pageCountOut"], json!(2)); // tail lands on page 2
        let artifact = &result.artifacts[0];
        assert_eq!(artifact.name, "note-md-pdf.pdf");
        assert_eq!(artifact.kind, "pdf");
        let document = Document::load_mem(&artifact.bytes).unwrap();
        assert_eq!(document.get_pages().len(), 2);
        // Courier for the code run, Helvetica for the prose, one image
        // XObject with its /SMask from the alpha PNG.
        let content = document
            .objects
            .values()
            .find_map(|object| match object {
                Object::Stream(stream)
                    if stream.dict.get(b"Length").is_ok() && stream.dict.get(b"Subtype").is_err() =>
                {
                    String::from_utf8(stream.content.clone()).ok()
                }
                _ => None,
            })
            .unwrap();
        assert!(content.contains("/F1"));
        assert!(content.contains("/F3")); // third registered std face (bold/oblique/courier set)
        assert!(content.contains("0.45 0.16 0.2 rg")); // code color
        let image_count = document
            .objects
            .values()
            .filter(|object| matches!(object,
                Object::Stream(stream) if stream.dict.get(b"Subtype").ok()
                    .and_then(|o| o.as_name().ok()) == Some(b"Image".as_slice())))
            .count();
        assert_eq!(image_count, 2); // RGB + SMask
    }

    #[test]
    fn missing_asset_warns_and_drops_the_image() {
        let markdown = "# T\n\n![pic](gone.png)\n\ntext\n";
        let ctx = setup(markdown, json!({}));
        let result = run(&ctx).unwrap();
        assert_eq!(result.warnings, vec!["找不到图片 gone.png".to_owned()]);
        let document = Document::load_mem(&result.artifacts[0].bytes).unwrap();
        let images = document
            .objects
            .values()
            .filter(|object| matches!(object,
                Object::Stream(stream) if stream.dict.get(b"Subtype").ok()
                    .and_then(|o| o.as_name().ok()) == Some(b"Image".as_slice())))
            .count();
        assert_eq!(images, 0);
    }

    #[test]
    fn binary_guard_and_empty_doc_error() {
        let ctx = setup("%PDF-1.4 fake", json!({}));
        let error = run(&ctx).unwrap_err();
        assert_eq!(error.code, "unreadable_file");
        assert_eq!(error.hint_key, Some("error.notMarkdown"));
        let ctx = setup("\n\n", json!({}));
        let error = run(&ctx).unwrap_err();
        assert_eq!(error.code, "empty_selection");
        assert_eq!(error.message, "note.md 是空文档");
    }
}
