//! Merge implementation.

use super::common::{add_pdf, combine, err, number, option_name, save, string, EngineResult};
use crate::{RunContext, ToolResult};
use serde_json::json;

pub(super) fn run_merge(ctx: &RunContext<'_>) -> EngineResult<ToolResult> {
    if ctx.inputs.is_empty() {
        // merge is a file job; a bare tool.run reports unsupported like the engine.
        return Err(crate::EngineError::new(
            "unsupported",
            if ctx.locale.starts_with("en") {
                "Tool \"merge\" is not a plain-text tool; submit files through the job queue (job.submit) instead."
            } else {
                "工具「merge」不是纯文本工具，请通过任务队列（job.submit）提交文件后运行。"
            },
        ));
    }
    let (mut doc, _, page_count) = combine(ctx.inputs)?;
    let mut result = ToolResult::default();
    if page_count == 0 {
        return Err(err("empty_selection", "没有可合并的页面"));
    }
    if string(ctx.options, "pageSize", "keep") != "keep"
        || string(ctx.options, "orientation", "keep") != "keep"
        || number(ctx.options, "margin", 0.0) != 0.0
    {
        result.warnings.push("当前结构处理后端不支持缩放页面内容以匹配目标尺寸；已保留各页原始尺寸，页面尺寸/方向/边距选项未应用".to_owned());
    }
    let bytes = save(&mut doc)?;
    add_pdf(
        &mut result,
        option_name(&ctx.inputs[0].name, "merge", ctx.name_pattern, 1, 1, None),
        bytes,
        None,
    );
    result.extra.insert("__pageCountIn".into(), json!(page_count));
    result
        .extra
        .insert("__pageCountOut".into(), json!(page_count));
    Ok(result)
}
