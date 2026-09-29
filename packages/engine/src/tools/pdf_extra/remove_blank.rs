//! Blank-page detection and removal.
//!
//! Rasterization happens in the web platform adapter (PDF.js): the transport
//! renders every page and delivers one ink ratio per page through
//! `runtimeData.removeBlankInk`. This module owns the decision (ratio at or
//! below `tolerance/100` counts as blank) and the PDF rebuild, matching the
//! TypeScript reference implementation's outputs.

use super::{
    base_name, dedupe, json_artifact, load, render_name, root_id, save, truthy, NameContext,
    EngineError, EngineResult,
};
use crate::{Artifact, InputFile, RunContext, ToolResult};
use lopdf::{Object, ObjectId};
use serde_json::{json, Value};
use std::collections::HashSet;

fn err(code: &'static str, message: impl Into<String>) -> EngineError {
    EngineError::new(code, message)
}

/// Reads the per-page ink ratios produced by the web rasterizer. An empty or
/// length-mismatched array means the adapter could not render the document,
/// so blankness cannot be decided for it.
fn ink_ratios(runtime_data: Option<&Value>, file_id: &str) -> Option<Vec<f64>> {
    let pages = runtime_data?
        .get("removeBlankInk")?
        .get(file_id)?
        .as_array()?;
    pages.iter().map(|value| value.as_f64()).collect()
}

/// `tolerance` arrives as a percent (catalog default 2); the TypeScript
/// reference divides by 100 and clamps negatives to zero.
fn tolerance(options: &Value) -> f64 {
    let value = match options.get("tolerance") {
        Some(Value::Number(value)) => value.as_f64(),
        Some(Value::String(value)) => value.trim().parse::<f64>().ok(),
        Some(Value::Bool(value)) => Some(if *value { 1.0 } else { 0.0 }),
        _ => None,
    };
    value.unwrap_or(0.0).max(0.0) / 100.0
}

fn blank_label(blank: &[usize]) -> String {
    if blank.is_empty() {
        "无".to_owned()
    } else {
        blank
            .iter()
            .map(|page| page.to_string())
            .collect::<Vec<_>>()
            .join(", ")
    }
}

/// Emits the rebuilt (or pass-through) PDF under the `no-blank` token,
/// matching the TypeScript renderName call which carries no index.
fn emit_pdf(ctx: &RunContext<'_>, result: &mut ToolResult, input: &InputFile, bytes: Vec<u8>) {
    let name = render_name(
        ctx.name_pattern,
        NameContext {
            name: base_name(&input.name),
            tool: "no-blank",
            index: None,
            total: None,
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

/// Rebuilds the PDF keeping only `keep` (in order), reusing the source object
/// table and rewriting just the page tree like the delete-pages machinery.
fn rebuild_without_blank(document: &Document, keep: &[ObjectId]) -> EngineResult<Vec<u8>> {
    let mut out = document.clone();
    let catalog_id = root_id(&out)?;
    let mut catalog = out
        .get_dictionary(catalog_id)
        .map_err(|error| err("unreadable_file", format!("无法读取 PDF Catalog：{error}")))?
        .clone();
    let pages_id = catalog
        .get(b"Pages")
        .and_then(Object::as_reference)
        .map_err(|error| err("unreadable_file", format!("PDF 缺少页面树：{error}")))?;
    let mut root_pages = out
        .get_dictionary(pages_id)
        .map_err(|error| err("unreadable_file", format!("无法读取 PDF 页面树：{error}")))?
        .clone();
    root_pages.set("Type", Object::Name(b"Pages".to_vec()));
    root_pages.set(
        "Kids",
        Object::Array(keep.iter().copied().map(Object::Reference).collect()),
    );
    root_pages.set("Count", Object::Integer(keep.len() as i64));
    catalog.set("Pages", Object::Reference(pages_id));
    out.objects.insert(pages_id, Object::Dictionary(root_pages));
    out.objects.insert(catalog_id, Object::Dictionary(catalog));
    save(&mut out)
}

pub(super) fn run(ctx: &RunContext<'_>) -> EngineResult<ToolResult> {
    let mut result = ToolResult::default();
    let tolerance = tolerance(ctx.options);
    let report_only = truthy(ctx.options, "reportOnly", false);
    let mut blank_total = 0usize;
    for input in ctx.inputs {
        let document = load(input)?;
        let page_ids: Vec<ObjectId> = document.get_pages().into_values().collect();
        let page_count = page_ids.len();
        let stem = base_name(&input.name);
        let Some(ratios) = ink_ratios(ctx.runtime_data, &input.id) else {
            // Degraded path: the adapter could not render this document.
            // Keep every page (copy through unchanged) instead of guessing.
            result
                .warnings
                .push(format!("{stem}：无法检测空白页（缺少渲染数据），已保留全部页面"));
            if !report_only {
                let mut copy = document.clone();
                let bytes = save(&mut copy)?;
                emit_pdf(ctx, &mut result, input, bytes);
            }
            continue;
        };
        if ratios.len() != page_count {
            return Err(err(
                "unreadable_file",
                format!("{stem}：渲染数据与文档页数不一致"),
            ));
        }
        let blank: Vec<usize> = ratios
            .iter()
            .enumerate()
            .filter(|(_, ratio)| **ratio <= tolerance)
            .map(|(index, _)| index + 1)
            .collect();
        blank_total += blank.len();
        let label = blank_label(&blank);
        if report_only {
            let mut artifact = json_artifact(
                format!("{stem}-blank-report.json"),
                json!({ "file": input.name, "pages": page_count, "blankPages": blank }),
            );
            artifact.source_file_id = Some(input.id.clone());
            result.artifacts.push(artifact);
            result
                .warnings
                .push(format!("{stem}：检测到 {} 个空白页（{label}）", blank.len()));
            continue;
        }
        if blank.len() >= page_count {
            return Err(err("empty_selection", "全部页面都被判为空白，已停止"));
        }
        let blank_set: HashSet<usize> = blank.iter().copied().collect();
        let keep: Vec<ObjectId> = page_ids
            .iter()
            .enumerate()
            .filter(|(index, _)| !blank_set.contains(&(index + 1)))
            .map(|(_, id)| *id)
            .collect();
        let bytes = rebuild_without_blank(&document, &keep)?;
        emit_pdf(ctx, &mut result, input, bytes);
        result
            .warnings
            .push(format!("{stem}：已删除 {} 个空白页（{label}）", blank.len()));
    }
    result.extra.insert("blankPages".into(), json!(blank_total));
    Ok(result)
}

use lopdf::Document;
