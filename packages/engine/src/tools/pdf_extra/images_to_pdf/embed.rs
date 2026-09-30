//! Image decoding, page planning and PDF embedding for images-to-pdf.
//!
//! Page plans follow the original tool contract: auto pages scale pixels at
//! 0.75 pt/px capped at 2400 pt, contain/actual scale the page box, cover
//! fills the available area, and raster work stays within the 20 MP budget.

use super::super::{EngineError, EngineResult};
use image::{
    imageops, metadata::Orientation, DynamicImage, ExtendedColorType, ImageDecoder, ImageFormat,
    ImageReader, Rgba, RgbaImage,
};
use lopdf::{dictionary, Document, Object, ObjectId, Stream};
use std::io::Cursor;

pub(super) const PT_PER_PX: f64 = 72.0 / 96.0;
pub(super) const MAX_PAGE_PT: f64 = 2400.0;
pub(super) const MAX_PREPARED_PIXELS: f64 = 20_000_000.0;
const MAX_COVER_WIDTH: f64 = 4200.0;
/// Matches the browser raster decode gate used by the app.
const MAX_DECODE_PIXELS: u64 = 120_000_000;

pub(super) type Decoded = (DynamicImage, bool, bool);

/// Decodes a raster input: `(image, container is JPEG, EXIF orientation is
/// identity)`. The browser applies EXIF orientation, so it is baked in here.
pub(super) fn decode(bytes: &[u8]) -> Option<Decoded> {
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let container_jpeg = reader.format() == Some(ImageFormat::Jpeg);
    let mut decoder = reader.into_decoder().ok()?;
    let (width, height) = decoder.dimensions();
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_DECODE_PIXELS {
        return None;
    }
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder).ok()?;
    image.apply_orientation(orientation);
    Some((
        image,
        container_jpeg,
        orientation == Orientation::NoTransforms,
    ))
}

pub(super) struct PagePlan {
    pub(super) box_width: f64,
    pub(super) box_height: f64,
    pub(super) draw_x: f64,
    pub(super) draw_y: f64,
    pub(super) draw_width: f64,
    pub(super) draw_height: f64,
    pub(super) cover_aspect: Option<f64>,
}

/// Reproduces the browser page planner. Any unrecognized page size falls back
/// to A4, "actual" fit behaves exactly like "contain", and the contain rect
/// scales the page box itself (not the natural image size).
pub(super) fn plan_page(
    width: f64,
    height: f64,
    page_size: &str,
    orientation: &str,
    fit: &str,
    margin: f64,
) -> Option<PagePlan> {
    let margin = margin.max(0.0);
    let landscape_source = width >= height;
    let (box_width, box_height) = if page_size == "auto" {
        let raw_width = width * PT_PER_PX;
        let raw_height = height * PT_PER_PX;
        let cap = raw_width.max(raw_height) / MAX_PAGE_PT;
        if cap > 1.0 {
            (raw_width / cap, raw_height / cap)
        } else {
            (raw_width, raw_height)
        }
    } else {
        let preset = if page_size == "letter" {
            (612.0, 792.0)
        } else {
            (595.28, 841.89)
        };
        let landscape = orientation == "landscape" || (orientation == "auto" && landscape_source);
        if landscape {
            (preset.1, preset.0)
        } else {
            preset
        }
    };
    let available_width = box_width - margin * 2.0;
    let available_height = box_height - margin * 2.0;
    if fit == "cover" {
        if available_width <= 0.0 || available_height <= 0.0 {
            return None;
        }
        return Some(PagePlan {
            box_width,
            box_height,
            draw_x: margin,
            draw_y: margin,
            draw_width: available_width,
            draw_height: available_height,
            cover_aspect: Some(available_width / available_height),
        });
    }
    let scale = (available_width / box_width)
        .min(available_height / box_height)
        .min(1.0);
    let draw_width = box_width * scale;
    let draw_height = box_height * scale;
    if draw_width <= 0.0 || draw_height <= 0.0 {
        return None;
    }
    Some(PagePlan {
        box_width,
        box_height,
        draw_x: margin + (available_width - draw_width) / 2.0,
        draw_y: margin + (available_height - draw_height) / 2.0,
        draw_width,
        draw_height,
        cover_aspect: None,
    })
}

