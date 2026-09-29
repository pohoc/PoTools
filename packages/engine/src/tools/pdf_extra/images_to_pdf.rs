//! Images-to-PDF conversion: decodes raster inputs and lays one image per
//! page into a fresh PDF document, mirroring the browser implementation.

use self::embed::{decode, embed, jpeg_components, plan_page, prepare, Prepared, MAX_PREPARED_PIXELS};
use super::{base_name, number, save, string, EngineError, EngineResult};
use crate::services::naming::{render_name, NameContext};
use crate::{Artifact, RunContext, ToolResult};
use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream};
use serde_json::json;

mod embed;

pub(super) fn run(ctx: &RunContext<'_>) -> EngineResult<ToolResult> {
    let page_size = string(ctx.options, "pageSize", "auto");
    let orientation = string(ctx.options, "orientation", "auto");
    let fit = string(ctx.options, "fit", "contain");
    let margin = number(ctx.options, "margin", 0.0);
    let quality = number(ctx.options, "imageQuality", 85.0).round().clamp(1.0, 100.0) as u8;
    let background = string(ctx.options, "background", "#ffffff");
    let background = if background.is_empty() { "#ffffff" } else { background.as_str() };

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

    let mut result = ToolResult::default();
    let mut kids: Vec<Object> = Vec::new();
    for input in ctx.inputs {
        let Some((image, container_jpeg, orientation_identity)) = decode(&input.bytes) else {
            result.warnings.push(format!("{}：无法解码图片", input.name));
            continue;
        };
        let Some(plan) = plan_page(
            image.width() as f64,
            image.height() as f64,
            &page_size,
            &orientation,
            &fit,
            margin,
        ) else {
            result.warnings.push(format!("{}：图片处理失败，已跳过", input.name));
            continue;
        };
        // The browser re-encodes every input through a canvas. When nothing
        // would change for an opaque JPEG container, the original bytes are
        // embedded as-is (DCTDecode passthrough): visually identical and
        // avoids a needless generation loss.
        let pixel_count = image.width() as f64 * image.height() as f64;
        let prepared = if container_jpeg
            && orientation_identity
            && plan.cover_aspect.is_none()
            && pixel_count <= MAX_PREPARED_PIXELS
        {
            Prepared::Jpeg {
                bytes: input.bytes.clone(),
                width: image.width(),
                height: image.height(),
                components: jpeg_components(&input.bytes).unwrap_or(3),
            }
        } else {
            let Some(prepared) = prepare(&image, plan.cover_aspect, quality, background) else {
                result.warnings.push(format!("{}：图片处理失败，已跳过", input.name));
                continue;
            };
            prepared
        };
        let Ok(image_id) = embed(&mut document, &prepared) else {
            result.warnings.push(format!("{}：图片处理失败，已跳过", input.name));
            continue;
        };
        let page_id = draw_page(&mut document, pages_id, &plan, image_id, kids.len() + 1, background);
        kids.push(Object::Reference(page_id));
    }

    if kids.is_empty() {
        return Err(EngineError::new("empty_selection", "没有可写入的图片"));
    }
    let page_count = kids.len();
    if let Some(Object::Dictionary(pages)) = document.objects.get_mut(&pages_id) {
        pages.set("Kids", Object::Array(kids));
        pages.set("Count", Object::Integer(page_count as i64));
    }
    let bytes = save(&mut document)?;

    let stem = base_name(
        ctx.inputs
            .first()
            .map(|input| input.name.as_str())
            .unwrap_or("images"),
    );
    let label = if ctx.inputs.len() > 1 {
        format!("{stem}-{}pages", ctx.inputs.len())
    } else {
        stem.to_owned()
    };
    let name = render_name(
        ctx.name_pattern,
        NameContext {
            name: &label,
            tool: "images",
            index: None,
            total: None,
            range: None,
        },
        "pdf",
    );
    result.artifacts.push(Artifact::new(name, "pdf", bytes));
    result.extra.insert("images".into(), json!(ctx.inputs.len()));
    result.extra.insert("__pageCountOut".into(), json!(page_count));
    Ok(result)
}

