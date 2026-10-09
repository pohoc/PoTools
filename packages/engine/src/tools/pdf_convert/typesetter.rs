//! Flow typesetter over lopdf, ported from `lib/typesetter.ts`: styled-run
//! line breaking (Latin wraps at spaces keeping trailing whitespace, CJK
//! breaks per character), cursor/pagination (`ensure`), heading sizing,
//! list markers, image scaling and the `parseInline`-driven paragraph mode.
//! Font selection mirrors the TS `fontFor`: pure-ASCII code → Courier,
//! Latin-1-safe → the Helvetica family, anything else → the Unicode
//! resolver (configured font bytes or a covering host system font).

use super::imgpdf;
use super::md_parse::{parse_inline, InlineRun, MdBlock, MdStyle};
use super::pdfdoc::PdfDoc;
use super::std14::StdFace;
use super::text::is_js_space;
use crate::tools::pdf_extra::markup::font::{
    content_code_points, covering_host_font, face_count, face_covers, HostFont,
};
use crate::EngineError;
use std::collections::HashMap;

type EngineResult<T> = Result<T, EngineError>;

const TEXT_COLOR: [f64; 3] = [0.08, 0.1, 0.14];
const CODE_COLOR: [f64; 3] = [0.45, 0.16, 0.2];

/// Where non-Latin text comes from (the TS `TypesetterFontResolver`).
#[derive(Clone)]
pub(crate) enum FontSource {
    /// The user-configured markdown font (`runtimeData.markdownFontBytes`);
    /// some face must cover every code point or the job errors.
    Configured(std::sync::Arc<Vec<u8>>),
    /// Fresh Helvetica first, then the first covering host font.
    HostSystem(std::sync::Arc<Vec<HostFont>>),
}

pub(crate) struct TypesetStyle {
    pub size: f64,
    pub line_height: f64,
    pub paragraph_gap: f64,
    pub heading_gap: f64,
    pub indent: f64,
}

struct LayoutRun {
    text: String,
    style: MdStyle,
    width: f64,
}

pub(crate) struct Typesetter<'a> {
    doc: &'a mut PdfDoc,
    box_w: f64,
    box_h: f64,
    margin: f64,
    style: TypesetStyle,
    y: f64,
    std_cache: HashMap<&'static str, usize>,
    cjk: Option<usize>,
    source: FontSource,
}

/// The typesetter's own CJK test (`lib/typesetter.ts`, narrower than the
/// layout module's `isCjk`).
fn is_typeset_cjk(text: &str) -> bool {
    text.chars().any(|c| {
        let code = c as u32;
        (0x3000..=0x30ff).contains(&code)
            || (0x4e00..=0x9fff).contains(&code)
            || (0xac00..=0xd7af).contains(&code)
            || (0xff00..=0xff60).contains(&code)
    })
}

fn latin_only(text: &str) -> bool {
    text.chars()
        .all(|c| matches!(c as u32, 0x20..=0x7e | 0xa0..=0xff))
}

fn ascii_only(text: &str) -> bool {
    text.chars().all(|c| matches!(c as u32, 0x20..=0x7e))
}

/// Non-CJK wrap units: split after every whitespace character (the TS
/// `split(/(?<=\s)/)`).
fn wrap_units(text: &str) -> Vec<&str> {
    let mut units = Vec::new();
    let mut start = 0usize;
    for (index, c) in text.char_indices() {
        if is_js_space(c) {
            let end = index + c.len_utf8();
            units.push(&text[start..end]);
            start = end;
        }
    }
    if start < text.len() {
        units.push(&text[start..]);
    }
    units
}

fn plain_run(text: &str) -> InlineRun {
    InlineRun {
        text: text.to_owned(),
        style: MdStyle::default(),
    }
}

impl<'a> Typesetter<'a> {
    /// Starts the first page at the cursor (the TS constructor's `addPage`).
    pub(crate) fn new(
        doc: &'a mut PdfDoc,
        box_w: f64,
        box_h: f64,
        margin: f64,
        style: TypesetStyle,
        source: FontSource,
    ) -> Self {
        doc.begin_page(box_w, box_h);
        Self {
            doc,
            box_w,
            box_h,
            margin,
            style,
            y: box_h - margin,
            std_cache: HashMap::new(),
            cjk: None,
            source,
        }
    }

    fn content_width(&self) -> f64 {
        (self.box_w - self.margin * 2.0).max(40.0)
    }

    fn new_page(&mut self) {
        self.doc.begin_page(self.box_w, self.box_h);
        self.y = self.box_h - self.margin;
    }

    fn ensure(&mut self, space: f64) {
        if self.y - space < self.margin {
            self.new_page();
        }
    }

