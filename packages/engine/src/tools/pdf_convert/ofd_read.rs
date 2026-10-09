//! OFD package reader, ported from `lib/ofd.ts` `readOfd` (fast-xml-parser
//! tree walk → quick-xml event tree): `OFD.xml` → doc root, resource
//! directory, fonts/multimedia registries, then per-page geometry (page box
//! from `Page.xml` else the document box), image placements and text objects
//! (bounds + optional per-code offset, font resolved through the ID map).
//! Geometry is returned in points after one `mmToPt` pass — the TS output
//! contract, quirk included.

use super::ofd::mm_to_pt;
use crate::EngineError;
use quick_xml::events::Event;
use quick_xml::Reader;
use quick_xml::XmlVersion;
use std::collections::HashMap;
use std::io::Read as _;
use zip::ZipArchive;

type EngineResult<T> = Result<T, EngineError>;

/// A parsed XML element with namespace prefixes stripped (the TS
/// `removeNSPrefix`), direct text accumulated and attributes kept in order.
pub(crate) struct XmlNode {
    pub name: String,
    attrs: Vec<(String, String)>,
    pub children: Vec<XmlNode>,
    pub text: String,
}

impl XmlNode {
    fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    fn child(&self, name: &str) -> Option<&XmlNode> {
        self.children.iter().find(|node| node.name == name)
    }

    /// TS `asArray(...)` over a possibly-repeated element.
    fn children_of<'a>(&'a self, name: &str) -> Vec<&'a XmlNode> {
        self.children
            .iter()
            .filter(|node| node.name == name)
            .collect()
    }

    /// `Number(attr ?? fallback)` over string attributes.
    fn number(&self, name: &str, fallback: f64) -> f64 {
        match self.attr(name) {
            Some(value) => parse_js_number(value),
            None => fallback,
        }
    }
}

/// TS `Number()`: empty string → 0, junk → NaN.
fn parse_js_number(value: &str) -> f64 {
    let text = value.trim();
    if text.is_empty() {
        return 0.0;
    }
    text.parse::<f64>().unwrap_or(f64::NAN)
}

/// TS `value || fallback` on a numeric parse: 0 and NaN fall through.
fn or_default(value: f64, fallback: f64) -> f64 {
    if value == 0.0 || value.is_nan() {
        fallback
    } else {
        value
    }
}

/// The document's root element, or a named child of it (fast-xml-parser
/// lookups like `.OFD` work either way).
fn element(node: Option<XmlNode>, name: &str) -> Option<XmlNode> {
    match node {
        Some(top) if top.name == name => Some(top),
        Some(top) => top.children.into_iter().find(|child| child.name == name),
        None => None,
    }
}

fn text_of(node: Option<&XmlNode>) -> String {
    node.map(|node| node.text.trim().to_owned())
        .unwrap_or_default()
}

/// TS `boxOf`: whitespace split, numeric coercion, always four values.
fn box_of(node: Option<&XmlNode>) -> [f64; 4] {
    let mut values = [0.0f64; 4];
    for (index, token) in text_of(node).split_whitespace().take(4).enumerate() {
        values[index] = or_default(parse_js_number(token), 0.0);
    }
    values
}

/// Parses one XML document; `None` when it is empty or unreadable (the TS
/// parser yields an empty object in those cases, which the lookups tolerate).
fn parse_xml(content: &str) -> Option<XmlNode> {
    if content.trim().is_empty() {
        return None;
    }
    let mut reader = Reader::from_str(content);
    reader.config_mut().trim_text(true);
    let mut stack: Vec<XmlNode> = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(start)) => {
                stack.push(XmlNode {
                    name: start.name().local_name().into_inner().to_owned(),
                    attrs: attributes(&start),
                    children: Vec::new(),
                    text: String::new(),
                });
            }
            Ok(Event::Empty(start)) => {
                let node = XmlNode {
                    name: start.name().local_name().into_inner().to_owned(),
                    attrs: attributes(&start),
                    children: Vec::new(),
                    text: String::new(),
                };
                stack.last_mut()?.children.push(node);
            }
            Ok(Event::Text(text)) => {
                let decoded = text.xml_content(XmlVersion::Implicit1_0).to_string();
                if let Some(top) = stack.last_mut() {
                    top.text.push_str(&decoded);
                }
            }
            Ok(Event::End(_)) => {
                let node = stack.pop()?;
                match stack.last_mut() {
                    Some(parent) => parent.children.push(node),
                    None => return Some(node),
                }
            }
            Ok(Event::Eof) => return None,
            Err(_) => return None,
            _ => {}
        }
    }
}

