//! Image placement rects ported from `lib/pagedata.ts` (`pageImageRects`,
//! `rectFromCtm`, `toVisualRect`) onto lopdf. Per page: collect image XObject
//! resource names (Subtype `/Image`, skipping `ImageMask`, walking inherited
//! `Resources` up the Pages tree), tokenize the decoded content streams,
//! simulate the `q`/`Q`/`cm` CTM stack, and record the unit square of every
//! `Do` that names a known image. Rects below 18×18 pt are dropped, then the
//! survivors are folded into visual (top-left origin) space.
//!
//! Consumed by the `pdfImageRects` wasm export; the browser adapter crops the
//! regions out of PDF.js renders.

use crate::EngineError;
use lopdf::{Document, Object};
use serde::Serialize;
use std::collections::HashSet;

/// A rectangle in user space (`x`/`y` bottom-left after normalization) or
/// visual space (`x`/`y` top-left, set by [`to_visual_rect`]), in points.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// One page's visual-space image rects, as served to the adapter.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageImageRects {
    page: u32,
    width: f64,
    height: f64,
    rotation: u32,
    /// `[x, y, w, h]` in visual space (top-left origin), points.
    rects: Vec<[f64; 4]>,
}

/// Full reply of the `pdfImageRects` export.
#[derive(Serialize)]
pub struct PdfImageRectsDocument {
    pages: Vec<PageImageRects>,
}

/// Computes the visual-space image rects for every page of `bytes`.
pub(crate) fn pdf_image_rects_document(bytes: &[u8]) -> Result<PdfImageRectsDocument, EngineError> {
    let document = load_document(bytes)?;
    let pages = document
        .get_pages()
        .into_iter()
        .map(|(index, page_id)| {
            let (width, height, rotation) = page_geometry(&document, page_id);
            let rects = page_image_rects(&document, page_id)
                .into_iter()
                .map(|rect| {
                    let visual = to_visual_rect(rect, width, height, rotation);
                    [visual.x, visual.y, visual.w, visual.h]
                })
                .collect();
            PageImageRects {
                page: index,
                width: if rotation % 180 == 90 { height } else { width },
                height: if rotation % 180 == 90 { width } else { height },
                rotation,
                rects,
            }
        })
        .collect();
    Ok(PdfImageRectsDocument { pages })
}

fn pdf_load_error(message: impl std::fmt::Display) -> EngineError {
    let message = message.to_string();
    if message.to_ascii_lowercase().contains("encrypt")
        || message.to_ascii_lowercase().contains("password")
    {
        EngineError::new(
            "encrypted_document",
            format!("PDF 受密码保护，无法读取：{message}"),
        )
    } else {
        EngineError::new("unreadable_file", format!("无法读取 PDF：{message}"))
    }
}

fn load_document(bytes: &[u8]) -> Result<Document, EngineError> {
    Document::load_mem(bytes).map_err(pdf_load_error)
}

/// MediaBox size plus the normalized `/Rotate` angle, both inherited up the
/// page tree (TS `pageBoxOf` + `normalizeAngle` of the page rotation).
fn page_geometry(document: &Document, page_id: lopdf::ObjectId) -> (f64, f64, u32) {
    let media = inherited_object(document, page_id, b"MediaBox")
        .and_then(|object| numbers_of(document, &object))
        .unwrap_or([0.0; 4]);
    let (x0, y0, x1, y1) = (media[0], media[1], media[2], media[3]);
    let rotation = inherited_object(document, page_id, b"Rotate")
        .and_then(|object| resolve(document, &object).cloned())
        .and_then(|object| match object {
            Object::Integer(value) => Some(value as f64),
            Object::Real(value) => Some(value as f64),
            _ => None,
        })
        .unwrap_or(0.0);
    let rotation = (((rotation.round() as i64) % 360) + 360).rem_euclid(360) as u32;
    (x1 - x0, y1 - y0, rotation)
}

/// Reads the four numbers of a rectangle object (direct array or reference).
fn numbers_of(document: &Document, object: &Object) -> Option<[f64; 4]> {
    let resolved = resolve(document, object)?;
    let values = resolved.as_array().ok()?;
    if values.len() != 4 {
        return None;
    }
    let mut out = [0.0; 4];
    for (index, value) in values.iter().enumerate() {
        out[index] = match resolve(document, value)? {
            Object::Integer(number) => *number as f64,
            Object::Real(number) => *number as f64,
            _ => return None,
        };
    }
    Some(out)
}

fn resolve<'a>(document: &'a Document, object: &'a Object) -> Option<&'a Object> {
    match object {
        Object::Reference(id) => document.objects.get(id),
        other => Some(other),
    }
}

/// Walks the page tree upward for an inherited key (TS `inheritedResources`).
fn inherited_object(document: &Document, page_id: lopdf::ObjectId, key: &[u8]) -> Option<Object> {
    let mut current = page_id;
    let mut seen = Vec::new();
    while !seen.contains(&current) {
        seen.push(current);
        let dictionary = document.get_dictionary(current).ok()?;
        if let Ok(value) = dictionary.get(key) {
            return Some(value.clone());
        }
        current = dictionary
            .get(b"Parent")
            .ok()
            .and_then(|parent| parent.as_reference().ok())?;
    }
    None
}

