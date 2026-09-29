//! `pdf-to-ppt` runner (oracle `tools/pdf-to-ppt-browser.ts`): one slide per
//! PDF page over the adapter-supplied full-page renders
//! (`runtimeData.pdfPageImages` at the requested dpi) with an optional
//! searchable text layer from the merged `pdfText` lines. Slides without a
//! render are skipped; when nothing rendered the TS `no_rasterizer` error
//! surfaces.

use super::layout::pages_for;
use super::model::pdf_page_images;
use super::pptx::{write_pptx, PptLine, PptSlide, PptxInput};
use super::{emit, number, truthy};
use crate::services::naming::base_name;
use crate::{EngineError, RunContext, ToolResult};
use serde_json::json;

type RunResult = Result<ToolResult, EngineError>;

pub(super) fn run(ctx: &RunContext<'_>) -> RunResult {
    let with_text = truthy(ctx.options, "textLayer", true);
    let dpi = number(ctx.options, "dpi", 144.0).clamp(72.0, 300.0);
    let mut result = ToolResult::default();
    let mut produced = 0usize;
    for input in ctx.inputs {
        let pages = pages_for(ctx, &input.id);
        if pages.is_empty() {
            return Err(EngineError::new(
                "empty_selection",
                format!("{} 没有页面", input.name),
            ));
        }
        let renders = pdf_page_images(ctx, &input.id);
        let mut slides: Vec<PptSlide<'_>> = Vec::new();
        for page in &pages {
            // TS renders at the requested dpi; the adapter pre-renders, so an
            // entry at another dpi (or an empty payload) means "not rendered".
            let Some(entry) = renders
                .iter()
                .find(|entry| entry.page == page.page && (entry.dpi - dpi).abs() < 0.5)
                .filter(|entry| !entry.bytes.is_empty())
            else {
                continue;
            };
            let lines = if with_text {
                page.lines
                    .iter()
                    .map(|line| PptLine {
                        text: line.text.clone(),
                        x_in: line.x / 72.0,
                        y_in: line.y / 72.0,
                        w_in: (line.w / 72.0).max(0.2),
                        h_in: (line.h / 72.0).max(0.12),
                        font_size: (line.size * 0.72).round().max(5.0) as i64,
                        bold: line.weight == "bold" || line.font.to_lowercase().contains("bold"),
                        color: "000000",
                    })
                    .collect()
            } else {
                Vec::new()
            };
            slides.push(PptSlide {
                width_in: page.width / 72.0,
                height_in: page.height / 72.0,
                image: &entry.bytes,
                lines,
            });
        }
        if slides.is_empty() {
            return Err(EngineError::new("no_rasterizer", "无法渲染页面图像").with_hint("error.noRasterizer"));
        }
        let bytes = write_pptx(&PptxInput {
            slides,
            title: base_name(&input.name),
        })?;
        emit(ctx, &mut result, input, "ppt", "pptx", "pptx", bytes);
        produced += 1;
    }
    result.extra.insert("presentations".into(), json!(produced));
    Ok(result)
}

#[cfg(test)]
mod tests {
    #[test]
    fn line_boxes_use_ts_clamps_and_font_size() {
        let size = 24.0f64;
        assert_eq!((size * 0.72).round().max(5.0) as i64, 17);
        assert_eq!((4.0f64 * 0.72).round().max(5.0) as i64, 5);
        assert_eq!((1.0f64 / 72.0).max(0.2), 0.2);
        assert_eq!((0.05f64 / 72.0).max(0.12), 0.12);
    }
}

#[cfg(test)]
mod end_to_end {
    use super::run;
    use crate::{InputFile, RunContext};
    use serde_json::json;
    use std::io::Read as _;
    use zip::ZipArchive;