    fn std_font(&mut self, face: StdFace) -> usize {
        let key = face.base_font();
        if let Some(index) = self.std_cache.get(key) {
            return *index;
        }
        let index = self.doc.register_std(face);
        self.std_cache.insert(key, index);
        index
    }

    /// Ported `fontFor`: standard faces cached per variant, one Unicode font
    /// per document (the TS `this.cjk`).
    fn font_for(&mut self, text: &str, style: MdStyle) -> EngineResult<usize> {
        if style.code && ascii_only(text) {
            return Ok(self.std_font(StdFace::Courier));
        }
        if latin_only(text) {
            let face = match (style.bold, style.italic) {
                (true, true) => StdFace::HelveticaBoldOblique,
                (true, false) => StdFace::HelveticaBold,
                (false, true) => StdFace::HelveticaOblique,
                (false, false) => StdFace::Helvetica,
            };
            return Ok(self.std_font(face));
        }
        if let Some(index) = self.cjk {
            return Ok(index);
        }
        let index = self.resolve_unicode(text)?;
        self.cjk = Some(index);
        Ok(index)
    }

    /// The TS resolver: the configured font must have a face covering the
    /// text's code points; otherwise a fresh Helvetica embed precedes the
    /// covering host font lookup, and absence is a hard failure now (the TS
    /// raised `InMemoryFallback`).
    fn resolve_unicode(&mut self, text: &str) -> EngineResult<usize> {
        // Cheap Arc clone so the config borrow cannot fight `&mut self`.
        match self.source.clone() {
            FontSource::Configured(bytes) => {
                let code_points = content_code_points(text);
                match (0..face_count(&bytes) as u32)
                    .find(|index| face_covers(&bytes, *index, &code_points))
                {
                    Some(face_index) => self
                        .doc
                        .register_embedded("Markdown", &bytes, face_index, text)
                        .or(Err(EngineError::new(
                            "unsupported",
                            "Configured font does not contain all glyphs required by Markdown",
                        ))),
                    None => Err(EngineError::new(
                        "unsupported",
                        "Configured font does not contain all glyphs required by Markdown",
                    )),
                }
            }
            FontSource::HostSystem(fonts) => {
                let helvetica = self.std_font(StdFace::Helvetica);
                if self.doc.font_can_encode(helvetica, text) {
                    return Ok(helvetica);
                }
                match covering_host_font(&fonts, text) {
                    Some((resource, face_index)) => self.doc.register_embedded(
                        &resource.name,
                        &resource.bytes,
                        face_index,
                        text,
                    ),
                    None => Err(EngineError::new(
                        "unsupported",
                        "A Unicode font resolver is required for non-Latin text",
                    )),
                }
            }
        }
    }

    /// Ported `layoutRuns`: units overflow onto new lines, adjacent
    /// same-style runs merge (fonts re-derive from the merged text at draw
    /// time, as in the TS `fontOf(run)` key).
    fn layout_runs(
        &mut self,
        runs: &[InlineRun],
        size: f64,
        max_width: f64,
    ) -> EngineResult<Vec<Vec<LayoutRun>>> {
        let mut lines: Vec<Vec<LayoutRun>> = vec![Vec::new()];
        let mut width = 0.0f64;
        for run in runs {
            if run.text.is_empty() {
                continue;
            }
            let font = self.font_for(&run.text, run.style)?;
            let units: Vec<String> = if is_typeset_cjk(&run.text) {
                run.text.chars().map(String::from).collect()
            } else {
                wrap_units(&run.text)
                    .into_iter()
                    .map(str::to_owned)
                    .collect()
            };
            for unit in units {
                let piece = self.doc.font_width(font, &unit) * size / 1000.0;
                if width + piece > max_width {
                    // TS newline(): only pushes when the current line holds
                    // content; the cursor width always resets.
                    if lines.last().is_some_and(|line| !line.is_empty()) {
                        lines.push(Vec::new());
                    }
                    width = 0.0;
                }
                let last = lines.last_mut().expect("line exists");
                if let Some(tail) = last.last_mut() {
                    if tail.style == run.style {
                        tail.text.push_str(&unit);
                        tail.width += piece;
                        width += piece;
                        continue;
                    }
                }
                last.push(LayoutRun {
                    text: unit,
                    style: run.style,
                    width: piece,
                });
                width += piece;
            }
        }
        lines.retain(|line| !line.is_empty());
        Ok(lines)
    }

