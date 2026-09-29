//! Cutout output and local watermark repair over decoded image pixels.

use super::{
    background, bad_request, decode, emit, encode, option_bool, option_string, RasterFormat,
};
use crate::{EngineError, RunContext, ToolResult};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::{imageops, DynamicImage, RgbaImage};
use serde_json::json;

pub(super) fn run(context: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    if context.inputs.is_empty() {
        return Err(bad_request("请先添加图片"));
    }
    let mut result = ToolResult::default();
    let mut last_size = (0, 0);
    for (index, input) in context.inputs.iter().enumerate() {
        let source = decode(&input.bytes)?;
        let (image, format, quality, label) = if context.tool == "image-cutout" {
            let format = if option_bool(context.options, "transparent", true) {
                RasterFormat::Png
            } else {
                RasterFormat::Jpeg
            };
            (source, format, 94, "cutout")
        } else {
            let repaired = repair(source, option_string(context.options, "repairPng", ""))?;
            last_size = (repaired.width(), repaired.height());
            (repaired, RasterFormat::Png, 85, "watermark-cleaned")
        };
        let bytes = encode(image, format, quality, background(context.options))?;
        emit(
            &mut result,
            &input.id,
            &input.name,
            label,
            format,
            bytes,
            context.name_pattern,
            index + 1,
            context.inputs.len(),
        );
    }
    if context.tool == "image-cutout" {
        result
            .extra
            .insert("images".into(), json!(context.inputs.len()));
    } else {
        result.extra.insert("width".into(), json!(last_size.0));
        result.extra.insert("height".into(), json!(last_size.1));
        result
            .extra
            .insert("method".into(), json!("local-neighbor-fill"));
    }
    Ok(result)
}

fn repair(source: DynamicImage, encoded_mask: &str) -> Result<DynamicImage, EngineError> {
    let compact: String = encoded_mask
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect();
    if compact.is_empty() {
        return Err(bad_request("请先在预览中涂选要修复的区域"));
    }
    let mask_bytes = STANDARD
        .decode(compact.as_bytes())
        .map_err(|_| bad_request("修复选区数据无效，请重新涂选"))?;
    let mask = image::load_from_memory(&mask_bytes)
        .map_err(|_| bad_request("修复选区数据无效，请重新涂选"))?
        .to_rgba8();
    let original = source.to_rgba8();
    let (width, height) = original.dimensions();
    let mask = if mask.dimensions() == (width, height) {
        mask
    } else {
        imageops::resize(&mask, width, height, imageops::FilterType::Triangle)
    };
    let selected: Vec<bool> = mask
        .pixels()
        .map(|pixel| {
            (u32::from(pixel[0]) * 299
                + u32::from(pixel[1]) * 587
                + u32::from(pixel[2]) * 114
                + 500)
                / 1000
                >= 32
        })
        .collect();
    let mut output: RgbaImage = original.clone();
    let radius = ((width.min(height) as f64 / 160.0).round() as i32).clamp(1, 8);
    for y in 0..height {
        for x in 0..width {
            if !selected[(y * width + x) as usize] {
                continue;
            }
            let mut rgb = [0u32; 3];
            let mut count = 0u32;
            for dy in -radius..=radius {
                for dx in -radius..=radius {
                    let sx = x as i32 + dx;
                    let sy = y as i32 + dy;
                    if sx < 0 || sy < 0 || sx >= width as i32 || sy >= height as i32 {
                        continue;
                    }
                    if selected[(sy as u32 * width + sx as u32) as usize] {
                        continue;
                    }
                    let pixel = original.get_pixel(sx as u32, sy as u32);
                    for channel in 0..3 {
                        rgb[channel] += u32::from(pixel[channel]);
                    }
                    count += 1;
                }
            }
            if count > 0 {
                let pixel = output.get_pixel_mut(x, y);
                for channel in 0..3 {
                    pixel[channel] = ((rgb[channel] as f64 / f64::from(count)).round()) as u8;
                }
            }
        }
    }
    Ok(DynamicImage::ImageRgba8(output))
}
