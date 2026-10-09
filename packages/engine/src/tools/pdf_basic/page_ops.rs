//! Split, page rotation, extraction, deletion and organizer operations.

use super::common::{
    boolean, combine, emit_selected, err, indexed_pages, number, option_name,
    page_ids_for_selection, pages_count, parse_ranges, string, EngineResult,
};
use crate::{RunContext, ToolResult};
use serde_json::{json, Value};

fn split_groups(ctx: &RunContext<'_>, total: usize) -> EngineResult<Vec<Vec<u32>>> {
    match string(ctx.options, "mode", "each-page") {
        "each-page" => Ok((1..=total as u32).map(|p| vec![p]).collect()),
        "every-n" => {
            let size = number(ctx.options, "everyN", 2.0).trunc().max(1.0) as usize;
            Ok((0..total)
                .step_by(size)
                .map(|start| {
                    ((start + 1)..=(start + size).min(total))
                        .map(|p| p as u32)
                        .collect()
                })
                .collect())
        }
        "halves" => {
            let middle = total.div_ceil(2);
            let mut groups = vec![
                (1..=middle as u32).collect::<Vec<_>>(),
                (((middle + 1) as u32)..=total as u32).collect::<Vec<_>>(),
            ];
            groups.retain(|g| !g.is_empty());
            Ok(groups)
        }
        "manual" => {
            let groups = ctx
                .options
                .get("groups")
                .and_then(Value::as_array)
                .ok_or_else(|| err("empty_selection", "请先在预览上选择拆分位置"))?;
            let mut parsed = Vec::new();
            for group in groups {
                let Some(values) = group.as_array() else {
                    continue;
                };
                let pages: Vec<u32> = values
                    .iter()
                    .filter_map(Value::as_u64)
                    .map(|v| v as u32)
                    .collect();
                if !pages.is_empty() {
                    parsed.push(pages);
                }
            }
            if parsed.is_empty() {
                return Err(err("empty_selection", "请先在预览上选择拆分位置"));
            }
            Ok(parsed)
        }
        "ranges" => {
            let raw = string(ctx.options, "ranges", "1-3,4");
            let groups: Vec<Vec<u32>> = raw
                .split([',', ';', '，', '、'])
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .map(|part| parse_ranges(part, total))
                .collect::<EngineResult<_>>()?;
            if boolean(ctx.options, "rangesAsOne", false) {
                Ok(vec![groups.into_iter().flatten().collect()])
            } else {
                Ok(groups)
            }
        }
        _ => Err(err("bad_request", "不支持的拆分模式")),
    }
}

pub(super) fn run_split(ctx: &RunContext<'_>) -> EngineResult<ToolResult> {
    let input = ctx
        .inputs
        .first()
        .ok_or_else(|| err("bad_request", "请先添加 PDF 文件"))?;
    let (doc, _, _) = combine(std::slice::from_ref(input))?;
    let total = pages_count(&doc);
    let groups = split_groups(ctx, total)?;
    let groups: Vec<_> = groups.into_iter().filter(|g| !g.is_empty()).collect();
    if groups.is_empty() {
        return Err(err("empty_selection", "没有匹配到任何页面"));
    }
    let mut result = ToolResult::default();
    let mut pages_out = 0usize;
    for (index, group) in groups.iter().enumerate() {
        let selected = page_ids_for_selection(&doc, group)?
            .into_iter()
            .map(|id| (id, None))
            .collect::<Vec<_>>();
        emit_selected(
            &doc,
            &selected,
            option_name(
                &input.name,
                "split",
                ctx.name_pattern,
                index + 1,
                groups.len(),
                Some(&potools_core::pages::format_page_ranges(
                    &group.iter().map(|page| *page as usize).collect::<Vec<_>>(),
                )),
            ),
            Some(&input.id),
            &mut result,
        )?;
        pages_out += group.len();
        crate::progress::report(index + 1, groups.len());
    }
    result.extra.insert("__pageCountIn".into(), json!(total));
    result
        .extra
        .insert("__pageCountOut".into(), json!(pages_out));
    result.extra.insert("files".into(), json!(groups.len()));
    Ok(result)
}

pub(super) fn run_rotate(ctx: &RunContext<'_>) -> EngineResult<ToolResult> {
    let angle = number(ctx.options, "angle", 90.0) as i32;
    let mut result = ToolResult::default();
    let mut total_in = 0;
    let mut total_out = 0;
    for input in ctx.inputs {
        let (doc, _, _) = combine(std::slice::from_ref(input))?;
        let count = pages_count(&doc);
        let pages = parse_ranges(string(ctx.options, "pages", "all"), count)?;
        let chosen: std::collections::HashSet<_> = pages.iter().copied().collect();
        let ids = indexed_pages(&doc);
        let selected = ids
            .into_iter()
            .enumerate()
            .map(|(i, id)| {
                (
                    id,
                    if chosen.contains(&((i + 1) as u32)) {
                        Some(angle)
                    } else {
                        None
                    },
                )
            })
            .collect::<Vec<_>>();
        emit_selected(
            &doc,
            &selected,
            option_name(
                &input.name,
                "rotated",
                ctx.name_pattern,
                result.artifacts.len() + 1,
                ctx.inputs.len(),
                None,
            ),
            Some(&input.id),
            &mut result,
        )?;
        total_in += pages.len();
        total_out += pages.len();
    }
    result.extra.insert("__pageCountIn".into(), json!(total_in));
    result
        .extra
        .insert("__pageCountOut".into(), json!(total_out));
    result.extra.insert("angle".into(), json!(angle));
    Ok(result)
}

