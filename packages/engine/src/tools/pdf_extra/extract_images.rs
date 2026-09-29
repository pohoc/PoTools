//! Extracts embedded image XObjects from the selected pages of PDF documents.
//!
//! Mirrors the browser implementation: each selected page's /Resources
//! /XObject dictionary is walked recursively into /Form XObjects, image
//! streams are deduplicated per document and filtered by their native
//! stream filter. Non-`original` formats re-encode through the `image`
//! crate; any decode/encode failure falls back to the original stream
//! bytes so unsupported/invalid codecs remain available in their
//! original form (matching the browser fallback).

use super::pages::{inherited, parse_pages};
use super::{base_name, load, number, string, EngineError, EngineResult};
use crate::{Artifact, InputFile, RunContext, ToolResult};
use image::{codecs::jpeg::JpegEncoder, DynamicImage, ExtendedColorType, ImageDecoder, ImageFormat, ImageReader};use lopdf::{Dictionary, Document, Object, ObjectId};
use serde_json::json;
use std::collections::HashSet;
use std::io::Cursor;

const XOBJECT_DEPTH: usize = 4;
const MAX_EDGE: u32 = 16_000;
const MAX_PIXELS: u64 = 120_000_000;
const CONVERT_QUALITY: u8 = 90;

pub(super) fn run(ctx: &RunContext<'_>) -> EngineResult<ToolResult> {
    let wanted = string(ctx.options, "format", "original");
    let min_bytes = (number(ctx.options, "minBytes", 0.0).max(0.0) * 1024.0) as usize;
    let mut result = ToolResult::default();
    let mut emitted = 0usize;

    for input in ctx.inputs {
        let document = load(input)?;
        let stem = base_name(&input.name);
        let selection =
            parse_pages(&string(ctx.options, "pages", "all"), document.get_pages().len())?;
        let mut seen = HashSet::new();
        let mut counter = 0usize;
        let pages = document.get_pages();
        for page in selection {
            let Some(page_id) = pages.get(&(page as u32)) else {
                continue;
            };
            let mut images = Vec::new();
            collect_images(&document, *page_id, 0, &mut images);
            for object_id in images {
                if !seen.insert(object_id) {
                    continue;
                }
                let Some(Object::Stream(stream)) = document.objects.get(&object_id) else {
                    continue;
                };
                if is_image_mask(&stream.dict) {
                    continue;
                }
                let bytes = stream.content.clone();
                if bytes.len() < min_bytes {
                    continue;
                }
                let filter = stream_filter(&stream.dict).unwrap_or_default();
                let Some(native) = native_extension(&filter) else {
                    continue;
                };
                counter += 1;
                emitted += 1;
                let name = format!("{stem}-img{counter:02}");
                if wanted == "original" {
                    emit(&mut result, input, &format!("{name}.{native}"), bytes);
                    continue;
                }
                match convert(&bytes, &wanted) {
                    Some(converted) => {
                        let ext = output_extension(&wanted);
                        emit(&mut result, input, &format!("{name}.{ext}"), converted);
                    }
                    // Unsupported/invalid image codecs remain available in their original form.
                    None => emit(&mut result, input, &format!("{name}.{native}"), bytes),
                }
            }
        }
        if counter == 0 {
            result.warnings.push(format!("{stem}：未找到符合条件的图片"));
        }
    }
    if emitted == 0 {
        return Err(EngineError::new("empty_selection", "没有可提取的图片"));
    }
    result.extra.insert("images".into(), json!(emitted));
    Ok(result)
}

/// Maps a PDF stream filter to the native raster extension it yields.
fn native_extension(filter: &str) -> Option<&'static str> {
    match filter {
        "DCTDecode" => Some("jpg"),
        "JPXDecode" => Some("jp2"),
        "JBIG2Decode" => Some("jb2"),
        "CCITTFaxDecode" => Some("tif"),
        "FlateDecode" => Some("png"),
        _ => None,
    }
}

fn output_extension(format: &str) -> &'static str {
    match format {
        "jpeg" => "jpg",
        "png" => "png",
        "webp" => "webp",
        _ => "bin",
    }
}

fn is_image_mask(dict: &Dictionary) -> bool {
    matches!(dict.get(b"ImageMask"), Ok(Object::Boolean(true)))
}

fn stream_filter(dict: &Dictionary) -> Option<String> {
    // The browser path stringifies /Name filters and drops the leading slash;
    // array filters never matched a usable extension there either.
    match dict.get(b"Filter").ok()? {
        Object::Name(name) => {
            let name = String::from_utf8_lossy(name);
            Some(name.strip_prefix('/').unwrap_or(&name).to_owned())
        }
        _ => None,
    }
}

