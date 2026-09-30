use crate::EngineError;
use base64::Engine as _;
use lopdf::{dictionary, Document, Object, ObjectId, Stream};
use serde_json::Value;
use std::collections::HashMap;
use subsetter::{subset, subset_with_variations, GlyphRemapper, Tag};
use ttf_parser::{Face, GlyphId};

/// One embedded font. CID (Identity-H) fonts carry [`Subset`] state so the
/// glyph set can grow after the font object was created (`extend`); the simple
/// Helvetica fallback is static. Shared by the markup tools and the C3 PDF
/// builders (pdf-to-ofd / ofd-to-pdf / markdown-to-pdf).
#[derive(Clone)]
pub(crate) struct Font {
    pub(crate) resource: String,
    pub(crate) reference: ObjectId,
    pub(crate) glyphs: HashMap<char, u16>,
    pub(crate) widths: HashMap<char, f64>,
    pub(crate) height: f64,
    pub(crate) simple: bool,
    pub(crate) subset: Option<Subset>,
}

/// Everything needed to grow a CID subset after embedding: the font program
/// (for glyph lookups), the glyph ids in cid order and the ids of the objects
/// that encode the subset (CIDToGIDMap, /W, ToUnicode).
#[derive(Clone)]
pub(crate) struct Subset {
    file: Vec<u8>,
    face_index: u32,
    remapper: GlyphRemapper,
    gids: Vec<u16>,
    font_file_id: ObjectId,
    cid_font_id: ObjectId,
    cid_map_id: ObjectId,
    to_unicode_id: ObjectId,
}

impl Font {
    /// Summed advance width in 1000-unit font space (unknown chars default to
    /// the /DW fallback of 1000).
    pub(crate) fn width(&self, text: &str) -> f64 {
        text.chars()
            .map(|c| self.widths.get(&c).copied().unwrap_or(1000.0))
            .sum()
    }

    /// Ensures every char of `text` has a face-measured advance and returns
    /// the summed width in 1000-unit font space. Pure metrics — layout uses
    /// this before any subset extension happens.
    pub(crate) fn face_width(&mut self, text: &str) -> f64 {
        let missing: Vec<char> = if self.subset.is_some() {
            text.chars()
                .filter(|c| !self.widths.contains_key(c))
                .collect()
        } else {
            Vec::new()
        };
        if !missing.is_empty() {
            if let Some(subset) = self.subset.as_ref() {
                if let Ok(face) = Face::parse(&subset.file, subset.face_index) {
                    let upm = face.units_per_em() as f64;
                    for character in missing {
                        let advance = face
                            .glyph_index(character)
                            .and_then(|g| face.glyph_hor_advance(g))
                            .unwrap_or(face.units_per_em());
                        self.widths.insert(character, advance as f64 * 1000.0 / upm);
                    }
                }
            }
        }
        text.chars()
            .map(|c| self.widths.get(&c).copied().unwrap_or(1000.0))
            .sum()
    }

    /// Encodes `text` for the font's encoding, returning the bytes plus the
    /// summed advance in 1000-unit font space.
    pub(crate) fn encoded(&self, text: &str) -> Result<(Vec<u8>, f64), EngineError> {
        let mut out = Vec::with_capacity(text.chars().count() * if self.simple { 1 } else { 2 });
        let mut width = 0.0;
        for character in text.chars() {
            let cid = self.glyphs.get(&character).ok_or_else(|| {
                EngineError::new("bad_request", format!("系统字体不支持字符：{character}"))
            })?;
            if self.simple {
                out.push(*cid as u8);
            } else {
                out.extend_from_slice(&cid.to_be_bytes());
            }
            width += self.widths.get(&character).copied().unwrap_or(1000.0);
        }
        Ok((out, width))
    }

