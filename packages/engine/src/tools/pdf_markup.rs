//! PDF watermark, page numbering and header/footer drawing.
use crate::services::naming::{base_name, dedupe, render_name, NameContext};
use crate::{Artifact, EngineError, RunContext, ToolResult};
use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream};
use serde_json::json;
use std::collections::HashSet;

#[path = "pdf_markup_font.rs"]
pub(crate) mod font;
#[path = "pdf_markup_support.rs"]
mod support;
use support::{
    align, bad, boolean, hex, number, parse_color, parse_pages, pdf_error, position_center, save,
    string, user_space,
};

pub fn run(ctx: &RunContext<'_>) -> Result<Option<ToolResult>, EngineError> {
    if !matches!(ctx.tool, "watermark" | "page-numbers" | "header-footer") {
        return Ok(None);
    }
    if ctx.inputs.is_empty() {
        return Err(bad("请先添加 PDF 文件"));
    }
    if ctx.tool == "header-footer"
        && string(ctx.options, "header", "").trim().is_empty()
        && string(ctx.options, "footer", "").trim().is_empty()
    {
        return Err(bad("页眉与页脚至少填写一个"));
    }
    if ctx.tool == "watermark" && string(ctx.options, "text", "机密文件").trim().is_empty() {
        return Err(bad("水印文字 不能为空"));
    }
    let mut result = ToolResult::default();
    let mut total_touched = 0usize;
    for (index, input) in ctx.inputs.iter().enumerate() {
        let mut document =
            Document::load_mem(&input.bytes).map_err(|e| pdf_error(&e.to_string()))?;
        let total = document.get_pages().len();
        if total == 0 {
            return Err(EngineError::new("unreadable_file", "PDF 没有页面"));
        }
        let selected = parse_pages(string(ctx.options, "pages", "all"), total)?;
        let sample = font_sample(ctx, input.name.as_str(), total);
        let font = font::embed(&mut document, ctx.runtime_data, &sample)?;
        let opacity = if ctx.tool == "watermark" {
            (number(ctx.options, "opacity", 22.0) / 100.0).clamp(0.01, 1.0)
        } else {
            1.0
        };
        let color = parse_color(string(
            ctx.options,
            "color",
            if ctx.tool == "watermark" {
                "#6b7280"
            } else if ctx.tool == "page-numbers" {
                "#111827"
            } else {
                "#374151"
            },
        ))?;
        let gs = add_graphics_state(&mut document, opacity);
        let ids: Vec<ObjectId> = document.get_pages().into_values().collect();
        let skip_first = boolean(ctx.options, "skipFirst", false);
        let mut touched = 0usize;
        for (page_index, page_id) in ids.iter().copied().enumerate() {
            let page_no = page_index + 1;
            if !selected.contains(&(page_no as u32))
                || (skip_first && page_index == 0 && ctx.tool != "watermark")
            {
                continue;
            }
            match ctx.tool {
                "watermark" => {
                    let text = string(ctx.options, "text", "机密文件");
                    let tiled = boolean(ctx.options, "tiled", false);
                    let angle = number(ctx.options, "rotation", 45.0);
                    let margin = number(ctx.options, "fontSize", 48.0);
                    let gap = number(ctx.options, "tileGap", 60.0).max(0.0);
                    let (width, height, rotation, origin) = page_geometry(&document, page_id)?;
                    if tiled {
                        let step_x =
                            (font.encoded(text)?.1 * margin / 1000.0 + gap).max(1.0);
                        let step_y = (font.height * margin / 1000.0 + gap).max(1.0);
                        let reach = width.max(height);
                        let mut cy = step_y / 2.0;
                        while cy < reach + step_y {
                            let mut cx = -reach;
                            while cx < reach * 2.0 {
                                draw(
                                    &mut document,
                                    page_id,
                                    &font,
                                    text,
                                    margin,
                                    color,
                                    gs,
                                    -rotation + angle,
                                    cx + step_x / 2.0,
                                    cy,
                                    width,
                                    height,
                                    rotation,
                                    origin,
                                    string(ctx.options, "layer", "above") == "below",
                                )?;
                                cx += step_x;
                            }
                            cy += step_y;
                        }
                    } else {
                        let (cx, cy) = position_center(
                            string(ctx.options, "position", "center"),
                            width,
                            height,
                            margin,
                            font.width(text) * margin / 1000.0,
                            font.height * margin / 1000.0,
                        );
                        draw(
                            &mut document,
                            page_id,
                            &font,
                            text,
                            margin,
                            color,
                            gs,
                            -rotation + angle,
                            cx,
                            cy,
                            width,
                            height,
                            rotation,
                            origin,
                            string(ctx.options, "layer", "above") == "below",
                        )?;
                    }
                }
                "page-numbers" => {
                    let format = string(ctx.options, "format", "{n} / {total}");
                    let start = number(ctx.options, "start", 1.0).trunc() as i64;
                    let label = format
                        .replace("{n}", &(page_index as i64 + start).to_string())
                        .replace(
                            "{total}",
                            &((total - usize::from(skip_first)).max(1)).to_string(),
                        );
                    let size = number(ctx.options, "fontSize", 11.0);
                    let margin = number(ctx.options, "margin", 24.0) * 72.0 / 25.4;
                    draw_positioned(
                        &mut document,
                        page_id,
                        &font,
                        &label,
                        size,
                        color,
                        gs,
                        string(ctx.options, "position", "bottom-center"),
                        margin,
                    )?;
                    touched += 1;
                }
                _ => {
                    let header = string(ctx.options, "header", "").trim();
                    let footer = string(ctx.options, "footer", "").trim();
                    let size = number(ctx.options, "fontSize", 10.0);
                    let margin = number(ctx.options, "margin", 24.0) * 72.0 / 25.4;
                    let fill = |value: &str| {
                        value
                            .replace("{name}", base_name(&input.name))
                            .replace("{n}", &page_no.to_string())
                            .replace(
                                "{total}",
                                &((total - usize::from(skip_first)).max(1)).to_string(),
                            )
                    };
                    if !header.is_empty() {
                        draw_positioned(
                            &mut document,
                            page_id,
                            &font,
                            &fill(header),
                            size,
                            color,
                            gs,
                            &format!(
                                "top-{}",
                                align(string(ctx.options, "headerAlign", "center"))
                            ),
                            margin,
                        )?;
                    }
                    if !footer.is_empty() {
                        draw_positioned(
                            &mut document,
                            page_id,
                            &font,
                            &fill(footer),
                            size,
                            color,
                            gs,
                            &format!(
                                "bottom-{}",
                                align(string(ctx.options, "footerAlign", "center"))
                            ),
                            margin,
                        )?;
                    }
                    touched += 1;
                }
            }
            if ctx.tool == "watermark" {
                touched += 1;
            }
        }
        total_touched += touched;
        let bytes = save(&mut document)?;
        let suffix = match ctx.tool {
            "watermark" => "watermarked",
            "page-numbers" => "numbered",
            _ => "hf",
        };
        let name = render_name(
            ctx.name_pattern,
            NameContext {
                name: base_name(&input.name),
                tool: suffix,
                index: Some(index + 1),
                total: Some(ctx.inputs.len()),
                range: None,
            },
            "pdf",
        );
        let name = dedupe(name, |candidate| {
            result.artifacts.iter().any(|a| a.name == candidate)
        });
        let mut artifact = Artifact::new(name, "pdf", bytes);
        artifact.source_file_id = Some(input.id.clone());
        result.artifacts.push(artifact);
    }
    let key = if ctx.tool == "page-numbers" {
        "numberedPages"
    } else {
        "pagesTouched"
    };
    result.extra.insert(key.into(), json!(total_touched));
    result
        .extra
        .insert("pageCountOut".into(), json!(total_touched));
    Ok(Some(result))
}