fn draw_page(
    document: &mut Document,
    pages_id: ObjectId,
    plan: &embed::PagePlan,
    image_id: ObjectId,
    index: usize,
    background: &str,
) -> ObjectId {
    let image_name = format!("Im{index}");
    let mut content = String::new();
    if background != "#ffffff" {
        let [r, g, b] = embed::parse_background(background);
        content.push_str(&format!(
            "q {} {} {} rg 0 0 {} {} re f Q\n",
            r as f64 / 255.0,
            g as f64 / 255.0,
            b as f64 / 255.0,
            plan.box_width,
            plan.box_height
        ));
    }
    content.push_str(&format!(
        "q {} 0 0 {} {} {} cm /{image_name} Do Q",
        plan.draw_width, plan.draw_height, plan.draw_x, plan.draw_y
    ));
    let content_id = document.add_object(Stream::new(Dictionary::new(), content.into_bytes()));
    document.add_object(Object::Dictionary(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_id),
        "MediaBox" => Object::Array(vec![
            Object::Real(0.0),
            Object::Real(0.0),
            Object::Real(plan.box_width as f32),
            Object::Real(plan.box_height as f32),
        ]),
        "Resources" => Object::Dictionary(dictionary! {
            "XObject" => Object::Dictionary(dictionary! {
                image_name => Object::Reference(image_id),
            }),
        }),
        "Contents" => Object::Reference(content_id),
    }))
}

#[cfg(test)]
mod tests {
    use super::run;
    use crate::{EngineError, InputFile, RunContext, ToolResult};
    use image::{codecs::jpeg::JpegEncoder, DynamicImage, ExtendedColorType, ImageFormat, Rgba, RgbaImage};
    use lopdf::{Document, Object};
    use serde_json::{json, Value};
    use std::io::Cursor;

