//! `pdf-to-ofd` runner (oracle `tools/pdf-to-ofd-browser.ts`): text mode
//! lays the merged `pdfText` lines out in millimetres under one covering
//! font (the adapter-supplied `ofdFont` wins, else the first `systemFonts`
//! entry whose glyphs cover the document), image mode embeds one full-page
//! render per page. The TS `InMemoryFallback` for a missing covering font
//! surfaces here as a real `unsupported` error — the browser fallback path
//! no longer exists for this tool.

use super::emit;
use super::layout::pages_for;
use super::model::{font_resources, ofd_font, pdf_page_images};
use super::ofd::{pt_to_mm, write_ofd, OfdFont, OfdImage, OfdInput, OfdPage, OfdText};
use crate::services::naming::base_name;
use crate::tools::pdf_extra::markup::font::{covering_host_font, HostFont};
use crate::{EngineError, RunContext, ToolResult};
use serde_json::json;

type RunResult = Result<ToolResult, EngineError>;

/// Fonts larger than this are registered by name only (readers fall back by
/// name), with one job-level warning — the TS contract.
const MAX_EMBEDDED_FONT_BYTES: usize = 3_000_000;

pub(super) fn run(ctx: &RunContext<'_>) -> RunResult {
    let mode = match ctx.options.get("mode").and_then(serde_json::Value::as_str) {
        Some("image") => "image",
        // TS: String(ctx.options.mode ?? 'text') — unknown values degrade to
        // text mode.
        _ => "text",
    };
    let raw_font_present = ctx
        .runtime_data
        .map(|data| data.get("ofdFont").is_some())
        .unwrap_or(false);
    let font_resource = ofd_font(ctx);
    let host_fonts: Vec<HostFont> = font_resources(ctx)
        .into_iter()
        .map(|font| HostFont {
            name: font.name,
            bytes: font.bytes,
        })
        .collect();
    let mut result = ToolResult::default();
    let mut produced = 0usize;
    let mut oversize_warned = false;
    for input in ctx.inputs {
        let pages = pages_for(ctx, &input.id);
        if pages.is_empty() {
            return Err(EngineError::new(
                "empty_selection",
                format!("{} 没有页面", input.name),
            ));
        }
        // The font must cover every text line whose run carries no font hint.
        let needed_text: String = pages
            .iter()
            .flat_map(|page| page.lines.iter())
            .filter(|line| line.font.is_empty())
            .map(|line| line.text.as_str())
            .collect();
        let matched: Option<(&String, &Vec<u8>)> = if mode == "text" && !raw_font_present {
            covering_host_font(&host_fonts, &needed_text).map(|(font, _)| (&font.name, &font.bytes))
        } else {
            None
        };
        let selected: Option<(&str, &[u8])> = match font_resource.as_ref() {
            Some(font) => Some((font.name.as_str(), font.bytes.as_slice())),
            None => matched.map(|(name, bytes)| (name.as_str(), bytes.as_slice())),
        };
        if mode == "text" && selected.is_none() {
            return Err(EngineError::new(
                "unsupported",
                "Text-mode OFD export requires a system font that covers the document",
            ));
        }
        let font = if mode == "text" {
            selected.map(|(name, bytes)| {
                if bytes.len() > MAX_EMBEDDED_FONT_BYTES {
                    if !oversize_warned {
                        oversize_warned = true;
                        result.warnings.push(
                            "字体体积过大，OFD 内只登记字体名，请用装有该字体的阅读器打开"
                                .to_owned(),
                        );
                    }
                    OfdFont { name, bytes: None }
                } else {
                    OfdFont {
                        name,
                        bytes: Some(bytes),
                    }
                }
            })
        } else {
            None
        };

        let stem = base_name(&input.name);
        let mut ofd_pages: Vec<OfdPage<'_>> = Vec::new();
        let renders = if mode == "image" {
            pdf_page_images(ctx, &input.id)
        } else {
            Vec::new()
        };
        for page in &pages {
            let width = pt_to_mm(page.width);
            let height = pt_to_mm(page.height);
            if mode == "text" {
                ofd_pages.push(OfdPage {
                    width,
                    height,
                    texts: page
                        .lines
                        .iter()
                        .map(|line| OfdText {
                            text: line.text.clone(),
                            x: pt_to_mm(line.x),
                            // Baseline offset: line.y is the box top.
                            y: pt_to_mm(line.y + line.size_max * 0.82),
                            width: pt_to_mm(line.w),
                            // The largest run size in the merged line stands
                            // in for the TS stext line size.
                            size: pt_to_mm(line.size_max),
                        })
                        .collect(),
                    images: Vec::new(),
                });
                continue;
            }
            let Some(entry) = renders
                .iter()
                .find(|entry| entry.page == page.page)
                .filter(|entry| !entry.bytes.is_empty())
            else {
                continue;
            };
            ofd_pages.push(OfdPage {
                width,
                height,
                texts: Vec::new(),
                images: vec![OfdImage {
                    bytes: &entry.bytes,
                    name: format!("{stem}-p{}.png", page.page),
                    x: 0.0,
                    y: 0.0,
                    width,
                    height,
                }],
            });
        }
        if ofd_pages.is_empty() {
            return Err(EngineError::new("no_rasterizer", "没有可导出的页面")
                .with_hint("error.noRasterizer"));
        }
        let bytes = write_ofd(&OfdInput {
            font,
            pages: ofd_pages,
        })?;
        emit(ctx, &mut result, input, "ofd", "ofd", "ofd", bytes);
        produced += 1;
    }
    result.extra.insert("documents".into(), json!(produced));
    Ok(result)
}

