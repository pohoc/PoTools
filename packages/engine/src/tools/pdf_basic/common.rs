//! Shared parsing, naming, PDF object-tree and output helpers for page tools.

use super::super::{Artifact, EngineError, InputFile, ToolResult};
use lopdf::{Dictionary, Document, Object, ObjectId};
use serde_json::Value;
use std::collections::HashMap;
use std::io::Cursor;

pub(super) type EngineResult<T> = Result<T, EngineError>;

pub(super) fn err(code: &'static str, message: impl Into<String>) -> EngineError {
    EngineError::new(code, message)
}

pub(super) fn string<'a>(options: &'a Value, key: &str, default: &'a str) -> &'a str {
    options.get(key).and_then(Value::as_str).unwrap_or(default)
}

pub(super) fn number(options: &Value, key: &str, default: f64) -> f64 {
    options.get(key).and_then(Value::as_f64).unwrap_or(default)
}

pub(super) fn boolean(options: &Value, key: &str, default: bool) -> bool {
    options.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn pdf_error(error: impl std::fmt::Display) -> EngineError {
    let message = error.to_string();
    if message.to_ascii_lowercase().contains("encrypt")
        || message.to_ascii_lowercase().contains("password")
    {
        err(
            "encrypted_document",
            format!("PDF 受密码保护，无法读取：{message}"),
        )
    } else {
        err("unreadable_file", format!("无法读取 PDF：{message}"))
    }
}

pub(super) fn load(input: &InputFile) -> EngineResult<Document> {
    Document::load_mem(&input.bytes).map_err(pdf_error)
}

pub(super) fn save(document: &mut Document) -> EngineResult<Vec<u8>> {
    let mut output = Cursor::new(Vec::new());
    document
        .save_to(&mut output)
        .map_err(|e| err("write_failed", format!("无法写入 PDF：{e}")))?;
    Ok(output.into_inner())
}

pub(super) fn option_name(
    name: &str,
    suffix: &str,
    pattern: Option<&str>,
    index: usize,
    total: usize,
    range: Option<&str>,
) -> String {
    crate::services::naming::render_name(
        pattern,
        crate::services::naming::NameContext {
            name: base_name(name),
            tool: suffix,
            index: Some(index),
            total: Some(total),
            range,
        },
        "pdf",
    )
}

fn base_name(name: &str) -> &str {
    let leaf = name.rsplit(['/', '\\']).next().unwrap_or(name);
    match leaf.rfind('.') {
        Some(i) if i > 0 => &leaf[..i],
        _ => leaf,
    }
}

pub(super) fn add_pdf(
    result: &mut ToolResult,
    name: String,
    bytes: Vec<u8>,
    source_id: Option<&str>,
) {
    let mut name = name;
    let base = name.strip_suffix(".pdf").unwrap_or(&name).to_owned();
    let mut duplicate = 2;
    while result
        .artifacts
        .iter()
        .any(|artifact| artifact.name == name)
    {
        name = format!("{base} ({duplicate}).pdf");
        duplicate += 1;
    }
    let mut artifact = Artifact::new(name, "pdf", bytes);
    artifact.source_file_id = source_id.map(str::to_owned);
    result.artifacts.push(artifact);
}

pub(super) fn parse_ranges(raw: &str, page_count: usize) -> EngineResult<Vec<u32>> {
    let raw = raw.trim();
    if raw.is_empty()
        || matches!(
            raw.to_ascii_lowercase().as_str(),
            "all" | "*" | "全部" | "所有"
        )
    {
        return Ok((1..=page_count as u32).collect());
    }
    let lowered = raw.to_ascii_lowercase();
    if lowered == "odd" || raw == "奇数" {
        return Ok((1..=page_count as u32).step_by(2).collect());
    }
    if lowered == "even" || raw == "偶数" {
        return Ok((2..=page_count as u32).step_by(2).collect());
    }
    let mut pages = Vec::new();
    for token in raw
        .split([',', ';', '，', '、'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if let Some((start, end)) = token.split_once('-') {
            if end.contains('-') {
                return Err(err("bad_page_range", format!("无效页码范围：{token}")));
            }
            let start = if start.trim().is_empty() {
                1
            } else {
                parse_page_side(start, page_count, token)?
            };
            let end = if end.trim().is_empty() {
                page_count as u32
            } else {
                parse_page_side(end, page_count, token)?
            };
            if start > end {
                return Err(err(
                    "bad_page_range",
                    format!("页码范围起始值大于结束值：{token}"),
                ));
            }
            pages.extend(start..=end);
        } else {
            let page = token
                .parse::<usize>()
                .map_err(|_| err("bad_page_range", format!("无效页码：{token}")))?;
            if page == 0 || page > page_count {
                return Err(err(
                    "bad_page_range",
                    format!("页码 {page} 超出范围 (1-{page_count})"),
                ));
            }
            pages.push(page as u32);
        }
    }
    if pages.is_empty() {
        return Err(err("empty_selection", "没有匹配到任何页面"));
    }
    Ok(pages)
}

fn parse_page_side(raw: &str, page_count: usize, token: &str) -> EngineResult<u32> {
    let value = raw
        .trim()
        .parse::<usize>()
        .map_err(|_| err("bad_page_range", format!("无效页码范围：{token}")))?;
    if value == 0 {
        return Err(err("bad_page_range", format!("页码必须大于 0：{token}")));
    }
    Ok(value.min(page_count) as u32)
}

pub(super) fn catalog_pages(
    document: &Document,
) -> EngineResult<(ObjectId, Dictionary, ObjectId, Dictionary)> {
    let catalog_id = document
        .trailer
        .get(b"Root")
        .and_then(Object::as_reference)
        .map_err(pdf_error)?;
    let mut catalog = document
        .get_dictionary(catalog_id)
        .map_err(pdf_error)?
        .clone();
    let pages_id = catalog
        .get(b"Pages")
        .and_then(Object::as_reference)
        .map_err(pdf_error)?;
    let pages = document
        .get_dictionary(pages_id)
        .map_err(pdf_error)?
        .clone();
    catalog.set("Pages", Object::Reference(pages_id));
    Ok((catalog_id, catalog, pages_id, pages))
}

const INHERITED_PAGE_KEYS: [&[u8]; 4] = [b"Resources", b"MediaBox", b"CropBox", b"Rotate"];

pub(super) fn inherited_page_value(
    document: &Document,
    page_id: ObjectId,
    key: &[u8],
) -> Option<Object> {
    let mut current = Some(page_id);
    let mut seen = Vec::new();
    while let Some(id) = current {
        if seen.contains(&id) {
            return None;
        }
        seen.push(id);
        let dictionary = document.get_dictionary(id).ok()?;
        if let Ok(value) = dictionary.get(key) {
            return Some(value.clone());
        }
        current = dictionary
            .get(b"Parent")
            .ok()
            .and_then(|parent| parent.as_reference().ok());
    }
    None
}

pub(super) fn indexed_pages(document: &Document) -> Vec<ObjectId> {
    document.get_pages().into_values().collect()
}

pub(super) fn page_ids_for_selection(
    document: &Document,
    pages: &[u32],
) -> EngineResult<Vec<ObjectId>> {
    let all = indexed_pages(document);
    pages
        .iter()
        .map(|page| {
            all.get(page.saturating_sub(1) as usize)
                .copied()
                .ok_or_else(|| {
                    err(
                        "bad_page_range",
                        format!("页码 {page} 超出范围 (1-{})", all.len()),
                    )
                })
        })
        .collect()
}

pub(super) fn root_inherited(
    document: &Document,
) -> EngineResult<(ObjectId, ObjectId, Dictionary)> {
    let (catalog_id, _catalog, pages_id, pages) = catalog_pages(document)?;
    Ok((catalog_id, pages_id, pages))
}

/// Combines source object tables using lopdf's supported object renumbering,
/// then constructs one flat page tree. Per-page inherited attributes are
/// copied down before source page-tree nodes are discarded.
pub(super) fn combine(
    inputs: &[InputFile],
) -> EngineResult<(Document, HashMap<String, Vec<ObjectId>>, usize)> {
    if inputs.is_empty() {
        return Err(err("bad_request", "请先添加 PDF 文件"));
    }
    let mut out = Document::with_version("1.7");
    let mut next_id = 1u32;
    let mut catalog_seed = None;
    let mut root_seed = None;
    let mut info_ref = None;
    let mut page_map = HashMap::new();
    let mut all_pages = Vec::new();
    let mut first = true;

    for input in inputs {
        let mut source = load(input)?;
        source.renumber_objects_with(next_id);
        next_id = source.max_id.saturating_add(1);
        let (catalog_id, catalog, pages_id, pages_root) = catalog_pages(&source)?;
        if first {
            catalog_seed = Some((catalog_id, catalog));
            root_seed = Some((pages_id, pages_root));
            info_ref = source
                .trailer
                .get(b"Info")
                .ok()
                .and_then(|o| o.as_reference().ok());
            first = false;
        }

        let current_pages = indexed_pages(&source);
        for &page_id in &current_pages {
            let mut page_dict = source.get_dictionary(page_id).map_err(pdf_error)?.clone();
            for key in INHERITED_PAGE_KEYS {
                if page_dict.get(key).is_err() {
                    if let Some(value) = inherited_page_value(&source, page_id, key) {
                        page_dict.set(key.to_vec(), value);
                    }
                }
            }
            source
                .objects
                .insert(page_id, Object::Dictionary(page_dict));
        }
        page_map.insert(input.id.clone(), current_pages.clone());
        all_pages.extend(current_pages.iter().copied());
        for (id, object) in source.objects {
            match object.type_name().unwrap_or(b"") {
                b"Catalog" | b"Pages" => {}
                _ => {
                    out.objects.insert(id, object);
                }
            }
        }
    }

    let (catalog_id, mut catalog) =
        catalog_seed.ok_or_else(|| err("unreadable_file", "PDF 缺少 Catalog"))?;
    let (pages_id, mut root_pages) =
        root_seed.ok_or_else(|| err("unreadable_file", "PDF 缺少页面树"))?;
    for &page_id in &all_pages {
        let mut page = out.get_dictionary(page_id).map_err(pdf_error)?.clone();
        page.set("Parent", Object::Reference(pages_id));
        out.objects.insert(page_id, Object::Dictionary(page));
    }
    root_pages.set("Type", Object::Name(b"Pages".to_vec()));
    root_pages.set(
        "Kids",
        Object::Array(all_pages.iter().copied().map(Object::Reference).collect()),
    );
    root_pages.set("Count", Object::Integer(all_pages.len() as i64));
    catalog.set("Pages", Object::Reference(pages_id));
    out.objects.insert(pages_id, Object::Dictionary(root_pages));
    out.objects.insert(catalog_id, Object::Dictionary(catalog));
    out.trailer.set("Root", Object::Reference(catalog_id));
    if let Some(id) = info_ref {
        out.trailer.set("Info", Object::Reference(id));
    }
    out.max_id = next_id.saturating_sub(1);
    Ok((out, page_map, all_pages.len()))
}

pub(super) fn emit_selected(
    source_doc: &Document,
    selected: &[(ObjectId, Option<i32>)],
    name: String,
    source_id: Option<&str>,
    result: &mut ToolResult,
) -> EngineResult<()> {
    if selected.is_empty() {
        return Err(err("empty_selection", "没有可输出的页面"));
    }
    let (catalog_id, _pages_id, mut root_pages) = root_inherited(source_doc)?;
    let mut out = source_doc.clone();
    let (_catalog_id, mut catalog, pages_id, _old_root) = catalog_pages(&out)?;
    let mut ids = Vec::with_capacity(selected.len());
    for &(page_id, rotation) in selected {
        let id = if ids.contains(&page_id) {
            let copy = out.get_dictionary(page_id).map_err(pdf_error)?.clone();
            out.add_object(Object::Dictionary(copy))
        } else {
            page_id
        };
        let mut page = out.get_dictionary(id).map_err(pdf_error)?.clone();
        if let Some(angle) = rotation {
            let current = page.get(b"Rotate").and_then(Object::as_i64).unwrap_or(0) as i32;
            page.set(
                "Rotate",
                Object::Integer((current + angle).rem_euclid(360) as i64),
            );
        }
        page.set("Parent", Object::Reference(pages_id));
        out.objects.insert(id, Object::Dictionary(page));
        ids.push(id);
    }
    let _ = catalog_id;
    root_pages.set(
        "Kids",
        Object::Array(ids.iter().copied().map(Object::Reference).collect()),
    );
    root_pages.set("Count", Object::Integer(ids.len() as i64));
    root_pages.set("Type", Object::Name(b"Pages".to_vec()));
    catalog.set("Pages", Object::Reference(pages_id));
    out.objects.insert(pages_id, Object::Dictionary(root_pages));
    out.objects.insert(catalog_id, Object::Dictionary(catalog));
    let bytes = save(&mut out)?;
    add_pdf(result, name, bytes, source_id);
    Ok(())
}

pub(super) fn pages_count(document: &Document) -> usize {
    document.get_pages().len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_open_ranges_and_odd_even() {
        assert_eq!(parse_ranges("2-", 4).unwrap(), vec![2, 3, 4]);
        assert_eq!(parse_ranges("odd", 5).unwrap(), vec![1, 3, 5]);
        assert_eq!(parse_ranges("偶数", 5).unwrap(), vec![2, 4]);
    }

    #[test]
    fn rejects_bad_and_reversed_ranges() {
        assert_eq!(parse_ranges("5-2", 6).unwrap_err().code, "bad_page_range");
        assert_eq!(parse_ranges("7", 6).unwrap_err().code, "bad_page_range");
    }
}