fn attributes(start: &quick_xml::events::BytesStart<'_>) -> Vec<(String, String)> {
    start
        .attributes()
        .filter_map(|attr| attr.ok())
        .map(|attr| {
            (
                attr.key.local_name().into_inner().to_owned(),
                attr.normalized_value(XmlVersion::Implicit1_0)
                    .unwrap_or_default()
                    .to_string(),
            )
        })
        .collect()
}

pub(crate) struct ReadText {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub size: f64,
    /// Per-char advance in points (parsed for contract parity; the PDF
    /// renderer draws the whole string and never consumes it).
    #[allow(dead_code)]
    pub advance: f64,
    pub font: Option<String>,
}

pub(crate) struct ReadImage {
    pub bytes: Vec<u8>,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub(crate) struct ReadPage {
    pub width: f64,
    pub height: f64,
    pub texts: Vec<ReadText>,
    pub images: Vec<ReadImage>,
}

pub(crate) struct OfdDoc {
    pub pages: Vec<ReadPage>,
    /// Package fonts in document order: `(resource file name, bytes)`.
    pub fonts: Vec<(String, Vec<u8>)>,
}

/// Decompression budget for one OFD package.
///
/// An OFD is a zip, so a small file can expand to an arbitrary size ("zip
/// bomb"). Every entry read is capped individually *and* charged against a
/// package-wide budget, which mirrors the decode limits the rest of the engine
/// enforces before allocating.
const MAX_OFD_ENTRIES: usize = 4_096;
const MAX_OFD_ENTRY_BYTES: u64 = 64 * 1024 * 1024;
const MAX_OFD_TOTAL_BYTES: u64 = 256 * 1024 * 1024;

/// Reads at most `limit` bytes. Returns `None` when the source yields more than
/// `limit` — i.e. when the zip header's declared size lied — or fails mid-read.
fn read_entry_bounded<R: std::io::Read>(reader: R, limit: u64) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    reader.take(limit + 1).read_to_end(&mut out).ok()?;
    if out.len() as u64 > limit {
        return None;
    }
    Some(out)
}

