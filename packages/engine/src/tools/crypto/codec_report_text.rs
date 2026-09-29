//! Text-shaped codec reports (URL codec and Unicode escape), split out of
//! `codec_report` to keep both files small.

use super::codec_report::{emit, stats_section};
use super::enc;
use super::hash::{boolean, string};
use super::url::{build_query, parse_pairs, percent_decode, percent_encode, split_url};
use crate::tools::text::fmt::{join_blocks, row, section};
use crate::{EngineError, RunContext, ToolResult};
use serde_json::json;

pub(super) fn url_report(ctx: &RunContext<'_>, raw: &str) -> Result<ToolResult, EngineError> {
    let en = enc::is_en(ctx);
    let mode = match string(ctx, "mode", "encode") {
        "decode" | "parse" | "build" => string(ctx, "mode", "encode"),
        _ => "encode",
    };
    let component = boolean(ctx, "component", true);
    let form = boolean(ctx, "form", false);
    let scope = enc::t(en, "component（encodeURIComponent）", "component (encodeURIComponent)");
    let mut extra = serde_json::Map::new();
    extra.insert("mode".into(), json!(mode));
    extra.insert("component".into(), json!(if component { "component" } else { "url" }));
    let mut blocks: Vec<String> = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    if mode == "encode" {
        let encoded = percent_encode(raw, component, form);
        blocks.push(section(&format!(
            "{}{scope}",
            enc::t(en, "URL 编码 · ", "URL encode - ")
        )));
        blocks.push(encoded.clone());
        // count well-formed %XX runs (the engine regex-counted them)
        let bytes = encoded.as_bytes();
        let mut escapes = 0usize;
        let mut index = 0usize;
        while index + 2 < bytes.len() {
            if bytes[index] == b'%' && bytes[index + 1].is_ascii_hexdigit() && bytes[index + 2].is_ascii_hexdigit() {
                escapes += 1;
                index += 3;
            } else {
                index += 1;
            }
        }
        let (head, rows_text) = stats_section(en, &[
            row(enc::t(en, "输入字符", "Input characters"), enc::code_points(raw).to_string()),
            row(enc::t(en, "输出字符", "Output characters"), encoded.len().to_string()),
            row(enc::t(en, "%XX 片段", "%XX fragments"), escapes.to_string()),
            row(
                enc::t(en, "未转义字符", "Left unescaped"),
                enc::t(
                    en,
                    if component { "! ' ( ) * - . _ ~ 字母数字" } else { "额外保留 : / ? # [ ] @ & = + $ ," },
                    if component { "! ' ( ) * - . _ ~ letters and digits" } else { "also kept: : / ? # [ ] @ & = + $ ," },
                ),
            ),
        ]);
        blocks.push(head);
        blocks.push(rows_text);
        notes.push(
            enc::t(
                en,
                if component { "· component=true 会转义 & = ? # / 等分隔符，适合单个参数值。" } else { "· component=false（encodeURI）保留 URL 结构字符，适合整条 URL。" },
                if component { "- component=true escapes the separators & = ? # / as well, which suits a single parameter value." } else { "- component=false (encodeURI) keeps the URL structure characters, which suits a whole URL." },
            )
            .to_string(),
        );
        extra.insert("inputChars".into(), json!(enc::code_points(raw)));
        extra.insert("outputChars".into(), json!(encoded.len()));
        extra.insert("escapes".into(), json!(escapes));
    } else if mode == "decode" {
        let decoded = percent_decode(raw, component, form)?;
        blocks.push(section(&format!(
            "{}{scope}",
            enc::t(en, "URL 解码 · ", "URL decode - ")
        )));
        blocks.push(decoded.clone());
        let restored = raw.matches('%').count();
        let pluses = raw.matches('+').count();
        let (head, rows_text) = stats_section(en, &[
            row(enc::t(en, "输入字符", "Input characters"), enc::code_points(raw).to_string()),
            row(enc::t(en, "输出字符", "Output characters"), enc::code_points(&decoded).to_string()),
            row(enc::t(en, "还原 %XX", "%XX restored"), restored.to_string()),
            row(
                enc::t(en, "加号转空格", "Plus to space"),
                if pluses > 0 {
                    if en { format!("Yes ({pluses} places)") } else { format!("是（{pluses} 处）") }
                } else {
                    enc::t(en, "无加号", "no plus sign").to_string()
                },
            ),
            row(
                enc::t(en, "再编码一致", "Re-encode matches"),
                if percent_encode(&decoded, component, false) == raw {
                    enc::t(en, "是", "Yes").to_string()
                } else {
                    enc::t(en, "否", "No").to_string()
                },
            ),
        ]);
        blocks.push(head);
        blocks.push(rows_text);
        notes.push(enc::t(en, "· 解码把 + 还原为空格；若原文里的 + 是字面量，请确认它已写成 %2B。", "- Decoding turns + into a space; if a literal + belongs to the source, make sure it was written as %2B.").to_string());
        extra.insert("inputChars".into(), json!(enc::code_points(raw)));
        extra.insert("outputChars".into(), json!(enc::code_points(&decoded)));
    } else if mode == "parse" {
        let (base, query, fragment, had_fragment, had_query) = split_url(raw);
        let effective_query = if query.is_empty() && !had_query && raw.contains('=') && !raw.contains("://") { raw } else { query };
        let pairs = parse_pairs(effective_query)?;
        blocks.push(section(&format!(
            "{}{}{}",
            enc::t(en, "URL 参数解析 · ", "URL parameters - "),
            pairs.len(),
            enc::t(en, " 个参数", " entries")
        )));
        let mut detail_rows = vec![
            row(enc::t(en, "输入", "Input"), enc::preview(en, raw, 96)),
            row(enc::t(en, "基础地址", "Base URL"), if base.is_empty() { enc::t(en, "(未给出)", "(not given)").to_string() } else { base.to_string() }),
            row(enc::t(en, "查询串", "Query string"), if query.is_empty() { enc::t(en, "(空)", "(empty)").to_string() } else { query.to_string() }),
            row(
                enc::t(en, "片段", "Fragment"),
                if had_fragment {
                    if fragment.is_empty() { enc::t(en, "(空片段)", "(empty fragment)").to_string() } else { fragment.to_string() }
                } else {
                    enc::t(en, "无", "None").to_string()
                },
            ),
        ];
        let mut repeated: Vec<String> = Vec::new();
        for (index, pair) in pairs.iter().enumerate() {
            let count = pairs.iter().filter(|other| other.key == pair.key).count();
            if count > 1 && !repeated.iter().any(|existing| existing.starts_with(&format!("{index} "))) {
                repeated.push(format!("{index} {}×{count}", pair.key));
            }
        }
        detail_rows.push(row(
            enc::t(en, "重复键", "Repeated keys"),
            if repeated.is_empty() {
                enc::t(en, "无", "None").to_string()
            } else {
                repeated.iter().map(|entry| entry.split_once(' ').unwrap_or((entry, "")).1.to_string()).collect::<Vec<_>>().join(if en { ", " } else { "、" })
            },
        ));
        let (head, rows_text) = stats_section(en, &detail_rows);
        blocks.push(head);
        blocks.push(rows_text);
        blocks.push(section(enc::t(en, "参数明细", "Parameter detail")));
        blocks.push(if pairs.is_empty() {
            enc::t(en, "  · 未解析到参数。", "  - No parameters were parsed.").to_string()
        } else {
            pairs
                .iter()
                .enumerate()
                .map(|(index, pair)| {
                    let key = if pair.has_value { pair.key.clone() } else { format!("{}{}", pair.key, enc::t(en, "（无 =）", " (no =)")) };
                    row(format!("{}. {}", index + 1, key), pair.value.clone()).1
                })
                .collect::<Vec<_>>()
                .join("\n")
        });
        notes.push(enc::t(en, "· component=true：键与值都按 encodeURIComponent 规则还原（含 + → 空格）。", "- component=true: keys and values are restored with the encodeURIComponent rules (including + to space).").to_string());
        notes.push(enc::t(en, "· 重复键逐行保留，不做合并。", "- Repeated keys are kept row by row and never merged.").to_string());
        if pairs.is_empty() {
            notes.push(enc::t(en, "· 若只是想还原整条 URL，请改用 mode=decode。", "- To restore a whole URL instead, switch to mode=decode.").to_string());
        }
        extra.insert("params".into(), json!(pairs.len()));
    } else {
        let query = build_query(raw, component)?;
        blocks.push(section(&format!(
            "{}{scope}",
            enc::t(en, "查询串组装 · ", "Query string assembly - ")
        )));
        blocks.push(query.clone());
        let lines: Vec<&str> = raw.split(['\r', '\n']).map(str::trim).filter(|l| !l.is_empty()).collect();
        let (head, rows_text) = stats_section(en, &[
            row(enc::t(en, "参数行数", "Parameter lines"), lines.len().to_string()),
            row(enc::t(en, "查询串长度", "Query string length"), query.len().to_string()),
            row(enc::t(en, "解析回来", "Parses back"), {
                let back = parse_pairs(&query).map(|pairs| pairs.len()).unwrap_or(0);
                if back == lines.len() {
                    enc::t(en, "一致", "consistent").to_string()
                } else {
                    enc::t(en, "需检查输入中的 & 与 =", "check the & and = in the input").to_string()
                }
            }),
        ]);
        blocks.push(head);
        blocks.push(rows_text);
        notes.push(enc::t(en, "· 每行一个 key=value，值里的 = 之后的内容整段视为值。", "- One key=value per line; everything after the first = in a line counts as the value.").to_string());
        notes.push(enc::t(en, "· component=true：键与值全部转义，& = + # 都写成 %XX。", "- component=true: keys and values are fully escaped, & = + # all become %XX.").to_string());
        extra.insert("params".into(), json!(lines.len()));
        extra.insert("queryLength".into(), json!(query.len()));
    }
    blocks.push(section(enc::t(en, "说明", "Notes")));
    blocks.push(notes.join("\n"));
    Ok(emit("url-codec.txt", join_blocks(blocks.iter().map(String::as_str)), extra))
}

