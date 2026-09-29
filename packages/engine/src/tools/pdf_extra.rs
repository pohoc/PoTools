//! PDF metadata, crop and structural repair tools implemented with lopdf.
//!
//! Structure-level PDF metadata and page transformations.

use crate::services::naming::{base_name, dedupe, render_name, NameContext};
use crate::{Artifact, EngineError, InputFile, RunContext, ToolResult};
use lopdf::{decode_text_string, text_string, Dictionary, Document, Object, ObjectId};
use potools_core::protocol::ProbedPdf;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::io::Cursor;

mod compress;
pub mod export;
mod extract_images;
mod geometry;
mod images_to_pdf;
mod invoice;
#[path = "pdf_markup.rs"]
pub(crate) mod markup;
mod metadata;
mod pages;
mod remove_blank;
mod repair;

type EngineResult<T> = Result<T, EngineError>;

pub fn run(ctx: &RunContext<'_>) -> Result<Option<ToolResult>, EngineError> {
    if let Some(result) = export::run(ctx)? {
        return Ok(Some(result));
    }
    if matches!(ctx.tool, "watermark" | "page-numbers" | "header-footer") {
        return markup::run(ctx);
    }
    if matches!(ctx.tool, "resize" | "margins" | "nup") {
        return geometry::run(ctx).map(Some);
    }
    if ctx.tool == "invoice-merge" {
        return invoice::run(ctx).map(Some);
    }
    // Repair and remove-blank are fully migrated: a real load failure must
    // surface its unreadable/encrypted error instead of degrading to the
    // browser-compatibility path (which no longer exists for them).
    if ctx.tool == "repair" {
        return repair::run(ctx).map(Some);
    }
    if ctx.tool == "remove-blank" {
        return remove_blank::run(ctx).map(Some);
    }
    let result = match ctx.tool {
        "compress" => compress::run(ctx),
        "metadata" => metadata::run(ctx),
        "extract-images" => extract_images::run(ctx).map(Some),
        "images-to-pdf" => images_to_pdf::run(ctx).map(Some),
        // shrinkToContent insets are precomputed by the web adapter and
        // delivered through runtimeData; missing data degrades to manual
        // margins inside run_crop.
        "crop" => pages::run_crop(ctx).map(Some),
        _ => return Ok(None),
    };
    match result {
        Ok(result) => Ok(result),
        Err(error) if matches!(error.code, "unreadable_file" | "encrypted_document") => Ok(None),
        Err(error) => Err(error),
    }
}

/// Runs the metadata/page portion of file.probe and page.list RPCs.
/// `None` means this PDF needs the browser PDF.js/MuPDF compatibility path.
pub fn inspect_rpc(method: &str, input: &InputFile) -> EngineResult<Option<Value>> {
    if !matches!(method, "file.probe" | "page.list") {
        return Ok(None);
    }
    if input.bytes.is_empty()
        || !String::from_utf8_lossy(&input.bytes[..input.bytes.len().min(1024)]).contains("%PDF-")
    {
        return Err(err(
            "unreadable_file",
            format!("not a PDF document: {}", input.name),
        ));
    }
    let document = load(input)?;
    if document.trailer.get(b"Encrypt").is_ok() {
        return Err(err(
            "encrypted_document",
            format!("{} 已加密，需要先解密", input.name),
        )
        .with_hint("error.encrypted"));
    }
    let pages = pages::pages_info(&document)?;
    if method == "page.list" {
        return Ok(Some(json!({ "pageCount": pages.len(), "pages": pages })));
    }
    let mut metadata = metadata_report(&document);
    if let Some(fields) = metadata.as_object_mut() {
        fields.remove("pages");
    }
    let metadata: BTreeMap<String, String> = serde_json::from_value(metadata)
        .map_err(|error| err("unreadable_file", format!("无法读取 PDF 元数据：{error}")))?;
    let uniform_size = pages.first().is_none_or(|first| {
        pages.iter().skip(1).all(|page| {
            (page.width - first.width).abs() < 1.0 && (page.height - first.height).abs() < 1.0
        })
    });
    let result = ProbedPdf {
        file_id: input.id.clone(),
        name: input.name.clone(),
        size_bytes: input.bytes.len() as u64,
        page_count: pages.len() as u32,
        pages,
        metadata,
        encrypted: false,
        uniform_size,
    };
    serde_json::to_value(result)
        .map(Some)
        .map_err(|error| err("internal", format!("无法序列化 PDF 探测结果：{error}")))
}

fn err(code: &'static str, message: impl Into<String>) -> EngineError {
    EngineError::new(code, message)
}

