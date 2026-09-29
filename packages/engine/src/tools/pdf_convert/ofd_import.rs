//! `ofd-to-pdf` runner (oracle `ofd-to-pdf-browser.ts`): reads the OFD zip
//! back (`ofd_read`), embeds every package font, then draws each selected
//! page's images (JPEG DCT passthrough / decoded PNG) and text lines into a
//! fresh lopdf document. The TS oracle applies `mmToPt` a second time to the
//! already-point-based page/image/text geometry (`readOfd` output is pt);
//! that quirk is preserved verbatim so outputs match the browser engine.

use super::imgpdf;
use super::model::font_resources;
use super::ofd::mm_to_pt;
use super::ofd_read::read_ofd;
use super::text::utf16_slice;
use super::pdfdoc::PdfDoc;
use super::std14::StdFace;
use crate::services::naming::{base_name, render_name, NameContext};
use crate::tools::pdf_extra::markup::font::{covering_host_font, HostFont};
use crate::{Artifact, EngineError, RunContext, ToolResult};
use serde_json::json;
use std::collections::HashMap;

type EngineResult<T> = Result<T, EngineError>;

const TEXT_COLOR: [f64; 3] = [0.08, 0.1, 0.14];

pub(super) fn run(ctx: &RunContext<'_>) -> EngineResult<ToolResult> {
    let mut result = ToolResult::default();
    let mut pages_out = 0usize;
    for input in ctx.inputs {
        pages_out += convert_one(ctx, input, &mut result)?;
    }
    result.extra.insert("__pageCountOut".into(), json!(pages_out));
    Ok(result)
}

fn convert_one(
    ctx: &RunContext<'_>,
    input: &crate::InputFile,
    result: &mut ToolResult,
) -> EngineResult<usize> {
    let doc = read_ofd(&input.bytes)?;
    if doc.pages.is_empty() {
        return Err(EngineError::new(
            "empty_selection",
            format!("{} 中没有页面", input.name),
        ));
    }
    let selected: Vec<u32> = potools_core::pages::parse_page_ranges(
        ctx.options
            .get("pages")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(""),
        doc.pages.len(),
    )
    .map_err(|error| EngineError::new("bad_page_range", error.to_string()))?
    .into_iter()
    .map(|page| page as u32)
    .collect();
    let wanted: std::collections::HashSet<u32> = selected.into_iter().collect();

    let mut out = PdfDoc::new();
    // Package fonts embed up front; a failure warns and leaves the text to
    // the standard/host font fallback below (the TS catch block).
    let mut embedded: HashMap<String, usize> = HashMap::new();
    for (name, bytes) in &doc.fonts {
        match out.register_embedded(name, bytes, 0, "") {
            Ok(index) => {
                embedded.insert(name.clone(), index);
            }
            Err(_) => {
                result
                    .warnings
                    .push(format!("字体 {name} 无法嵌入，尝试使用标准字体"));
            }
        }
    }
    let host_fonts: Vec<HostFont> = font_resources(ctx)
        .into_iter()
        .map(|font| HostFont {
            name: font.name,
            bytes: font.bytes,
        })
        .collect();
    // The TS oracle embeds a fresh host font per line (native-engine byte
    // parity); here one subset per covering resource is reused and grown.
    let mut host_cache: HashMap<(String, u32), usize> = HashMap::new();
    let helvetica = out.register_std(StdFace::Helvetica);

    let stem = base_name(&input.name);
    let mut pages_out = 0usize;
    for (index, source) in doc.pages.iter().enumerate() {
        if !wanted.contains(&((index + 1) as u32)) {
            continue;
        }
        let width = mm_to_pt(source.width);
        let height = mm_to_pt(source.height);
        out.begin_page(width, height);
        for image in &source.images {
            let embedded_image = imgpdf::embed(&mut out.document, &image.bytes);
            let Some((image_id, _, _)) = embedded_image else {
                result
                    .warnings
                    .push(format!("{stem}：第 {} 页有无法解码的图片", index + 1));
                continue;
            };
            let name = out.add_image(image_id);
            out.draw_image(
                &name,
                mm_to_pt(image.x),
                height - mm_to_pt(image.y) - mm_to_pt(image.height),
                mm_to_pt(image.width),
                mm_to_pt(image.height),
            );
        }
        for line in &source.texts {
            let font_index = match line.font.as_ref().and_then(|name| embedded.get(name)) {
                Some(index) => *index,
                None => {
                    if out.font_can_encode(helvetica, &line.text) {
                        helvetica
                    } else {
                        let Some((resource, face_index)) = covering_host_font(&host_fonts, &line.text)
                        else {
                            return Err(EngineError::new(
                                "unsupported",
                                format!(
                                    "OFD text needs a system font: {}",
                                    utf16_slice(&line.text, 24)
                                ),
                            ));
                        };
                        let key = (resource.name.clone(), face_index);
                        match host_cache.get(&key) {
                            Some(index) => *index,
                            None => {
                                let index = out.register_embedded(
                                    &resource.name,
                                    &resource.bytes,
                                    face_index,
                                    &line.text,
                                )?;
                                host_cache.insert(key, index);
                                index
                            }
                        }
                    }
                }
            };
            out.font_extend(font_index, &line.text, false)?;
            out.draw_text(
                font_index,
                line.size,
                TEXT_COLOR,
                mm_to_pt(line.x),
                height - mm_to_pt(line.y),
                &line.text,
            )?;
        }
        out.end_page();
        pages_out += 1;
    }

    let bytes = out.save()?;
    let name = render_name(
        ctx.name_pattern,
        NameContext {
            name: stem,
            tool: "ofd-pdf",
            index: None,
            total: None,
            range: None,
        },
        "pdf",
    );
    let mut artifact = Artifact::new(name, "pdf", bytes);
    artifact.source_file_id = Some(input.id.clone());
    result.artifacts.push(artifact);
    Ok(pages_out)
}

