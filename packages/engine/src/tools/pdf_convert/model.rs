//! serde models for the adapter-supplied PDF conversion inputs
//! (`runtimeData.pdfText` / `pdfImages` / `pdfPageImages` / `pdfOcrPages`).
//!
//! Contracts (camelCase JSON, produced by the web PDF.js adapter):
//!
//! ```text
//! pdfText: { [fileId]: Array<{
//!   page: number, width: number, height: number,
//!   runs: Array<{ text, x, y, w, h, size, font?, weight?, style? }>
//! }> }
//! pdfImages: { [fileId]: Array<{ page, index, widthPt, heightPt, bytes }> }
//! pdfPageImages: { [fileId]: Array<{ page, dpi, bytes }> }
//! pdfOcrPages: { [fileId]: Array<{ page, text }> }
//! ```
//!
//! `x/y` are top-left visual coordinates in points (`y = baseline −
//! ascent*size`, computed adapter-side), `w/h` the item box, `size` the font
//! size and `font/weight/style` optional style hints. A missing `pdfText`
//! entry for a file means "no extractable text" (zero pages). `pdfImages`
//! carries the PNG crops of the page regions reported by the `pdfImageRects`
//! export (`index` is the 0-based position in that page's `rects` array);
//! a missing or empty entry means "no images". `pdfPageImages` carries
//! full-page PNG renders (word scan-page fallback; dpi 150).
//! `pdfOcrPages` carries OCR fallback text for zero-text pages, with
//! recognized lines already trimmed, filtered and joined with `\n`.

use crate::RunContext;
use base64::Engine as _;
use serde::Deserialize;
use serde_json::Value;

/// One PDF.js text run as delivered by the browser adapter. `font`/`style`
/// complete the wire contract even though only `weight` drives classification.
#[allow(dead_code)]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfTextRun {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default)]
    pub w: f64,
    #[serde(default)]
    pub h: f64,
    #[serde(default)]
    pub size: f64,
    #[serde(default)]
    pub font: Option<String>,
    #[serde(default)]
    pub weight: Option<String>,
    #[serde(default)]
    pub style: Option<String>,
}

/// One page of extracted text runs. `width`/`height` are the visual (post
/// rotation) page size in points; the word writer reads them for scan-page
/// image blocks and the content width.
#[allow(dead_code)]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfTextPage {
    #[serde(default)]
    pub page: u32,
    #[serde(default)]
    pub width: f64,
    #[serde(default)]
    pub height: f64,
    #[serde(default)]
    pub runs: Vec<PdfTextRun>,
}

/// One cropped page region PNG (from the `pdfImageRects` export). `index` is
/// the rect index within that page's `rects` array (0-based).
#[allow(dead_code)]
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PdfImagePlacement {
    #[serde(default)]
    pub page: u32,
    #[serde(default)]
    pub index: u32,
    #[serde(default)]
    pub width_pt: f64,
    #[serde(default)]
    pub height_pt: f64,
    #[serde(default, deserialize_with = "deserialize_bytes_flex")]
    pub bytes: Vec<u8>,
}

/// One full-page PNG render (scan-page fallback; dpi 150 for word).
#[allow(dead_code)]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfPageImage {
    #[serde(default)]
    pub page: u32,
    #[serde(default)]
    pub dpi: f64,
    #[serde(default, deserialize_with = "deserialize_bytes_flex")]
    pub bytes: Vec<u8>,
}

/// OCR fallback text for one zero-text page: recognized lines already
/// trimmed, filtered and joined with `\n` (adapter-side).
#[allow(dead_code)]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfOcrPage {
    #[serde(default)]
    pub page: u32,
    #[serde(default)]
    pub text: String,
}

/// Reads one input's `key` entry as a list of `T`. Follows the
/// `contentInsets` precedent in `pdf_extra.rs`: the per-file entry is looked
/// up directly on the runtime JSON instead of deserializing the whole
/// file-id keyed object, so one malformed entry cannot blank the other
/// inputs. Missing or malformed data yields an empty list, never an error.
fn read_entries<T: serde::de::DeserializeOwned>(
    ctx: &RunContext<'_>,
    key: &str,
    file_id: &str,
) -> Vec<T> {
    let Some(entry) = ctx
        .runtime_data
        .and_then(|data| data.get(key))
        .and_then(|map| map.get(file_id))
    else {
        return Vec::new();
    };
    serde_json::from_value(entry.clone()).unwrap_or_default()
}

/// Wire bytes for adapter-built runtime data: either a JSON array of numbers
/// or a base64 string (the adapter encodes large rasters before dispatch,
/// because a raw `Uint8Array` cannot be deserialized into a JSON value).
fn deserialize_bytes_flex<'de, D>(deserializer: D) -> Result<Vec<u8>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use base64::Engine as _;
    let value = serde_json::Value::deserialize(deserializer)?;
    if let Some(encoded) = value.as_str() {
        return base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(serde::de::Error::custom);
    }
    let Some(items) = value.as_array() else {
        return Ok(Vec::new());
    };
    Ok(items
        .iter()
        .filter_map(serde_json::Value::as_u64)
        .map(|value| value as u8)
        .collect())
}

