//! Rust implementations of resize, margins and n-up page layout.
use super::{boolean, load, number, string, EngineError, EngineResult};
use crate::{RunContext, ToolResult};
use lopdf::ObjectId;
use serde_json::json;
pub(super) mod layout;
use layout::{add_geometry_pdf, make_form, orient, output_document, preset, PlacedPage, Size};

pub(super) fn run(ctx: &RunContext<'_>) -> EngineResult<ToolResult> {
    match ctx.tool {
        "resize" => run_resize(ctx),
        "margins" => run_margins(ctx),
        "nup" => run_nup(ctx),
        _ => Err(EngineError::new("internal", "无效几何工具路由")),
    }
}

fn run_resize(ctx: &RunContext<'_>) -> EngineResult<ToolResult> {
    if ctx.inputs.is_empty() {
        return Err(EngineError::new("bad_request", "请先添加 PDF 文件"));
    }
    let target = string(ctx.options, "target", "a4");
    let orientation = string(ctx.options, "orientation", "keep");
    let mut result = ToolResult::default();
    for input in ctx.inputs {
        let mut document = load(input)?;
        let original_pages: Vec<ObjectId> = document.get_pages().into_values().collect();
        if original_pages.is_empty() {
            return Err(EngineError::new(
                "empty_selection",
                format!("{} 没有页面", input.name),
            ));
        }
        let forms: Vec<PlacedPage> = original_pages
            .iter()
            .map(|id| make_form(&mut document, *id))
            .collect::<EngineResult<_>>()?;
        let first = forms[0].size;
        let mut specs = Vec::with_capacity(forms.len());
        let margin = number(ctx.options, "margin", 0.0).max(0.0);
        let keep_ratio = boolean(ctx.options, "keepRatio", true);
        let scale_option = if target == "scale" {
            (number(ctx.options, "scale", 100.0).max(25.0) / 100.0).min(8.0)
        } else {
            1.0
        };
        for form in &forms {
            let mut box_size = if target == "match-first" {
                first
            } else {
                preset(&target).unwrap_or(form.size)
            };
            box_size = orient(box_size, &orientation);
            if target == "scale" {
                box_size = Size {
                    width: box_size.width * scale_option,
                    height: box_size.height * scale_option,
                };
            }
            let available_w = (box_size.width - margin * 2.0).max(1.0);
            let available_h = (box_size.height - margin * 2.0).max(1.0);
            let ratio = if keep_ratio {
                (available_w / form.size.width).min(available_h / form.size.height)
            } else {
                1.0
            };
            // The original min/max chain coalesced NaN to 1.0 (f64::min returns
            // the non-NaN operand); `clamp` propagates NaN instead, so normalise
            // first to keep malformed geometry from poisoning the scale.
            let ratio = if ratio.is_nan() { 1.0 } else { ratio };
            let scale = ratio.clamp(0.0, 1.0);
            let draw_w = form.size.width * scale;
            let draw_h = form.size.height * scale;
            let x = margin + (available_w - draw_w) / 2.0;
            let y = margin + (available_h - draw_h) / 2.0;
            specs.push((box_size, vec![(form.form, x, y, scale, scale, None)], false));
        }
        let bytes = output_document(&mut document, specs)?;
        add_geometry_pdf(ctx, &mut result, input, "resized", bytes);
    }
    Ok(result)
}

fn run_margins(ctx: &RunContext<'_>) -> EngineResult<ToolResult> {
    if ctx.inputs.is_empty() {
        return Err(EngineError::new("bad_request", "请先添加 PDF 文件"));
    }
    let edge = number(ctx.options, "edge", 24.0).max(0.0);
    let sides = string(ctx.options, "sides", "all");
    let vertical = if sides == "all" || sides == "vertical" {
        edge
    } else {
        0.0
    };
    let horizontal = if sides == "all" || sides == "horizontal" {
        edge
    } else {
        0.0
    };
    let keep_size = boolean(ctx.options, "keepPageSize", true);
    let mut result = ToolResult::default();
    let mut total_pages = 0;
    for input in ctx.inputs {
        let mut document = load(input)?;
        let source_pages: Vec<ObjectId> = document.get_pages().into_values().collect();
        let forms: Vec<PlacedPage> = source_pages
            .iter()
            .map(|id| make_form(&mut document, *id))
            .collect::<EngineResult<_>>()?;
        let mut specs = Vec::with_capacity(forms.len());
        for form in forms {
            let box_size = if keep_size {
                form.size
            } else {
                Size {
                    width: form.size.width + horizontal * 2.0,
                    height: form.size.height + vertical * 2.0,
                }
            };
            let inset = if keep_size {
                vertical.max(horizontal)
            } else {
                0.0
            };
            let available_w = (box_size.width - inset * 2.0).max(1.0);
            let available_h = (box_size.height - inset * 2.0).max(1.0);
            let scale = (available_w / form.size.width)
                .min(available_h / form.size.height)
                .min(1.0)
                .min(8.0);
            let x = inset + (available_w - form.size.width * scale) / 2.0;
            let y = inset + (available_h - form.size.height * scale) / 2.0;
            specs.push((box_size, vec![(form.form, x, y, scale, scale, None)], false));
            total_pages += 1;
        }
        let bytes = output_document(&mut document, specs)?;
        add_geometry_pdf(ctx, &mut result, input, "margins", bytes);
    }
    result
        .extra
        .insert("__pageCountOut".into(), json!(total_pages));
    Ok(result)
}