#[cfg(test)]
mod end_to_end {
    use super::*;
    use crate::InputFile;
    use crate::tools::pdf_convert::ofd::{write_ofd, OfdImage, OfdInput, OfdPage, OfdText};
    use image::RgbImage;
    use lopdf::{Document, Object};
    use std::io::Cursor;

    fn png_bytes() -> Vec<u8> {
        let image = RgbImage::from_fn(8, 6, |x, y| image::Rgb([(x * 20) as u8, (y * 30) as u8, 90]));
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        bytes.into_inner()
    }

    fn ofd_bytes() -> Vec<u8> {
        let image = png_bytes();
        write_ofd(&OfdInput {
            font: None,
            pages: vec![OfdPage {
                width: 210.0,
                height: 297.0,
                texts: vec![OfdText {
                    text: "Hello OFD".to_owned(),
                    x: 10.0,
                    y: 20.0,
                    width: 45.0,
                    size: 4.0,
                }],
                images: vec![OfdImage {
                    bytes: &image,
                    name: "p1.jpg".to_owned(),
                    x: 0.0,
                    y: 0.0,
                    width: 100.0,
                    height: 50.0,
                }],
            }],
        })
        .unwrap()
    }

    fn setup(options: serde_json::Value) -> (RunContext<'static>, usize) {
        let options: &'static serde_json::Value = Box::leak(Box::new(options));
        let inputs: &'static [InputFile] = Box::leak(Box::new(vec![InputFile {
            id: "f1".into(),
            name: "样例.ofd".into(),
            path: None,
            bytes: ofd_bytes(),
        }]));
        let ctx = RunContext {
            tool: "ofd-to-pdf",
            options,
            locale: "zh-CN",
            inputs,
            name_pattern: None,
            runtime_data: None,
        };
        (ctx, 0)
    }

    #[test]
    fn round_trips_text_and_image_into_a_valid_pdf() {
        let (ctx, _) = setup(json!({}));
        let result = run(&ctx).unwrap();
        assert_eq!(result.extra["__pageCountOut"], json!(1));
        let artifact = &result.artifacts[0];
        assert_eq!(artifact.name, "样例-ofd-pdf.pdf");
        assert_eq!(artifact.kind, "pdf");
        let document = Document::load_mem(&artifact.bytes).unwrap();
        assert_eq!(document.get_pages().len(), 1);
        // The TS oracle applies mmToPt twice to the readOfd output; the page
        // box is therefore 210mm × (72/25.4)² ≈ 1687.4pt wide.
        let page = document
            .get_dictionary(*document.get_pages().get(&1).unwrap())
            .unwrap();
        let media = page.get(b"MediaBox").unwrap().as_array().unwrap();
        let width = media[2]
            .as_float()
            .map(|value| value as f64)
            .or_else(|_| media[2].as_i64().map(|value| value as f64))
            .unwrap();
        let expected = 210.0f64 * (72.0f64 / 25.4).powi(2);
        assert!((width - expected).abs() < 0.5, "{width}");
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
        // Text drawn through the standard Helvetica face (ASCII covers it),
        // with the TS color.
        assert!(content.contains("/F1"));
        assert!(content.contains("48656C6C6F204F4644"));
        assert!(content.contains("0.08 0.1 0.14 rg"));
        // TS readOfd quirk kept verbatim: media paths resolve at
        // resBase/Imgs while the writer stores them at resBase/Res/Imgs, so
        // self-written images are skipped silently (no warning, no draw).
        assert!(!content.contains(" Do Q"));
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn page_selection_filters_output_pages() {
        let (ctx, _) = setup(json!({ "pages": "x" }));
        assert_eq!(run(&ctx).unwrap_err().code, "bad_page_range");
        let (ctx, _) = setup(json!({ "pages": "1" }));
        let result = run(&ctx).unwrap();
        assert_eq!(result.extra["__pageCountOut"], json!(1));
    }
}