/// Reads one input's `pdfText` pages.
pub fn pdf_text_pages(ctx: &RunContext<'_>, file_id: &str) -> Vec<PdfTextPage> {
    read_entries(ctx, "pdfText", file_id)
}

/// Reads one input's cropped region images.
pub fn pdf_images(ctx: &RunContext<'_>, file_id: &str) -> Vec<PdfImagePlacement> {
    read_entries(ctx, "pdfImages", file_id)
}

/// Reads one input's full-page renders.
pub fn pdf_page_images(ctx: &RunContext<'_>, file_id: &str) -> Vec<PdfPageImage> {
    read_entries(ctx, "pdfPageImages", file_id)
}

/// Reads one input's OCR fallback pages.
pub fn pdf_ocr_pages(ctx: &RunContext<'_>, file_id: &str) -> Vec<PdfOcrPage> {
    read_entries(ctx, "pdfOcrPages", file_id)
}

/// The adapter-supplied OFD font (`runtimeData.ofdFont`): a `{name, bytes}`
/// pair. Validated like the TS oracle (string name, non-empty byte payload);
/// `None` when absent or malformed so callers fall back to `systemFonts`.
pub fn ofd_font(ctx: &RunContext<'_>) -> Option<FontResource> {
    let entry = ctx.runtime_data?.get("ofdFont")?;
    let name = entry.get("name")?.as_str()?.to_owned();
    let bytes = byte_array(entry.get("bytes")?)?;
    (!bytes.is_empty()).then_some(FontResource { name, bytes })
}

/// One host font resource (`runtimeData.systemFonts` entry) or the configured
/// markdown font (`runtimeData.markdownFontBytes`).
#[derive(Clone, Debug)]
pub struct FontResource {
    pub name: String,
    pub bytes: Vec<u8>,
}

/// Host-discovered fonts (`runtimeData.systemFonts`), validated the same way
/// as `lib/system-fonts.ts`: string name plus a byte payload.
pub fn font_resources(ctx: &RunContext<'_>) -> Vec<FontResource> {
    let Some(items) = ctx
        .runtime_data
        .and_then(|data| data.get("systemFonts"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let name = item.get("name")?.as_str()?.to_owned();
            let bytes = item
                .get("bytes")
                .and_then(byte_array)
                .or_else(|| item.get("bytesBase64").and_then(byte_array))?;
            Some(FontResource { name, bytes })
        })
        .collect()
}

/// The user-configured markdown font bytes (`runtimeData.markdownFontBytes`),
/// when present.
pub fn markdown_font_bytes(ctx: &RunContext<'_>) -> Option<Vec<u8>> {
    byte_array(ctx.runtime_data?.get("markdownFontBytes")?)
}

/// The filesystem image assets the host resolved for one markdown input
/// (`runtimeData.markdownAssets`), keyed by `` `${inputId}\0${src}` ``.
pub fn markdown_assets(ctx: &RunContext<'_>) -> std::collections::HashMap<String, Vec<u8>> {
    let Some(entries) = ctx
        .runtime_data
        .and_then(|data| data.get("markdownAssets"))
        .and_then(Value::as_object)
    else {
        return Default::default();
    };
    entries
        .iter()
        .filter_map(|(key, value)| byte_array(value).map(|bytes| (key.clone(), bytes)))
        .collect()
}

/// Decodes a wire byte payload: array of numbers (wasm runtimeData) or a
/// base64 string. Anything else is absent.
fn byte_array(value: &Value) -> Option<Vec<u8>> {
    if let Some(encoded) = value.as_str() {
        return base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .ok();
    }
    value.as_array().map(|items| {
        items
            .iter()
            .filter_map(Value::as_u64)
            .map(|value| value as u8)
            .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn image_entries_deserialize_camel_case() {
        let entries: Vec<PdfImagePlacement> = serde_json::from_value(json!([
            { "page": 2, "index": 1, "widthPt": 300.5, "heightPt": 120, "bytes": [1, 2, 3] }
        ]))
        .unwrap();
        assert_eq!(entries[0].page, 2);
        assert_eq!(entries[0].index, 1);
        assert_eq!(entries[0].width_pt, 300.5);
        assert_eq!(entries[0].height_pt, 120.0);
        assert_eq!(entries[0].bytes, vec![1, 2, 3]);
    }

    #[test]
    fn ocr_and_page_image_entries_deserialize() {
        let ocr: Vec<PdfOcrPage> =
            serde_json::from_value(json!([{ "page": 3, "text": "a\nb" }])).unwrap();
        assert_eq!(ocr[0].text, "a\nb");
        let renders: Vec<PdfPageImage> =
            serde_json::from_value(json!([{ "page": 1, "dpi": 150, "bytes": [] }])).unwrap();
        assert_eq!(renders[0].dpi, 150.0);
    }

    #[test]
    fn missing_runtime_data_yields_empty() {
        let options = serde_json::Value::Null;
        let ctx = RunContext {
            tool: "t",
            options: &options,
            locale: "zh-CN",
            inputs: &[],
            name_pattern: None,
            runtime_data: None,
        };
        assert_eq!(pdf_images(&ctx, "f"), Vec::<PdfImagePlacement>::new());
    }
}