/// Walks the page resources into image XObjects, recursing through /Form
/// XObjects up to [`XOBJECT_DEPTH`].
fn collect_images(document: &Document, page_id: ObjectId, depth: usize, found: &mut Vec<ObjectId>) {
    let resources = inherited(document, page_id, b"Resources")
        .and_then(|object| resolved_dictionary(document, &object));
    if let Some(resources) = resources {
        walk_resources(document, &resources, depth, found);
    }
}

fn walk_resources(
    document: &Document,
    resources: &Dictionary,
    depth: usize,
    found: &mut Vec<ObjectId>,
) {
    if depth > XOBJECT_DEPTH {
        return;
    }
    let Some(xobjects) = resources
        .get(b"XObject")
        .ok()
        .and_then(|object| resolved_dictionary(document, object))
    else {
        return;
    };
    for (_key, value) in &xobjects {
        let Some(Object::Stream(stream)) = resolve(document, value) else {
            continue;
        };
        let subtype = stream
            .dict
            .get(b"Subtype")
            .ok()
            .and_then(as_name_string)
            .unwrap_or_default();
        match subtype {
            "Image" => {
                if let Object::Reference(id) = value {
                    found.push(*id);
                }
            }
            "Form" => {
                // Form XObjects fall back to their parent resources, as in the browser.
                let inner = stream
                    .dict
                    .get(b"Resources")
                    .ok()
                    .and_then(|object| resolved_dictionary(document, object))
                    .unwrap_or_else(|| resources.clone());
                walk_resources(document, &inner, depth + 1, found);
            }
            _ => {}
        }
    }
}

fn resolve<'a>(document: &'a Document, object: &'a Object) -> Option<&'a Object> {
    match object {
        Object::Reference(id) => document.objects.get(id),
        other => Some(other),
    }
}

fn as_name_string(object: &Object) -> Option<&str> {
    match object {
        Object::Name(name) => std::str::from_utf8(name).ok(),
        _ => None,
    }
}

fn resolved_dictionary(document: &Document, object: &Object) -> Option<Dictionary> {
    match resolve(document, object)? {
        Object::Dictionary(dictionary) => Some(dictionary.clone()),
        _ => None,
    }
}

/// Re-encodes one embedded image stream to the requested browser format.
/// `None` means the source could not be decoded (or did not survive the
/// size guards) and the original bytes must be emitted instead.
fn convert(bytes: &[u8], format: &str) -> Option<Vec<u8>> {
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let decoder = reader.into_decoder().ok()?;
    let (width, height) = decoder.dimensions();
    if width == 0
        || height == 0
        || width > MAX_EDGE
        || height > MAX_EDGE
        || u64::from(width) * u64::from(height) > MAX_PIXELS
    {
        return None;
    }
    let image = DynamicImage::from_decoder(decoder).ok()?;
    match format {
        // PNG keeps its alpha channel; everything else is flattened onto white.
        "png" => encode(&image, ImageFormat::Png),
        "jpeg" => encode(&flatten_white(&image), ImageFormat::Jpeg),
        // The `image` crate only writes lossless WebP; the quality knob is ignored.
        "webp" => encode(&flatten_white(&image), ImageFormat::WebP),
        _ => None,
    }
}

fn flatten_white(image: &DynamicImage) -> DynamicImage {
    let source = image.to_rgba8();
    let mut out = image::RgbaImage::from_pixel(
        source.width(),
        source.height(),
        image::Rgba([255, 255, 255, 255]),
    );
    image::imageops::overlay(&mut out, &source, 0, 0);
    DynamicImage::ImageRgba8(out)
}

fn encode(image: &DynamicImage, format: ImageFormat) -> Option<Vec<u8>> {
    let mut output = Cursor::new(Vec::new());
    match format {
        ImageFormat::Jpeg => {
            let rgb = image.to_rgb8();
            JpegEncoder::new_with_quality(&mut output, CONVERT_QUALITY)
                .encode(rgb.as_raw(), rgb.width(), rgb.height(), ExtendedColorType::Rgb8)
                .ok()?;
        }
        _ => image.write_to(&mut output, format).ok()?,
    }
    Some(output.into_inner())
}

fn emit(result: &mut ToolResult, input: &InputFile, name: &str, bytes: Vec<u8>) {
    let mut artifact = Artifact::new(name.to_owned(), "image", bytes);
    artifact.source_file_id = Some(input.id.clone());
    result.artifacts.push(artifact);
}

#[cfg(test)]
mod tests {
    use super::run;
    use crate::{EngineError, InputFile, RunContext, ToolResult};
    use lopdf::{dictionary, Dictionary, Document, Object, Stream};
    use serde_json::{json, Value};
    use std::io::Cursor;

