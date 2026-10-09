//! Invoice PDF imposition, matching the invoice-merge layout in the web engine.
use super::geometry::layout::{make_form_rect, output_document, FormPlacement, Size};
use super::pages;
use super::{boolean, load, runtime_content_insets, EngineError, EngineResult};
use crate::services::naming::{base_name, render_name, NameContext};
use crate::{Artifact, InputFile, RunContext, ToolResult};
use serde_json::json;

#[path = "invoice_layout.rs"]
mod layout;
use layout::{combine, grid_slots, natural_cmp, shelf_slots, Tile};

fn err(code: &'static str, message: impl Into<String>) -> EngineError {
    EngineError::new(code, message)
}

fn option(ctx: &RunContext<'_>, key: &str, default: &str) -> String {
    ctx.options
        .get(key)
        .map(|value| match value {
            serde_json::Value::String(value) => value.clone(),
            serde_json::Value::Number(value) => value.to_string(),
            serde_json::Value::Bool(value) => value.to_string(),
            _ => default.to_owned(),
        })
        .unwrap_or_else(|| default.to_owned())
}

fn number(ctx: &RunContext<'_>, key: &str, default: f64) -> f64 {
    ctx.options
        .get(key)
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(default)
}

fn clamp_inset(value: f64, dimension: f64) -> f64 {
    value.max(0.0).min((dimension - 20.0).max(0.0))
}

pub(super) fn run(ctx: &RunContext<'_>) -> EngineResult<ToolResult> {
    if ctx.inputs.is_empty() {
        return Err(err("empty_selection", "没有可拼版的票据文件"));
    }
    let mut inputs: Vec<&InputFile> = ctx.inputs.iter().collect();
    if boolean(ctx.options, "sortByName", true) {
        inputs.sort_by(|a, b| natural_cmp(&a.name, &b.name));
    }
    let mut kept = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut result = ToolResult::default();
    let mut duplicates = 0usize;
    for input in inputs {
        let key = format!("{}:{}", input.name.to_lowercase(), input.bytes.len());
        if boolean(ctx.options, "skipDuplicates", true) && !seen.insert(key.clone()) {
            duplicates += 1;
            result
                .warnings
                .push(format!("已跳过重复文件：{}", input.name));
        } else {
            seen.insert(key);
            kept.push(input);
        }
    }
    if kept.is_empty() {
        return Err(err(
            "empty_selection",
            "所有文件都是重复项，没有可拼版的票据",
        ));
    }

    let auto_crop = boolean(ctx.options, "autoCrop", true);
    let owned: Vec<InputFile> = kept.iter().map(|input| (*input).clone()).collect();
    let (mut document, page_ids) = combine(&owned)?;
    let mut tiles = Vec::new();
    let mut source_pages = 0usize;
    let mut page_offset = 0usize;
    for input in &owned {
        // Page IDs are appended per input in source order; use each source's own page count.
        let source_count = load(input)?.get_pages().len();
        if source_count == 0 {
            result
                .warnings
                .push(format!("{} 没有页面，已跳过", input.name));
            continue;
        }
        for (page_index, page_id) in page_ids
            .iter()
            .skip(page_offset)
            .take(source_count)
            .enumerate()
            .map(|(position, id)| (position, *id))
        {
            let mut rect = pages::page_rect(&document, page_id)?;
            if auto_crop {
                if let Some([left, bottom, right, top]) =
                    runtime_content_insets(ctx, &input.id, page_index)
                {
                    let width = rect[2] - rect[0];
                    let height = rect[3] - rect[1];
                    rect = [
                        rect[0] + clamp_inset(left, width),
                        rect[1] + clamp_inset(bottom, height),
                        rect[2] - clamp_inset(right, width),
                        rect[3] - clamp_inset(top, height),
                    ];
                }
            }
            let form = make_form_rect(&mut document, page_id, rect)?;
            tiles.push(Tile {
                form: form.form,
                width: form.size.width,
                height: form.size.height,
            });
        }
        source_pages += source_count;
        page_offset += source_count;
    }
    if tiles.is_empty() {
        return Err(err("empty_selection", "没有可拼版的页面"));
    }

    let key = option(ctx, "sheetSize", "a4");
    let base = super::geometry::layout::preset(&key).unwrap_or(Size {
        width: 595.28,
        height: 841.89,
    });
    let per_sheet_text = option(ctx, "perSheet", "auto");
    let per_sheet = if per_sheet_text == "auto" {
        0
    } else {
        per_sheet_text
            .parse::<f64>()
            .unwrap_or(0.0)
            .trunc()
            .max(1.0) as usize
    };
    let gap = number(ctx, "gap", 6.0);
    let margin = number(ctx, "margin", 12.0);
    let column_first = option(ctx, "order", "horizontal") == "vertical";
    let landscape = tiles.iter().filter(|tile| tile.width > tile.height).count();
    let orientation = option(ctx, "orientation", "auto");
    let want_landscape = orientation == "landscape"
        || (orientation == "auto"
            && (per_sheet >= 4 || (per_sheet == 0 && landscape > tiles.len() / 2)));
    let sheet = if want_landscape {
        Size {
            width: base.width.max(base.height),
            height: base.width.min(base.height),
        }
    } else {
        Size {
            width: base.width.min(base.height),
            height: base.width.max(base.height),
        }
    };
    let sheets = if per_sheet > 0 {
        grid_slots(&tiles, sheet, per_sheet, gap, margin, column_first)
    } else {
        shelf_slots(&tiles, sheet, gap, margin, column_first)
    };
    let border = boolean(ctx.options, "border", false);
    let page_specs = sheets
        .iter()
        .map(|slots| {
            let forms: Vec<FormPlacement> = slots
                .iter()
                .map(|slot| {
                    let tile = tiles[slot.tile];
                    let draw_w = tile.width * slot.scale;
                    let draw_h = tile.height * slot.scale;
                    let left = slot.x + (slot.width - draw_w) / 2.0;
                    let bottom = sheet.height - slot.y - (slot.height + draw_h) / 2.0;
                    let bounds = border.then_some((
                        slot.x,
                        sheet.height - slot.y - slot.height,
                        slot.width,
                        slot.height,
                    ));
                    (tile.form, left, bottom, slot.scale, slot.scale, bounds)
                })
                .collect();
            (sheet, forms, border)
        })
        .collect();
    let bytes = output_document(&mut document, page_specs)?;
    let name_base = base_name(&kept[0].name);
    let name = render_name(
        ctx.name_pattern,
        NameContext {
            name: name_base,
            tool: "invoices",
            index: None,
            total: None,
            range: None,
        },
        "pdf",
    );
    result.artifacts.push(Artifact::new(name, "pdf", bytes));
    result.extra.insert("sheets".into(), json!(sheets.len()));
    result.extra.insert("invoices".into(), json!(tiles.len()));
    result.extra.insert("duplicates".into(), json!(duplicates));
    result
        .extra
        .insert("__pageCountIn".into(), json!(source_pages));
    result
        .extra
        .insert("__pageCountOut".into(), json!(sheets.len()));
    Ok(result)
}