    fn png_bytes(alpha: u8) -> Vec<u8> {
        let image = DynamicImage::ImageRgba8(RgbaImage::from_fn(8, 6, |x, y| {
            Rgba([(x * 20) as u8, (y * 30) as u8, 90, alpha])
        }));
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, ImageFormat::Png).unwrap();
        bytes.into_inner()
    }

    fn jpeg_bytes() -> Vec<u8> {
        let image = DynamicImage::ImageRgb8(image::RgbImage::from_fn(4, 3, |x, y| {
            image::Rgb([(x * 60) as u8, (y * 80) as u8, 128])
        }));
        let rgb = image.to_rgb8();
        let mut output = Cursor::new(Vec::new());
        JpegEncoder::new_with_quality(&mut output, 85)
            .encode(rgb.as_raw(), rgb.width(), rgb.height(), ExtendedColorType::Rgb8)
            .unwrap();
        output.into_inner()
    }

    fn try_invoke(options: Value, inputs: &[InputFile]) -> Result<ToolResult, EngineError> {
        let context = RunContext {
            tool: "images-to-pdf",
            options: &options,
            locale: "zh-CN",
            inputs,
            name_pattern: None,
            runtime_data: None,
        };
        run(&context)
    }

    fn invoke(options: Value, inputs: &[InputFile]) -> ToolResult {
        try_invoke(options, inputs).unwrap()
    }

    /// Reads an Integer/Real MediaBox component as f64 (lopdf reparses "6"
    /// as an Integer and f32 reals lose a little precision).
    fn real(object: &Object) -> f64 {
        object
            .as_float()
            .map(f64::from)
            .or_else(|_| object.as_i64().map(|n| n as f64))
            .unwrap()
    }

    #[test]
    fn embeds_alpha_png_and_jpeg_into_two_auto_pages() {
        let inputs = [
            InputFile { id: "a".into(), name: "one.png".into(), path: None, bytes: png_bytes(128) },
            InputFile { id: "b".into(), name: "two.jpg".into(), path: None, bytes: jpeg_bytes() },
        ];
        let result = invoke(json!({ "pageSize": "auto", "fit": "contain" }), &inputs);
        assert_eq!(result.artifacts.len(), 1);
        let artifact = &result.artifacts[0];
        assert_eq!(artifact.name, "one-2pages-images.pdf");
        assert_eq!(artifact.kind, "pdf");
        assert_eq!(result.extra["images"], json!(2));
        assert_eq!(result.extra["__pageCountOut"], json!(2));

        let document = Document::load_mem(&artifact.bytes).unwrap();
        assert_eq!(document.get_pages().len(), 2);
        // 8x6 px at 0.75 pt/px → a 6 x 4.5 pt auto page for the PNG input.
        let first = document.get_dictionary(*document.get_pages().get(&1).unwrap()).unwrap();
        let media = first.get(b"MediaBox").unwrap().as_array().unwrap();
        assert_eq!(real(&media[2]), 6.0);
        assert_eq!(real(&media[3]), 4.5);
        let filters: Vec<Option<String>> = document
            .objects
            .values()
            .filter_map(|object| match object {
                Object::Stream(stream)
                    if stream.dict.get(b"Subtype").ok().and_then(|o| o.as_name().ok())
                        == Some(b"Image".as_slice()) =>
                {
                    stream.dict.get(b"Filter").ok().map(|f| {
                        f.as_name().ok().and_then(|bytes| std::str::from_utf8(bytes).ok()).map(str::to_owned)
                    })
                }
                _ => None,
            })
            .collect();
        // RGB image + SMask for the PNG, plus the DCTDecode JPEG.
        assert_eq!(filters.len(), 3);
        assert_eq!(filters.iter().filter(|f| **f == Some("FlateDecode".into())).count(), 2);
        assert!(filters.contains(&Some("DCTDecode".into())));
        // The alpha PNG carries an /SMask side stream.
        let has_smask = document.objects.values().any(|object| match object {
            Object::Stream(stream) => stream.dict.get(b"SMask").is_ok(),
            _ => false,
        });
        assert!(has_smask);
    }

    #[test]
    fn cover_crop_flattens_alpha_and_background_draws_rect() {
        let inputs = [InputFile { id: "a".into(), name: "solo.png".into(), path: None, bytes: png_bytes(0) }];
        let result = invoke(
            json!({ "pageSize": "a4", "orientation": "portrait", "fit": "cover", "background": "#123456" }),
            &inputs,
        );
        assert_eq!(result.artifacts[0].name, "solo-images.pdf");
        let document = Document::load_mem(&result.artifacts[0].bytes).unwrap();
        assert_eq!(document.get_pages().len(), 1);
        let page = document
            .get_dictionary(*document.get_pages().get(&1).unwrap())
            .unwrap();
        let media = page.get(b"MediaBox").unwrap().as_array().unwrap();
        assert!((real(&media[2]) - 595.28).abs() < 0.01);
        assert!((real(&media[3]) - 841.89).abs() < 0.01);
        // Cover crop flattens onto white, so the only image stream is JPEG.
        let contents = document
            .objects
            .values()
            .find_map(|object| match object {
                Object::Stream(stream) if stream.dict.get(b"Length").is_ok()
                    && stream.dict.get(b"Subtype").is_err() =>
                {
                    String::from_utf8(stream.content.clone()).ok()
                }
                _ => None,
            })
            .unwrap();
        assert!(contents.contains("0.07058823"));
        assert!(contents.contains(" rg "));
        assert!(contents.contains(" re f Q"));
        assert!(contents.contains(" cm /Im1 Do Q"));
    }

    #[test]
    fn skips_undecodable_inputs_and_errors_when_none_remain() {
        let inputs = [
            InputFile { id: "a".into(), name: "bad.png".into(), path: None, bytes: vec![0, 1, 2, 3] },
            InputFile { id: "b".into(), name: "good.jpg".into(), path: None, bytes: jpeg_bytes() },
        ];
        let result = invoke(json!({}), &inputs);
        assert_eq!(result.warnings, vec!["bad.png：无法解码图片".to_owned()]);
        assert_eq!(result.extra["images"], json!(2));
        assert_eq!(result.extra["__pageCountOut"], json!(1));

        let broken = [InputFile { id: "a".into(), name: "bad.png".into(), path: None, bytes: vec![0, 1, 2, 3] }];
        let error = try_invoke(json!({}), &broken).unwrap_err();
        assert_eq!(error.code, "empty_selection");
        assert_eq!(error.message, "没有可写入的图片");
    }
}
