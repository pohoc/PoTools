//! Pure OCR business logic: localized messages, table reconstruction,
//! ocr-text/ocr-table artifact assembly and image decoding.
//!
//! The browser adapter owns model inference (PaddleOCR ONNX) and PDF
//! rendering (PDF.js); this module owns the parsing and rules so both hosts
//! stay consistent with the retired `ocr-browser.ts` implementation.
//! No `wasm-bindgen` here — the thin JS ABI lives in `wasm.rs`.

use crate::services::xlsx::{self, Sheet};
use crate::EngineError;
use image::{metadata::Orientation, DynamicImage, ImageDecoder, ImageReader};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::HashSet;
use std::io::Cursor;

/// One recognized text line as sent by the adapter (polygons are already
/// collapsed to their min/max bounding box).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrLine {
    pub text: String,
    #[serde(default)]
    pub confidence: Option<f64>,
    #[serde(rename = "box", default)]
    pub box_: Option<[f64; 4]>,
}

/// One recognized page. `page` is the 1-based page number, `width` the raster
/// width in pixels used for column-anchor thresholds.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrPage {
    #[serde(default = "default_page")]
    pub page: u32,
    #[serde(default)]
    pub width: Option<f64>,
    #[serde(default)]
    pub lines: Vec<OcrLine>,
}

fn default_page() -> u32 {
    1
}

/// One input file with its recognized pages.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrInput {
    pub name: String,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub pages: Vec<OcrPage>,
}

/// Request for [`ocr_text_artifacts`].
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrTextRequest {
    #[serde(default)]
    pub inputs: Vec<OcrInput>,
    #[serde(default = "default_true")]
    pub page_markers: bool,
    #[serde(default)]
    pub locale: String,
}

fn default_true() -> bool {
    true
}

/// Request for [`ocr_table_workbook`].
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrTableRequest {
    #[serde(default)]
    pub inputs: Vec<OcrInput>,
    #[serde(default)]
    pub locale: String,
}

/// Error payload embedded in replies so the adapter parses one uniform shape.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint_key: Option<String>,
}

impl OcrError {
    fn from_engine(error: EngineError) -> Self {
        OcrError {
            code: error.code.to_string(),
            message: error.message,
            hint_key: error.hint_key.map(str::to_string),
        }
    }
}

/// An assembled text artifact; the adapter encodes and downloads it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrTextArtifact {
    pub name: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_id: Option<String>,
}

/// Reply for [`ocr_text_artifacts`]. `empty` mirrors the `empty_selection`
/// error condition: no input produced any recognized page.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrTextReply {
    pub artifacts: Vec<OcrTextArtifact>,
    pub warnings: Vec<String>,
    pub empty: bool,
    pub pages: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<OcrError>,
}

/// Reply for [`ocr_table_workbook`]; `bytes` is the XLSX file content.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrTableReply {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<Vec<u8>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pages: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows: Option<usize>,
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<OcrError>,
}

/// The six localized strings from `lib/messages/ocr.ts`, verbatim.
#[derive(Debug, Clone, Copy)]
pub(crate) enum OcrMessage {
    Page,
    WarningEmpty,
    WarningNoTable,
    WarningReview,
    ErrorEmpty,
    ErrorNoTable,
}

/// Same locale pick as the web `normalizeLocale`: an "en*" locale (after
/// trimming/casing) selects English, everything else defaults to zh-CN.
pub(crate) fn ocr_message(locale: &str, key: OcrMessage) -> &'static str {
    let english = locale.trim().to_lowercase().starts_with("en");
    match (key, english) {
        (OcrMessage::Page, false) => "第 {page} 页",
        (OcrMessage::WarningEmpty, false) => "{name}：没有识别到文字。",
        (OcrMessage::WarningNoTable, false) => "{name} 第 {page} 页：没有识别到表格内容。",
        (OcrMessage::WarningReview, false) => {
            "OCR 表格按文字位置自动推断行列，请打开工作簿检查表头、列顺序和数字。"
        }
        (OcrMessage::ErrorEmpty, false) => "没有可识别的页面。",
        (OcrMessage::ErrorNoTable, false) => "没有识别到可导出的表格内容。",
        (OcrMessage::Page, true) => "Page {page}",
        (OcrMessage::WarningEmpty, true) => "{name}: no text was recognized.",
        (OcrMessage::WarningNoTable, true) => "{name}, page {page}: no table content was recognized.",
        (OcrMessage::WarningReview, true) => {
            "Rows and columns are inferred from OCR text positions. Review the workbook for headers, column order, and numbers."
        }
        (OcrMessage::ErrorEmpty, true) => "There are no pages to recognize.",
        (OcrMessage::ErrorNoTable, true) => "No table content was recognized for export.",
    }
}

fn interpolate(template: &str, params: &[(&str, String)]) -> String {
    let mut out = template.to_string();
    for (key, value) in params {
        out = out.replace(&format!("{{{key}}}"), value);
    }
    out
}

fn asc(a: &f64, b: &f64) -> Ordering {
    a.partial_cmp(b).unwrap_or(Ordering::Equal)
}

