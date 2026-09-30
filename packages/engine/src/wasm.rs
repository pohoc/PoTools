//! JavaScript ABI for running platform-neutral tools in a browser Worker.

use potools_core::{Artifact, InputFile, ToolResult};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::PathBuf;
use wasm_bindgen::prelude::*;

fn to_js_json<T: Serialize + ?Sized>(value: &T) -> Result<JsValue, JsValue> {
    value
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

/// Like [`to_js_json`], but `Vec<u8>` fields become a JS `Uint8Array` instead
/// of an array of numbers (`json_compatible` otherwise, so `Option::None` is
/// still `null` and replies remain `JSON.stringify`-able). Used by the OCR
/// exports whose payloads carry image pixels or XLSX bytes.
fn to_js_payload<T: Serialize + ?Sized>(value: &T) -> Result<JsValue, JsValue> {
    value
        .serialize(
            &serde_wasm_bindgen::Serializer::json_compatible().serialize_bytes_as_arrays(false),
        )
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

#[wasm_bindgen(js_name = coreAllTools)]
pub fn core_all_tools() -> Result<JsValue, JsValue> {
    let tools =
        potools_core::tools::all_tools().map_err(|error| JsValue::from_str(&error.to_string()))?;
    to_js_json(&tools)
}

#[wasm_bindgen(js_name = coreFieldsOf)]
pub fn core_fields_of(fields: JsValue) -> Result<JsValue, JsValue> {
    let fields: Vec<potools_core::fields::ToolField> = serde_wasm_bindgen::from_value(fields)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    to_js_json(&potools_core::fields::fields_of(&fields))
}

#[wasm_bindgen(js_name = coreVisibleFields)]
pub fn core_visible_fields(fields: JsValue, values: JsValue) -> Result<JsValue, JsValue> {
    let fields: Vec<potools_core::fields::ToolField> = serde_wasm_bindgen::from_value(fields)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    let values: Map<String, Value> = serde_wasm_bindgen::from_value(values)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    let visible = potools_core::fields::visible_fields(&fields, &values);
    to_js_json(&visible)
}

#[wasm_bindgen(js_name = coreParsePageRanges)]
pub fn core_parse_page_ranges(input: &str, page_count: usize) -> Result<JsValue, JsValue> {
    let pages = potools_core::pages::parse_page_ranges(input, page_count)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    to_js_json(&pages)
}

#[wasm_bindgen(js_name = coreFormatPageRanges)]
pub fn core_format_page_ranges(pages: JsValue) -> Result<String, JsValue> {
    let pages: Vec<usize> = serde_wasm_bindgen::from_value(pages)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    Ok(potools_core::pages::format_page_ranges(&pages))
}

#[wasm_bindgen(js_name = coreIsValidPageRanges)]
pub fn core_is_valid_page_ranges(input: &str) -> bool {
    potools_core::pages::is_valid_page_ranges(input)
}

#[wasm_bindgen(js_name = coreAssessPasswordStrength)]
pub fn core_assess_password_strength(password: &str) -> Result<JsValue, JsValue> {
    use potools_core::password_strength::{
        assess_password_strength, PasswordStrengthLevel as L, PasswordStrengthTip as T,
    };
    let assessment = assess_password_strength(password);
    let level = match assessment.level {
        L::VeryWeak => "very-weak",
        L::Weak => "weak",
        L::Fair => "fair",
        L::Strong => "strong",
        L::VeryStrong => "very-strong",
    };
    let tips: Vec<&str> = assessment
        .tips
        .iter()
        .map(|tip| match tip {
            T::Length => "length",
            T::Variety => "variety",
            T::Common => "common",
            T::Repeated => "repeated",
        })
        .collect();
    to_js_json(
        &serde_json::json!({ "level": level, "score": assessment.score, "length": assessment.length, "tips": tips }),
    )
}

#[wasm_bindgen(js_name = coreIdPhotoPrintSize)]
pub fn core_id_photo_print_size(id: Option<String>) -> Result<JsValue, JsValue> {
    let (width, height) = potools_core::id_photo::print_size_300_dpi(id.as_deref());
    to_js_json(&serde_json::json!({ "width": width, "height": height }))
}

#[wasm_bindgen(js_name = coreIdPhotoSize)]
pub fn core_id_photo_size(id: Option<String>) -> Result<JsValue, JsValue> {
    to_js_json(potools_core::id_photo::get_id_photo_size(id.as_deref()))
}

#[wasm_bindgen(js_name = parseInvoiceFields)]
pub fn parse_invoice_fields(text: &str) -> Result<JsValue, JsValue> {
    to_js_json(&crate::tools::pdf_extra::export::parse_invoice_fields(text))
}

/// Decodes an image for the browser OCR adapter: bytes in, `{ width, height,
/// rgba }` out (`rgba` is a `Uint8Array`; the adapter strips alpha to RGB).
/// `max_pixels` is the OCR pixel budget (the adapter passes 20e6).
///
/// Rejections carry an error object (not a string) `{ code, message,
/// hintKey }` (same shape as the `error` field of `dispatch` replies, with
/// `hintKey: null` when absent): `unreadable_file` for unrecognized/corrupt
/// images, `unsupported` when the pixel budget is exceeded.
#[wasm_bindgen(js_name = decodeImageRgba)]
pub fn decode_image_rgba(bytes: Vec<u8>, max_pixels: f64) -> Result<JsValue, JsValue> {
    let decoded = match crate::ocr::decode_image_rgba(&bytes, max_pixels.max(0.0) as u64) {
        Ok(decoded) => decoded,
        Err(error) => {
            // Rejections carry the error object itself (not a JSON string);
            // see the doc comment above for the exact `{ code, message,
            // hintKey }` shape the adapter parses.
            return Err(to_js_payload(&SerializableError {
                code: error.code.into(),
                message: error.message,
                hint_key: error.hint_key,
            })?);
        }
    };
    to_js_payload(&decoded)
}

/// Assembles ocr-text artifacts from adapter-side recognition results.
///
/// Request JSON: `{ inputs: [{ name, id?, pages: [{ page?, width?, lines:
/// [{ text, confidence?, box? }] }] }], pageMarkers, locale }`.
/// Reply JSON: `{ artifacts: [{ name, text, inputId? }], warnings: [string],
/// empty: bool, pages: number, error?: { code, message, hintKey? } }` where
/// `text` already includes the trailing newline. Business errors (empty
/// selection) are reported in `error`, never as a rejected promise; only a
/// malformed request rejects with a `bad_request: …` string.
#[wasm_bindgen(js_name = ocrTextArtifacts)]
pub fn ocr_text_artifacts(request: JsValue) -> Result<JsValue, JsValue> {
    let request: crate::ocr::OcrTextRequest = serde_wasm_bindgen::from_value(request)
        .map_err(|error| JsValue::from_str(&format!("bad_request: {error}")))?;
    to_js_payload(&crate::ocr::ocr_text_artifacts(&request))
}

/// Builds the merged ocr-table XLSX workbook from adapter-side recognition
/// results.
///
/// Request JSON: `{ inputs: [{ name, id?, pages: [{ page?, width?, lines:
/// [...] }] }], locale }`. Reply JSON: `{ ok, name?, bytes?, pages?, rows?,
/// warnings: [string], error?: { code, message, hintKey? } }`; `bytes`
/// serializes as a `Uint8Array`. `ok: false` carries `error` (e.g.
/// `empty_selection` with `hintKey: "error.noTable"`) plus any accumulated
/// warnings; only a malformed request rejects with `bad_request: …`.
#[wasm_bindgen(js_name = ocrTableWorkbook)]
pub fn ocr_table_workbook(request: JsValue) -> Result<JsValue, JsValue> {
    let request: crate::ocr::OcrTableRequest = serde_wasm_bindgen::from_value(request)
        .map_err(|error| JsValue::from_str(&format!("bad_request: {error}")))?;
    to_js_payload(&crate::ocr::ocr_table_workbook(&request))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    tool: String,
    #[serde(default)]
    options: Map<String, Value>,
    #[serde(default = "default_locale")]
    locale: String,
    #[serde(default)]
    name_pattern: Option<String>,
    #[serde(default)]
    inputs: Vec<Input>,
    #[serde(default)]
    runtime_data: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    id: String,
    name: String,
    path: Option<String>,
    #[serde(default)]
    bytes: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Reply {
    handled: bool,
    result: Option<SerializableResult>,
    error: Option<SerializableError>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RpcReply {
    handled: bool,
    result: Option<Value>,
    error: Option<SerializableError>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SerializableResult {
    text: Option<String>,
    artifacts: Vec<SerializableArtifact>,
    warnings: Vec<String>,
    extra: Map<String, Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SerializableArtifact {
    name: String,
    kind: String,
    size_bytes: usize,
    source_file_id: Option<String>,
    bytes: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SerializableError {
    code: String,
    message: String,
    hint_key: Option<&'static str>,
}

fn default_locale() -> String {
    "zh-CN".into()
}

fn serialize_result(result: ToolResult) -> SerializableResult {
    SerializableResult {
        text: result.text,
        artifacts: result
            .artifacts
            .into_iter()
            .map(serialize_artifact)
            .collect(),
        warnings: result.warnings,
        extra: result.extra,
    }
}

fn serialize_artifact(artifact: Artifact) -> SerializableArtifact {
    SerializableArtifact {
        name: artifact.name,
        kind: artifact.kind,
        size_bytes: artifact.size_bytes,
        source_file_id: artifact.source_file_id,
        bytes: artifact.bytes,
    }
}

/// Dispatches one in-memory tool request. Call from a dedicated Web Worker.
#[wasm_bindgen]
pub fn dispatch(request: JsValue) -> Result<JsValue, JsValue> {
    let request: Request = serde_wasm_bindgen::from_value(request)
        .map_err(|error| JsValue::from_str(&format!("bad_request: {error}")))?;
    let inputs: Vec<InputFile> = request
        .inputs
        .into_iter()
        .map(|input| InputFile {
            id: input.id,
            name: input.name,
            path: input.path.map(PathBuf::from),
            bytes: input.bytes,
        })
        .collect();
    if matches!(request.tool.as_str(), "file.probe" | "page.list") {
        let reply = match inputs.first() {
            None => RpcReply {
                handled: false,
                result: None,
                error: None,
            },
            Some(input) => match crate::tools::pdf_extra::inspect_rpc(&request.tool, input) {
                Ok(Some(result)) => RpcReply {
                    handled: true,
                    result: Some(result),
                    error: None,
                },
                Ok(None) => RpcReply {
                    handled: false,
                    result: None,
                    error: None,
                },
                Err(error) => RpcReply {
                    handled: true,
                    result: None,
                    error: Some(SerializableError {
                        code: error.code.into(),
                        message: error.message,
                        hint_key: error.hint_key,
                    }),
                },
            },
        };
        return to_js_json(&reply);
    }
    let options = Value::Object(request.options);
    let runtime_data = request.runtime_data;
    let context = crate::RunContext {
        tool: &request.tool,
        options: &options,
        locale: &request.locale,
        inputs: &inputs,
        name_pattern: request.name_pattern.as_deref(),
        runtime_data: runtime_data.as_ref(),
    };
    let reply = match crate::run_tool(&context) {
        Ok(Some(result)) => Reply {
            handled: true,
            result: Some(serialize_result(result)),
            error: None,
        },
        Ok(None) => Reply {
            handled: false,
            result: None,
            error: None,
        },
        Err(error) => Reply {
            handled: true,
            result: None,
            error: Some(SerializableError {
                code: error.code.into(),
                message: error.message,
                hint_key: error.hint_key,
            }),
        },
    };
    to_js_json(&reply)
}

/// Renders an output file name from the shared naming pattern so web
/// adapters can preview names without duplicating the naming logic.
#[wasm_bindgen(js_name = renderToolName)]
pub fn render_tool_name(
    pattern: Option<String>,
    name: String,
    tool: String,
    index: usize,
    total: usize,
    range: Option<String>,
    ext: String,
) -> String {
    crate::services::naming::render_name(
        pattern.as_deref(),
        crate::services::naming::NameContext {
            name: &name,
            tool: &tool,
            index: Some(index),
            total: Some(total),
            range: range.as_deref(),
        },
        &ext,
    )
}

/// Locates the drawable image regions of every page for the browser adapter
/// (ported `lib/pagedata.ts` `pageImageRects`). The adapter renders each
/// region with PDF.js at the tool's dpi and feeds the crops back through
/// `runtimeData.pdfImages` (keyed by page + rect index).
///
/// Reply JSON: `{ pages: [{ page, width, height, rotation, rects: [[x, y, w,
/// h], ...] }] }` where `page` is 1-based, `width`/`height` are the visual
/// (post-rotation) page size in points, `rotation` is the normalized
/// `/Rotate` angle and every rect is in visual space with a top-left origin.
/// Rejections carry the error object `{ code, message, hintKey }` (same
/// shape as the `error` field of `dispatch` replies).
#[wasm_bindgen(js_name = pdfImageRects)]
pub fn pdf_image_rects(bytes: Vec<u8>) -> Result<JsValue, JsValue> {
    match crate::tools::pdf_convert::rects::pdf_image_rects_document(&bytes) {
        Ok(document) => to_js_json(&document),
        Err(error) => Err(to_js_payload(&SerializableError {
            code: error.code.into(),
            message: error.message,
            hint_key: error.hint_key,
        })?),
    }
}

/// Returns catalog tools routed by the Rust engine, including tools that
/// return a validation error when called without their required input, plus the
/// engine-only entry points that the catalog does not expose.
#[wasm_bindgen(js_name = toolCapabilities)]
pub fn tool_capabilities() -> Result<JsValue, JsValue> {
    to_js_json(&crate::tools::capabilities::advertised())
}
