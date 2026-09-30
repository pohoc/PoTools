//! Image embedding for the C3 PDF builders (`ofd-to-pdf`,
//! `markdown-to-pdf`), mirroring the pdf-lib `embedJpg`/`embedPng` behavior
//! the TS oracles rely on: JPEG bytes pass through as DCTDecode (color space
//! picked from the SOF component count), everything else decodes through the
//! `image` crate into FlateDecode RGB (plus an 8-bit /SMask when alpha is
//! present). Mirrors `pdf_extra/images_to_pdf/embed.rs` helpers, which are
//! module-private to pdf_extra and therefore ported here.

use image::{DynamicImage, ImageReader, RgbaImage};
use lopdf::{dictionary, Document, Object, ObjectId, Stream};
use std::io::Cursor;

/// Embeds `bytes` and returns `(object id, pixel width, pixel height)`.
/// `None`/`Err` when the payload cannot be used (callers warn and skip, like
/// the TS catch blocks).
pub(crate) fn embed(document: &mut Document, bytes: &[u8]) -> Option<(ObjectId, u32, u32)> {
    if bytes.len() >= 2 && bytes[0] == 0xff && bytes[1] == 0xd8 {
        let (width, height, components) = jpeg_sof(bytes)?;
        let id = document.add_object(Object::Stream(Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Image",
                "Width" => width as i64, "Height" => height as i64,
                "ColorSpace" => color_space(components), "BitsPerComponent" => 8,
                "Filter" => "DCTDecode",
            },
            bytes.to_vec(),
        )));
        return Some((id, width, height));
    }
    let decoded = decode_rgba(bytes)?;
    let (id, width, height) = embed_dynamic(document, &decoded)?;
    Some((id, width, height))
}

fn color_space(components: u8) -> &'static str {
    match components {
        1 => "DeviceGray",
        4 => "DeviceCMYK",
        _ => "DeviceRGB",
    }
}

/// Decodes any non-JPEG raster through the `image` crate. A JPEG that failed
/// the SOF scan lands here too and re-embeds as decoded RGB.
fn decode_rgba(bytes: &[u8]) -> Option<DynamicImage> {
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    DynamicImage::from_decoder(reader.into_decoder().ok()?).ok()
}

fn embed_dynamic(document: &mut Document, image: &DynamicImage) -> Option<(ObjectId, u32, u32)> {
    let (width, height) = (image.width(), image.height());
    if width == 0 || height == 0 {
        return None;
    }
    if image.color().has_alpha() {
        let rgba: RgbaImage = image.to_rgba8();
        let mut rgb = Vec::with_capacity(rgba.len() / 4 * 3);
        let mut alpha = Vec::with_capacity(rgba.len() / 4);
        for pixel in rgba.pixels() {
            rgb.extend_from_slice(&[pixel[0], pixel[1], pixel[2]]);
            alpha.push(pixel[3]);
        }
        let mut smask = Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Image",
                "Width" => width as i64, "Height" => height as i64, "BitsPerComponent" => 8,
            },
            alpha,
        );
        smask.compress().ok()?;
        let smask_id = document.add_object(Object::Stream(smask));
        let mut image_stream = Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Image",
                "Width" => width as i64, "Height" => height as i64,
                "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8,
            },
            rgb,
        );
        image_stream.compress().ok()?;
        image_stream.dict.set("SMask", Object::Reference(smask_id));
        return Some((
            document.add_object(Object::Stream(image_stream)),
            width,
            height,
        ));
    }
    let rgb = image.to_rgb8();
    let mut stream = Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Image",
            "Width" => width as i64, "Height" => height as i64,
            "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8,
        },
        rgb.as_raw().clone(),
    );
    stream.compress().ok()?;
    Some((document.add_object(Object::Stream(stream)), width, height))
}

/// SOF scan ported from `images_to_pdf/embed.rs`: returns
/// `(width, height, component count)` for baseline/progressive JPEGs.
pub(crate) fn jpeg_sof(bytes: &[u8]) -> Option<(u32, u32, u8)> {
    let mut offset = 2usize;
    while offset + 9 < bytes.len() {
        if bytes[offset] != 0xff {
            offset += 1;
            continue;
        }
        let marker = *bytes.get(offset + 1)?;
        if matches!(marker, 0xd8 | 0xd9 | 0x01 | 0xd0..=0xd7) {
            offset += 2;
            continue;
        }
        let length = ((*bytes.get(offset + 2)? as usize) << 8) | *bytes.get(offset + 3)? as usize;
        if length < 2 || offset + 2 + length > bytes.len() {
            return None;
        }
        if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) {
            let height =
                ((*bytes.get(offset + 5)? as usize) << 8) | *bytes.get(offset + 6)? as usize;
            let width =
                ((*bytes.get(offset + 7)? as usize) << 8) | *bytes.get(offset + 8)? as usize;
            return Some((width as u32, height as u32, *bytes.get(offset + 9)?));
        }
        offset += 2 + length;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sof_scan_reads_dimensions_and_components() {
        // Minimal SOF0: FF C0 len=8 precision=8 height=20 width=30 comps=3
        // (the segment length counts itself: 2 + 6 payload bytes).
        let bytes = [
            0xff, 0xd8, 0xff, 0xc0, 0x00, 0x08, 0x08, 0x00, 0x14, 0x00, 0x1e, 0x03,
        ];
        assert_eq!(jpeg_sof(&bytes), Some((30, 20, 3)));
        assert_eq!(jpeg_sof(&[0xff, 0xd8]), None);
    }
}
