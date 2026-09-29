//! Vector-preserving PDF page placement shared by resize, margins and n-up.
use super::super::pages;
use super::super::{dedupe, save, EngineError, EngineResult};
use crate::services::naming::{base_name, render_name, NameContext};
use crate::{Artifact, RunContext, ToolResult};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use std::collections::HashSet;

#[derive(Clone, Copy, Debug)]
pub(in crate::tools::pdf_extra) struct Size {
    pub(in crate::tools::pdf_extra) width: f64,
    pub(in crate::tools::pdf_extra) height: f64,
}

#[derive(Clone, Copy)]
pub(in crate::tools::pdf_extra) struct PlacedPage {
    pub(in crate::tools::pdf_extra) form: ObjectId,
    pub(in crate::tools::pdf_extra) size: Size,
}
pub(in crate::tools::pdf_extra) type FormPlacement =
    (ObjectId, f64, f64, f64, f64, Option<(f64, f64, f64, f64)>);

fn bad_pdf(message: impl Into<String>) -> EngineError {
    EngineError::new("unreadable_file", message)
}

fn num(value: &Object) -> Option<f64> {
    match value {
        Object::Integer(v) => Some(*v as f64),
        Object::Real(v) => Some(*v as f64),
        _ => None,
    }
}

fn rect_array(rect: [f64; 4]) -> Object {
    Object::Array(rect.into_iter().map(|n| Object::Real(n as f32)).collect())
}

fn normalized_rotation(document: &Document, page_id: ObjectId) -> i32 {
    pages::inherited(document, page_id, b"Rotate")
        .and_then(|value| match value {
            Object::Reference(id) => document.get_object(id).ok().cloned(),
            other => Some(other),
        })
        .and_then(|value| num(&value))
        .map(|value| ((value.round() as i32 % 360) + 360) % 360)
        .unwrap_or(0)
}

fn page_resources(document: &Document, page_id: ObjectId) -> EngineResult<Object> {
    let Some(value) = pages::inherited(document, page_id, b"Resources") else {
        return Ok(Object::Dictionary(Dictionary::new()));
    };
    let mut value = value;
    let mut seen = HashSet::new();
    loop {
        match value {
            Object::Reference(id) => {
                if !seen.insert(id) {
                    return Err(bad_pdf("页面 Resources 引用形成循环"));
                }
                value = document
                    .get_object(id)
                    .map_err(|e| bad_pdf(e.to_string()))?
                    .clone();
            }
            other => {
                value = other;
                break;
            }
        }
    }
    if !matches!(value, Object::Dictionary(_)) {
        return Err(bad_pdf("页面 Resources 结构无效"));
    }
    Ok(value)
}

fn append_content(
    document: &Document,
    object: &Object,
    output: &mut Vec<u8>,
    refs: &mut HashSet<ObjectId>,
    depth: usize,
) -> EngineResult<()> {
    if depth > 64 {
        return Err(bad_pdf("页面 Contents 嵌套过深"));
    }
    match object {
        Object::Reference(id) => {
            if !refs.insert(*id) {
                return Err(bad_pdf("页面 Contents 引用形成循环"));
            }
            let target = document
                .get_object(*id)
                .map_err(|e| bad_pdf(e.to_string()))?;
            append_content(document, target, output, refs, depth + 1)?;
            refs.remove(id);
        }
        Object::Array(items) => {
            for item in items {
                append_content(document, item, output, refs, depth + 1)?;
            }
        }
        Object::Stream(stream) => {
            let decoded = stream
                .decompressed_content()
                .map_err(|e| bad_pdf(format!("不支持的 PDF 页面内容流：{e}")))?;
            output.extend_from_slice(&decoded);
            output.push(b'\n');
        }
        _ => return Err(bad_pdf("页面 Contents 结构无效")),
    }
    Ok(())
}

fn rotation_matrix(rect: [f64; 4], rotation: i32) -> ([f64; 6], Size) {
    let [x0, y0, x1, y1] = rect;
    let width = x1 - x0;
    let height = y1 - y0;
    match rotation {
        90 => (
            [0.0, -1.0, 1.0, 0.0, -y0, x1],
            Size {
                width: height,
                height: width,
            },
        ),
        180 => ([-1.0, 0.0, 0.0, -1.0, x1, y1], Size { width, height }),
        270 => (
            [0.0, 1.0, -1.0, 0.0, y1, -x0],
            Size {
                width: height,
                height: width,
            },
        ),
        _ => ([1.0, 0.0, 0.0, 1.0, -x0, -y0], Size { width, height }),
    }
}

