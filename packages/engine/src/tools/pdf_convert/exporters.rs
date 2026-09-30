//! Per-tool runners for the PDF text conversions, one per TS tool entry in
//! `pdf-text-export-browser.ts` / `pdf-to-excel-browser.ts`. Progress and
//! browser fallbacks are worker-side concerns and are not modeled here.

use super::layout::{pages_for, pages_to_flow, pages_to_flow_with_images, rows_of};
use super::model::pdf_images;
use super::writers::{flow_to_markdown, flow_to_rtf, rows_to_csv};
use super::{column_gap, emit, string, truthy, EngineResult, FlowBlock, ImageSource};
use crate::services::naming::base_name;
use crate::services::xlsx::{sanitize_sheet_name, write_xlsx, Sheet};
use crate::{Artifact, EngineError, InputFile, RunContext, ToolResult};
use serde_json::json;

type RunResult = EngineResult<ToolResult>;

/// `pdf-to-csv`: one CSV per input; pages without rows are dropped (with a
/// per-input warning) and multi-page tables get `# page N` separator rows.
pub(super) fn run_csv(ctx: &RunContext<'_>) -> RunResult {
    // TS: DELIMITERS[str(options, 'delimiter')] ?? ',' — unknown or missing
    // values degrade to comma.
    let delimiter = match string(ctx.options, "delimiter") {
        "semicolon" => ";",
        "tab" => "\t",
        _ => ",",
    };
    let gap = column_gap(ctx.options);
    let mut result = ToolResult::default();
    let mut tables = 0usize;
    for input in ctx.inputs {
        let stem = base_name(&input.name);
        let pages = pages_for(ctx, &input.id);
        let kept: Vec<(u32, Vec<Vec<String>>)> = pages
            .iter()
            .map(|page| (page.page, rows_of(page, gap)))
            .filter(|(_, rows)| !rows.is_empty())
            .collect();
        if kept.is_empty() {
            result
                .warnings
                .push(format!("{stem}：未识别到可导出的表格行"));
            continue;
        }
        let rows: Vec<Vec<String>> = if kept.len() == 1 {
            Vec::clone(&kept[0].1)
        } else {
            let mut framed: Vec<Vec<String>> = Vec::new();
            for (page, page_rows) in &kept {
                framed.push(vec![format!("# page {page}")]);
                framed.extend(page_rows.iter().cloned());
                framed.push(vec![String::new()]);
            }
            framed
        };
        emit(
            ctx,
            &mut result,
            input,
            "csv",
            "csv",
            "csv",
            rows_to_csv(&rows, delimiter).into_bytes(),
        );
        tables += 1;
    }
    if tables == 0 {
        return Err(EngineError::new("empty_selection", "没有可导出的表格内容"));
    }
    result.extra.insert("tables".into(), json!(tables));
    Ok(result)
}

/// `pdf-to-rtf`: one RTF document per input from the layout flow.
pub(super) fn run_rtf(ctx: &RunContext<'_>) -> RunResult {
    let page_breaks = truthy(ctx.options, "pageBreaks", false);
    let mut result = ToolResult::default();
    let mut documents = 0usize;
    for input in ctx.inputs {
        let pages = pages_for(ctx, &input.id);
        let flow = pages_to_flow(&pages, page_breaks);
        emit(
            ctx,
            &mut result,
            input,
            "rtf",
            "rtf",
            "rtf",
            flow_to_rtf(&flow).into_bytes(),
        );
        documents += 1;
    }
    result.extra.insert("documents".into(), json!(documents));
    Ok(result)
}

