//! Fresh lopdf PDF document builder shared by the C3 PDF producers
//! (`ofd-to-pdf`, `markdown-to-pdf`): pages, resource bookkeeping, text
//! drawing (standard-14 or embedded CID faces, reusing the markup font
//! machinery) and image placement. The TS oracles build on pdf-lib; page
//! geometry, colors and baseline math are kept identical.

use super::std14::StdFace;
use crate::tools::pdf_extra::markup::font as markup;
use crate::EngineError;
use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream};
use std::collections::HashMap;

type EngineResult<T> = Result<T, EngineError>;

enum FontKind {
    /// Standard-14 face drawn with WinAnsi bytes and static AFM metrics.
    Std(StdFace),
    /// Embedded CIDFontType2 subset (markup machinery); grows via `extend`.
    Embedded(markup::Font),
}

struct FontEntry {
    resource: String,
    reference: ObjectId,
    kind: FontKind,
}

/// A document under construction: one page content buffer at a time.
pub(crate) struct PdfDoc {
    pub(crate) document: Document,
    pages_id: ObjectId,
    kids: Vec<ObjectId>,
    content: String,
    page_box: (f64, f64),
    fonts: Vec<FontEntry>,
    xobjects: Vec<(String, ObjectId)>,
    std_registry: HashMap<&'static str, usize>,
    page_open: bool,
}

