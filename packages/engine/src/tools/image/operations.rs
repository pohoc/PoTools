//! Per-image operation implementations.

use super::*;

pub(super) fn run_one(
    context: &RunContext<'_>,
    image: DynamicImage,
    idx: usize,
    result: &mut ToolResult,
) -> Result<(), EngineError> {
    let input = &context.inputs[idx];
    let (mut output, format, label) = match context.tool {
        "image-resize" => {
            let width = round_dim(option_number(context.options, "width", 1600.0))?;
            let height = round_dim(option_number(context.options, "height", 1600.0))?;
            let fit = option_string(context.options, "fit", "inside");
            let img = if fit == "inside" {
                scaled_inside(
                    &image,
                    width,
                    height,
                    option_bool(context.options, "withoutEnlargement", true),
                )
            } else {
                resize_fit(
                    &image,
                    width,
                    height,
                    fit,
                    false,
                    background(context.options),
                )
            };
            (img, source_format(input)?, "resized")
        }
        "image-crop" => {
            let (w_ratio, h_ratio) = match option_string(context.options, "aspect", "1:1") {
                "original" => (image.width(), image.height()),
                v => {
                    let mut p = v.split(':').filter_map(|s| s.parse::<u32>().ok());
                    (p.next().unwrap_or(1), p.next().unwrap_or(1))
                }
            };
            let aspect = w_ratio as f64 / h_ratio.max(1) as f64;
            let source_aspect = image.width() as f64 / image.height() as f64;
            let (w, h) = if source_aspect > aspect {
                (
                    (image.height() as f64 * aspect).round() as u32,
                    image.height(),
                )
            } else {
                (
                    image.width(),
                    (image.width() as f64 / aspect).round() as u32,
                )
            };
            let position = option_string(context.options, "position", "centre");
            let x = match position {
                "west" => 0,
                "east" => image.width() - w,
                _ => (image.width() - w) / 2,
            };
            let y = match position {
                "north" => 0,
                "south" => image.height() - h,
                _ => (image.height() - h) / 2,
            };
            (
                image.crop_imm(x, y, w.max(1), h.max(1)),
                source_format(input)?,
                "cropped",
            )
        }
        "image-rotate" => {
            let angle = option_number(context.options, "angle", 90.0) as i32;
            let mut img = match angle.rem_euclid(360) {
                90 => imageops::rotate90(&image),
                180 => imageops::rotate180(&image),
                270 => imageops::rotate270(&image),
                0 => image.to_rgba8(),
                _ => return Err(bad_request("旋转角度只支持 90、180 或 270 度")),
            };
            if option_bool(context.options, "flipHorizontal", false) {
                img = imageops::flip_horizontal(&img);
            }
            if option_bool(context.options, "flipVertical", false) {
                img = imageops::flip_vertical(&img);
            }
            (
                DynamicImage::ImageRgba8(img),
                source_format(input)?,
                "rotated",
            )
        }
        "image-compress" => {
            let raw = option_string(context.options, "format", "original");
            let format = if raw == "original" {
                source_format(input)?
            } else {
                RasterFormat::parse(raw).ok_or_else(|| bad_request("不支持的图片输出格式"))?
            };
            let edge = option_number(context.options, "maxEdge", 0.0).round();
            let img = if edge > 0.0 {
                let scale = (edge / image.width().max(image.height()) as f64).min(1.0);
                image.resize_exact(
                    (image.width() as f64 * scale).round().max(1.0) as u32,
                    (image.height() as f64 * scale).round().max(1.0) as u32,
                    imageops::FilterType::Lanczos3,
                )
            } else {
                image
            };
            let quality = option_number(context.options, "quality", 82.0)
                .round()
                .clamp(20.0, 100.0) as u8;
            let bytes = encode(img.clone(), format, quality, background(context.options))?;
            emit(
                result,
                &input.id,
                &input.name,
                "compressed",
                format,
                bytes,
                context.name_pattern,
                idx + 1,
                context.inputs.len(),
            );
            return Ok(());
        }
        "image-convert" => {
            let format = RasterFormat::parse(option_string(context.options, "format", "webp"))
                .ok_or_else(|| bad_request("不支持的图片输出格式"))?;
            (image, format, "converted")
        }
        "image-metadata-clean" => (image, source_format(input)?, "metadata-clean"),
        "image-print" => {
            let letter = option_string(context.options, "paper", "a4") == "letter";
            let (paper_w, paper_h, name) = if letter {
                (2550_u32, 3300_u32, "letter")
            } else {
                (2480_u32, 3508_u32, "a4")
            };
            let landscape = match option_string(context.options, "orientation", "auto") {
                "landscape" => true,
                "portrait" => false,
                _ => image.width() > image.height(),
            };
            let (w, h) = if landscape {
                (paper_h, paper_w)
            } else {
                (paper_w, paper_h)
            };
            let margin = (option_number(context.options, "marginMm", 10.0).clamp(0.0, 40.0) * 300.0
                / 25.4)
                .round() as u32;
            let area_w = w.saturating_sub(margin.saturating_mul(2)).max(1);
            let area_h = h.saturating_sub(margin.saturating_mul(2)).max(1);
            let fit = if option_string(context.options, "fit", "contain") == "cover" {
                "cover"
            } else {
                "inside"
            };
            let scaled = if fit == "cover" {
                image.resize_to_fill(area_w, area_h, imageops::FilterType::Lanczos3)
            } else {
                scaled_inside(&image, area_w, area_h, false)
            };
            let mut page = RgbaImage::from_pixel(w, h, Rgba([255, 255, 255, 255]));
            let x = (w - scaled.width()) / 2;
            let y = (h - scaled.height()) / 2;
            imageops::overlay(&mut page, &scaled.to_rgba8(), i64::from(x), i64::from(y));
            (
                DynamicImage::ImageRgba8(page),
                RasterFormat::Jpeg,
                if name == "a4" {
                    "a4-print"
                } else {
                    "letter-print"
                },
            )
        }
        _ => return Ok(()),
    };
    let quality = match context.tool {
        "image-metadata-clean" => 92,
        "image-print" => 94,
        _ => option_number(context.options, "quality", 85.0)
            .round()
            .clamp(20.0, 100.0) as u8,
    };
    if context.tool == "image-print" {
        // Print pages always use the UI-compatible white background.
        output = flatten(output, Rgba([255, 255, 255, 255]));
    }
    let bytes = encode(output, format, quality, background(context.options))?;
    emit(
        result,
        &input.id,
        &input.name,
        label,
        format,
        bytes,
        context.name_pattern,
        idx + 1,
        context.inputs.len(),
    );
    Ok(())
}