    /// Grows the CID subset so `text` becomes encodable, rewriting the
    /// CIDToGIDMap stream, the /W array and the ToUnicode CMap in place.
    /// Missing glyphs map to gid 0 (`.notdef`) when `notdef` is set — the
    /// pdf-lib subset behavior OFD fonts rely on — and error otherwise.
    pub(crate) fn extend(
        &mut self,
        document: &mut Document,
        text: &str,
        notdef: bool,
    ) -> Result<(), EngineError> {
        if self.subset.is_none() || text.is_empty() {
            return Ok(());
        }
        let additions = {
            let subset = self.subset.as_ref().expect("subset exists");
            let face = Face::parse(&subset.file, subset.face_index)
                .map_err(|_| EngineError::new("unsupported", "系统字体文件格式无效"))?;
            let upm = face.units_per_em() as f64;
            let mut additions: Vec<(char, u16, f64)> = Vec::new();
            for character in text.chars() {
                if self.glyphs.contains_key(&character) {
                    continue;
                }
                let glyph_id = face
                    .glyph_index(character)
                    .map(|g| g.0)
                    .or_else(|| notdef.then_some(0))
                    .ok_or_else(|| EngineError::new("unsupported", "系统字体缺少文本所需字形"))?;
                let advance = face
                    .glyph_hor_advance(GlyphId(glyph_id))
                    .unwrap_or(face.units_per_em());
                additions.push((character, glyph_id, advance as f64 * 1000.0 / upm));
            }
            additions
        };
        let (cid_font_id, cid_map_id, unicode_id) = {
            let font_subset = self.subset.as_mut().expect("subset exists");
            for (character, glyph_id, width) in additions {
                // A repeated character inside one extension batch is added once.
                if self.glyphs.contains_key(&character) {
                    continue;
                }
                let cid = (self.glyphs.len() + 1) as u16;
                self.glyphs.insert(character, cid);
                self.widths.insert(character, width);
                let subset_gid = font_subset.remapper.remap(glyph_id);
                font_subset.gids.push(subset_gid);
            }
            // The stored font program is a subset; re-subset it so the newly
            // added glyphs have outlines in the embedded file.
            let face = Face::parse(&font_subset.file, font_subset.face_index)
                .map_err(|_| EngineError::new("unsupported", "系统字体文件格式无效"))?;
            let has_variations = face.variation_axes().len() > 0;
            let program = if has_variations {
                subset_with_variations(
                    &font_subset.file,
                    font_subset.face_index,
                    &[(Tag::new(b"wght"), 400.0)],
                    &font_subset.remapper,
                )
            } else {
                subset(
                    &font_subset.file,
                    font_subset.face_index,
                    &font_subset.remapper,
                )
            };
            let program = program.unwrap_or_else(|_| font_subset.file.clone());
            let program_len = program.len();
            if let Ok(Object::Stream(stream)) = document.get_object_mut(font_subset.font_file_id) {
                stream.set_content(program);
                stream.dict.set("Length1", program_len as i64);
            }
            (
                font_subset.cid_font_id,
                font_subset.cid_map_id,
                font_subset.to_unicode_id,
            )
        };
        // The CID map tracks one subset GID per entry (plus .notdef) — the
        // same count the extension loop pushed.
        // CID map entry count == pushed subset GIDs (+ .notdef slot 0).
        let cid_count = {
            let subset = self.subset.as_ref().expect("subset exists");
            subset.gids.len()
        };
        let mut cid_map = vec![0u8; (cid_count + 1) * 2];
        {
            let font_subset = self.subset.as_ref().expect("subset exists");
            for (index, gid) in font_subset.gids.iter().enumerate() {
                cid_map[(index + 1) * 2..(index + 2) * 2].copy_from_slice(&gid.to_be_bytes());
            }
        }
        let max_cid = self.glyphs.values().copied().max().unwrap_or(0);
        let mut width_array = vec![Object::Integer(1000); max_cid as usize];
        for (character, cid) in self.glyphs.iter() {
            width_array[*cid as usize - 1] = Object::Integer(
                self.widths
                    .get(character)
                    .copied()
                    .unwrap_or(1000.0)
                    .round() as i64,
            );
        }
        let cmap = to_unicode(&self.glyphs);
        if let Ok(Object::Stream(stream)) = document.get_object_mut(cid_map_id) {
            stream.content = cid_map;
        }
        if let Ok(Object::Dictionary(dict)) = document.get_object_mut(cid_font_id) {
            dict.set(
                "W",
                Object::Array(vec![Object::Integer(1), Object::Array(width_array)]),
            );
        }
        if let Ok(Object::Stream(stream)) = document.get_object_mut(unicode_id) {
            stream.content = cmap.into_bytes();
        }
        Ok(())
    }
}