/// Reconstructs table rows from positioned OCR lines, ported from
/// `tableRows` in `ocr-browser.ts`: lines are sorted by top then left,
/// clustered into rows by vertical-center distance (≤ 0.55 × the taller of
/// line/row height), and assigned to rolling-average column anchors.
pub fn table_rows(lines: &[OcrLine], width: f64) -> Vec<Vec<String>> {
    let mut positioned: Vec<PositionedLine> = Vec::new();
    for line in lines {
        if line.text.trim().is_empty() {
            continue;
        }
        let index = positioned.len();
        let (left, top, right, bottom) = match line.box_ {
            Some(box_) => (box_[0], box_[1], box_[2], box_[3]),
            None => {
                let left = index as f64 * 10.0;
                let top = index as f64 * 24.0;
                let right = left + 24.0f64.max(xlsx::js_len(&line.text) as f64 * 12.0);
                let bottom = top + 18.0;
                (left, top, right, bottom)
            }
        };
        positioned.push(PositionedLine {
            text: line.text.trim().to_string(),
            left,
            top,
            right,
            bottom,
        });
    }
    positioned.sort_by(|a, b| asc(&a.top, &b.top).then(asc(&a.left, &b.left)));
    if positioned.is_empty() {
        return Vec::new();
    }
    let mut lefts: Vec<f64> = positioned.iter().map(|line| line.left).collect();
    lefts.sort_by(|a, b| asc(a, b));
    let mut rows: Vec<Vec<PositionedLine>> = Vec::new();
    for line in positioned {
        let line_center = (line.top + line.bottom) / 2.0;
        let line_height = line.bottom - line.top;
        let target = rows.iter().position(|row| {
            let top = row
                .iter()
                .map(|cell| cell.top)
                .fold(f64::INFINITY, f64::min);
            let bottom = row
                .iter()
                .map(|cell| cell.bottom)
                .fold(f64::NEG_INFINITY, f64::max);
            let height = line_height.max(bottom - top);
            (line_center - (top + bottom) / 2.0).abs() <= height * 0.55
        });
        match target {
            Some(index) => rows[index].push(line),
            None => rows.push(vec![line]),
        }
    }
    rows.sort_by(|a, b| {
        let min = |row: &Vec<PositionedLine>| {
            row.iter()
                .map(|cell| cell.top)
                .fold(f64::INFINITY, f64::min)
        };
        asc(&min(a), &min(b))
    });
    let threshold = 18.0f64.max(width * 0.018);
    let mut anchors: Vec<f64> = Vec::new();
    for left in lefts {
        match anchors
            .iter()
            .position(|anchor| (*anchor - left).abs() <= threshold)
        {
            Some(index) => anchors[index] = (anchors[index] + left) / 2.0,
            None => anchors.push(left),
        }
    }
    anchors.sort_by(|a, b| asc(a, b));
    rows.iter()
        .map(|row| {
            let mut cells = vec![String::new(); anchors.len()];
            let mut sorted: Vec<&PositionedLine> = row.iter().collect();
            sorted.sort_by(|a, b| asc(&a.left, &b.left));
            for line in sorted {
                let mut best = 0usize;
                for (index, anchor) in anchors.iter().enumerate() {
                    if (anchor - line.left).abs() < (anchors[best] - line.left).abs() {
                        best = index;
                    }
                }
                let mut column = best;
                if !cells[column].is_empty() {
                    let next = (column + 1..anchors.len()).find(|index| cells[*index].is_empty());
                    if let Some(next) = next {
                        if line.left - anchors[column] > threshold {
                            column = next;
                        }
                    }
                }
                if cells[column].is_empty() {
                    cells[column] = line.text.clone();
                } else {
                    cells[column] = format!("{} {}", cells[column], line.text);
                }
            }
            cells
        })
        .collect()
}

/// Assembles the per-input `*-ocr.txt` artifacts for the ocr-text tool,
/// ported from `ocrTextBrowser.run` in `ocr-browser.ts`.
pub fn ocr_text_artifacts(request: &OcrTextRequest) -> OcrTextReply {
    let mut artifacts = Vec::new();
    let mut warnings = Vec::new();
    let mut total_pages = 0usize;
    for input in &request.inputs {
        total_pages += input.pages.len();
        let base = crate::services::naming::base_name(&input.name);
        let parts: Vec<String> = input
            .pages
            .iter()
            .map(|page| {
                let body = page
                    .lines
                    .iter()
                    .map(|line| line.text.trim())
                    .collect::<Vec<_>>()
                    .join("\n")
                    .trim()
                    .to_string();
                if request.page_markers && input.pages.len() > 1 {
                    format!(
                        "{}\n{}",
                        interpolate(
                            ocr_message(&request.locale, OcrMessage::Page),
                            &[("page", page.page.to_string())]
                        ),
                        body
                    )
                } else {
                    body
                }
            })
            .filter(|part| !part.is_empty())
            .collect();
        let text = parts.join("\n\n");
        if text.is_empty() {
            warnings.push(interpolate(
                ocr_message(&request.locale, OcrMessage::WarningEmpty),
                &[("name", base.to_string())],
            ));
        } else {
            artifacts.push(OcrTextArtifact {
                name: format!("{base}-ocr.txt"),
                text: format!("{text}\n"),
                input_id: input.id.clone(),
            });
        }
    }
    let empty = total_pages == 0;
    OcrTextReply {
        artifacts,
        warnings,
        empty,
        pages: total_pages,
        error: empty.then(|| OcrError {
            code: "empty_selection".into(),
            message: ocr_message(&request.locale, OcrMessage::ErrorEmpty).to_string(),
            hint_key: None,
        }),
    }
}