/// Reads the OFD zip into page geometry, text runs and images. Invalid zip →
/// `unreadable_file` with the TS `error.notOfd` hint.
pub(crate) fn read_ofd(bytes: &[u8]) -> EngineResult<OfdDoc> {
    let mut archive = ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|_| {
        EngineError::new("unreadable_file", "文件不是有效的 OFD 包").with_hint("error.notOfd")
    })?;
    if archive.len() > MAX_OFD_ENTRIES {
        return Err(
            EngineError::new("unsupported", "OFD 包内条目过多，已拒绝处理")
                .with_hint("error.notOfd"),
        );
    }
    let remaining = std::cell::Cell::new(MAX_OFD_TOTAL_BYTES);

    // Returns `None` when the entry is missing, oversized, or would exceed the
    // remaining package budget.
    let load = |archive: &mut ZipArchive<_>, path: &str| -> Option<Vec<u8>> {
        let limit = remaining.get().min(MAX_OFD_ENTRY_BYTES);
        if limit == 0 {
            return None;
        }
        for candidate in [path.to_owned(), path.replace('\\', "/")] {
            let Ok(entry) = archive.by_name(&candidate) else {
                continue;
            };
            // The declared size is attacker-controlled, but it is still worth
            // rejecting outright before decompressing anything.
            if entry.size() > limit {
                return None;
            }
            // Read one byte past the limit so a lying declared size is caught
            // instead of silently truncating into a "valid" document.
            let out = read_entry_bounded(entry, limit)?;
            remaining.set(remaining.get() - out.len() as u64);
            return Some(out);
        }
        None
    };
    let read = |archive: &mut ZipArchive<_>, path: &str| -> String {
        match load(archive, path) {
            Some(bytes) => String::from_utf8(bytes).unwrap_or_default(),
            None => String::new(),
        }
    };
    let read_bytes =
        |archive: &mut ZipArchive<_>, path: &str| -> Option<Vec<u8>> { load(archive, path) };

    let root = element(parse_xml(&read(&mut archive, "OFD.xml")), "OFD");
    let body = root.as_ref().and_then(|ofd| ofd.child("DocBody"));
    let doc_root = {
        let value = text_of(body.and_then(|body| body.child("DocRoot")));
        if value.is_empty() {
            "Document.xml".to_owned()
        } else {
            value
        }
    };
    let base_path = match doc_root.rfind('/') {
        Some(index) => doc_root[..index].to_owned(),
        None => String::new(),
    };
    let document = element(parse_xml(&read(&mut archive, &doc_root)), "Document");
    let common = document.as_ref().and_then(|node| node.child("CommonData"));
    let doc_box = box_of(
        common
            .and_then(|node| node.child("PageArea"))
            .and_then(|node| node.child("PhysicalBox")),
    );
    let res_path = text_of(common.and_then(|node| node.child("DocumentRes")));
    let res_dir = if res_path.is_empty() {
        String::new()
    } else {
        format!("{base_path}/{res_path}")
    };
    let res_base = match res_dir.rfind('/') {
        Some(index) => res_dir[..index].to_owned(),
        None => String::new(),
    };
    let res = element(parse_xml(&read(&mut archive, &res_dir)), "Res");

    let mut fonts: Vec<(String, Vec<u8>)> = Vec::new();
    let mut font_ids: HashMap<u64, String> = HashMap::new();
    if let Some(fonts_node) = res.as_ref().and_then(|node| node.child("Fonts")) {
        for font in fonts_node.children_of("Font") {
            let file = text_of(font.child("FontFile"));
            if file.is_empty() {
                continue;
            }
            let Some(data) = read_bytes(&mut archive, &format!("{res_base}/{file}")) else {
                continue;
            };
            let name = file.rsplit('/').next().unwrap_or(&file).to_owned();
            if let Ok(id) = font.attr("ID").unwrap_or("").trim().parse::<u64>() {
                font_ids.insert(id, name.clone());
            }
            fonts.push((name, data));
        }
    }
    let mut media: HashMap<u64, String> = HashMap::new();
    if let Some(medias) = res.as_ref().and_then(|node| node.child("MultiMedias")) {
        for item in medias.children_of("MultiMedia") {
            let file = text_of(item.child("MediaFile"));
            if !file.is_empty() {
                if let Ok(id) = item.attr("ID").unwrap_or("").trim().parse::<u64>() {
                    media.insert(id, file);
                }
            }
        }
    }

    let mut page_entries: Vec<String> = Vec::new();
    if let Some(pages) = document.as_ref().and_then(|node| node.child("Pages")) {
        for page in pages.children_of("Page") {
            // TS: text(@_BaseLoc) || 'content.xml'.
            let base = {
                let value = page.attr("BaseLoc").unwrap_or("").trim().to_owned();
                if value.is_empty() {
                    "content.xml".to_owned()
                } else {
                    value
                }
            };
            page_entries.push(base);
        }
    }

    let mut pages: Vec<ReadPage> = Vec::new();
    for base in page_entries {
        let dir = match base.rfind('/') {
            Some(index) => base[..index].to_owned(),
            None => String::new(),
        };
        let at = |file: &str| -> String {
            [base_path.as_str(), dir.as_str(), file]
                .iter()
                .filter(|part| !part.is_empty())
                .copied()
                .collect::<Vec<_>>()
                .join("/")
        };
        let page_xml = element(parse_xml(&read(&mut archive, &at("Content.xml"))), "Page");
        let page_meta = element(parse_xml(&read(&mut archive, &at("Page.xml"))), "Page");
        let meta_box = page_meta
            .as_ref()
            .and_then(|node| node.child("Area"))
            .and_then(|node| node.child("PhysicalBox"));
        // TS: metaTree?.Area?.PhysicalBox ? boxOf(...) : docBox — an absent
        // or empty element falls back to the document box.
        let box_values = match meta_box {
            Some(node) if !node.text.trim().is_empty() => box_of(Some(node)),
            _ => doc_box,
        };
        let mut page = ReadPage {
            width: mm_to_pt(or_default(box_values[2], 210.0)),
            height: mm_to_pt(or_default(box_values[3], 297.0)),
            texts: Vec::new(),
            images: Vec::new(),
        };
        if let Some(content) = page_xml.as_ref().and_then(|node| node.child("Content")) {
            for layer in content.children_of("Layer") {
                for image in layer.children_of("ImageObject") {
                    let Ok(resource_id) =
                        image.attr("ResourceID").unwrap_or("").trim().parse::<u64>()
                    else {
                        continue;
                    };
                    let Some(file) = media.get(&resource_id) else {
                        continue;
                    };
                    let Some(data) = read_bytes(&mut archive, &format!("{res_base}/{file}")) else {
                        continue;
                    };
                    let rect = box_of(image.child("BBox"));
                    page.images.push(ReadImage {
                        bytes: data,
                        x: mm_to_pt(rect[0]),
                        y: mm_to_pt(rect[1]),
                        // TS: mmToPt(rect[2] || rect[0]) — width/height fall
                        // back to the x/y position when missing.
                        width: mm_to_pt(or_default(rect[2], rect[0])),
                        height: mm_to_pt(or_default(rect[3], rect[1])),
                    });
                }
                for object in layer.children_of("TextObject") {
                    // TS: Number(@_Size ?? 3) || 3.
                    let size = or_default(object.number("Size", 3.0), 3.0);
                    let Some(code) = object.children_of("TextCode").into_iter().next() else {
                        continue;
                    };
                    let value = code.text.trim().to_owned();
                    if value.is_empty() {
                        continue;
                    }
                    let delta = js_number_split(code.attr("DeltaX").unwrap_or(""));
                    let mut advance = size * 0.6;
                    if delta.len() >= 2 {
                        advance = delta[1];
                    }
                    page.texts.push(ReadText {
                        text: value,
                        x: mm_to_pt(object.number("XBound", 0.0) + code.number("X", 0.0)),
                        y: mm_to_pt(object.number("YBound", 0.0) + code.number("Y", 0.0)),
                        size: mm_to_pt(size),
                        advance: mm_to_pt(advance),
                        font: object
                            .attr("Font")
                            .and_then(|value| value.trim().parse::<u64>().ok())
                            .and_then(|id| font_ids.get(&id).cloned()),
                    });
                }
            }
        }
        pages.push(page);
    }
    Ok(OfdDoc { pages, fonts })
}