/// One host-discovered system font (a `runtimeData.systemFonts` entry).
#[derive(Clone, Debug)]
pub(crate) struct HostFont {
    pub(crate) name: String,
    pub(crate) bytes: Vec<u8>,
}

/// Ported `systemFontForText`: the first resource with any face covering all
/// non-whitespace code points of `text` (faces iterated for TTC collections).
pub(crate) fn covering_host_font<'a>(
    fonts: &'a [HostFont],
    text: &str,
) -> Option<(&'a HostFont, u32)> {
    let code_points = content_code_points(text);
    for font in fonts {
        for face_index in 0..face_count(&font.bytes) as u32 {
            if face_covers(&font.bytes, face_index, &code_points) {
                return Some((font, face_index));
            }
        }
    }
    None
}

/// Number of faces in a font program (TTC collections expose several).
pub(crate) fn face_count(bytes: &[u8]) -> usize {
    ttf_parser::fonts_in_collection(bytes).unwrap_or(1).max(1) as usize
}

/// True when the face has a glyph for every given code point.
pub(crate) fn face_covers(bytes: &[u8], face_index: u32, code_points: &[char]) -> bool {
    let Ok(face) = Face::parse(bytes, face_index) else {
        return false;
    };
    code_points.iter().all(|c| face.glyph_index(*c).is_some())
}

/// Unique non-whitespace (JavaScript `\s`) code points, first-seen order.
pub(crate) fn content_code_points(text: &str) -> Vec<char> {
    let mut out: Vec<char> = Vec::new();
    for character in text.chars() {
        if is_js_whitespace(character) || out.contains(&character) {
            continue;
        }
        out.push(character);
    }
    out
}