pub(super) enum Prepared {
    /// DCTDecode stream; `components` selects the PDF color space.
    Jpeg {
        bytes: Vec<u8>,
        width: u32,
        height: u32,
        components: u8,
    },
    /// FlateDecode RGB image with an 8-bit gray /SMask, as pdf-lib's embedPng.
    Rgba {
        rgb: Vec<u8>,
        alpha: Vec<u8>,
        width: u32,
        height: u32,
    },
}

/// Crops/rescales/flattens a decoded image, mirroring the browser canvas
/// pipeline (cover crop onto white, 20 MP cap, alpha kept only outside cover).
pub(super) fn prepare(
    image: &DynamicImage,
    cover_aspect: Option<f64>,
    quality: u8,
    background: &str,
) -> Option<Prepared> {
    let has_alpha = image.color().has_alpha();
    let mut source = image.clone();
    if let Some(aspect) = cover_aspect {
        source = cover_crop(&source, aspect)?;
    }
    let scale = (MAX_PREPARED_PIXELS / (source.width() as f64 * source.height() as f64).max(1.0))
        .sqrt()
        .min(1.0);
    let width = ((source.width() as f64 * scale).round() as u32).max(1);
    let height = ((source.height() as f64 * scale).round() as u32).max(1);
    if (width, height) != (source.width(), source.height()) {
        source = source.resize_exact(width, height, imageops::FilterType::Lanczos3);
    }
    if has_alpha && cover_aspect.is_none() {
        let rgba = source.to_rgba8();
        let (rgb, alpha) = split_rgba(&rgba);
        return Some(Prepared::Rgba {
            rgb,
            alpha,
            width: rgba.width(),
            height: rgba.height(),
        });
    }
    // Non-alpha images are composited onto the background color (white for
    // cover crops) and JPEG-encoded at the requested quality.
    let color = if cover_aspect.is_some() {
        [255, 255, 255]
    } else {
        parse_background(background)
    };
    let flattened = flatten(&source, Rgba([color[0], color[1], color[2], 255]));
    let rgb = flattened.to_rgb8();
    let mut output = Cursor::new(Vec::new());
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, quality)
        .encode(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            ExtendedColorType::Rgb8,
        )
        .ok()?;
    Some(Prepared::Jpeg {
        bytes: output.into_inner(),
        width: rgb.width(),
        height: rgb.height(),
        components: 3,
    })
}

fn split_rgba(rgba: &RgbaImage) -> (Vec<u8>, Vec<u8>) {
    let mut rgb = Vec::with_capacity(rgba.len() / 4 * 3);
    let mut alpha = Vec::with_capacity(rgba.len() / 4);
    for pixel in rgba.pixels() {
        rgb.extend_from_slice(&[pixel[0], pixel[1], pixel[2]]);
        alpha.push(pixel[3]);
    }
    (rgb, alpha)
}

fn cover_crop(source: &DynamicImage, aspect: f64) -> Option<DynamicImage> {
    if !aspect.is_finite() || aspect <= 0.0 {
        return None;
    }
    let width = source.width() as f64;
    let height = source.height() as f64;
    let target_width = MAX_COVER_WIDTH
        .min(width.max(height * aspect).round())
        .max(1.0);
    let target_height = (target_width / aspect).round().max(1.0);
    let source_aspect = width / height;
    let crop_width = if source_aspect > aspect {
        height * aspect
    } else {
        width
    };
    let crop_height = if source_aspect > aspect {
        height
    } else {
        width / aspect
    };
    let source_x = ((width - crop_width) / 2.0).round();
    let source_y = ((height - crop_height) / 2.0).round();
    let crop_w = (crop_width.round() as u32).clamp(1, source.width());
    let crop_h = (crop_height.round() as u32).clamp(1, source.height());
    let crop_x = (source_x as i64).clamp(0, source.width() as i64 - crop_w as i64) as u32;
    let crop_y = (source_y as i64).clamp(0, source.height() as i64 - crop_h as i64) as u32;
    let cropped = imageops::crop_imm(&source.to_rgba8(), crop_x, crop_y, crop_w, crop_h).to_image();
    let resized = DynamicImage::ImageRgba8(cropped).resize_exact(
        target_width as u32,
        target_height as u32,
        imageops::FilterType::Lanczos3,
    );
    let mut canvas = RgbaImage::from_pixel(
        target_width as u32,
        target_height as u32,
        Rgba([255, 255, 255, 255]),
    );
    imageops::overlay(&mut canvas, &resized.to_rgba8(), 0, 0);
    Some(DynamicImage::ImageRgba8(canvas))
}