fn load(input: &InputFile) -> EngineResult<Document> {
    Document::load_mem(&input.bytes).map_err(|error| {
        let message = error.to_string();
        let encrypted = message.to_ascii_lowercase().contains("encrypt")
            || message.to_ascii_lowercase().contains("password");
        err(
            if encrypted {
                "encrypted_document"
            } else {
                "unreadable_file"
            },
            format!("无法读取 PDF：{message}"),
        )
        .with_hint(if encrypted {
            "error.encrypted"
        } else {
            "error.unreadable"
        })
    })
}

fn save(document: &mut Document) -> EngineResult<Vec<u8>> {
    let mut output = Cursor::new(Vec::new());
    document
        .save_to(&mut output)
        .map_err(|error| err("write_failed", format!("无法写入 PDF：{error}")))?;
    Ok(output.into_inner())
}

fn add_pdf(
    ctx: &RunContext<'_>,
    result: &mut ToolResult,
    input: &InputFile,
    suffix: &str,
    bytes: Vec<u8>,
) {
    let name = render_name(
        ctx.name_pattern,
        NameContext {
            name: base_name(&input.name),
            tool: suffix,
            index: Some(result.artifacts.len() + 1),
            total: Some(ctx.inputs.len()),
            range: None,
        },
        "pdf",
    );
    let name = dedupe(name, |candidate| {
        result
            .artifacts
            .iter()
            .any(|artifact| artifact.name == candidate)
    });
    let mut artifact = Artifact::new(name, "pdf", bytes);
    artifact.source_file_id = Some(input.id.clone());
    result.artifacts.push(artifact);
}

fn string(options: &Value, key: &str, default: &str) -> String {
    options
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or(default)
        .to_owned()
}

fn number(options: &Value, key: &str, default: f64) -> f64 {
    options.get(key).and_then(Value::as_f64).unwrap_or(default)
}

fn boolean(options: &Value, key: &str, default: bool) -> bool {
    options.get(key).and_then(Value::as_bool).unwrap_or(default)
}

/// Matches the web option coercion for booleans: `true`/'true'/1/'1'.
/// Missing or null values fall back to `default`; any other shape is false.
fn truthy(options: &Value, key: &str, default: bool) -> bool {
    match options.get(key) {
        None | Some(Value::Null) => default,
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(value)) => value.as_f64() == Some(1.0),
        Some(Value::String(value)) => matches!(value.as_str(), "true" | "1"),
        _ => false,
    }
}

/// Per-page unrotated content insets produced by the web rasterizer, keyed by
/// input file id with the array index as `page number - 1`. A null entry means
/// content detection failed for that page.
pub(super) fn runtime_content_insets(
    ctx: &RunContext<'_>,
    file_id: &str,
    page_index: usize,
) -> Option<[f64; 4]> {
    let value = ctx
        .runtime_data?
        .get("contentInsets")?
        .get(file_id)?
        .as_array()?
        .get(page_index)?;
    if value.is_null() {
        return None;
    }
    Some([
        value.get("left")?.as_f64()?,
        value.get("bottom")?.as_f64()?,
        value.get("right")?.as_f64()?,
        value.get("top")?.as_f64()?,
    ])
}

fn set_info_string(info: &mut Dictionary, key: &[u8], value: &str) {
    info.set(key.to_vec(), text_string(value));
}

fn read_info_string(document: &Document, info: &Dictionary, key: &[u8]) -> String {
    let Ok(value) = info.get(key) else {
        return String::new();
    };
    let resolved = match value {
        Object::Reference(id) => document.objects.get(id),
        other => Some(other),
    };
    match resolved {
        Some(object @ Object::String(_, _)) => decode_text_string(object).unwrap_or_default(),
        Some(Object::Name(bytes)) => String::from_utf8_lossy(bytes).into_owned(),
        _ => String::new(),
    }
}

fn info_dict(document: &Document) -> Dictionary {
    document
        .trailer
        .get(b"Info")
        .ok()
        .and_then(|object| object.as_reference().ok())
        .and_then(|id| document.get_dictionary(id).ok())
        .cloned()
        .unwrap_or_default()
}

fn store_info(document: &mut Document, info: Dictionary) {
    let id = document
        .trailer
        .get(b"Info")
        .ok()
        .and_then(|object| object.as_reference().ok());
    let id = id.unwrap_or_else(|| document.add_object(Object::Dictionary(Dictionary::new())));
    document.objects.insert(id, Object::Dictionary(info));
    document.trailer.set("Info", Object::Reference(id));
}