    fn jpeg_bytes() -> Vec<u8> {
        let image = image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(4, 3, |x, y| {
            image::Rgb([(x * 60) as u8, (y * 80) as u8, 128])
        }));
        let rgb = image.to_rgb8();
        let mut output = Cursor::new(Vec::new());
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, 90)
            .encode(rgb.as_raw(), rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8)
            .unwrap();
        output.into_inner()
    }

    /// Builds a one-page PDF whose content stream references /Im0.
    fn pdf_with_image(bytes: Vec<u8>, width: i64, height: i64, filter: &str) -> Vec<u8> {
        let mut document = Document::with_version("1.7");
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
        let image_id = document.add_object(Object::Stream(Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Image",
                "Width" => width, "Height" => height,
                "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8, "Filter" => filter,
            },
            bytes,
        )));
        let content_id = document.add_object(Stream::new(
            Dictionary::new(),
            b"q 100 0 0 100 0 0 cm /Im0 Do Q".to_vec(),
        ));
        let page_id = document.add_object(Object::Dictionary(dictionary! {
            "Type" => "Page",
            "Parent" => Object::Reference(pages_id),
            "MediaBox" => Object::Array(vec![
                Object::Integer(0),
                Object::Integer(0),
                Object::Integer(200),
                Object::Integer(200),
            ]),
            "Resources" => Object::Dictionary(dictionary! {
                "XObject" => Object::Dictionary(dictionary! {
                    "Im0" => Object::Reference(image_id),
                }),
            }),
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

    /// Builds a one-page PDF whose resources contain no image XObjects.
    fn pdf_without_images() -> Vec<u8> {
        let mut document = Document::with_version("1.7");
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
            b"1 0 0 RG 0 0 200 200 re S".to_vec(),
        ));
        let page_id = document.add_object(Object::Dictionary(dictionary! {
            "Type" => "Page",
            "Parent" => Object::Reference(pages_id),
            "MediaBox" => Object::Array(vec![
                Object::Integer(0),
                Object::Integer(0),
                Object::Integer(200),
                Object::Integer(200),
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

    fn invoke(options: Value, inputs: &[InputFile]) -> Result<ToolResult, EngineError> {
        let context = RunContext {
            tool: "extract-images",
            options: &options,
            locale: "zh-CN",
            inputs,
            name_pattern: None,
            runtime_data: None,
        };
        run(&context)
    }

    fn input(name: &str, bytes: Vec<u8>) -> InputFile {
        InputFile { id: "in-1".into(), name: name.into(), path: None, bytes }
    }

    #[test]
    fn extracts_original_streams_with_padded_names() {
        let bytes = jpeg_bytes();
        let inputs = [input("Sample.PDF", pdf_with_image(bytes.clone(), 4, 3, "DCTDecode"))];
        let result = invoke(json!({ "format": "original", "pages": "all" }), &inputs).unwrap();
        assert_eq!(result.artifacts.len(), 1);
        let artifact = &result.artifacts[0];
        assert_eq!(artifact.name, "Sample-img01.jpg");
        assert_eq!(artifact.kind, "image");
        assert_eq!(artifact.source_file_id.as_deref(), Some("in-1"));
        assert_eq!(artifact.bytes, bytes);
        assert_eq!(result.extra["images"], json!(1));
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn converts_jpeg_to_target_format_and_falls_back_otherwise() {
        // A DCT stream re-encodes to the requested format.
        let inputs = [input("doc.pdf", pdf_with_image(jpeg_bytes(), 4, 3, "DCTDecode"))];
        let result = invoke(json!({ "format": "png" }), &inputs).unwrap();
        assert_eq!(result.artifacts[0].name, "doc-img01.png");
        assert_eq!(
            image::guess_format(&result.artifacts[0].bytes).unwrap(),
            image::ImageFormat::Png
        );
        // Garbage in a DCT stream fails to decode and keeps the original bytes.
        let inputs = [input("doc.pdf", pdf_with_image(vec![1, 2, 3, 4], 4, 3, "DCTDecode"))];
        let result = invoke(json!({ "format": "png" }), &inputs).unwrap();
        assert_eq!(result.artifacts[0].name, "doc-img01.jpg");
        assert_eq!(result.artifacts[0].bytes, vec![1, 2, 3, 4]);
    }

    #[test]
    fn warns_for_files_without_images_and_errors_when_all_empty() {
        let inputs = [
            input("good.pdf", pdf_with_image(jpeg_bytes(), 4, 3, "DCTDecode")),
            input("none.pdf", pdf_without_images()),
        ];
        let result = invoke(json!({ "format": "original", "pages": "all" }), &inputs).unwrap();
        assert_eq!(result.artifacts.len(), 1);
        assert_eq!(result.warnings, vec!["none：未找到符合条件的图片".to_owned()]);
        assert_eq!(result.extra["images"], json!(1));

        // Nothing qualifying anywhere fails the whole run, like the browser.
        let inputs = [input("none.pdf", pdf_without_images())];
        let error = invoke(json!({ "format": "original" }), &inputs).unwrap_err();
        assert_eq!(error.code, "empty_selection");
        assert_eq!(error.message, "没有可提取的图片");
    }
}
