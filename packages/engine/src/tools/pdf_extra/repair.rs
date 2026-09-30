use super::{
    add_pdf, boolean, info_dict, load, remove_xmp, save, set_info_string, store_info, EngineError,
    EngineResult,
};
use crate::{RunContext, ToolResult};

pub(super) fn run(ctx: &RunContext<'_>) -> EngineResult<ToolResult> {
    let mut result = ToolResult::default();
    for input in ctx.inputs {
        let mut document = load(input)?;
        if document.get_pages().is_empty() {
            return Err(EngineError::new(
                "unreadable_file",
                format!("{}：文档结构损坏严重，读取后没有可恢复页面", input.name),
            ));
        }
        if boolean(ctx.options, "stripMetadata", false) {
            let mut info = info_dict(&document);
            for key in [b"Title".as_slice(), b"Author", b"Subject", b"Keywords"] {
                info.remove(key);
            }
            set_info_string(&mut info, b"Producer", "PoTools");
            store_info(&mut document, info);
            remove_xmp(&mut document)?;
        } else {
            let mut info = info_dict(&document);
            set_info_string(&mut info, b"Producer", "PoTools");
            store_info(&mut document, info);
        }
        if boolean(ctx.options, "recompress", true) {
            // Compress eligible unfiltered streams. Existing image codecs and
            // streams with unsupported filters remain byte-preserving.
            document.compress();
        }
        // 重建后择优保存：小文件里对象流/xref 流的开销可能超过压缩收益，
        // 不膨胀就不触发用户的体积警告。
        let mut bytes = save(&mut document)?;
        if bytes.len() > input.bytes.len() {
            let options = lopdf::SaveOptions::builder()
                .use_object_streams(false)
                .use_xref_streams(false)
                .build();
            let mut compact = Vec::new();
            if document
                .save_with_options(&mut compact, options)
                .is_ok()
                && compact.len() < bytes.len()
            {
                bytes = compact;
            }
        }
        let ratio = if input.bytes.is_empty() {
            0
        } else {
            ((bytes.len() as f64 - input.bytes.len() as f64) / input.bytes.len() as f64 * 100.0)
                .round() as i64
        };
        if ratio > 5 {
            result
                .warnings
                .push(format!("{}：重写后体积增加 {ratio}%", input.name));
        }
        add_pdf(ctx, &mut result, input, "repaired", bytes);
    }
    if ctx.inputs.is_empty() {
        return Err(EngineError::new("bad_request", "请先添加文件"));
    }
    Ok(result)
}