fn root_id(document: &Document) -> EngineResult<ObjectId> {
    document
        .trailer
        .get(b"Root")
        .and_then(Object::as_reference)
        .map_err(|error| err("unreadable_file", format!("PDF 缺少 Catalog：{error}")))
}

fn metadata_report(document: &Document) -> Value {
    let info = info_dict(document);
    let root = root_id(document)
        .ok()
        .and_then(|id| document.get_dictionary(id).ok());
    let has_xmp = root.is_some_and(|dict| dict.get(b"Metadata").is_ok());
    let get = |key: &[u8]| read_info_string(document, &info, key).trim().to_owned();
    let date = |key: &[u8]| pdf_date_to_iso(&get(key));
    json!({
        "pages": document.get_pages().len(),
        "title": get(b"Title"),
        "author": get(b"Author"),
        "subject": get(b"Subject"),
        "keywords": get(b"Keywords"),
        "creator": get(b"Creator"),
        "producer": get(b"Producer"),
        "creationDate": date(b"CreationDate"),
        "modificationDate": date(b"ModDate"),
        "hasXmp": has_xmp.to_string(),
    })
}

/// Converts the PDF date syntax D:YYYY[MM[DD[HH[mm[SS]]]]][Z|+HH'mm']
/// to the ISO form returned by pdf-lib's getCreationDate/getModificationDate.
fn pdf_date_to_iso(value: &str) -> String {
    use chrono::{FixedOffset, NaiveDate, NaiveTime, SecondsFormat, TimeZone, Utc};

    let raw = value.trim().strip_prefix("D:").unwrap_or(value.trim());
    let tz_start = raw
        .find(['+', '-'])
        .unwrap_or_else(|| raw.find('Z').unwrap_or(raw.len()));
    let (digits, zone) = raw.split_at(tz_start);
    if digits.len() < 4 || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return String::new();
    }
    let component = |start: usize, end: usize, fallback: u32| -> Option<u32> {
        if digits.len() <= start {
            return Some(fallback);
        }
        let slice = &digits[start..digits.len().min(end)];
        if slice.is_empty() {
            Some(fallback)
        } else {
            slice.parse().ok()
        }
    };
    let Some(year) = component(0, 4, 0) else {
        return String::new();
    };
    let Some(month) = component(4, 6, 1) else {
        return String::new();
    };
    let Some(day) = component(6, 8, 1) else {
        return String::new();
    };
    let Some(hour) = component(8, 10, 0) else {
        return String::new();
    };
    let Some(minute) = component(10, 12, 0) else {
        return String::new();
    };
    let Some(second) = component(12, 14, 0) else {
        return String::new();
    };
    let Some(date) = NaiveDate::from_ymd_opt(year as i32, month, day) else {
        return String::new();
    };
    let Some(time) = NaiveTime::from_hms_opt(hour, minute, second) else {
        return String::new();
    };
    let naive = date.and_time(time);

    let offset_seconds = if zone.is_empty() || zone == "Z" || zone == "z" {
        0
    } else {
        let sign = if zone.starts_with('-') {
            -1
        } else if zone.starts_with('+') {
            1
        } else {
            return String::new();
        };
        let digits: String = zone[1..]
            .chars()
            .filter(|character| character.is_ascii_digit())
            .collect();
        if digits.len() != 4 {
            return String::new();
        }
        let hours = digits[..2].parse::<i32>().ok();
        let minutes = digits[2..].parse::<i32>().ok();
        let (Some(hours), Some(minutes)) = (hours, minutes) else {
            return String::new();
        };
        if hours > 23 || minutes > 59 {
            return String::new();
        }
        sign * (hours * 3600 + minutes * 60)
    };
    let Some(offset) = FixedOffset::east_opt(offset_seconds) else {
        return String::new();
    };
    let Some(datetime) = offset.from_local_datetime(&naive).single() else {
        return String::new();
    };
    datetime
        .with_timezone(&Utc)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn remove_xmp(document: &mut Document) -> EngineResult<()> {
    let id = root_id(document)?;
    let root = document
        .get_dictionary_mut(id)
        .map_err(|error| err("unreadable_file", format!("无法读取 PDF Catalog：{error}")))?;
    root.remove(b"Metadata");
    Ok(())
}

fn json_artifact(name: String, value: Value) -> Artifact {
    Artifact::new(
        name,
        "json",
        serde_json::to_vec_pretty(&value).unwrap_or_default(),
    )
}

fn map() -> Map<String, Value> {
    Map::new()
}