/// Collects the image XObject resource names (without the leading `/`) for a
/// page, following inherited `Resources` up the Pages tree. Image masks are
/// skipped, matching the TS `imageResourceNames`.
fn image_resource_names(document: &Document, page_id: lopdf::ObjectId) -> HashSet<String> {
    fn as_dictionary<'a>(
        document: &'a Document,
        object: &'a Object,
    ) -> Option<&'a lopdf::Dictionary> {
        resolve(document, object).and_then(|resolved| resolved.as_dict().ok())
    }
    let mut found = HashSet::new();
    let Some(resources) = inherited_object(document, page_id, b"Resources") else {
        return found;
    };
    let Some(resources) = as_dictionary(document, &resources) else {
        return found;
    };
    let Ok(xobject) = resources.get(b"XObject") else {
        return found;
    };
    let Some(xobject) = as_dictionary(document, xobject) else {
        return found;
    };
    for (name, value) in xobject.iter() {
        let Some(stream) = resolve(document, value).and_then(|resolved| resolved.as_stream().ok())
        else {
            continue;
        };
        let is_image = matches!(
            stream.dict.get(b"Subtype"),
            Ok(Object::Name(name)) if name.as_slice() == b"Image"
        );
        if !is_image {
            continue;
        }
        if matches!(stream.dict.get(b"ImageMask"), Ok(Object::Boolean(true))) {
            continue;
        }
        found.insert(String::from_utf8_lossy(name).into_owned());
    }
    found
}

/// Ported `pageImageRects` for one page: content-stream simulation over the
/// decoded streams, then normalize, the 18 pt floor and no rotation yet.
pub(crate) fn page_image_rects(document: &Document, page_id: lopdf::ObjectId) -> Vec<Rect> {
    let names = image_resource_names(document, page_id);
    if names.is_empty() {
        return Vec::new();
    }
    let content = page_content_text(document, page_id);
    if content.is_empty() {
        return Vec::new();
    }
    collect_placed_rects(&names, &content)
}

/// Joins the page's decoded content streams with `\n` (TS `contentText`).
fn page_content_text(document: &Document, page_id: lopdf::ObjectId) -> Vec<u8> {
    let mut content = Vec::new();
    for stream_id in document.get_page_contents(page_id) {
        let Ok(stream) = document.get_object(stream_id).and_then(Object::as_stream) else {
            continue;
        };
        let bytes = stream
            .decompressed_content()
            .unwrap_or_else(|_| stream.content.clone());
        if !content.is_empty() {
            content.push(b'\n');
        }
        content.extend_from_slice(&bytes);
    }
    content
}

/// The tokenizer/simulator half of `pageImageRects`, factored out for tests.
fn collect_placed_rects(names: &HashSet<String>, content: &[u8]) -> Vec<Rect> {
    let identity = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
    let mut placed: Vec<Rect> = Vec::new();
    let mut stack: Vec<[f64; 6]> = Vec::new();
    let mut ctm = identity;
    let mut operands: Vec<Operand> = Vec::new();

    for token in tokenize(content) {
        match &token {
            Token::Number(value) => operands.push(Operand::Number(*value)),
            Token::Name(name) => operands.push(Operand::Name(name.clone())),
            Token::Other("q") => stack.push(ctm),
            Token::Other("Q") => ctm = stack.pop().unwrap_or(identity),
            Token::Other("cm") => {
                if operands.len() >= 6 {
                    let tail = &operands[operands.len() - 6..];
                    let values = [
                        number_or_nan(&tail[0]),
                        number_or_nan(&tail[1]),
                        number_or_nan(&tail[2]),
                        number_or_nan(&tail[3]),
                        number_or_nan(&tail[4]),
                        number_or_nan(&tail[5]),
                    ];
                    ctm = multiply(ctm, values);
                }
            }
            Token::Other("Do") => {
                if let Some(Operand::Name(name)) = operands.last() {
                    let name = name.trim_start_matches('/');
                    if names.contains(name) {
                        placed.push(rect_from_ctm(ctm));
                    }
                }
            }
            _ => {}
        }
        if matches!(&token, Token::Other(_) | Token::String) {
            operands.clear();
        }
    }

    placed
        .into_iter()
        .map(|rect| Rect {
            x: rect.x.min(rect.x + rect.w),
            y: rect.y.min(rect.y + rect.h),
            w: rect.w.abs(),
            h: rect.h.abs(),
        })
        .filter(|rect| rect.w >= 18.0 && rect.h >= 18.0)
        .collect()
}

enum Operand {
    Number(f64),
    Name(String),
}