impl PdfDoc {
    /// Creates the catalog/pages skeleton plus the PoTools metadata the TS
    /// `createDocument` writes (producer/creator; dates use the current UTC).
    pub(crate) fn new() -> Self {
        let mut document = Document::with_version("1.7");
        let pages_id = document.add_object(Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => Object::Array(Vec::new()),
            "Count" => Object::Integer(0),
        }));
        let catalog_id = document.add_object(Object::Dictionary(dictionary! {
            "Type" => "Catalog",
            "Pages" => Object::Reference(pages_id),
        }));
        document.trailer.set("Root", Object::Reference(catalog_id));
        let now = pdf_date();
        let info = document.add_object(dictionary! {
            "Producer" => Object::String(b"PoTools".to_vec(), lopdf::StringFormat::Literal),
            "Creator" => Object::String(b"PoTools".to_vec(), lopdf::StringFormat::Literal),
            "CreationDate" => Object::String(now.as_bytes().to_vec(), lopdf::StringFormat::Literal),
            "ModDate" => Object::String(now.as_bytes().to_vec(), lopdf::StringFormat::Literal),
        });
        document.trailer.set("Info", Object::Reference(info));
        Self {
            document,
            pages_id,
            kids: Vec::new(),
            content: String::new(),
            page_box: (0.0, 0.0),
            fonts: Vec::new(),
            xobjects: Vec::new(),
            std_registry: HashMap::new(),
            page_open: false,
        }
    }

    /// Registers (once per face) a standard-14 font dictionary; returns the
    /// font index used by [`PdfDoc::draw_text`].
    pub(crate) fn register_std(&mut self, face: StdFace) -> usize {
        if let Some(index) = self.std_registry.get(face.base_font()) {
            return *index;
        }
        let reference = self.document.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type1",
            "BaseFont" => face.base_font(), "Encoding" => "WinAnsiEncoding",
        });
        let index = self.fonts.len();
        self.fonts.push(FontEntry {
            resource: format!("F{}", index + 1),
            reference,
            kind: FontKind::Std(face),
        });
        self.std_registry.insert(face.base_font(), index);
        index
    }

    /// Embeds one face of a font program via the markup subset machinery,
    /// preloading `sample`'s glyphs (call [`PdfDoc::font_extend`] for more).
    pub(crate) fn register_embedded(
        &mut self,
        name: &str,
        bytes: &[u8],
        face_index: u32,
        sample: &str,
    ) -> EngineResult<usize> {
        let font = markup::embed_face(
            &mut self.document,
            name,
            bytes,
            face_index,
            sample,
            &format!("F{}", self.fonts.len() + 1),
        )?;
        let index = self.fonts.len();
        self.fonts.push(FontEntry {
            resource: font.resource.clone(),
            reference: font.reference,
            kind: FontKind::Embedded(font),
        });
        Ok(index)
    }

    /// Whether the font can encode every character (Std: WinAnsi coverage;
    /// embedded: every char already has a glyph mapping).
    pub(crate) fn font_can_encode(&self, index: usize, text: &str) -> bool {
        match &self.fonts[index].kind {
            FontKind::Std(face) => face.can_encode(text),
            FontKind::Embedded(font) => text.chars().all(|c| font.glyphs.contains_key(&c)),
        }
    }

    /// Grows an embedded subset so `text` becomes encodable (`notdef` maps
    /// missing glyphs to gid 0, as the pdf-lib subset paths rely on).
    pub(crate) fn font_extend(
        &mut self,
        index: usize,
        text: &str,
        notdef: bool,
    ) -> EngineResult<()> {
        if let FontKind::Embedded(font) = &mut self.fonts[index].kind {
            font.extend(&mut self.document, text, notdef)?;
        }
        Ok(())
    }

    /// Summed advance in 1000-unit font space (embedded faces measure missing
    /// glyphs on demand, so layout can run before the subset is extended).
    pub(crate) fn font_width(&mut self, index: usize, text: &str) -> f64 {
        match &mut self.fonts[index].kind {
            FontKind::Std(face) => text.chars().map(|c| face.width(c).unwrap_or(500.0)).sum(),
            FontKind::Embedded(font) => font.face_width(text),
        }
    }

    /// Adds an image XObject and returns its resource name.
    pub(crate) fn add_image(&mut self, image_id: ObjectId) -> String {
        let name = format!("Im{}", self.xobjects.len() + 1);
        self.xobjects.push((name.clone(), image_id));
        name
    }

    /// Appends one text-showing operation at the baseline point (`x`, `y`),
    /// matching pdf-lib `drawText` geometry.
    pub(crate) fn draw_text(
        &mut self,
        font: usize,
        size: f64,
        color: [f64; 3],
        x: f64,
        y: f64,
        text: &str,
    ) -> EngineResult<()> {
        let encoded = self.font_encoded(font, text)?;
        let hex: String = encoded.iter().map(|b| format!("{b:02X}")).collect();
        self.content.push_str(&format!(
            "BT /{} {size} Tf {} {} {} rg {x} {y} Td <{hex}> Tj ET\n",
            self.fonts[font].resource, color[0], color[1], color[2],
        ));
        Ok(())
    }

    /// Appends one image placement (`q w 0 0 h x y cm /Name Do Q`).
    pub(crate) fn draw_image(&mut self, name: &str, x: f64, y: f64, width: f64, height: f64) {
        self.content
            .push_str(&format!("q {width} 0 0 {height} {x} {y} cm /{name} Do Q\n"));
    }

    /// Starts a new page content buffer with the given MediaBox size. The
    /// previous page (if any) is materialized first.
    pub(crate) fn begin_page(&mut self, width: f64, height: f64) {
        if self.page_open {
            self.end_page();
        }
        self.content.clear();
        self.page_box = (width, height);
        self.page_open = true;
    }

    /// Materializes the current page (content stream + dictionary + resources
    /// covering every registered font/image) and appends it to the page tree.
    pub(crate) fn end_page(&mut self) {
        self.page_open = false;
        let fonts: Vec<(String, ObjectId)> = self
            .fonts
            .iter()
            .map(|font| (font.resource.clone(), font.reference))
            .collect();
        let content_id = self.document.add_object(Stream::new(
            Dictionary::new(),
            self.content.as_bytes().to_vec(),
        ));
        let (width, height) = self.page_box;
        let page_id = self.document.add_object(Object::Dictionary(dictionary! {
            "Type" => "Page",
            "Parent" => Object::Reference(self.pages_id),
            "MediaBox" => Object::Array(vec![
                Object::Real(0.0),
                Object::Real(0.0),
                Object::Real(width as f32),
                Object::Real(height as f32),
            ]),
            "Resources" => Object::Dictionary(dictionary! {
                "Font" => Object::Dictionary(
                    fonts.into_iter().map(|(name, id)| (name, Object::Reference(id))).collect(),
                ),
                "XObject" => Object::Dictionary(
                    self.xobjects.iter().map(|(name, id)| (name.clone(), Object::Reference(*id))).collect(),
                ),
            }),
            "Contents" => Object::Reference(content_id),
        }));
        self.kids.push(page_id);
        self.xobjects.clear();
    }

    pub(crate) fn page_count(&self) -> usize {
        self.kids.len()
    }

    /// Materializes a still-open page so page counts see it.
    pub(crate) fn finalize(&mut self) {
        if self.page_open {
            self.end_page();
        }
    }

    /// Flushes the page tree and serializes the document.
    pub(crate) fn save(&mut self) -> EngineResult<Vec<u8>> {
        self.finalize();
        let count = self.kids.len() as i64;
        if let Some(Object::Dictionary(pages)) = self.document.objects.get_mut(&self.pages_id) {
            pages.set(
                "Kids",
                Object::Array(self.kids.iter().map(|id| Object::Reference(*id)).collect()),
            );
            pages.set("Count", Object::Integer(count));
        }
        let mut out = std::io::Cursor::new(Vec::new());
        self.document
            .save_to(&mut out)
            .map_err(|error| EngineError::new("write_failed", format!("无法写入 PDF：{error}")))?;
        Ok(out.into_inner())
    }

    fn font_encoded(&self, index: usize, text: &str) -> EngineResult<Vec<u8>> {
        match &self.fonts[index].kind {
            FontKind::Std(face) => {
                let mut out = Vec::with_capacity(text.len());
                for character in text.chars() {
                    out.push(face.encode(character).ok_or_else(|| {
                        EngineError::new(
                            "unsupported",
                            format!("标准字体缺少文本所需字形：{character}"),
                        )
                    })?);
                }
                Ok(out)
            }
            FontKind::Embedded(font) => font.encoded(text).map(|(bytes, _)| bytes),
        }
    }
}

/// PDF text date (`D:YYYYMMDDHHmmSSZ`, UTC — pdf-lib's serialization).
fn pdf_date() -> String {
    let now = chrono::Utc::now();
    format!("D:{}Z", now.format("%Y%m%d%H%M%S"))
}