#[derive(Clone, Copy)]
struct Cell {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn grid_cells(per_sheet: usize, sheet: Size, gap: f64, margin: f64) -> Vec<Cell> {
    let columns = if per_sheet >= 9 {
        3
    } else if per_sheet >= 4 {
        if per_sheet == 6 {
            3
        } else {
            2
        }
    } else if per_sheet == 2 {
        2
    } else {
        1
    };
    let rows = per_sheet.div_ceil(columns);
    let width = (sheet.width - margin * 2.0 - gap * (columns - 1) as f64) / columns as f64;
    let height = (sheet.height - margin * 2.0 - gap * (rows - 1) as f64) / rows as f64;
    (0..per_sheet)
        .map(|index| {
            let col = index % columns;
            let row = index / columns;
            Cell {
                x: margin + col as f64 * (width + gap),
                y: margin + row as f64 * (height + gap),
                width,
                height,
            }
        })
        .collect()
}

fn run_nup(ctx: &RunContext<'_>) -> EngineResult<ToolResult> {
    let input = ctx
        .inputs
        .first()
        .ok_or_else(|| EngineError::new("bad_request", "请先添加 PDF 文件"))?;
    let mut document = load(input)?;
    let source_pages: Vec<ObjectId> = document.get_pages().into_values().collect();
    if source_pages.is_empty() {
        return Err(EngineError::new(
            "empty_selection",
            format!("{} 没有页面", input.name),
        ));
    }
    let forms: Vec<PlacedPage> = source_pages
        .iter()
        .map(|id| make_form(&mut document, *id))
        .collect::<EngineResult<_>>()?;
    let total = forms.len();
    let per_sheet = number(ctx.options, "perSheet", 2.0).trunc().max(1.0) as usize;
    let gap = number(ctx.options, "gap", 8.0);
    let margin = number(ctx.options, "margin", 12.0);
    let preset_key = string(ctx.options, "pageSize", "a4");
    let first = forms[0].size;
    let orientation = string(ctx.options, "orientation", "auto");
    let mut sheet = if preset_key == "match-first" {
        first
    } else {
        preset(&preset_key).unwrap_or(first)
    };
    if orientation == "landscape" || (orientation == "auto" && per_sheet >= 4) {
        sheet = Size {
            width: sheet.width.max(sheet.height),
            height: sheet.width.min(sheet.height),
        };
    } else if orientation == "portrait" {
        sheet = Size {
            width: sheet.width.min(sheet.height),
            height: sheet.width.max(sheet.height),
        };
    }
    let cells = grid_cells(per_sheet, sheet, gap, margin);
    let vertical = string(ctx.options, "order", "horizontal") == "vertical";
    let border = boolean(ctx.options, "border", false);
    let mut specs = Vec::new();
    for start in (0..total).step_by(per_sheet) {
        let block_end = (start + per_sheet).min(total);
        let block_len = block_end - start;
        let mut order: Vec<usize> = (start..block_end).collect();
        if vertical {
            let columns = (block_len as f64 / (block_len as f64).sqrt().ceil())
                .ceil()
                .max(1.0) as usize;
            let rows = block_len.div_ceil(columns);
            order.clear();
            for col in 0..columns {
                for row in 0..rows {
                    let index = start + row + col * rows;
                    if index < block_end {
                        order.push(index);
                    }
                }
            }
        }
        let mut placements = Vec::new();
        for (slot, source_index) in order.into_iter().enumerate() {
            let form = forms[source_index];
            let cell = cells[slot];
            let scale = (cell.width / form.size.width).min(cell.height / form.size.height);
            let draw_w = form.size.width * scale;
            let draw_h = form.size.height * scale;
            let x = cell.x + (cell.width - draw_w) / 2.0;
            let y = sheet.height - cell.y - cell.height + (cell.height - draw_h) / 2.0;
            placements.push((
                form.form,
                x,
                y,
                scale,
                scale,
                Some((
                    cell.x,
                    sheet.height - cell.y - cell.height,
                    cell.width,
                    cell.height,
                )),
            ));
        }
        specs.push((sheet, placements, border));
    }
    let sheets = specs.len();
    let bytes = output_document(&mut document, specs)?;
    let mut result = ToolResult::default();
    add_geometry_pdf(ctx, &mut result, input, "nup", bytes);
    result.extra.insert("__pageCountIn".into(), json!(total));
    result.extra.insert("__pageCountOut".into(), json!(sheets));
    result.extra.insert("sheets".into(), json!(sheets));
    result.extra.insert("perSheet".into(), json!(per_sheet));
    Ok(result)
}