fn font_sample(ctx: &RunContext<'_>, name: &str, total: usize) -> String {
    match ctx.tool {
        "watermark" => string(ctx.options, "text", "机密文件").to_owned(),
        "page-numbers" => string(ctx.options, "format", "{n} / {total}")
            .replace("{n}", "888")
            .replace("{total}", &total.to_string()),
        _ => format!(
            "{}{}",
            string(ctx.options, "header", ""),
            string(ctx.options, "footer", "")
        )
        .replace("{name}", base_name(name))
        .replace("{n}", "888")
        .replace("{total}", &total.to_string()),
    }
}

fn draw_positioned(
    doc: &mut Document,
    page: ObjectId,
    font: &font::Font,
    text: &str,
    size: f64,
    color: [f64; 3],
    gs: ObjectId,
    position: &str,
    margin: f64,
) -> Result<(), EngineError> {
    let (width, height, rotation, origin) = page_geometry(doc, page)?;
    let (cx, cy) = position_center(
        position,
        width,
        height,
        margin,
        font.width(text) * size / 1000.0,
        font.height * size / 1000.0,
    );
    draw(
        doc, page, font, text, size, color, gs, -rotation, cx, cy, width, height, rotation, origin,
        false,
    )
}

fn draw(
    doc: &mut Document,
    page: ObjectId,
    font: &font::Font,
    text: &str,
    size: f64,
    color: [f64; 3],
    gs: ObjectId,
    angle: f64,
    cx: f64,
    cy: f64,
    width: f64,
    height: f64,
    rotation: f64,
    origin: (f64, f64),
    behind: bool,
) -> Result<(), EngineError> {
    let (encoded, text_width) = font.encoded(text)?;
    let line_height = font.height * size / 1000.0;
    let (x, y) = user_space(width, height, rotation, cx, cy);
    let radians = angle.to_radians();
    let (sin, cos) = radians.sin_cos();
    let base = 0.28 * line_height;
    let tx = origin.0 + x - (text_width * size / 2000.0) * cos + base * sin;
    let ty = origin.1 + y - (text_width * size / 2000.0) * sin - base * cos;
    let stream = format!(
        "q /GSMark gs {} {} {} rg BT /FMark {} Tf {} {} {} {} {} {} Tm <{}> Tj ET Q",
        color[0],
        color[1],
        color[2],
        size,
        cos,
        sin,
        -sin,
        cos,
        tx,
        ty,
        hex(&encoded)
    );
    append_content(doc, page, &stream, font, gs, behind)
}

