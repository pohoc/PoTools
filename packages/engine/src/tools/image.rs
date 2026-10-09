//! Raster image tools implemented by the native engine.
//!
//! Requires the `image` crate with jpeg, png, webp and tiff features enabled.

use super::{Artifact, EngineError, RunContext, ToolResult};
use crate::services::naming::{base_name as naming_base, render_name, NameContext};
use image::{
    imageops, DynamicImage, GenericImageView, ImageDecoder, ImageFormat, ImageReader, Rgba,
    RgbaImage,
};
use serde_json::{json, Value};
use std::io::Cursor;

mod cleanup;
mod id_photo;
mod operations;
use operations::run_one;

const MAX_PIXELS: u64 = 120_000_000;

fn option_string<'a>(options: &'a Value, key: &str, default: &'a str) -> &'a str {
    options.get(key).and_then(Value::as_str).unwrap_or(default)
}

fn option_bool(options: &Value, key: &str, default: bool) -> bool {
    options.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn option_number(options: &Value, key: &str, default: f64) -> f64 {
    options.get(key).and_then(Value::as_f64).unwrap_or(default)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RasterFormat {
    Jpeg,
    Png,
    Webp,
    Tiff,
}

impl RasterFormat {
    fn parse(value: &str) -> Option<Self> {
        match value.to_ascii_lowercase().as_str() {
            "jpg" | "jpeg" => Some(Self::Jpeg),
            "png" => Some(Self::Png),
            "webp" => Some(Self::Webp),
            "tif" | "tiff" => Some(Self::Tiff),
            _ => None,
        }
    }

    fn ext(self) -> &'static str {
        match self {
            Self::Jpeg => "jpg",
            Self::Png => "png",
            Self::Webp => "webp",
            Self::Tiff => "tiff",
        }
    }

    fn kind_name(self) -> &'static str {
        match self {
            Self::Jpeg => "jpeg",
            Self::Png => "png",
            Self::Webp => "webp",
            Self::Tiff => "tiff",
        }
    }

    fn image_format(self) -> ImageFormat {
        match self {
            Self::Jpeg => ImageFormat::Jpeg,
            Self::Png => ImageFormat::Png,
            Self::Webp => ImageFormat::WebP,
            Self::Tiff => ImageFormat::Tiff,
        }
    }
}

fn bad_request(message: impl Into<String>) -> EngineError {
    EngineError::new("bad_request", message)
}

fn decode(bytes: &[u8]) -> Result<DynamicImage, EngineError> {
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| EngineError::new("unreadable_file", format!("无法读取图片：{e}")))?;
    let mut decoder = reader
        .into_decoder()
        .map_err(|e| EngineError::new("unreadable_file", format!("无法读取图片：{e}")))?;
    let (width, height) = decoder.dimensions();
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err(bad_request("图片尺寸超出处理范围"));
    }
    let orientation = decoder
        .orientation()
        .map_err(|e| EngineError::new("unreadable_file", format!("无法读取图片方向：{e}")))?;
    let mut image = DynamicImage::from_decoder(decoder)
        .map_err(|e| EngineError::new("unreadable_file", format!("无法读取图片：{e}")))?;
    image.apply_orientation(orientation);
    Ok(image)
}

fn background(options: &Value) -> Rgba<u8> {
    let value = option_string(options, "background", "#ffffff").trim_start_matches('#');
    let parsed = u32::from_str_radix(value, 16).ok();
    match (value.len(), parsed) {
        (6, Some(v)) => Rgba([(v >> 16) as u8, (v >> 8) as u8, v as u8, 255]),
        (8, Some(v)) => Rgba([(v >> 24) as u8, (v >> 16) as u8, (v >> 8) as u8, v as u8]),
        _ => Rgba([255, 255, 255, 255]),
    }
}

fn flatten(image: DynamicImage, color: Rgba<u8>) -> DynamicImage {
    let source = image.to_rgba8();
    let mut out = RgbaImage::from_pixel(source.width(), source.height(), color);
    imageops::overlay(&mut out, &source, 0, 0);
    DynamicImage::ImageRgba8(out)
}