pub(super) fn unicode_report(ctx: &RunContext<'_>, raw: &str) -> Result<ToolResult, EngineError> {
    let en = enc::is_en(ctx);
    let mode = if string(ctx, "mode", "encode") == "decode" { "decode" } else { "encode" };
    let style = string(ctx, "style", "unicode");
    let style_label = match style {
        "json" => enc::t(en, "JSON 字符串", "JSON string"),
        "html-entity" => enc::t(en, "HTML 具名实体", "HTML named entities"),
        "html-numeric" => enc::t(en, "HTML 数字实体", "HTML numeric entities"),
        _ => "\\uXXXX",
    };
    let mut extra = serde_json::Map::new();
    extra.insert("mode".into(), json!(mode));
    extra.insert("style".into(), json!(style));
    let mut blocks: Vec<String> = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    if mode == "encode" {
        let output = super::unicode::unicode_encode(raw, style);
        let non_ascii = raw.chars().filter(|c| *c as u32 > 0x7e).count();
        blocks.push(section(&format!(
            "{}{style_label}",
            enc::t(en, "Unicode 转义 · 编码 · ", "Unicode escape - encode - ")
        )));
        blocks.push(output.clone());
        let fragments = if style.starts_with("html") {
            html_entity_count(&output)
        } else {
            unicode_escape_count(&output)
        };
        let (head, rows_text) = stats_section(en, &[
            row(enc::t(en, "输入字符", "Input characters"), enc::code_points(raw).to_string()),
            row(enc::t(en, "输出字符", "Output characters"), enc::code_points(&output).to_string()),
            row(enc::t(en, "非 ASCII", "Non-ASCII"), enc::fill(en, enc::Tmpl::Pieces, non_ascii)),
            row(enc::t(en, "转义片段", "Escape fragments"), fragments.to_string()),
            row(enc::t(en, "UTF-8 字节", "UTF-8 bytes"), raw.len().to_string()),
        ]);
        blocks.push(head);
        blocks.push(rows_text);
        match style {
            "html-entity" => notes.push(enc::t(en, "· 只对有标准名称的字符用具名实体，其余非 ASCII 退化为 &#NNN; 数字实体。", "- Characters with a standard name use the named entity, every other non-ASCII character falls back to the &#NNN; numeric entity.").to_string()),
            "html-numeric" => notes.push(enc::t(en, "· 数字实体按 Unicode 码点写十进制（&#20013;），增补字符也能整段表示。", "- Numeric entities carry the Unicode code point in decimal (&#20013;), which also covers astral characters in one piece.").to_string()),
            "json" => notes.push(enc::t(en, "· 输出含首尾双引号，引号与反斜杠一并转义，可直接粘进 JSON。", "- The output carries the surrounding double quotes and escapes quotes and backslashes, so it pastes straight into JSON.").to_string()),
            _ => notes.push(enc::t(en, "· \\uXXXX 以 UTF-16 码元写出，表情等增补字符会拆成代理对（\\ud83d\\ude00）。", "- \\uXXXX writes UTF-16 code units, so emoji and other astral characters split into surrogate pairs (\\ud83d\\ude00).").to_string()),
        }
        extra.insert("inputChars".into(), json!(enc::code_points(raw)));
        extra.insert("outputChars".into(), json!(enc::code_points(&output)));
        extra.insert("nonAscii".into(), json!(non_ascii));
    } else {
        let decoded = super::unicode::unicode_decode(raw, style)?;
        if decoded.is_empty() {
            return Err(super::hash::bad("input", "decodes to an empty string"));
        }
        let re_encoded = super::unicode::unicode_encode(&decoded, style);
        blocks.push(section(&format!(
            "{}{style_label}",
            enc::t(en, "Unicode 转义 · 解码 · ", "Unicode escape - decode - ")
        )));
        blocks.push(decoded.clone());
        let non_ascii = decoded.chars().filter(|c| *c as u32 > 0x7e).count();
        let mut rows = vec![
            row(enc::t(en, "输入字符", "Input characters"), enc::code_points(raw).to_string()),
            row(enc::t(en, "输出字符", "Output characters"), enc::code_points(&decoded).to_string()),
            row(enc::t(en, "非 ASCII", "Non-ASCII"), enc::fill(en, enc::Tmpl::Pieces, non_ascii)),
            row(enc::t(en, "UTF-8 字节", "UTF-8 bytes"), decoded.len().to_string()),
        ];
        let stable = re_encoded == raw || (style == "json" && re_encoded == raw.trim());
        rows.push(row(
            enc::t(en, "再编码一致", "Re-encode matches"),
            if stable {
                enc::t(en, "是", "Yes").to_string()
            } else {
                enc::t(en, "否（规范写法见下）", "No (canonical spelling below)").to_string()
            },
        ));
        let (head, rows_text) = stats_section(en, &rows);
        blocks.push(head);
        blocks.push(rows_text);
        if !stable {
            blocks.push(section(enc::t(en, "规范再编码", "Canonical re-encoding")));
            blocks.push(re_encoded);
        }
        notes.push(enc::t(en, "· 解码可与普通字符混写，逐段还原转义片段。", "- Decoding mixes plain text and escape fragments and restores each fragment in turn.").to_string());
        match style {
            "json" => notes.push(enc::t(en, "· 省略首尾引号时按字符串补全解析，对象/数组则原样美化输出。", "- With the surrounding quotes missing it parses as a plain string; objects and arrays are prettified as they are.").to_string()),
            "html-numeric" => notes.push(enc::t(en, "· 同时识别 &#NNN; 与 &#xHHHH; 两种数字实体。", "- Recognizes both the &#NNN; and the &#xHHHH; numeric entity forms.").to_string()),
            _ => notes.push(enc::t(en, "· 支持 \\uXXXX、\\xNN、\\n\\r\\t\\b\\f 与 \\\\；代理对自动合并。", "- Supports \\uXXXX, \\xNN, \\n\\r\\t\\b\\f and \\\\, and merges surrogate pairs automatically.").to_string()),
        }
        let unknown = super::unicode::unknown_html_entities(raw);
        extra.insert("inputChars".into(), json!(enc::code_points(raw)));
        extra.insert("outputChars".into(), json!(enc::code_points(&decoded)));
        extra.insert("unknownEntities".into(), json!(unknown));
        let mut result = emit("unicode-escape.txt", join_blocks(blocks.iter().map(String::as_str)), extra);
        if unknown > 0 {
            result.warnings.push(enc::t(en, "未知具名实体已按原文保留。", "Unknown named entities were left as written.").to_string());
        }
        return Ok(result);
    }
    blocks.push(section(enc::t(en, "说明", "Notes")));
    blocks.push(notes.join("\n"));
    Ok(emit("unicode-escape.txt", join_blocks(blocks.iter().map(String::as_str)), extra))
}

fn unicode_escape_count(text: &str) -> usize {
    let bytes = text.as_bytes();
    let mut count = 0;
    let mut index = 0;
    while index + 6 <= bytes.len() {
        if bytes[index] == b'\\' && bytes[index + 1] == b'u' && bytes[index + 2..index + 6].iter().all(|b| b.is_ascii_hexdigit()) {
            count += 1;
            index += 6;
        } else {
            index += 1;
        }
    }
    count
}

fn html_entity_count(text: &str) -> usize {
    let mut count = 0;
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        if let Some(end) = rest[at..].find(';') {
            count += 1;
            rest = &rest[at + end + 1..];
        } else {
            break;
        }
    }
    count
}
