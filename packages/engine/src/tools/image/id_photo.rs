//! Compose the transparent person image prepared by the local UI into ID photos.

use super::*;
use potools_core::id_photo::{get_id_photo_size, print_size_300_dpi};

const QUALITIES: [u8; 22] = [
    94, 90, 86, 82, 78, 74, 70, 66, 62, 58, 54, 50, 46, 42, 38, 34, 30, 26, 22, 18, 14, 10,
];

fn jpeg_density(bytes: Vec<u8>, dpi: u16) -> Vec<u8> {
    if bytes.len() < 2 || bytes[..2] != [0xff, 0xd8] {
        return bytes;
    }
    let density = dpi.max(1).to_be_bytes();
    if bytes.len() >= 18 && bytes[2..4] == [0xff, 0xe0] && &bytes[6..11] == b"JFIF\0" {
        let mut bytes = bytes;
        bytes[13] = 1;
        bytes[14..16].copy_from_slice(&density);
        bytes[16..18].copy_from_slice(&density);
        return bytes;
    }
    let segment = [
        0xff, 0xe0, 0, 16, b'J', b'F', b'I', b'F', 0, 1, 1, 1, density[0], density[1], density[0],
        density[1], 0, 0,
    ];
    let mut output = Vec::with_capacity(bytes.len() + segment.len());
    output.extend_from_slice(&bytes[..2]);
    output.extend_from_slice(&segment);
    output.extend_from_slice(&bytes[2..]);
    output
}

fn photo_frame(
    image: &RgbaImage,
    options: &Value,
    width: u32,
    height: u32,
) -> Result<RgbaImage, EngineError> {
    let mut left = image.width();
    let mut top = image.height();
    let mut right = 0;
    let mut bottom = 0;
    let mut found = false;
    for (x, y, pixel) in image.enumerate_pixels() {
        if pixel[3] < 24 {
            continue;
        }
        left = left.min(x);
        top = top.min(y);
        right = right.max(x);
        bottom = bottom.max(y);
        found = true;
    }
    if !found {
        return Err(EngineError::new(
            "unreadable_file",
            "没有识别到人物，请换一张正面清晰的照片。",
        ));
    }
    let scale = option_number(options, "scale", 100.0).clamp(70.0, 130.0) / 100.0;
    let vertical = option_number(options, "verticalOffset", 0.0).clamp(-20.0, 20.0) / 100.0;
    let aspect = width as f64 / height as f64;
    let crop_height = (((bottom - top + 1) as f64 * 0.62).max((right - left + 1) as f64 / aspect)
        / scale)
        .max(1.0);
    let crop_width = crop_height * aspect;
    let crop_x = ((left as f64 + right as f64 + 1.0) / 2.0 - crop_width / 2.0).round() as i64;
    let crop_y = (top as f64 - crop_height * 0.035 + crop_height * vertical).round() as i64;
    let crop_w = crop_width.round().max(1.0) as u32;
    let crop_h = crop_height.round().max(1.0) as u32;
    if u64::from(crop_w) * u64::from(crop_h) > MAX_PIXELS {
        return Err(bad_request("证件照裁切范围超出处理范围"));
    }
    let mut crop = RgbaImage::new(crop_w, crop_h);
    let x0 = crop_x.max(0) as u32;
    let y0 = crop_y.max(0) as u32;
    let x1 = (crop_x + i64::from(crop_w))
        .min(i64::from(image.width()))
        .max(0) as u32;
    let y1 = (crop_y + i64::from(crop_h))
        .min(i64::from(image.height()))
        .max(0) as u32;
    for y in y0..y1 {
        for x in x0..x1 {
            crop.put_pixel(
                (i64::from(x) - crop_x) as u32,
                (i64::from(y) - crop_y) as u32,
                *image.get_pixel(x, y),
            );
        }
    }
    let resized = imageops::resize(&crop, width, height, imageops::FilterType::Lanczos3);
    let mut output = RgbaImage::from_pixel(width, height, background(options));
    imageops::overlay(&mut output, &resized, 0, 0);
    Ok(output)
}