fn is_js_whitespace(char: char) -> bool {
    matches!(
        char,
        '\u{09}'..='\u{0d}'
            | '\u{20}'
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// The markup tools' entry point (behavior preserved exactly): an ASCII sample
/// takes the simple Helvetica, anything else needs a covering system font.
pub(crate) fn embed(
    document: &mut Document,
    runtime: Option<&Value>,
    sample: &str,
) -> Result<Font, EngineError> {
    if sample.is_ascii() {
        let reference = document.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica", "Encoding" => "WinAnsiEncoding" });
        let mut glyphs = HashMap::new();
        let mut widths = HashMap::new();
        for character in (32u8..=126).map(char::from) {
            glyphs.insert(character, character as u16);
            widths.insert(character, helvetica_width(character));
        }
        return Ok(Font {
            resource: "FMark".into(),
            reference,
            glyphs,
            widths,
            height: 1100.0,
            simple: true,
            subset: None,
        });
    }
    let resources = runtime
        .and_then(|v| v.get("systemFonts"))
        .and_then(Value::as_array)
        .ok_or_else(|| {
            EngineError::new("unsupported", "当前运行环境未提供系统字体，无法处理此文本")
        })?;
    let mut selected = None;
    for item in resources {
        let Some(name) = item.get("name").and_then(Value::as_str) else {
            continue;
        };
        let Some(bytes) = item
            .get("bytes")
            .and_then(byte_array)
            .or_else(|| item.get("bytesBase64").and_then(byte_array))
        else {
            continue;
        };
        let Ok(face) = Face::parse(&bytes, 0) else {
            continue;
        };
        let chars: Vec<char> = sample.chars().collect();
        if chars.iter().all(|c| face.glyph_index(*c).is_some()) {
            selected = Some((name.to_owned(), bytes));
            break;
        }
    }
    let (name, bytes) = selected.ok_or_else(|| {
        EngineError::new(
            "unsupported",
            "没有可覆盖全部文字的系统字体，无法嵌入 CJK 字形",
        )
    })?;
    embed_face(document, &name, &bytes, 0, sample, "FMark")
}

/// Embeds one face of a font program as a CIDFontType2 subset pre-loaded with
/// the sample's glyphs (plus digits and punctuation, as the TS engine does).
pub(crate) fn embed_face(
    document: &mut Document,
    name: &str,
    bytes: &[u8],
    face_index: u32,
    sample: &str,
    resource: &str,
) -> Result<Font, EngineError> {
    let face = Face::parse(bytes, face_index)
        .map_err(|_| EngineError::new("unsupported", "系统字体文件格式无效"))?;
    let upm = face.units_per_em() as f64;
    let chars: Vec<char> = sample.chars().chain("0123456789-.".chars()).collect();
    let mut remapper = GlyphRemapper::new();
    let mut glyphs = HashMap::new();
    let mut gids = Vec::new();
    let mut widths = HashMap::new();
    for character in chars {
        if glyphs.contains_key(&character) {
            continue;
        }
        let glyph: GlyphId = face
            .glyph_index(character)
            .ok_or_else(|| EngineError::new("unsupported", "系统字体缺少文本所需字形"))?;
        let cid = (glyphs.len() + 1) as u16;
        glyphs.insert(character, cid);
        let subset_gid = remapper.remap(glyph.0);
        gids.push(subset_gid);
        let advance = face.glyph_hor_advance(glyph).unwrap_or(face.units_per_em());
        widths.insert(character, advance as f64 * 1000.0 / upm);
    }
    // Subset the font program to the glyphs actually used (and instantiate
    // variable fonts to their default weight) so a 17 MB CJK font does not
    // end up inside every output PDF. Falls back to the full program if the
    // subsetter cannot handle the face.
    let has_variations = face.variation_axes().len() > 0;
    let font_program = if has_variations {
        subset_with_variations(bytes, face_index, &[(Tag::new(b"wght"), 400.0)], &remapper)
    } else {
        subset(bytes, face_index, &remapper)
    };
    let font_bytes: Vec<u8> = font_program.unwrap_or_else(|_| bytes.to_vec());
    let base_name = pdf_name(name);
    let font_file = document.add_object(Stream::new(
        dictionary! { "Length1" => font_bytes.len() as i64 },
        font_bytes,
    ));
    let bounds = face.global_bounding_box();
    let scale = |v: i16| (v as f64 * 1000.0 / upm).round() as i64;
    let descriptor = document.add_object(dictionary! {
        "Type" => "FontDescriptor", "FontName" => Object::Name(base_name.as_bytes().to_vec()),
        "Flags" => 4, "FontBBox" => Object::Array(vec![scale(bounds.x_min), scale(bounds.y_min), scale(bounds.x_max), scale(bounds.y_max)].into_iter().map(Object::Integer).collect()),
        "ItalicAngle" => 0, "Ascent" => scale(face.ascender()), "Descent" => scale(face.descender()),
        "CapHeight" => scale(face.capital_height().unwrap_or(face.ascender())), "StemV" => 80,
        "FontFile2" => Object::Reference(font_file),
    });
    let mut cid_map = vec![0u8; (glyphs.len() + 1) * 2];
    for (index, gid) in gids.iter().enumerate() {
        cid_map[(index + 1) * 2..(index + 2) * 2].copy_from_slice(&gid.to_be_bytes());
    }
    let cid_map_ref = document.add_object(Stream::new(dictionary! {}, cid_map));
    let width_values = glyphs.iter().collect::<Vec<_>>();
    let max_cid = width_values.iter().map(|(_, cid)| **cid).max().unwrap_or(0);
    let mut width_array = vec![Object::Integer(1000); max_cid as usize];
    for (character, cid) in &width_values {
        width_array[**cid as usize - 1] =
            Object::Integer(widths.get(character).copied().unwrap_or(1000.0).round() as i64);
    }
    let cid_font = document.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "CIDFontType2", "BaseFont" => Object::Name(base_name.as_bytes().to_vec()),
        "CIDSystemInfo" => dictionary! { "Registry" => "Adobe", "Ordering" => "Identity", "Supplement" => 0 },
        "FontDescriptor" => Object::Reference(descriptor), "DW" => 1000,
        "W" => vec![Object::Integer(1), Object::Array(width_array)], "CIDToGIDMap" => Object::Reference(cid_map_ref),
    });
    let to_unicode = to_unicode(&glyphs);
    let unicode_ref = document.add_object(Stream::new(dictionary! {}, to_unicode.into_bytes()));
    let reference = document.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "Type0", "BaseFont" => Object::Name(base_name.as_bytes().to_vec()),
        "Encoding" => "Identity-H", "DescendantFonts" => vec![Object::Reference(cid_font)],
        "ToUnicode" => Object::Reference(unicode_ref),
    });
    let height = (face.ascender() - face.descender()) as f64 * 1000.0 / upm;
    Ok(Font {
        resource: resource.to_owned(),
        reference,
        glyphs,
        widths,
        height,
        simple: false,
        subset: Some(Subset {
            file: bytes.to_vec(),
            face_index,
            remapper: remapper.clone(),
            gids,
            font_file_id: font_file,
            cid_font_id: cid_font,
            cid_map_id: cid_map_ref,
            to_unicode_id: unicode_ref,
        }),
    })
}

