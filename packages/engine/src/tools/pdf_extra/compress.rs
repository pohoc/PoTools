use super::{boolean, info_dict, load, save, set_info_string, store_info, EngineResult};
use crate::services::naming::{base_name, dedupe, render_name, NameContext};
use crate::{Artifact, EngineError, RunContext, ToolResult};
use image::codecs::jpeg::JpegEncoder;
use image::{ColorType, ImageDecoder, ImageFormat, ImageReader as NewImageReader};
use lopdf::{Dictionary, Document, Object};
use serde_json::{json, Value};
use std::io::Cursor;

const MAX_DECODED_PIXELS: u64 = 80_000_000;
const DEFAULT_QUALITY: f64 = 70.0;
const DEFAULT_DPI: f64 = 150.0;

pub(super) fn run(ctx: &RunContext<'_>) -> Result<Option<ToolResult>, EngineError> {
    if ctx.inputs.is_empty() {
        return Err(EngineError::new("bad_request", "请先添加文件"));
    }

    let resample = boolean(ctx.options, "resampleImages", false);
    let quality = if resample {
        clamp_number(
            number(ctx, "imageQuality", DEFAULT_QUALITY),
            20.0,
            96.0,
            DEFAULT_QUALITY,
        ) as u8
    } else {
        100
    };
    let dpi = if resample {
        clamp_number(number(ctx, "maxDpi", DEFAULT_DPI), 72.0, 300.0, DEFAULT_DPI)
    } else {
        300.0
    };
    let max_edge = (dpi / 72.0 * 612.0).round() as u32;
    let strip_metadata = boolean(ctx.options, "stripMetadata", false);
    let mut result = ToolResult::default();
    let mut total_in = 0usize;
    let mut total_out = 0usize;
    let mut images_replaced = 0usize;

    for input in ctx.inputs {
        let mut document = load(input)?;
        let stats = if resample {
            match recompress_images(&mut document, max_edge, quality)? {
                RecompressResult::Stats(stats) => stats,
                RecompressResult::NeedsBrowserFallback => return Ok(None),
            }
        } else {
            ImageStats::default()
        };
        if stats.skipped > 0 {
            result.warnings.push(format!(
                "{}：{} 张图片因带透明度/特殊色彩空间被跳过",
                base_name(&input.name),
                stats.skipped
            ));
        }
        images_replaced += stats.replaced;

        if strip_metadata {
            let mut info = info_dict(&document);
            for key in [b"Title".as_slice(), b"Author", b"Subject", b"Keywords"] {
                info.remove(key);
            }
            store_info(&mut document, info);
            remove_xmp_if_present(&mut document);
        }
        update_pdf_lib_save_metadata(&mut document);
        let object_streams = boolean(ctx.options, "objectStreams", true);
        if object_streams && document.trailer.get(b"Encrypt").is_ok() {
            // lopdf cannot safely put already-encrypted objects into object streams.
            return Ok(None);
        }
        let bytes = if object_streams {
            save_with_object_streams(&mut document)?
        } else {
            save(&mut document)?
        };
        total_in = total_in.saturating_add(input.bytes.len());
        total_out = total_out.saturating_add(bytes.len());
        if bytes.len() > input.bytes.len() {
            let percent = (bytes.len() as f64 / input.bytes.len() as f64 - 1.0) * 100.0;
            result.warnings.push(format!(
                "{}：已优化结构但体积变大 {:.1}%，可保留原文件",
                base_name(&input.name),
                percent
            ));
        }

        let name = render_name(
            ctx.name_pattern,
            NameContext {
                name: base_name(&input.name),
                tool: "compressed",
                index: None,
                total: None,
                range: None,
            },
            "pdf",
        );
        let name = dedupe(name, |candidate| {
            result
                .artifacts
                .iter()
                .any(|artifact| artifact.name == candidate)
        });
        let mut artifact = Artifact::new(name, "pdf", bytes);
        artifact.source_file_id = Some(input.id.clone());
        result.artifacts.push(artifact);
    }

    let saved_percent = if total_in == 0 {
        0
    } else {
        js_round((total_in as f64 - total_out as f64) / total_in as f64 * 100.0) as i64
    };
    result
        .extra
        .insert("savedPercent".into(), Value::from(saved_percent));
    result
        .extra
        .insert("imagesReplaced".into(), json!(images_replaced));
    Ok(Some(result))
}

fn save_with_object_streams(document: &mut Document) -> EngineResult<Vec<u8>> {
    // Write PDF 1.5 ObjStm containers plus a cross-reference stream directly;
    // the plain save() used by every other PDF tool keeps the classic layout.
    let options = lopdf::SaveOptions::builder()
        .use_object_streams(true)
        .use_xref_streams(true)
        .build();
    let mut output = Vec::new();
    document
        .save_with_options(&mut output, options)
        .map_err(|error| EngineError::new("internal", format!("PDF object stream 写入失败：{error}")))?;
    Ok(output)
}

#[derive(Default)]
struct ImageStats {
    replaced: usize,
    skipped: usize,
}