fn encode(
    image: DynamicImage,
    format: RasterFormat,
    quality: u8,
    bg: Rgba<u8>,
) -> Result<Vec<u8>, EngineError> {
    let image = if format == RasterFormat::Jpeg {
        flatten(image, bg)
    } else {
        image
    };
    let mut output = Cursor::new(Vec::new());
    if format == RasterFormat::Jpeg {
        let rgb = image.to_rgb8();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, quality)
            .encode(
                &rgb,
                rgb.width(),
                rgb.height(),
                image::ExtendedColorType::Rgb8,
            )
            .map_err(|e| EngineError::new("internal", format!("JPEG 编码失败：{e}")))?;
    } else {
        image
            .write_to(&mut output, format.image_format())
            .map_err(|e| {
                EngineError::new(
                    "no_image_codec",
                    format!("{} 编码失败：{e}", format.kind_name()),
                )
            })?;
    }
    Ok(output.into_inner())
}

fn artifact_name(
    pattern: Option<&str>,
    source: &str,
    label: &str,
    format: RasterFormat,
    index: usize,
    total: usize,
) -> String {
    render_name(
        pattern,
        NameContext {
            name: naming_base(source),
            tool: label,
            index: Some(index),
            total: Some(total),
            range: None,
        },
        format.ext(),
    )
}

fn emit(
    result: &mut ToolResult,
    input_id: &str,
    source: &str,
    label: &str,
    format: RasterFormat,
    bytes: Vec<u8>,
    pattern: Option<&str>,
    index: usize,
    total: usize,
) {
    let name = artifact_name(pattern, source, label, format, index, total);
    let name = crate::services::naming::dedupe(name, |candidate| {
        result.artifacts.iter().any(|item| item.name == candidate)
    });
    let mut artifact = Artifact::new(name, "image", bytes);
    artifact.source_file_id = Some(input_id.to_owned());
    result.artifacts.push(artifact);
}

fn scaled_inside(image: &DynamicImage, width: u32, height: u32, no_enlarge: bool) -> DynamicImage {
    let ratio = (width as f64 / image.width() as f64).min(height as f64 / image.height() as f64);
    let ratio = if no_enlarge { ratio.min(1.0) } else { ratio };
    let w = ((image.width() as f64 * ratio).round() as u32).max(1);
    let h = ((image.height() as f64 * ratio).round() as u32).max(1);
    image.resize_exact(w, h, imageops::FilterType::Lanczos3)
}

fn resize_fit(
    image: &DynamicImage,
    width: u32,
    height: u32,
    fit: &str,
    no_enlarge: bool,
    bg: Rgba<u8>,
) -> DynamicImage {
    if fit == "fill" {
        return image.resize_exact(width, height, imageops::FilterType::Lanczos3);
    }
    if fit == "cover" {
        return image.resize_to_fill(width, height, imageops::FilterType::Lanczos3);
    }
    let resized = scaled_inside(image, width, height, no_enlarge);
    if resized.dimensions() == (width, height) {
        return resized;
    }
    let mut canvas = RgbaImage::from_pixel(width, height, bg);
    let left = i64::from((width - resized.width()) / 2);
    let top = i64::from((height - resized.height()) / 2);
    imageops::overlay(&mut canvas, &resized.to_rgba8(), left, top);
    DynamicImage::ImageRgba8(canvas)
}

fn round_dim(value: f64) -> Result<u32, EngineError> {
    if !value.is_finite() || value < 1.0 || value > 16_000.0 {
        return Err(bad_request("宽度和高度必须在 1 到 16000 之间"));
    }
    Ok(value.round() as u32)
}

fn source_format(input: &super::InputFile) -> Result<RasterFormat, EngineError> {
    image::guess_format(&input.bytes)
        .ok()
        .and_then(|f| match f {
            ImageFormat::Jpeg => Some(RasterFormat::Jpeg),
            ImageFormat::Png => Some(RasterFormat::Png),
            ImageFormat::WebP => Some(RasterFormat::Webp),
            ImageFormat::Tiff => Some(RasterFormat::Tiff),
            _ => None,
        })
        .ok_or_else(|| {
            EngineError::new(
                "unreadable_file",
                format!("不支持的图片格式：{}", input.name),
            )
        })
}