#[cfg(test)]
mod end_to_end {
    use super::*;
    use crate::{InputFile, RunContext};
    use std::io::Read as _;
    use zip::ZipArchive;

    fn setup(options: serde_json::Value, runtime: serde_json::Value) -> RunContext<'static> {
        let runtime: &'static serde_json::Value = Box::leak(Box::new(runtime));
        let options: &'static serde_json::Value = Box::leak(Box::new(options));
        let inputs: &'static [InputFile] = Box::leak(Box::new(vec![InputFile {
            id: "f1".into(),
            name: "样例.pdf".into(),
            path: None,
            bytes: Vec::new(),
        }]));
        RunContext {
            tool: "pdf-to-ofd",
            options,
            locale: "zh-CN",
            inputs,
            name_pattern: None,
            runtime_data: Some(runtime),
        }
    }

    fn text_runtime() -> serde_json::Value {
        json!({
            "pdfText": { "f1": [
                { "page": 1, "width": 595.0, "height": 842.0, "runs": [
                    { "text": "你好 OFD", "x": 40.0, "y": 40.0, "w": 120.0, "h": 12.0, "size": 12.0 }
                ] }
            ] },
            "ofdFont": { "name": "TestFont", "bytes": [1, 2, 3] }
        })
    }

    #[test]
    fn text_mode_bundles_font_and_writes_gb_template() {
        let ctx = setup(json!({}), text_runtime());
        let result = run(&ctx).unwrap();
        assert_eq!(result.extra["documents"], json!(1));
        let artifact = &result.artifacts[0];
        assert_eq!(artifact.name, "样例-ofd.ofd");
        assert_eq!(artifact.kind, "ofd");
        let mut archive = ZipArchive::new(std::io::Cursor::new(&artifact.bytes)).unwrap();
        let mut ofd_xml = String::new();
        archive
            .by_name("OFD.xml")
            .unwrap()
            .read_to_string(&mut ofd_xml)
            .unwrap();
        assert!(ofd_xml.contains("http://www.ofdspec.org/2016"));
        let doc_id = ofd_xml
            .split("<ofd:DocID>")
            .nth(1)
            .unwrap()
            .split("</ofd:DocID>")
            .next()
            .unwrap();
        assert_eq!(doc_id.len(), 16);
        assert!(doc_id.chars().all(|c| c.is_ascii_hexdigit()));
        let mut document = String::new();
        archive
            .by_name("Doc_0/Document.xml")
            .unwrap()
            .read_to_string(&mut document)
            .unwrap();
        assert!(document.contains("<ofd:Page ID=\"100\" BaseLoc=\"Pages/Page_0/Content.xml\"/>"));
        assert!(document.contains("0 0 209.9027"), "PhysicalBox: {document}");
        assert!(document.contains("297.0388"));
        let mut content = String::new();
        archive
            .by_name("Doc_0/Pages/Page_0/Content.xml")
            .unwrap()
            .read_to_string(&mut content)
            .unwrap();
        // Baseline offset y = ptToMm(40 + 12*0.82) ≈ 17.11, DeltaX splits the
        // width over the code points (8 of them).
        // 6 code points in "你好 OFD"; ptToMm(120) / 6.
        assert!(content.contains("DeltaX=\"1 7.056\""));
        assert!(content.contains("<ofd:TextCode X=\"0\" Y=\"0\""));
        assert!(content.contains("你好 OFD"));
        let mut font_bytes = Vec::new();
        archive
            .by_name("Doc_0/Res/fonts/TestFont")
            .unwrap()
            .read_to_end(&mut font_bytes)
            .unwrap();
        assert_eq!(font_bytes, vec![1, 2, 3]);
        let mut res = String::new();
        archive
            .by_name("Doc_0/DocumentRes.xml")
            .unwrap()
            .read_to_string(&mut res)
            .unwrap();
        assert!(res.contains("FontName=\"TestFont\""));
        assert!(res.contains("<ofd:FontFile>fonts/TestFont</ofd:FontFile>"));
    }

    #[test]
    fn text_mode_without_a_covering_font_is_a_hard_error() {
        let ctx = setup(
            json!({}),
            json!({
                "pdfText": { "f1": [
                    { "page": 1, "width": 595.0, "height": 842.0, "runs": [
                        { "text": "中文", "x": 0.0, "y": 0.0, "w": 10.0, "h": 10.0, "size": 10.0 }
                    ] }
                ] }
            }),
        );
        let error = run(&ctx).unwrap_err();
        assert_eq!(error.code, "unsupported");
        assert_eq!(
            error.message,
            "Text-mode OFD export requires a system font that covers the document"
        );
    }

    #[test]
    fn image_mode_places_one_full_page_render_per_page() {
        let ctx = setup(
            json!({ "mode": "image", "dpi": 96 }),
            json!({
                "pdfText": { "f1": [
                    { "page": 1, "width": 595.0, "height": 842.0, "runs": [] }
                ] },
                "pdfPageImages": { "f1": [
                    { "page": 1, "dpi": 96, "bytes": [7, 8, 9] }
                ] }
            }),
        );
        let result = run(&ctx).unwrap();
        let mut archive =
            ZipArchive::new(std::io::Cursor::new(&result.artifacts[0].bytes)).unwrap();
        assert!(archive.by_name("Doc_0/Res/Imgs/样例-p1.png").is_ok());
        let mut content = String::new();
        archive
            .by_name("Doc_0/Pages/Page_0/Content.xml")
            .unwrap()
            .read_to_string(&mut content)
            .unwrap();
        assert!(content.contains("<ofd:ImageObject"));
        assert!(content.contains("ResourceID="));
    }
}