    fn setup(tool: &'static str) -> RunContext<'static> {
        let runtime: &'static serde_json::Value = Box::leak(Box::new(json!({
            "pdfText": { "f1": [
                { "page": 1, "width": 595.0, "height": 842.0, "runs": [
                    { "text": "标题", "x": 40.0, "y": 40.0, "w": 80.0, "h": 40.0, "size": 40.0, "weight": "normal" },
                    { "text": "body text", "x": 40.0, "y": 100.0, "w": 120.0, "h": 12.0, "size": 12.0, "weight": "bold" }
                ] },
                { "page": 2, "width": 595.0, "height": 842.0, "runs": [] }
            ] },
            "pdfPageImages": { "f1": [
                { "page": 1, "dpi": 144, "bytes": [1, 2, 3] },
                { "page": 2, "dpi": 144, "bytes": [4, 5, 6] }
            ] }
        })));
        let options: &'static serde_json::Value = Box::leak(Box::new(json!({})));
        let inputs: &'static [InputFile] = Box::leak(Box::new(vec![InputFile {
            id: "f1".into(),
            name: "样例.pdf".into(),
            path: None,
            bytes: Vec::new(),
        }]));
        RunContext {
            tool,
            options,
            locale: "zh-CN",
            inputs,
            name_pattern: None,
            runtime_data: Some(runtime),
        }
    }

    #[test]
    fn pptx_package_carries_slides_pictures_and_text_layer() {
        let ctx = setup("pdf-to-ppt");
        let result = run(&ctx).unwrap();
        assert_eq!(result.extra["presentations"], json!(1));
        let artifact = &result.artifacts[0];
        assert_eq!(artifact.name, "样例-ppt.pptx");
        assert_eq!(artifact.kind, "pptx");
        let mut archive = ZipArchive::new(std::io::Cursor::new(&artifact.bytes)).unwrap();
        let mut presentation = String::new();
        archive
            .by_name("ppt/presentation.xml")
            .unwrap()
            .read_to_string(&mut presentation)
            .unwrap();
        // 595pt / 72 × 914400 EMU per inch, from the first slide.
        let expected = (595.0f64 / 72.0 * 914400.0).round() as i64;
        assert!(presentation.contains(&format!("cx=\"{expected}\"")));
        assert!(presentation.contains("<p:sldId id=\"256\" r:id=\"rId2\"/>"));
        assert!(presentation.contains("<p:sldId id=\"257\" r:id=\"rId3\"/>"));
        assert!(archive.by_name("ppt/slides/slide1.xml").is_ok());
        assert!(archive.by_name("ppt/slides/slide2.xml").is_ok());
        assert!(archive.by_name("ppt/media/image1.png").is_ok());
        assert!(archive.by_name("ppt/media/image2.png").is_ok());
        assert!(archive.by_name("docProps/core.xml").is_ok());
        let mut slide = String::new();
        archive
            .by_name("ppt/slides/slide1.xml")
            .unwrap()
            .read_to_string(&mut slide)
            .unwrap();
        // Full-bleed picture plus the two text boxes (bold flag on the
        // bold-weight line, sz = round(size*0.72)*100: 40pt → 29 → 2900,
        // 12pt → 9 → 900).
        assert!(slide.contains("<p:pic>"));
        assert!(slide.contains("sz=\"2900\""));
        assert!(slide.contains("sz=\"900\""));
        assert!(slide.contains("b=\"1\""));
        assert!(slide.contains("wrap=\"none\""));
        assert!(slide.contains("<a:normAutofit/>"));
        assert!(slide.contains("<a:t>标题</a:t>"));
        assert!(slide.contains("r:embed=\"rId2\""));
    }

    #[test]
    fn missing_page_renders_surface_no_rasterizer() {
        let runtime: &'static serde_json::Value = Box::leak(Box::new(json!({
            "pdfText": { "f1": [
                { "page": 1, "width": 595.0, "height": 842.0, "runs": [] }
            ] },
            "pdfPageImages": { "f1": [] }
        })));
        let options: &'static serde_json::Value = Box::leak(Box::new(json!({})));
        let inputs: &'static [InputFile] = Box::leak(Box::new(vec![InputFile {
            id: "f1".into(),
            name: "scan.pdf".into(),
            path: None,
            bytes: Vec::new(),
        }]));
        let ctx = RunContext {
            tool: "pdf-to-ppt",
            options,
            locale: "zh-CN",
            inputs,
            name_pattern: None,
            runtime_data: Some(runtime),
        };
        let error = run(&ctx).unwrap_err();
        assert_eq!(error.code, "no_rasterizer");
        assert_eq!(error.hint_key, Some("error.noRasterizer"));
    }
}
