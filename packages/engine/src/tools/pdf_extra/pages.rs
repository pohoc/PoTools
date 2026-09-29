use super::{
    add_pdf, base_name, load, number, runtime_content_insets, save, string, truthy, EngineError,
    EngineResult,
};
use crate::{RunContext, ToolResult};
use lopdf::{Dictionary, Object, ObjectId};
use potools_core::protocol::PageInfo;
use serde_json::json;
use std::collections::HashSet;

fn fail(code: &'static str, message: impl Into<String>) -> EngineError {
    EngineError::new(code, message)
}

pub(super) fn inherited(document: &Document, page: ObjectId, key: &[u8]) -> Option<Object> {
    let mut current = Some(page);
    let mut visited = Vec::new();
    while let Some(id) = current {
        if visited.contains(&id) {
            return None;
        }
        visited.push(id);
        let dict = document.get_dictionary(id).ok()?;
        if let Ok(value) = dict.get(key) {
            return Some(value.clone());
        }
        current = dict
            .get(b"Parent")
            .ok()
            .and_then(|value| value.as_reference().ok());
    }
    None
}

fn resolve<'a>(document: &'a Document, object: &'a Object) -> Option<&'a Object> {
    match object {
        Object::Reference(id) => document.objects.get(id),
        other => Some(other),
    }
}

fn rect(document: &Document, object: Option<Object>) -> Option<[f64; 4]> {
    let object = object?;
    let values = resolve(document, &object)?.as_array().ok()?;
    if values.len() != 4 {
        return None;
    }
    let mut out = [0.0; 4];
    for (index, value) in values.iter().enumerate() {
        out[index] = match resolve(document, value)? {
            Object::Integer(n) => *n as f64,
            Object::Real(n) => *n as f64,
            _ => return None,
        };
    }
    Some(out)
}

pub(super) fn page_rect(document: &Document, page: ObjectId) -> EngineResult<[f64; 4]> {
    let media = rect(document, inherited(document, page, b"MediaBox"))
        .ok_or_else(|| fail("unreadable_file", "页面缺少有效 MediaBox"))?;
    let crop = rect(document, inherited(document, page, b"CropBox")).unwrap_or(media);
    let x0 = media[0].max(crop[0]);
    let y0 = media[1].max(crop[1]);
    let x1 = media[2].min(crop[2]);
    let y1 = media[3].min(crop[3]);
    if x1 - x0 < 8.0 || y1 - y0 < 8.0 {
        return Ok(media);
    }
    Ok([x0, y0, x1, y1])
}

pub(super) fn pages_info(document: &Document) -> EngineResult<Vec<PageInfo>> {
    document
        .get_pages()
        .into_iter()
        .enumerate()
        .map(|(index, (_, page_id))| {
            let rect = page_rect(document, page_id)?;
            let rotation = inherited(document, page_id, b"Rotate")
                .and_then(|object| match resolve(document, &object)? {
                    Object::Integer(value) => Some(*value as f64),
                    Object::Real(value) => Some(*value as f64),
                    _ => None,
                })
                .unwrap_or(0.0)
                .round() as i32;
            let rotation = rotation.rem_euclid(360);
            let (width, height) = if rotation % 180 == 90 {
                (rect[3] - rect[1], rect[2] - rect[0])
            } else {
                (rect[2] - rect[0], rect[3] - rect[1])
            };
            Ok(PageInfo {
                page: index as u32 + 1,
                width,
                height,
                rotation,
            })
        })
        .collect()
}