/// Builds the merged ocr-table workbook, ported from `ocrTableBrowser.run` in
/// `ocr-browser.ts`. Sheet names are deduped across the whole job and empty
/// sheets (pages without table content) are skipped with a warning.
pub fn ocr_table_workbook(request: &OcrTableRequest) -> OcrTableReply {
    let mut sheets: Vec<Sheet> = Vec::new();
    let mut taken: HashSet<String> = HashSet::new();
    let mut warnings = Vec::new();
    for input in &request.inputs {
        let base = crate::services::naming::base_name(&input.name);
        for page in &input.pages {
            let rows = table_rows(&page.lines, page.width.unwrap_or(0.0));
            if rows.is_empty() {
                warnings.push(interpolate(
                    ocr_message(&request.locale, OcrMessage::WarningNoTable),
                    &[("name", base.to_string()), ("page", page.page.to_string())],
                ));
                continue;
            }
            let sanitized = xlsx::sanitize_sheet_name(&format!("{base}-{}", page.page));
            let sheet_base = if sanitized.is_empty() {
                format!("Page-{}", sheets.len() + 1)
            } else {
                sanitized
            };
            sheets.push(Sheet {
                name: xlsx::unique_sheet_name(&sheet_base, &mut taken),
                rows,
            });
        }
    }
    if sheets.is_empty() {
        return OcrTableReply {
            ok: false,
            name: None,
            bytes: None,
            pages: None,
            rows: None,
            warnings,
            error: Some(OcrError {
                code: "empty_selection".into(),
                message: ocr_message(&request.locale, OcrMessage::ErrorNoTable).to_string(),
                hint_key: Some("error.noTable".into()),
            }),
        };
    }
    let bytes = match xlsx::write_xlsx(&sheets) {
        Ok(bytes) => bytes,
        Err(error) => {
            return OcrTableReply {
                ok: false,
                name: None,
                bytes: None,
                pages: None,
                rows: None,
                warnings,
                error: Some(OcrError::from_engine(error)),
            };
        }
    };
    let output_name = if request.inputs.len() == 1 {
        format!(
            "{}-tables.xlsx",
            crate::services::naming::base_name(&request.inputs[0].name)
        )
    } else {
        "ocr-tables.xlsx".to_string()
    };
    warnings.push(ocr_message(&request.locale, OcrMessage::WarningReview).to_string());
    OcrTableReply {
        ok: true,
        name: Some(output_name),
        pages: Some(sheets.len()),
        rows: Some(sheets.iter().map(|sheet| sheet.rows.len()).sum()),
        bytes: Some(bytes),
        warnings,
        error: None,
    }
}

struct PositionedLine {
    text: String,
    left: f64,
    top: f64,
    #[allow(dead_code)]
    right: f64,
    bottom: f64,
}

/// A decoded image ready for OCR: RGBA pixels with EXIF orientation applied.
/// The adapter converts RGBA→RGB before inference (as `recognizePixels` did).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodedImage {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// Decodes an image for OCR with the `image` crate, applying EXIF orientation
/// like `images_to_pdf/embed.rs`, and enforcing the OCR pixel budget.
pub fn decode_image_rgba(bytes: &[u8], max_pixels: u64) -> Result<DecodedImage, EngineError> {
    let unsupported = || EngineError::new("unreadable_file", "不支持的图片格式");
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| unsupported())?;
    if reader.format().is_none() {
        return Err(unsupported());
    }
    let mut decoder = reader
        .into_decoder()
        .map_err(|error| EngineError::new("unreadable_file", format!("图片解码失败：{error}")))?;
    let (width, height) = decoder.dimensions();
    if width == 0 || height == 0 {
        return Err(unsupported());
    }
    if u64::from(width) * u64::from(height) > max_pixels {
        // The TS oracle had no user-facing message here (it bailed to the host
        // via InMemoryFallback); this message is new. Formatted in 万-pixel
        // units so the standard 20e6 budget renders as 2000 万像素.
        return Err(EngineError::new(
            "unsupported",
            format!(
                "页面尺寸超过 OCR 上限（{} 万像素）",
                max_pixels as f64 / 1e4
            ),
        ));
    }
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder)
        .map_err(|error| EngineError::new("unreadable_file", format!("图片解码失败：{error}")))?;
    image.apply_orientation(orientation);
    let rgba = image.to_rgba8();
    Ok(DecodedImage {
        width: rgba.width(),
        height: rgba.height(),
        rgba: rgba.into_raw(),
    })
}