/// `pdf-to-excel`: one workbook per input, one sheet per page by default.
/// Sheets without rows are filtered before writing, so an all-empty document
/// still produces a sheet-less workbook (no error), matching the TS path.
pub(super) fn run_excel(ctx: &RunContext<'_>) -> RunResult {
    let sheet_per_page = truthy(ctx.options, "sheetPerPage", true);
    let gap = column_gap(ctx.options);
    let mut result = ToolResult::default();
    let mut produced = 0usize;
    for input in ctx.inputs {
        let pages = pages_for(ctx, &input.id);
        let stem = base_name(&input.name);
        let sheets: Vec<Sheet> = if sheet_per_page {
            pages
                .iter()
                .map(|page| Sheet {
                    name: sheet_name(&format!("{stem} {}", page.page), page.page as usize),
                    rows: rows_of(page, gap),
                })
                .collect()
        } else {
            vec![Sheet {
                name: sheet_name(stem, 1),
                rows: pages.iter().flat_map(|page| rows_of(page, gap)).collect(),
            }]
        };
        let populated: Vec<Sheet> = sheets
            .into_iter()
            .filter(|sheet| !sheet.rows.is_empty())
            .collect();
        let bytes = write_xlsx(&populated)?;
        emit(ctx, &mut result, input, "excel", "xlsx", "xlsx", bytes);
        produced += 1;
    }
    result.extra.insert("workbooks".into(), json!(produced));
    Ok(result)
}

/// Ported sheetName: sanitize, then fall back to `Sheet{index + 1}` — the TS
/// passes the page number as index for per-page sheets and literal 1 for the
/// merged sheet.
fn sheet_name(value: &str, index: usize) -> String {
    let sanitized = sanitize_sheet_name(value);
    if sanitized.is_empty() {
        format!("Sheet{}", index + 1)
    } else {
        sanitized
    }
}

/// Emits one plain-named image artifact (TS `ctx.emit({ name, kind: 'image',
/// bytes, sourceFileId })`) — crop artifacts are NOT run through renderName.
pub(super) fn emit_image_artifact(
    result: &mut ToolResult,
    input: &InputFile,
    name: &str,
    bytes: Vec<u8>,
) {
    let mut artifact = Artifact::new(name.to_owned(), "image", bytes);
    artifact.source_file_id = Some(input.id.clone());
    result.artifacts.push(artifact);
}

/// `pdf-to-markdown` (oracle `tools/pdf-text-export-browser.ts`, markdown
/// part): with `includeImages` the flow carries image blocks whose crops
/// arrive via `pdfImages`; each becomes a separate `${stem}-p${page}-${NN}.png`
/// artifact (flow-wide counter) referenced as `![图片 N](path)`. Without it,
/// the TS passes `imageFor: () => null`, so image blocks render nothing.
pub(super) fn run_markdown(ctx: &RunContext<'_>) -> RunResult {
    let include_images = truthy(ctx.options, "includeImages", true);
    let page_breaks = truthy(ctx.options, "pageBreaks", false);
    let mut result = ToolResult::default();
    let mut documents = 0usize;
    for input in ctx.inputs {
        let stem = base_name(&input.name);
        let pages = pages_for(ctx, &input.id);
        let mut names: Vec<String> = Vec::new();
        let flow = if include_images {
            if pages.is_empty() {
                return Err(EngineError::new(
                    "empty_selection",
                    format!("{} 没有页面", input.name),
                ));
            }
            let images = pdf_images(ctx, &input.id);
            let mut flow = pages_to_flow_with_images(&pages, page_breaks, &images);
            let mut image_count = 0usize;
            for block in flow.iter_mut() {
                let FlowBlock::Image {
                    page,
                    source:
                        ImageSource::Region {
                            page: source_page,
                            index,
                        },
                    ..
                } = block
                else {
                    continue;
                };
                let Some(image) = images
                    .iter()
                    .find(|image| image.page == *source_page && image.index == *index)
                else {
                    continue;
                };
                image_count += 1;
                let name = format!("{stem}-p{page}-{count:02}.png", count = image_count);
                names.push(name.clone());
                emit_image_artifact(&mut result, input, &name, image.bytes.clone());
            }
            flow
        } else {
            pages_to_flow(&pages, page_breaks)
        };
        let markdown = flow_to_markdown(&flow, &mut |ordinal| {
            names.get(ordinal.checked_sub(1)?).cloned()
        });
        emit(
            ctx,
            &mut result,
            input,
            "markdown",
            "md",
            "md",
            markdown.into_bytes(),
        );
        documents += 1;
    }
    result.extra.insert("documents".into(), json!(documents));
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sheet_name_falls_back_like_ts() {
        assert_eq!(sheet_name("报告 1", 1), "报告 1");
        assert_eq!(sheet_name("a/b\\c?d*e[f]g:h", 2), "a-b-c-d-e-f-g-h");
        assert_eq!(sheet_name("''", 3), "Sheet4");
    }
}
