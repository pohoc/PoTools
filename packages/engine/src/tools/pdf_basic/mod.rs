//! Structure-level PDF page tools. Page content is preserved without rendering.

use crate::{EngineError, RunContext, ToolResult};

mod common;
mod merge;
mod page_ops;

pub fn run(ctx: &RunContext<'_>) -> Result<Option<ToolResult>, EngineError> {
    let result = match ctx.tool {
        "merge" => merge::run_merge(ctx)?,
        "split" => page_ops::run_split(ctx)?,
        "organize" => page_ops::run_organize(ctx)?,
        "rotate" => page_ops::run_rotate(ctx)?,
        "extract-pages" => page_ops::run_extract(ctx)?,
        "delete-pages" => page_ops::run_delete(ctx)?,
        _ => return Ok(None),
    };
    Ok(Some(result))
}