fn flatten(source: &DynamicImage, color: Rgba<u8>) -> DynamicImage {
    let rgba = source.to_rgba8();
    let mut out = RgbaImage::from_pixel(rgba.width(), rgba.height(), color);
    imageops::overlay(&mut out, &rgba, 0, 0);
    DynamicImage::ImageRgba8(out)
}

pub(super) fn embed(document: &mut Document, prepared: &Prepared) -> EngineResult<ObjectId> {
    match prepared {
        Prepared::Jpeg {
            bytes,
            width,
            height,
            components,
        } => {
            let color_space = match components {
                1 => "DeviceGray",
                4 => "DeviceCMYK",
                _ => "DeviceRGB",
            };
            Ok(document.add_object(Object::Stream(Stream::new(
                dictionary! {
                    "Type" => "XObject", "Subtype" => "Image",
                    "Width" => *width as i64, "Height" => *height as i64,
                    "ColorSpace" => color_space, "BitsPerComponent" => 8, "Filter" => "DCTDecode",
                },
                bytes.clone(),
            ))))
        }
        Prepared::Rgba {
            rgb,
            alpha,
            width,
            height,
        } => {
            let mut smask = Stream::new(
                dictionary! {
                    "Type" => "XObject", "Subtype" => "Image",
                    "Width" => *width as i64, "Height" => *height as i64, "BitsPerComponent" => 8,
                },
                alpha.clone(),
            );
            compress(&mut smask)?;
            let smask_id = document.add_object(Object::Stream(smask));
            let mut image = Stream::new(
                dictionary! {
                    "Type" => "XObject", "Subtype" => "Image",
                    "Width" => *width as i64, "Height" => *height as i64,
                    "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8,
                },
                rgb.clone(),
            );
            compress(&mut image)?;
            image.dict.set("SMask", Object::Reference(smask_id));
            Ok(document.add_object(Object::Stream(image)))
        }
    }
}

/// Flate-compresses a stream in place; lopdf keeps the content unchanged when
/// compression does not pay off (tiny images stay raw).
fn compress(stream: &mut Stream) -> EngineResult<()> {
    stream
        .compress()
        .map_err(|error| EngineError::new("write_failed", format!("图片流压缩失败：{error}")))
}

/// Mirrors the browser `hexToRgb`: anything but `#rrggbb` becomes black.
pub(super) fn parse_background(value: &str) -> [u8; 3] {
    let hex = value.trim().trim_start_matches('#');
    if hex.len() == 6 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
        if let Ok(int) = u32::from_str_radix(hex, 16) {
            return [
                ((int >> 16) & 255) as u8,
                ((int >> 8) & 255) as u8,
                (int & 255) as u8,
            ];
        }
    }
    [0, 0, 0]
}

/// Reads the SOF component count so DCT passthrough picks the right color
/// space, as pdf-lib's embedJpg does.
pub(super) fn jpeg_components(bytes: &[u8]) -> Option<u8> {
    let mut offset = 2usize;
    while offset + 9 < bytes.len() {
        if bytes[offset] != 0xff {
            offset += 1;
            continue;
        }
        let marker = bytes.get(offset + 1).copied()?;
        if matches!(marker, 0xd8 | 0xd9 | 0x01 | 0xd0..=0xd7) {
            offset += 2;
            continue;
        }
        let length = ((bytes[offset + 2] as usize) << 8) | bytes[offset + 3] as usize;
        if length < 2 || offset + 2 + length > bytes.len() {
            return None;
        }
        if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) {
            return bytes.get(offset + 9).copied();
        }
        offset += 2 + length;
    }
    None
}