fn print_sheet(photo: &[u8], id: &str) -> Result<Vec<u8>, EngineError> {
    let photo = decode(photo)?;
    let (print_w, print_h) = print_size_300_dpi(Some(id));
    let (width, height, margin, gap) = (2480u32, 3508u32, 59u32, 24u32);
    let columns = ((width - 2 * margin + gap) / (print_w + gap)).max(1);
    let rows = ((height - 2 * margin + gap) / (print_h + gap)).max(1);
    let content_w = columns * print_w + (columns - 1) * gap;
    let content_h = rows * print_h + (rows - 1) * gap;
    let origin_x = (width - content_w) / 2;
    let origin_y = (height - content_h) / 2;
    let tile = photo.resize_exact(print_w, print_h, imageops::FilterType::Lanczos3);
    let mut sheet = RgbaImage::from_pixel(width, height, Rgba([255, 255, 255, 255]));
    for row in 0..rows {
        for column in 0..columns {
            imageops::overlay(
                &mut sheet,
                &tile,
                i64::from(origin_x + column * (print_w + gap)),
                i64::from(origin_y + row * (print_h + gap)),
            );
        }
    }
    let bytes = encode(
        DynamicImage::ImageRgba8(sheet),
        RasterFormat::Jpeg,
        94,
        Rgba([255, 255, 255, 255]),
    )?;
    Ok(jpeg_density(bytes, 300))
}

pub(super) fn run(context: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let input = context
        .inputs
        .first()
        .ok_or_else(|| bad_request("请先添加图片"))?;
    let image = decode(&input.bytes)?;
    if !image.color().has_alpha() {
        return Err(EngineError::new(
            "unreadable_file",
            "人物抠图结果没有透明通道，请重新识别人物。",
        ));
    }
    let id = context.options.get("size").and_then(Value::as_str);
    let size = get_id_photo_size(id);
    let framed = photo_frame(&image.to_rgba8(), context.options, size.width, size.height)?;
    let limit_kb = option_number(context.options, "maxFileKb", 100.0)
        .round()
        .clamp(10.0, 1000.0) as usize;
    let limit_bytes = limit_kb * 1024;
    let mut smallest = usize::MAX;
    let mut chosen = None;
    for quality in QUALITIES {
        let bytes = encode(
            DynamicImage::ImageRgba8(framed.clone()),
            RasterFormat::Jpeg,
            quality,
            background(context.options),
        )?;
        smallest = smallest.min(bytes.len());
        if bytes.len() <= limit_bytes {
            chosen = Some(bytes);
            break;
        }
    }
    let bytes = chosen.ok_or_else(|| {
        bad_request(format!(
            "证件照最低可用画质仍为 {} KB，超过 {} KB 上限；请提高文件大小上限后重试。",
            smallest.div_ceil(1024),
            limit_kb
        ))
    })?;
    let dpi = size.dpi.unwrap_or(300);
    let photo = jpeg_density(bytes, dpi);
    let stem = naming_base(&input.name);
    let mut result = ToolResult::default();
    let mut artifact = Artifact::new(
        format!("{}-{}-id-photo.jpg", stem, size.file_label),
        "image",
        photo.clone(),
    );
    artifact.source_file_id = Some(input.id.clone());
    result.artifacts.push(artifact);
    if option_bool(context.options, "printSheet", false) {
        let sheet = print_sheet(&photo, &size.id)?;
        let mut artifact = Artifact::new(
            format!("{}-{}-A4-print-sheet.jpg", stem, size.file_label),
            "image",
            sheet,
        );
        artifact.source_file_id = Some(input.id.clone());
        result.artifacts.push(artifact);
    }
    result.extra = json!({"width":size.width,"height":size.height,"dpi":dpi,"fileSizeLimitKb":limit_kb,"photoBytes":photo.len()})
        .as_object().cloned().unwrap_or_default();
    Ok(result)
}