fn helvetica_width(c: char) -> f64 {
    const WIDTHS: [u16; 95] = [
        278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556,
        556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722,
        722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722,
        667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556,
        556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
        500, 334, 260, 334, 584,
    ];
    let code = c as usize;
    if (32..=126).contains(&code) {
        WIDTHS[code - 32] as f64
    } else {
        556.0
    }
}

fn byte_array(value: &Value) -> Option<Vec<u8>> {
    if let Some(encoded) = value.as_str() {
        return base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .ok();
    }
    value.as_array().map(|items| {
        items
            .iter()
            .filter_map(Value::as_u64)
            .map(|v| v as u8)
            .collect()
    })
}

fn pdf_name(name: &str) -> String {
    let clean: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(50)
        .collect();
    format!("PoTools{}", if clean.is_empty() { "Font" } else { &clean })
}

fn to_unicode(glyphs: &HashMap<char, u16>) -> String {
    let mut cmap = String::from("/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n");
    let mut entries: Vec<_> = glyphs.iter().collect();
    entries.sort_by_key(|(_, cid)| **cid);
    for chunk in entries.chunks(100) {
        cmap.push_str(&format!("{} beginbfchar\n", chunk.len()));
        for (character, cid) in chunk {
            let mut utf16 = [0u16; 2];
            let encoded = character.encode_utf16(&mut utf16);
            let destination: String = encoded.iter().map(|unit| format!("{unit:04X}")).collect();
            cmap.push_str(&format!("<{:04X}> <{}>\n", **cid, destination));
        }
        cmap.push_str("endbfchar\n");
    }
    cmap.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend");
    cmap
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_code_points_dedupe_and_skip_whitespace() {
        assert_eq!(content_code_points("a b a\u{3000}c"), vec!['a', 'b', 'c']);
        assert_eq!(content_code_points(" \u{a0}"), Vec::<char>::new());
    }

    #[test]
    fn face_count_handles_single_fonts() {
        assert_eq!(face_count(&[]), 1);
    }
}