pub fn run(context: &RunContext<'_>) -> Result<Option<ToolResult>, EngineError> {
    if context.tool == "image-id-photo" {
        return id_photo::run(context).map(Some);
    }
    if matches!(context.tool, "image-cutout" | "image-watermark-clean") {
        return cleanup::run(context).map(Some);
    }
    const IDS: &[&str] = &[
        "image-compress",
        "image-resize",
        "image-crop",
        "image-rotate",
        "image-convert",
        "image-info",
        "image-metadata-clean",
        "image-print",
        "tiff-preview",
        "tiff-convert",
    ];
    if !IDS.contains(&context.tool) {
        return Ok(None);
    }
    if context.inputs.is_empty() {
        return Err(bad_request("请先添加图片"));
    }

    if context.tool == "tiff-preview" || context.tool == "tiff-convert" {
        return run_tiff(context);
    }
    if context.tool == "image-info" {
        let mut rows = Vec::with_capacity(context.inputs.len());
        for input in context.inputs {
            let image = decode(&input.bytes)?;
            let color = image.color();
            rows.push(json!({
                "file": input.name,
                "bytes": input.bytes.len(),
                "width": image.width(),
                "height": image.height(),
                "format": source_format(input)?.kind_name(),
                "channels": color.channel_count(),
                "hasAlpha": color.has_alpha(),
            }));
        }
        let data = serde_json::to_vec_pretty(&rows)
            .map_err(|e| EngineError::new("internal", e.to_string()))?;
        let mut result = ToolResult::default();
        // Fixed product name (matches the original engine); downstream
        // dedupe appends the (2)-style suffix when needed.
        result
            .artifacts
            .push(Artifact::new("image-info.json", "json", data));
        result.extra.insert("images".into(), json!(rows.len()));
        return Ok(Some(result));
    }

    let mut result = ToolResult::default();
    let mut input_bytes = 0usize;
    let mut output_bytes = 0usize;
    for (index, input) in context.inputs.iter().enumerate() {
        let image = decode(&input.bytes)?;
        let old_count = result.artifacts.len();
        run_one(context, image, index, &mut result)?;
        input_bytes += input.bytes.len();
        if let Some(artifact) = result.artifacts.get(old_count) {
            output_bytes += artifact.size_bytes;
        }
    }
    match context.tool {
        "image-compress" => {
            result.extra.insert("inputBytes".into(), json!(input_bytes));
            result
                .extra
                .insert("outputBytes".into(), json!(output_bytes));
            result.extra.insert(
                "savedBytes".into(),
                json!(input_bytes as i64 - output_bytes as i64),
            );
        }
        "image-print" => {
            result
                .extra
                .insert("images".into(), json!(context.inputs.len()));
            result.extra.insert(
                "paper".into(),
                json!(option_string(context.options, "paper", "a4")),
            );
            result.extra.insert("dpi".into(), json!(300));
        }
        _ => {
            result
                .extra
                .insert("images".into(), json!(context.inputs.len()));
        }
    }
    Ok(Some(result))
}

fn run_tiff(context: &RunContext<'_>) -> Result<Option<ToolResult>, EngineError> {
    let format = if context.tool == "tiff-preview" {
        RasterFormat::Png
    } else {
        RasterFormat::parse(option_string(context.options, "format", "png"))
            .ok_or_else(|| bad_request("不支持的 TIFF 输出格式"))?
    };
    let mut result = ToolResult::default();
    for (index, input) in context.inputs.iter().enumerate() {
        let image = decode(&input.bytes)?;
        let bytes = encode(
            image.clone(),
            format,
            option_number(context.options, "quality", 85.0)
                .round()
                .clamp(20.0, 100.0) as u8,
            background(context.options),
        )?;
        emit(
            &mut result,
            &input.id,
            &input.name,
            if context.tool == "tiff-preview" {
                "preview"
            } else {
                "converted"
            },
            format,
            bytes,
            context.name_pattern,
            index + 1,
            context.inputs.len(),
        );
    }
    result
        .extra
        .insert("images".into(), json!(context.inputs.len()));
    Ok(Some(result))
}

#[cfg(test)]
mod tests;