fn fmt(value: f64) -> String {
    let rounded = if value.abs() < 0.0000005 { 0.0 } else { value };
    format!("{rounded:.6}")
}

pub(in crate::tools::pdf_extra) fn make_form(
    document: &mut Document,
    page_id: ObjectId,
) -> EngineResult<PlacedPage> {
    let rect = pages::page_rect(document, page_id)?;
    make_form_rect(document, page_id, rect)
}

pub(in crate::tools::pdf_extra) fn make_form_rect(
    document: &mut Document,
    page_id: ObjectId,
    rect: [f64; 4],
) -> EngineResult<PlacedPage> {
    let rotation = normalized_rotation(document, page_id);
    // Page /Rotate is defined in quarter turns. Normalize odd legacy values as
    // the viewer does; the source geometry helper only swaps dimensions at 90/270.
    let rotation = if rotation % 90 == 0 { rotation } else { 0 };
    let (matrix, size) = rotation_matrix(rect, rotation);
    let mut contents = Vec::new();
    if let Ok(page) = document.get_dictionary(page_id) {
        if let Ok(value) = page.get(b"Contents") {
            append_content(document, value, &mut contents, &mut HashSet::new(), 0)?;
        }
    }
    let resources = page_resources(document, page_id)?;
    let mut form_bytes = format!(
        "q {} {} {} {} {} {} cm\n",
        fmt(matrix[0]),
        fmt(matrix[1]),
        fmt(matrix[2]),
        fmt(matrix[3]),
        fmt(matrix[4]),
        fmt(matrix[5])
    )
    .into_bytes();
    form_bytes.extend_from_slice(&contents);
    form_bytes.extend_from_slice(b"\nQ\n");
    let mut dict = Dictionary::new();
    dict.set("Type", Object::Name(b"XObject".to_vec()));
    dict.set("Subtype", Object::Name(b"Form".to_vec()));
    dict.set("FormType", Object::Integer(1));
    dict.set("BBox", rect_array([0.0, 0.0, size.width, size.height]));
    dict.set("Resources", resources);
    if let Ok(group) = document
        .get_dictionary(page_id)
        .and_then(|page| page.get(b"Group"))
    {
        dict.set("Group", group.clone());
    }
    let mut stream = Stream::new(dict, form_bytes);
    stream
        .compress()
        .map_err(|e| bad_pdf(format!("无法压缩页面内容：{e}")))?;
    let form = document.add_object(Object::Stream(stream));
    Ok(PlacedPage { form, size })
}

fn catalog_pages(document: &Document) -> EngineResult<(ObjectId, Dictionary)> {
    let catalog_id = document
        .trailer
        .get(b"Root")
        .and_then(Object::as_reference)
        .map_err(|e| bad_pdf(format!("PDF 缺少 Catalog：{e}")))?;
    let catalog = document
        .get_dictionary(catalog_id)
        .map_err(|e| bad_pdf(e.to_string()))?;
    let pages_id = catalog
        .get(b"Pages")
        .and_then(Object::as_reference)
        .map_err(|e| bad_pdf(format!("PDF 缺少页面树：{e}")))?;
    let pages = document
        .get_dictionary(pages_id)
        .map_err(|e| bad_pdf(e.to_string()))?
        .clone();
    Ok((pages_id, pages))
}