pub(super) fn parse_pages(raw: &str, total: usize) -> EngineResult<Vec<usize>> {
    let raw = raw.trim();
    if raw.is_empty()
        || ["all", "*", "全部", "所有"]
            .iter()
            .any(|s| raw.eq_ignore_ascii_case(s))
    {
        return Ok((1..=total).collect());
    }
    if raw.eq_ignore_ascii_case("odd") || raw == "奇数" {
        return Ok((1..=total).step_by(2).collect());
    }
    if raw.eq_ignore_ascii_case("even") || raw == "偶数" {
        return Ok((2..=total).step_by(2).collect());
    }
    let mut pages = Vec::new();
    for token in raw
        .split([',', ';', '，', '、'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if let Some((start, end)) = token.split_once('-') {
            if end.contains('-') {
                return Err(fail("bad_page_range", format!("无效页码范围：{token}")));
            }
            let start = if start.trim().is_empty() {
                1
            } else {
                page_side(start, total, token)?
            };
            let end = if end.trim().is_empty() {
                total
            } else {
                page_side(end, total, token)?
            };
            if start > end {
                return Err(fail(
                    "bad_page_range",
                    format!("页码范围起始值大于结束值：{token}"),
                ));
            }
            pages.extend(start..=end);
        } else {
            pages.push(page_side(token, total, token)?);
        }
    }
    if pages.is_empty() {
        return Err(fail("empty_selection", "没有匹配到任何页面"));
    }
    let mut seen = HashSet::new();
    pages.retain(|page| seen.insert(*page));
    Ok(pages)
}

fn page_side(raw: &str, total: usize, token: &str) -> EngineResult<usize> {
    let page = raw
        .trim()
        .parse::<usize>()
        .map_err(|_| fail("bad_page_range", format!("无效页码：{token}")))?;
    if page == 0 || page > total {
        return Err(fail(
            "bad_page_range",
            format!("页码 {page} 超出范围 (1-{total})"),
        ));
    }
    Ok(page)
}

fn real(value: f64) -> Object {
    Object::Real(value as f32)
}

pub(super) fn run_crop(ctx: &RunContext<'_>) -> EngineResult<ToolResult> {
    if ctx.inputs.is_empty() {
        return Err(fail("bad_request", "请先添加文件"));
    }
    let mut result = ToolResult::default();
    let manual =
        ["left", "bottom", "right", "top"].map(|key| number(ctx.options, key, 0.0).max(0.0));
    let shrink = truthy(ctx.options, "shrinkToContent", false);
    let mut cropped = 0usize;
    for input in ctx.inputs {
        let mut document = load(input)?;
        let pages = document.get_pages();
        let selected = parse_pages(&string(ctx.options, "pages", "all"), pages.len())?;
        for page_number in selected {
            let page_id = *pages
                .get(&(page_number as u32))
                .ok_or_else(|| fail("bad_page_range", "页码超出范围"))?;
            let [x0, y0, x1, y1] = page_rect(&document, page_id)?;
            let width = x1 - x0;
            let height = y1 - y0;
            // Detected insets arrive unrotated via runtimeData and compose
            // with the manual margins before the clamp below.
            let mut edges = manual;
            if shrink {
                match runtime_content_insets(ctx, &input.id, page_number - 1) {
                    Some(insets) => {
                        for (edge, inset) in edges.iter_mut().zip(insets) {
                            *edge += inset;
                        }
                    }
                    None => result.warnings.push(format!(
                        "{}：无法自动贴合内容（缺少图片解码器），已按手动边距裁剪",
                        base_name(&input.name)
                    )),
                }
            }
            // Match cropPage: preserve at least 20 pt in each dimension and
            // compose each crop with the existing printable CropBox.
            let left = edges[0].min((width - 20.0).max(0.0));
            let bottom = edges[1].min((height - 20.0).max(0.0));
            let right = edges[2].min((width - 20.0).max(0.0));
            let top = edges[3].min((height - 20.0).max(0.0));
            let new_box = [
                x0 + left,
                y0 + bottom,
                x0 + (width - left - right).max(20.0),
                y0 + (height - top - bottom).max(20.0),
            ];
            let dictionary: &mut Dictionary = document
                .get_dictionary_mut(page_id)
                .map_err(|error| fail("unreadable_file", format!("无法修改页面：{error}")))?;
            dictionary.set(
                "CropBox",
                Object::Array(new_box.into_iter().map(real).collect()),
            );
            cropped += 1;
        }
        let bytes = save(&mut document)?;
        add_pdf(ctx, &mut result, input, "cropped", bytes);
    }
    result.extra.insert("pageCountOut".into(), json!(cropped));
    result.extra.insert("pages".into(), json!(cropped));
    Ok(result)
}

use lopdf::Document;