pub(super) fn run_extract(ctx: &RunContext<'_>) -> EngineResult<ToolResult> {
    let mut result = ToolResult::default();
    let mut page_count_out = 0usize;
    for input in ctx.inputs {
        let (doc, _, _) = combine(std::slice::from_ref(input))?;
        let count = pages_count(&doc);
        let raw = string(ctx.options, "pages", "1");
        let selection = parse_ranges(raw, count)?;
        let groups = if boolean(ctx.options, "oneFilePerGroup", false) {
            let groups = raw
                .split([',', ';', '，', '、'])
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| parse_ranges(s, count))
                .collect::<EngineResult<Vec<_>>>()?;
            if groups.is_empty() {
                vec![selection.clone()]
            } else {
                groups
            }
        } else {
            vec![selection.clone()]
        };
        for (index, group) in groups.iter().enumerate() {
            let selected = page_ids_for_selection(&doc, group)?
                .into_iter()
                .map(|id| (id, None))
                .collect::<Vec<_>>();
            emit_selected(
                &doc,
                &selected,
                option_name(
                    &input.name,
                    "extract",
                    ctx.name_pattern,
                    index + 1,
                    groups.len(),
                    Some(&potools_core::pages::format_page_ranges(
                        &group.iter().map(|page| *page as usize).collect::<Vec<_>>(),
                    )),
                ),
                Some(&input.id),
                &mut result,
            )?;
            page_count_out += group.len();
        }
    }
    result
        .extra
        .insert("__pageCountOut".into(), json!(page_count_out));
    Ok(result)
}

pub(super) fn run_delete(ctx: &RunContext<'_>) -> EngineResult<ToolResult> {
    let raw = string(ctx.options, "pages", "").trim();
    if raw.is_empty() || raw.eq_ignore_ascii_case("all") {
        return Err(err("bad_request", "请填写要删除的页码"));
    }
    let mut result = ToolResult::default();
    for input in ctx.inputs {
        let (doc, _, _) = combine(std::slice::from_ref(input))?;
        let total = pages_count(&doc);
        let doomed = parse_ranges(raw, total)?;
        let removed: std::collections::HashSet<_> = doomed.into_iter().collect();
        let ids = indexed_pages(&doc);
        let selected: Vec<_> = ids
            .into_iter()
            .enumerate()
            .filter(|(i, _)| !removed.contains(&((*i + 1) as u32)))
            .map(|(_, id)| (id, None))
            .collect();
        if selected.is_empty() {
            return Err(err("empty_selection", "不能删除全部页面"));
        }
        emit_selected(
            &doc,
            &selected,
            option_name(
                &input.name,
                "trimmed",
                ctx.name_pattern,
                result.artifacts.len() + 1,
                1,
                None,
            ),
            Some(&input.id),
            &mut result,
        )?;
    }
    Ok(result)
}

pub(super) fn run_organize(ctx: &RunContext<'_>) -> EngineResult<ToolResult> {
    let plan = ctx
        .options
        .get("plan")
        .and_then(Value::as_array)
        .ok_or_else(|| err("empty_selection", "页面计划为空"))?;
    if plan.is_empty() {
        return Err(err("empty_selection", "页面计划为空"));
    }
    let (doc, pages_by_file, _) = combine(ctx.inputs)?;
    let mut selected = Vec::with_capacity(plan.len());
    let mut warnings = Vec::new();
    for item in plan {
        let file_id = item.get("fileId").and_then(Value::as_str).unwrap_or("");
        let page_number = item.get("page").and_then(Value::as_u64).unwrap_or(0) as usize;
        let Some(pages) = pages_by_file.get(file_id) else {
            warnings.push(format!("跳过来源缺失的页面 {page_number}"));
            continue;
        };
        if page_number == 0 {
            return Err(err("bad_page_range", "页面计划中的页码必须从 1 开始"));
        }
        let Some(&page_id) = pages.get(page_number.saturating_sub(1)) else {
            return Err(err(
                "bad_page_range",
                format!("页面计划中的页码 {page_number} 超出来源文件范围"),
            ));
        };
        let rotation = item
            .get("rotation")
            .and_then(Value::as_i64)
            .map(|n| n as i32);
        selected.push((page_id, rotation));
    }
    let mut result = ToolResult {
        warnings,
        ..ToolResult::default()
    };
    if string(ctx.options, "pageSize", "keep") != "keep" {
        result
            .warnings
            .push("当前结构处理后端未应用页面尺寸选项；保留来源页面尺寸".to_owned());
    }
    emit_selected(
        &doc,
        &selected,
        option_name(
            ctx.inputs
                .first()
                .map(|i| i.name.as_str())
                .unwrap_or("document.pdf"),
            "organize",
            ctx.name_pattern,
            1,
            1,
            None,
        ),
        None,
        &mut result,
    )?;
    result
        .extra
        .insert("__pageCountIn".into(), json!(plan.len()));
    result.extra.insert(
        "__pageCountOut".into(),
        json!(result
            .artifacts
            .first()
            .map(|_| selected.len())
            .unwrap_or(0)),
    );
    Ok(result)
}