enum Token {
    Number(f64),
    Name(String),
    /// Operators and any other bare token.
    Other(&'static str),
    /// Marker for a skipped literal string (`(...)`); it is not numeric and
    /// not a name, so it clears the operand run like the TS `Number('str')`
    /// NaN fall-through.
    String,
}

/// TS `Number(token)` acceptance: finite numbers only (the literal-string
/// marker and names never parse). Hex/exponent forms that `Number` accepts
/// do not occur in content-stream operands.
fn parse_number(token: &str) -> Option<f64> {
    token.parse::<f64>().ok().filter(|value| value.is_finite())
}

/// Non-numeric `cm` operands coerce to NaN in TS arithmetic; mirror that so
/// the corrupted matrix drops later rects the same way.
fn number_or_nan(operand: &Operand) -> f64 {
    match operand {
        Operand::Number(value) => *value,
        Operand::Name(_) => f64::NAN,
    }
}

/// Tokenizes content into numbers, `/Names`, operators, and literal-string
/// markers; comments, strings, arrays and dict brackets are skipped.
fn tokenize(content: &[u8]) -> Vec<Token> {
    fn is_delimiter(byte: u8) -> bool {
        matches!(byte, b'<' | b'>' | b'(' | b')' | b'[' | b']')
    }
    fn is_name_end(byte: u8) -> bool {
        byte.is_ascii_whitespace()
            || byte == 0xa0
            || matches!(
                byte,
                b'<' | b'>' | b'(' | b')' | b'[' | b']' | b'{' | b'}' | b'%' | b'/'
            )
    }
    fn is_token_end(byte: u8) -> bool {
        byte.is_ascii_whitespace()
            || byte == 0xa0
            || matches!(byte, b'<' | b'>' | b'[' | b']' | b'(' | b')' | b'/')
    }
    let mut tokens: Vec<Token> = Vec::new();
    let mut index = 0usize;
    while index < content.len() {
        let byte = content[index];
        if byte == b'%' {
            while index < content.len() && content[index] != b'\n' {
                index += 1;
            }
            continue;
        }
        if byte == b'(' {
            let mut depth = 1usize;
            index += 1;
            while index < content.len() && depth > 0 {
                let current = content[index];
                if current == b'\\' {
                    index += 1;
                } else if current == b'(' {
                    depth += 1;
                } else if current == b')' {
                    depth -= 1;
                }
                index += 1;
            }
            tokens.push(Token::String);
            continue;
        }
        if is_delimiter(byte) {
            index += 1;
            continue;
        }
        if byte.is_ascii_whitespace() || byte == 0xa0 {
            index += 1;
            continue;
        }
        if byte == b'/' {
            let mut end = index + 1;
            while end < content.len() && !is_name_end(content[end]) {
                end += 1;
            }
            tokens.push(Token::Name(
                String::from_utf8_lossy(&content[index..end]).into_owned(),
            ));
            index = end;
            continue;
        }
        let mut end = index;
        while end < content.len() && !is_token_end(content[end]) {
            end += 1;
        }
        if end == index {
            end += 1;
        }
        let text = String::from_utf8_lossy(&content[index..end]).into_owned();
        tokens.push(match parse_number(&text) {
            Some(value) => Token::Number(value),
            None => Token::Other(known_operator(&text)),
        });
        index = end;
    }
    tokens
}

/// interned operator tag (the simulator only ever compares against fixed
/// operators; anything else is an inert `Other`).
fn known_operator(text: &str) -> &'static str {
    match text {
        "q" => "q",
        "Q" => "Q",
        "cm" => "cm",
        "Do" => "Do",
        _ => "",
    }
}

/// TS `multiply`: `a * b` for the 3×2 augmented matrices.
fn multiply(a: [f64; 6], b: [f64; 6]) -> [f64; 6] {
    [
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5],
    ]
}

/// TS `rectFromCtm`: the unit square of an image XObject mapped through the
/// current matrix.
fn rect_from_ctm(m: [f64; 6]) -> Rect {
    let corners = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
    let mut xs = [0.0; 4];
    let mut ys = [0.0; 4];
    for (index, corner) in corners.iter().enumerate() {
        xs[index] = m[0] * corner[0] + m[2] * corner[1] + m[4];
        ys[index] = m[1] * corner[0] + m[3] * corner[1] + m[5];
    }
    let min_x = xs.iter().cloned().fold(f64::INFINITY, f64::min);
    let min_y = ys.iter().cloned().fold(f64::INFINITY, f64::min);
    Rect {
        x: min_x,
        y: min_y,
        w: xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max) - min_x,
        h: ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max) - min_y,
    }
}

/// TS `toVisualRect`: folds a user-space rectangle into the visual (top-left
/// origin) space that MuPDF renders and structured text reports in.
pub(crate) fn to_visual_rect(rect: Rect, width: f64, height: f64, rotation: u32) -> Rect {
    match rotation % 360 {
        90 => Rect {
            x: rect.y,
            y: width - (rect.x + rect.w),
            w: rect.h,
            h: rect.w,
        },
        180 => Rect {
            x: width - (rect.x + rect.w),
            y: height - (rect.y + rect.h),
            w: rect.w,
            h: rect.h,
        },
        270 => Rect {
            x: height - (rect.y + rect.h),
            y: rect.x,
            w: rect.h,
            h: rect.w,
        },
        _ => Rect {
            x: rect.x,
            y: height - (rect.y + rect.h),
            w: rect.w,
            h: rect.h,
        },
    }
}

#[cfg(test)]
mod tests;