    /// Ported `runs()`: lays out at the cursor, advances it per line, trims
    /// trailing whitespace from the drawn string but advances by the full
    /// measured width.
    pub(crate) fn runs(&mut self, runs: &[InlineRun], size: f64, indent: f64) -> EngineResult<()> {
        let content_width = self.content_width();
        let laid = self.layout_runs(runs, size, content_width - indent)?;
        for line in laid {
            self.ensure(size * self.style.line_height);
            self.y -= size * self.style.line_height;
            let mut x = self.margin + indent;
            for run in line {
                let font = self.font_for(&run.text, run.style)?;
                let drawn = run.text.trim_end_matches(is_js_space);
                if !drawn.is_empty() {
                    // Grows embedded subsets so the drawn text encodes; a
                    // missing glyph fails the job, as the TS draw does.
                    self.doc.font_extend(font, drawn, false)?;
                    let color = if run.style.code {
                        CODE_COLOR
                    } else {
                        TEXT_COLOR
                    };
                    self.doc.draw_text(font, size, color, x, self.y, drawn)?;
                }
                x += self.doc.font_width(font, &run.text) * size / 1000.0;
            }
        }
        Ok(())
    }

    /// Ported `image()`: embeds JPEG/PNG bytes, scales to the content width
    /// (capped at 55% of the page height, never below 24pt) and advances the
    /// cursor. Embed failures fall back to a placeholder text run.
    pub(crate) fn image(&mut self, bytes: Option<&[u8]>, page_label: &str) -> EngineResult<()> {
        let Some(bytes) = bytes else {
            return Ok(());
        };
        match imgpdf::embed(&mut self.doc.document, bytes) {
            Some((image_id, natural_w, natural_h)) => {
                let scale = (1.0f64)
                    .min(self.content_width() / natural_w as f64)
                    .min((self.box_h * 0.55) / natural_h as f64);
                let width = (natural_w as f64 * scale).max(24.0);
                let height = (natural_h as f64 * scale).max(24.0);
                self.ensure(height + 10.0);
                self.y -= height;
                let name = self.doc.add_image(image_id);
                self.doc
                    .draw_image(&name, self.margin, self.y, width, height);
                self.y -= 10.0;
                Ok(())
            }
            None => {
                let placeholder = format!("[图片 {page_label}]");
                self.runs(&[plain_run(&placeholder)], self.style.size, 0.0)
            }
        }
    }

    /// Ported `block()`: the shared flow walker with inline-mark paragraphs.
    pub(crate) fn block<'s>(
        &mut self,
        blocks: &[MdBlock],
        inline: bool,
        image_for: &'s dyn Fn(&str) -> Option<&'s [u8]>,
    ) -> EngineResult<()> {
        for block in blocks {
            match block {
                MdBlock::Heading { level, text } => {
                    let size = (self.style.size * (1.75 - (*level).min(6) as f64 * 0.13))
                        .max(self.style.size);
                    self.y -= self.style.heading_gap;
                    let runs = [InlineRun {
                        text: text.clone(),
                        style: MdStyle {
                            bold: true,
                            ..MdStyle::default()
                        },
                    }];
                    self.runs(&runs, size, 0.0)?;
                }
                MdBlock::Paragraph { text } => {
                    let runs = if inline {
                        parse_inline(text)
                    } else {
                        vec![plain_run(text)]
                    };
                    self.runs(&runs, self.style.size, 0.0)?;
                    self.y -= self.style.paragraph_gap;
                }
                MdBlock::List { ordered, items } => {
                    for (index, item) in items.iter().enumerate() {
                        let marker = if *ordered {
                            format!("{}.", index + 1)
                        } else {
                            "•".to_owned()
                        };
                        let mut runs = vec![plain_run(&format!("{marker}  "))];
                        if inline {
                            runs.extend(parse_inline(item));
                        } else {
                            runs.push(plain_run(item));
                        }
                        self.runs(&runs, self.style.size, self.style.indent)?;
                    }
                    self.y -= self.style.paragraph_gap;
                }
                MdBlock::Image { src, .. } => {
                    self.image(image_for(src), "")?;
                }
                MdBlock::PageBreak => self.new_page(),
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrap_units_keep_trailing_whitespace() {
        assert_eq!(wrap_units("a b"), vec!["a ", "b"]);
        assert_eq!(wrap_units("a  b"), vec!["a ", " ", "b"]);
        assert_eq!(wrap_units("ab"), vec!["ab"]);
    }

    #[test]
    fn cjk_detection_matches_typesetter_ranges() {
        assert!(is_typeset_cjk("中文"));
        assert!(!is_typeset_cjk("latin"));
        // U+3400..U+4DFF are CJK in the layout module but not here.
        assert!(!is_typeset_cjk("\u{3400}"));
    }

    #[test]
    fn heading_sizes_follow_the_ts_formula() {
        let style = TypesetStyle {
            size: 11.0,
            line_height: 1.5,
            paragraph_gap: 8.0,
            heading_gap: 12.0,
            indent: 18.0,
        };
        let size_of =
            |level: usize| (style.size * (1.75 - level.min(6) as f64 * 0.13)).max(style.size);
        assert!((size_of(1) - 17.82).abs() < 1e-9);
        assert!((size_of(6) - 11.0).abs() < 1e-9);
    }
}
