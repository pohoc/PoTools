use super::{base_name, load, pages, EngineError, EngineResult};
use crate::{Artifact, RunContext, ToolResult};
use regex::Regex;
use std::sync::OnceLock;
pub(super) fn run(ctx: &RunContext<'_>) -> EngineResult<Option<ToolResult>> {
    if ctx.tool == "invoice-parse-fields" {
        let text = ctx.options.get("text").and_then(serde_json::Value::as_str).unwrap_or_default();
        let mut result = ToolResult::default();
        result.extra.insert("fields".into(), parse_invoice_fields(text));
        return Ok(Some(result));
    }
    if ctx.tool != "extract-text" { return Ok(None); }
    let mut result = ToolResult::default();
    for input in ctx.inputs {
        let document = load(input)?;
        let pages = document.get_pages();
        let selected: Vec<u32> = pages.keys().copied().collect();
        if selected.is_empty() {
            return Err(EngineError::new("empty_selection", format!("{} 没有页面", input.name)));
        }
        let requested = pages::parse_pages(
            ctx.options.get("pages").and_then(serde_json::Value::as_str).unwrap_or("all"),
            selected.len(),
        )?;
        let requested: Vec<u32> = requested.into_iter().map(|page| page as u32).collect();
        {
            let stem = base_name(&input.name);
            let per_page = ctx.options.get("granularity").and_then(serde_json::Value::as_str) == Some("per-page");
            let markers = ctx.options.get("pageMarkers").and_then(serde_json::Value::as_bool).unwrap_or(true);
            if per_page {
                let mut characters = 0usize;
                for page_number in &requested {
                    let page_text = document.extract_text(&[*page_number]).map_err(|error| EngineError::new("unreadable_file", format!("无法提取 PDF 文本：{error}")))?;
                    characters += page_text.chars().count();
                    let mut artifact = Artifact::new(format!("{stem}-p{page_number:02}.txt"), "text", page_text.into_bytes());
                    artifact.source_file_id = Some(input.id.clone());
                    result.artifacts.push(artifact);
                }
                if characters == 0 {
                    result.warnings.push(format!("{stem}：未提取到文字层"));
                }
                continue;
            }
            let parts = requested.iter().map(|page| document.extract_text(&[*page]).map(|text| {
                if markers && requested.len() > 1 { format!("--- {page} ---\n{text}") } else { text }
            })).collect::<Result<Vec<_>, _>>().map_err(|error| EngineError::new("unreadable_file", format!("无法提取 PDF 文本：{error}")))?;
            let body = parts.join("\n\n").trim().to_string();
            if body.is_empty() { return Err(EngineError::new("empty_selection", format!("{stem} 中没有可提取的文字（可能是扫描件）"))); }
            let mut artifact = Artifact::new(format!("{stem}.txt"), "text", format!("{body}\n").into_bytes());
            artifact.source_file_id = Some(input.id.clone());
            result.artifacts.push(artifact);
        }
    }
    Ok(Some(result))
}

pub fn parse_invoice_fields(text: &str) -> serde_json::Value {
    let normalized = text.replace('\r', "").replace('\t', " ");
    let normalized = normalized.split('\n').map(|line| line.split_whitespace().collect::<Vec<_>>().join(" ")).collect::<Vec<_>>().join("\n");
    let extract = |pattern: &'static str| -> String {
        static DATE: OnceLock<Regex> = OnceLock::new();
        static SELLER: OnceLock<Regex> = OnceLock::new();
        static BUYER: OnceLock<Regex> = OnceLock::new();
        static NUMBER: OnceLock<Regex> = OnceLock::new();
        static AMOUNT: OnceLock<Regex> = OnceLock::new();
        let cache = match pattern { "date" => &DATE, "seller" => &SELLER, "buyer" => &BUYER, "number" => &NUMBER, _ => &AMOUNT };
        let source = match pattern {
            "date" => r"(?:开票日期|开票时间|填开日期)\s*[:：]?\s*((?:20\d{2})\s*[年./-]\s*\d{1,2}\s*[月./-]\s*\d{1,2}\s*日?)",
            "seller" => r"(?:销售方名称|销方名称|销售方)\s*[:：]?\s*([^\n\r]{2,80})",
            "buyer" => r"(?:购买方名称|购方名称|购买方)\s*[:：]?\s*([^\n\r]{2,80})",
            "number" => r"(?i)(?:发票号码|票据号码|发票\s*No\.?|发票编号)\s*[:：]?\s*([0-9０-９]{8,30})",
            _ => r"(?:价税合计|小写合计|合计金额)\s*(?:\([^\n)]*\))?\s*[:：]?\s*[¥￥]?\s*([0-9,]+\.\d{2})",
        };
        cache.get_or_init(|| Regex::new(source).expect("invoice field regex is valid"))
            .captures(&normalized).and_then(|captures| captures.get(1)).map(|value| value.as_str().trim().trim_end_matches([' ', '|']).chars().take(160).collect()).unwrap_or_default()
    };
    serde_json::json!({
        "date": extract("date"), "seller": extract("seller"), "buyer": extract("buyer"),
        "invoiceNo": extract("number"), "amount": extract("amount"),
        "type": if normalized.contains("数电发票") || normalized.contains("电子发票") { "电子发票" } else if normalized.contains("增值税专用发票") { "增值税专用发票" } else if normalized.contains("增值税普通发票") { "增值税普通发票" } else { "" },
    })
}