enum RecompressResult {
    Stats(ImageStats),
    NeedsBrowserFallback,
}

fn recompress_images(
    document: &mut Document,
    max_edge: u32,
    quality: u8,
) -> EngineResult<RecompressResult> {
    let image_ids = document
        .objects
        .iter()
        .filter_map(|(id, object)| match object {
            Object::Stream(stream) if is_image_stream(&stream.dict) => Some(*id),
            _ => None,
        })
        .collect::<Vec<_>>();
    let mut stats = ImageStats::default();
    for id in image_ids {
        let Some(Object::Stream(stream)) = document.objects.get(&id) else {
            continue;
        };
        if is_image_mask(&stream.dict) {
            continue;
        }
        if !is_recompressible(&stream.dict) {
            stats.skipped += 1;
            continue;
        }
        let source = stream.content.clone();
        if source.is_empty() {
            stats.skipped += 1;
            continue;
        }
        let (width, height, encoded) = match recompress_jpeg(&source, max_edge, quality)? {
            JpegResult::TooLarge => return Ok(RecompressResult::NeedsBrowserFallback),
            JpegResult::Unchanged => {
                stats.skipped += 1;
                continue;
            }
            JpegResult::Recompressed {
                width,
                height,
                bytes,
            } => {
                if bytes.len() >= source.len() {
                    stats.skipped += 1;
                    continue;
                }
                (width, height, bytes)
            }
        };
        if let Some(Object::Stream(stream)) = document.objects.get_mut(&id) {
            stream.dict.set("Width", width as i64);
            stream.dict.set("Height", height as i64);
            stream.set_content(encoded);
            stats.replaced += 1;
        }
    }
    Ok(RecompressResult::Stats(stats))
}

enum JpegResult {
    TooLarge,
    Unchanged,
    Recompressed {
        width: u32,
        height: u32,
        bytes: Vec<u8>,
    },
}

fn recompress_jpeg(source: &[u8], max_edge: u32, quality: u8) -> EngineResult<JpegResult> {
    let reader = NewImageReader::with_format(Cursor::new(source), ImageFormat::Jpeg);
    let Ok(mut decoder) = reader.into_decoder() else {
        return Ok(JpegResult::Unchanged);
    };
    let (source_width, source_height) = decoder.dimensions();
    if u64::from(source_width) * u64::from(source_height) > MAX_DECODED_PIXELS {
        return Ok(JpegResult::TooLarge);
    }
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let Ok(mut image) = image::DynamicImage::from_decoder(decoder) else {
        return Ok(JpegResult::Unchanged);
    };
    image.apply_orientation(orientation);
    let source_width = image.width();
    let source_height = image.height();
    let scale = (max_edge as f64 / source_width.max(source_height) as f64).min(1.0);
    let width = ((source_width as f64 * scale).round() as u32).max(1);
    let height = ((source_height as f64 * scale).round() as u32).max(1);
    if width == source_width && height == source_height {
        return Ok(JpegResult::Unchanged);
    }

    let mut output = Vec::new();
    if image.color().has_color() {
        let resized = image
            .resize_exact(width, height, image::imageops::FilterType::Triangle)
            .to_rgb8();
        JpegEncoder::new_with_quality(&mut output, quality)
            .encode(&resized, width, height, ColorType::Rgb8.into())
            .map_err(|_| EngineError::new("internal", "JPEG 图像压缩失败"))?;
    } else {
        let resized = image
            .resize_exact(width, height, image::imageops::FilterType::Triangle)
            .to_luma8();
        JpegEncoder::new_with_quality(&mut output, quality)
            .encode(&resized, width, height, ColorType::L8.into())
            .map_err(|_| EngineError::new("internal", "JPEG 图像压缩失败"))?;
    }
    Ok(JpegResult::Recompressed {
        width,
        height,
        bytes: output,
    })
}

fn is_image_stream(dict: &Dictionary) -> bool {
    name_str(dict, b"Subtype").as_deref() == Some("Image")
}

/// lopdf 0.45 dropped `Object::as_name_str`; this keeps the same strict-UTF-8
/// semantics for PDF name lookups.
fn name_str(dict: &Dictionary, key: &[u8]) -> Option<String> {
    dict.get(key)
        .and_then(Object::as_name)
        .ok()
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
        .map(str::to_owned)
}

fn is_image_mask(dict: &Dictionary) -> bool {
    matches!(dict.get(b"ImageMask"), Ok(Object::Boolean(true)))
}

fn is_recompressible(dict: &Dictionary) -> bool {
    let filter_ok = name_str(dict, b"Filter").as_deref() == Some("DCTDecode");
    let has_soft_mask = dict.get(b"SMask").is_ok();
    let bits_per_component = dict.get(b"BitsPerComponent").and_then(Object::as_i64).ok();
    let color_space = name_str(dict, b"ColorSpace");
    filter_ok
        && !has_soft_mask
        && bits_per_component == Some(8)
        && matches!(color_space.as_deref(), Some("DeviceRGB" | "DeviceGray"))
}