pub(super) fn page_with_forms(
    document: &mut Document,
    pages_id: ObjectId,
    size: Size,
    forms: &[FormPlacement],
    border: bool,
) -> ObjectId {
    let mut xobjects = Dictionary::new();
    let mut content = String::from("q\n");
    for (index, (form, x, y, scale_x, scale_y, _)) in forms.iter().enumerate() {
        let name = format!("Fm{index}");
        xobjects.set(name.as_bytes().to_vec(), Object::Reference(*form));
        content.push_str(&format!(
            "{} 0 0 {} {} {} cm /{} Do\n",
            fmt(*scale_x),
            fmt(*scale_y),
            fmt(*x),
            fmt(*y),
            name
        ));
    }
    if border {
        for (_, _, _, _, _, bounds) in forms {
            if let Some((x, y, width, height)) = bounds {
                content.push_str(&format!(
                    "0.75 0.78 0.83 RG 0.5 w {} {} {} {} re S\n",
                    fmt(*x),
                    fmt(*y),
                    fmt(*width),
                    fmt(*height)
                ));
            }
        }
    }
    content.push_str("Q\n");
    let mut resources = Dictionary::new();
    resources.set("XObject", Object::Dictionary(xobjects));
    let content_id = document.add_object(Stream::new(Dictionary::new(), content.into_bytes()));
    let mut page = Dictionary::new();
    page.set("Type", Object::Name(b"Page".to_vec()));
    page.set("Parent", Object::Reference(pages_id));
    page.set("MediaBox", rect_array([0.0, 0.0, size.width, size.height]));
    page.set("CropBox", rect_array([0.0, 0.0, size.width, size.height]));
    page.set("Resources", Object::Dictionary(resources));
    page.set("Contents", Object::Reference(content_id));
    document.add_object(Object::Dictionary(page))
}

fn replace_page_tree(
    document: &mut Document,
    pages_id: ObjectId,
    mut pages: Dictionary,
    page_ids: &[ObjectId],
) -> EngineResult<()> {
    pages.set("Type", Object::Name(b"Pages".to_vec()));
    pages.set(
        "Kids",
        Object::Array(page_ids.iter().copied().map(Object::Reference).collect()),
    );
    pages.set("Count", Object::Integer(page_ids.len() as i64));
    document.objects.insert(pages_id, Object::Dictionary(pages));
    Ok(())
}

pub(in crate::tools::pdf_extra) fn preset(key: &str) -> Option<Size> {
    match key {
        "a3" => Some(Size {
            width: 841.89,
            height: 1190.55,
        }),
        "a4" => Some(Size {
            width: 595.28,
            height: 841.89,
        }),
        "a5" => Some(Size {
            width: 419.53,
            height: 595.28,
        }),
        "letter" => Some(Size {
            width: 612.0,
            height: 792.0,
        }),
        "legal" => Some(Size {
            width: 612.0,
            height: 1008.0,
        }),
        _ => None,
    }
}

pub(in crate::tools::pdf_extra) fn orient(size: Size, orientation: &str) -> Size {
    match orientation {
        "portrait" if size.width > size.height => Size {
            width: size.height,
            height: size.width,
        },
        "landscape" if size.width < size.height => Size {
            width: size.height,
            height: size.width,
        },
        _ => size,
    }
}

fn render_geometry_name(ctx: &RunContext<'_>, input: &crate::InputFile, suffix: &str) -> String {
    render_name(
        ctx.name_pattern,
        NameContext {
            name: base_name(&input.name),
            tool: suffix,
            index: None,
            total: None,
            range: None,
        },
        "pdf",
    )
}

pub(super) fn add_geometry_pdf(
    ctx: &RunContext<'_>,
    result: &mut ToolResult,
    input: &crate::InputFile,
    suffix: &str,
    bytes: Vec<u8>,
) {
    let name = render_geometry_name(ctx, input, suffix);
    let name = dedupe(name, |candidate| {
        result
            .artifacts
            .iter()
            .any(|artifact| artifact.name == candidate)
    });
    let mut artifact = Artifact::new(name, "pdf", bytes);
    artifact.source_file_id = Some(input.id.clone());
    result.artifacts.push(artifact);
}

pub(in crate::tools::pdf_extra) fn output_document(
    document: &mut Document,
    page_specs: Vec<(Size, Vec<FormPlacement>, bool)>,
) -> EngineResult<Vec<u8>> {
    let (pages_id, pages_root) = catalog_pages(document)?;
    let mut page_ids = Vec::with_capacity(page_specs.len());
    for (size, forms, border) in page_specs {
        page_ids.push(page_with_forms(document, pages_id, size, &forms, border));
    }
    replace_page_tree(document, pages_id, pages_root, &page_ids)?;
    save(document)
}