/// TS: `text.split(/\s+/).map(Number)` — leading whitespace yields a leading
/// empty token, which coerces to 0.
fn js_number_split(value: &str) -> Vec<f64> {
    let mut tokens: Vec<f64> = Vec::new();
    let mut current = String::new();
    for character in value.chars() {
        if character.is_whitespace() {
            tokens.push(parse_js_number(&current));
            current.clear();
        } else {
            current.push(character);
        }
    }
    tokens.push(parse_js_number(&current));
    tokens
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_split_keeps_empty_tokens_like_ts() {
        assert_eq!(js_number_split("1 0.500"), vec![1.0, 0.5]);
        // TS " 1 0.5".split(/\s+/) → ['', '1', '0.5'] — delta[1] is '1'.
        assert_eq!(js_number_split(" 1 0.5"), vec![0.0, 1.0, 0.5]);
        assert_eq!(js_number_split(""), vec![0.0]);
    }

    #[test]
    fn number_coercion_matches_ts() {
        assert_eq!(parse_js_number(""), 0.0);
        assert!(parse_js_number("x").is_nan());
        assert_eq!(parse_js_number(" 12 "), 12.0);
        assert_eq!(or_default(0.0, 210.0), 210.0);
        assert_eq!(or_default(f64::NAN, 297.0), 297.0);
        assert_eq!(or_default(5.0, 210.0), 5.0);
    }

    #[test]
    fn invalid_zip_is_rejected_with_not_ofd() {
        let error = match read_ofd(b"not a zip") {
            Ok(_) => panic!("invalid zip accepted"),
            Err(error) => error,
        };
        assert_eq!(error.code, "unreadable_file");
        assert_eq!(error.hint_key, Some("error.notOfd"));
    }

    /// The zip header's uncompressed size is attacker-controlled; a source that
    /// keeps producing bytes must be cut off rather than buffered.
    #[test]
    fn bounded_read_refuses_to_exceed_the_limit() {
        // An endless source is truncated at limit+1 and therefore rejected.
        assert!(read_entry_bounded(std::io::repeat(0), 1024).is_none());
        assert!(read_entry_bounded(std::io::Cursor::new(vec![7_u8; 1025]), 1024).is_none());
        // Exactly at the limit is still accepted.
        assert_eq!(
            read_entry_bounded(std::io::Cursor::new(vec![7_u8; 1024]), 1024)
                .expect("exactly at limit")
                .len(),
            1024
        );
        assert_eq!(
            read_entry_bounded(std::io::Cursor::new(b"abc".to_vec()), 1024).expect("under limit"),
            b"abc"
        );
        // A zero budget reads nothing and rejects any non-empty entry.
        assert!(read_entry_bounded(std::io::Cursor::new(b"a".to_vec()), 0).is_none());
    }
}