fn append_content(
    doc: &mut Document,
    page_id: ObjectId,
    bytes: &str,
    font: &font::Font,
    gs: ObjectId,
    behind: bool,
) -> Result<(), EngineError> {
    let page = doc
        .get_dictionary(page_id)
        .map_err(|e| pdf_error(&e.to_string()))?
        .clone();
    let resources = inherited(doc, page_id, b"Resources")
        .and_then(|o| object_dictionary(doc, o))
        .unwrap_or_default();
    let mut resources = resources;
    let mut fonts = resource_dict(doc, &resources, b"Font");
    fonts.set(
        font.resource.as_bytes().to_vec(),
        Object::Reference(font.reference),
    );
    resources.set("Font", fonts);
    let mut states = resource_dict(doc, &resources, b"ExtGState");
    states.set("GSMark", Object::Reference(gs));
    resources.set("ExtGState", states);
    doc.get_dictionary_mut(page_id)
        .map_err(|e| pdf_error(&e.to_string()))?
        .set("Resources", Object::Dictionary(resources));
    let stream = doc.add_object(Stream::new(Dictionary::new(), bytes.as_bytes().to_vec()));
    let contents_value = page
        .get(b"Contents")
        .ok()
        .cloned()
        .and_then(|value| match value {
            Object::Reference(id) => doc.get_object(id).ok().cloned().map(|value| match value {
                Object::Array(items) => Object::Array(items),
                Object::Stream(_) => Object::Reference(id),
                _ => value,
            }),
            other => Some(other),
        });
    let mut contents = match contents_value {
        Some(Object::Array(a)) => a,
        Some(Object::Reference(id)) => vec![Object::Reference(id)],
        Some(Object::Stream(stream)) => {
            vec![Object::Reference(doc.add_object(Object::Stream(stream)))]
        }
        _ => Vec::new(),
    };
    if behind {
        contents.insert(0, Object::Reference(stream));
    } else {
        contents.push(Object::Reference(stream));
    }
    doc.get_dictionary_mut(page_id)
        .map_err(|e| pdf_error(&e.to_string()))?
        .set("Contents", Object::Array(contents));
    Ok(())
}

fn object_dictionary(doc: &Document, value: Object) -> Option<Dictionary> {
    match value {
        Object::Dictionary(dictionary) => Some(dictionary),
        Object::Reference(id) => doc.get_object(id).ok().and_then(|object| match object {
            Object::Dictionary(dictionary) => Some(dictionary.clone()),
            _ => None,
        }),
        _ => None,
    }
}

fn resource_dict(doc: &Document, resources: &Dictionary, key: &[u8]) -> Dictionary {
    resources
        .get(key)
        .ok()
        .cloned()
        .and_then(|object| object_dictionary(doc, object))
        .unwrap_or_default()
}

fn add_graphics_state(doc: &mut Document, opacity: f64) -> ObjectId {
    doc.add_object(dictionary! { "Type" => "ExtGState", "ca" => opacity, "CA" => opacity })
}

fn inherited(doc: &Document, page: ObjectId, key: &[u8]) -> Option<Object> {
    let mut current = Some(page);
    let mut seen = HashSet::new();
    while let Some(id) = current {
        if !seen.insert(id) {
            return None;
        }
        let dict = doc.get_dictionary(id).ok()?;
        if let Ok(value) = dict.get(key) {
            return Some(value.clone());
        }
        current = dict.get(b"Parent").ok().and_then(|o| o.as_reference().ok());
    }
    None
}

fn page_geometry(
    doc: &Document,
    page: ObjectId,
) -> Result<(f64, f64, f64, (f64, f64)), EngineError> {
    let media = inherited(doc, page, b"MediaBox")
        .ok_or_else(|| EngineError::new("unreadable_file", "PDF 页面缺少 MediaBox"))?;
    let array = media.as_array().map_err(|e| pdf_error(&e.to_string()))?;
    if array.len() < 4 {
        return Err(EngineError::new(
            "unreadable_file",
            "PDF 页面 MediaBox 无效",
        ));
    }
    let vals: Vec<f64> = array
        .iter()
        .take(4)
        .map(|v| {
            v.as_float()
                .map(|n| n as f64)
                .or_else(|_| v.as_i64().map(|n| n as f64))
                .map_err(|e| pdf_error(&e.to_string()))
        })
        .collect::<Result<_, _>>()?;
    let rotation = inherited(doc, page, b"Rotate")
        .and_then(|o| o.as_i64().ok())
        .unwrap_or(0) as f64;
    let w = vals[2] - vals[0];
    let h = vals[3] - vals[1];
    if rotation.round() as i32 % 180 == 0 {
        Ok((w, h, rotation, (vals[0], vals[1])))
    } else {
        Ok((h, w, rotation, (vals[0], vals[1])))
    }
}