fn remove_xmp_if_present(document: &mut Document) {
    let Some(root_id) = document
        .trailer
        .get(b"Root")
        .and_then(Object::as_reference)
        .ok()
    else {
        return;
    };
    if let Ok(root) = document.get_dictionary_mut(root_id) {
        root.remove(b"Metadata");
    }
}

fn update_pdf_lib_save_metadata(document: &mut Document) {
    const LIB_PRODUCER: &str = "pdf-lib (https://github.com/Hopding/pdf-lib)";
    let saved_at = chrono::Utc::now().format("D:%Y%m%d%H%M%SZ").to_string();
    let mut info = info_dict(document);
    if info.get(b"Creator").is_err() {
        set_info_string(&mut info, b"Creator", LIB_PRODUCER);
    }
    set_info_string(&mut info, b"Producer", LIB_PRODUCER);
    set_info_string(&mut info, b"ModDate", &saved_at);
    if info.get(b"CreationDate").is_err() {
        set_info_string(&mut info, b"CreationDate", &saved_at);
    }
    store_info(document, info);
}

fn number(ctx: &RunContext<'_>, key: &str, default: f64) -> f64 {
    ctx.options
        .get(key)
        .and_then(Value::as_f64)
        .unwrap_or(default)
}

fn clamp_number(value: f64, min: f64, max: f64, fallback: f64) -> f64 {
    if !value.is_finite() || value == 0.0 {
        fallback
    } else {
        value.round().clamp(min, max)
    }
}

fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

#[cfg(test)]
mod tests {
    use super::run;
    use crate::{InputFile, RunContext};
    use lopdf::{dictionary, Dictionary, Document, Object, Stream};
    use serde_json::json;
    use std::io::Cursor;

    /// Minimal one-page PDF with an uncompressed text content stream, saved
    /// classically (xref table, no object streams).
    fn sample_pdf() -> Vec<u8> {
        let mut document = Document::with_version("1.4");
        let pages_id = document.add_object(Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => Object::Array(Vec::new()),
            "Count" => Object::Integer(0),
        }));
        let catalog_id = document.add_object(Object::Dictionary(dictionary! {
            "Type" => "Catalog",
            "Pages" => Object::Reference(pages_id),
        }));
        document.trailer.set("Root", Object::Reference(catalog_id));
        let content_id = document.add_object(Stream::new(
            Dictionary::new(),
            b"BT /F1 24 Tf 72 700 Td (Hello PoTools) Tj ET".to_vec(),
        ));
        let page_id = document.add_object(Object::Dictionary(dictionary! {
            "Type" => "Page",
            "Parent" => Object::Reference(pages_id),
            "MediaBox" => Object::Array(vec![
                Object::Integer(0),
                Object::Integer(0),
                Object::Integer(612),
                Object::Integer(792),
            ]),
            "Contents" => Object::Reference(content_id),
        }));
        if let Some(Object::Dictionary(pages)) = document.objects.get_mut(&pages_id) {
            pages.set("Kids", Object::Array(vec![Object::Reference(page_id)]));
            pages.set("Count", Object::Integer(1));
        }
        let mut output = Cursor::new(Vec::new());
        document.save_to(&mut output).unwrap();
        output.into_inner()
    }

    fn object_type_names(document: &Document) -> Vec<Vec<u8>> {
        document
            .objects
            .values()
            .filter_map(|object| match object {
                Object::Stream(stream) => stream
                    .dict
                    .get(b"Type")
                    .and_then(Object::as_name)
                    .ok()
                    .map(<[u8]>::to_vec),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn compress_writes_object_streams_that_still_hold_the_page() {
        let context = RunContext {
            tool: "compress",
            options: &json!({}),
            locale: "zh-CN",
            inputs: &[InputFile {
                id: "a".into(),
                name: "in.pdf".into(),
                path: None,
                bytes: sample_pdf(),
            }],
            name_pattern: None,
            runtime_data: None,
        };
        let result = run(&context).unwrap().expect("compress must handle a PDF");
        assert_eq!(result.artifacts.len(), 1);
        let artifact = &result.artifacts[0];
        assert_eq!(artifact.kind, "pdf");
        assert!(result.extra["savedPercent"].is_i64());

        // The output contract: PDF 1.5 ObjStm containers plus a cross-reference
        // stream, while the page tree survives the rewrite.
        let bytes = &artifact.bytes;
        assert!(bytes.windows(b"/ObjStm".len()).any(|w| w == b"/ObjStm"));
        assert!(bytes.windows(b"/XRef".len()).any(|w| w == b"/XRef"));
        let document = Document::load_mem(bytes).unwrap();
        let types = object_type_names(&document);
        assert!(types.iter().any(|name| name == b"ObjStm"));
        assert!(types.iter().any(|name| name == b"XRef"));
        assert_eq!(document.get_pages().len(), 1);
        let page_id = document.get_pages().values().next().copied().unwrap();
        let content = String::from_utf8_lossy(&document.get_page_content(page_id)).into_owned();
        assert!(content.contains("(Hello PoTools) Tj"));
    }
}
