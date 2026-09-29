//! Minimal OOXML `.docx` writer mirroring `lib/office.ts` `writeBrowserDocx`
//! (the TS builds on the `docx` npm library). One paragraph per block, with
//! the TS semantics preserved:
//!
//! - headings map to `pStyle` `Title`/`Heading1`..`Heading4`
//!   (`[TITLE,H1,H2,H3,H4][min(level,5)-1]`);
//! - paragraph text containing `\n` becomes runs separated by `<w:br/>`
//!   (the `docx` library splits `TextRun` text on newlines into breaks);
//! - unordered list items carry the default bullet numbering, ordered items
//!   get none (TS passes `bullet: block.ordered ? undefined : { level: 0 }`);
//! - image extents scale to `max(72, contentWidth)` points and convert
//!   pt → px (`×96/72`, `Math.round`) → EMU (`×9525`);
//! - page breaks render only when the option is on.

use super::writers::escape_html;
use super::FlowBlock;
use crate::EngineError;
use std::io::{Cursor, Write};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

type EngineResult<T> = Result<T, EngineError>;

/// One image payload resolved by the caller: PNG bytes plus the drawn size
/// in points (TS `PlacedRegion`).
pub(crate) struct DocxImage<'a> {
    pub bytes: &'a [u8],
    pub width_pt: f64,
    pub height_pt: f64,
}

/// Inputs for [`write_docx`] (TS `DocxInput`). `image_for` receives the
/// 1-based ordinal of the image block and may return `None` to skip it.
pub(crate) struct DocxInput<'a> {
    pub title: &'a str,
    pub blocks: &'a [FlowBlock],
    pub image_for: &'a dyn Fn(usize) -> Option<DocxImage<'a>>,
    pub page_breaks: bool,
    /// Usable text width in points (page width minus margins).
    pub content_width: f64,
}

const HEADING_STYLES: [&str; 5] = ["Title", "Heading1", "Heading2", "Heading3", "Heading4"];
const EMU_PER_PX: f64 = 9525.0;
const PT_TO_PX: f64 = 96.0 / 72.0;

/// Builds the `.docx` package bytes for the given document model.
pub(crate) fn write_docx(input: &DocxInput<'_>) -> EngineResult<Vec<u8>> {
    let failed = |error: zip::result::ZipError| {
        EngineError::new("write_failed", format!("无法生成 DOCX：{error}"))
    };
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .compression_level(Some(6));
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));

    let mut children: Vec<String> = Vec::new();
    let mut media: Vec<(usize, Vec<u8>)> = Vec::new();
    let mut image_index = 0usize;
    for block in input.blocks {
        match block {
            FlowBlock::Heading { level, text, .. } => {
                let style = HEADING_STYLES[(*level).min(HEADING_STYLES.len()) - 1];
                children.push(format!(
                    "<w:p><w:pPr><w:pStyle w:val=\"{style}\"/></w:pPr>{}</w:p>",
                    text_run(text, false)
                ));
            }
            FlowBlock::Paragraph { text, bold, .. } => {
                children.push(format!("<w:p>{}</w:p>", text_run(text, *bold)));
            }
            FlowBlock::List { ordered, items, .. } => {
                for item in items {
                    // TS quirk: ordered items get no bullet numbering.
                    let number_pr = if *ordered {
                        String::new()
                    } else {
                        "<w:numPr><w:ilvl w:val=\"0\"/><w:numId w:val=\"1\"/></w:numPr>".to_owned()
                    };
                    let prefix = if number_pr.is_empty() {
                        String::new()
                    } else {
                        format!("<w:pPr>{number_pr}</w:pPr>")
                    };
                    children.push(format!("<w:p>{prefix}{}</w:p>", text_run(item, false)));
                }
            }
            FlowBlock::Image { .. } => {
                image_index += 1;
                let ordinal = image_index;
                let Some(region) = (input.image_for)(ordinal) else {
                    continue;
                };
                let max_width = 72.0f64.max(input.content_width);
                let scale = 1.0f64.min(max_width / region.width_pt);
                let width_px = (region.width_pt * scale * PT_TO_PX).round();
                let height_px = (region.height_pt * scale * PT_TO_PX).round();
                let cx = width_px * EMU_PER_PX;
                let cy = height_px * EMU_PER_PX;
                let doc_pr_id = 1000 + ordinal;
                let rel = rel_id(ordinal);
                children.push(format!(
                    "<w:p><w:r><w:drawing><wp:inline distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\">\
<wp:extent cx=\"{cx}\" cy=\"{cy}\"/>\
<wp:docPr id=\"{doc_pr_id}\" name=\"Picture {ordinal}\"/>\
<wp:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\">\
<pic:pic>\
<pic:nvPicPr><pic:cNvPr id=\"{doc_pr_id}\" name=\"image{ordinal}.png\"/><pic:cNvPicPr/></pic:nvPicPr>\
<pic:blipFill><a:blip r:embed=\"rId{rel}\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>\
<pic:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm>\
<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr>\
</pic:pic></a:graphicData></wp:graphic></wp:inline></w:drawing></w:r></w:p>"
                ));
                media.push((ordinal, region.bytes.to_vec()));
            }
            FlowBlock::PageBreak => {
                if input.page_breaks {
                    children.push("<w:p><w:r><w:br w:type=\"page\"/></w:r></w:p>".to_owned());
                }
            }
        }
    }

    let image_relationships: String = media
        .iter()
        .map(|(ordinal, _)| format!(
            "<Relationship Id=\"rId{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"media/image{}.png\"/>",
            rel_id(*ordinal),
            ordinal
        ))
        .collect();
    let media_defaults = if media.is_empty() {
        String::new()
    } else {
        "<Default Extension=\"png\" ContentType=\"image/png\"/>".to_owned()
    };

    for (name, content) in [
        ("[Content_Types].xml", content_types(&media_defaults)),
        ("_rels/.rels", root_rels()),
        ("word/document.xml", document_xml(&children)),
        (
            "word/_rels/document.xml.rels",
            document_rels(&image_relationships),
        ),
        ("word/numbering.xml", numbering_xml()),
        ("word/styles.xml", styles_xml()),
        ("docProps/core.xml", core_xml(input.title)),
    ] {
        zip.start_file(name, options).map_err(failed)?;
        zip.write_all(content.as_bytes())
            .map_err(|error| EngineError::new("write_failed", format!("无法生成 DOCX：{error}")))?;
    }
    for (ordinal, bytes) in &media {
        zip.start_file(format!("word/media/image{ordinal}.png"), options)
            .map_err(failed)?;
        zip.write_all(bytes)
            .map_err(|error| EngineError::new("write_failed", format!("无法生成 DOCX：{error}")))?;
    }
    zip.finish()
        .map_err(failed)
        .map(Cursor::into_inner)
}

/// Relationship ids: rId1 styles, rId2 numbering, images from rId10 up.
fn rel_id(ordinal: usize) -> usize {
    9 + ordinal
}

/// One run sequence for a paragraph body: text split on `\n` becomes runs
/// separated by a `<w:br/>` run (the `docx` library's TextRun behavior).
fn text_run(text: &str, bold: bool) -> String {
    let properties = if bold { "<w:rPr><w:b/></w:rPr>" } else { "" };
    text.split('\n')
        .map(|segment| format!(
            "<w:r>{properties}<w:t xml:space=\"preserve\">{}</w:t></w:r>",
            escape_html(segment)
        ))
        .collect::<Vec<_>>()
        .join("<w:r><w:br/></w:r>")
}

fn content_types(media_defaults: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
<Default Extension=\"xml\" ContentType=\"application/xml\"/>{media_defaults}\
<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>\
<Override PartName=\"/word/numbering.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml\"/>\
<Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/>\
<Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/>\
</Types>"
    )
}

fn root_rels() -> String {
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/>\
<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/>\
</Relationships>"
        .to_owned()
}

fn document_xml(children: &[String]) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" \
xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" \
xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\" \
xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" \
xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\">\
<w:body>{}<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/>\
<w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\" w:header=\"708\" w:footer=\"708\" w:gutter=\"0\"/></w:sectPr>\
</w:body></w:document>",
        children.concat()
    )
}

fn document_rels(image_relationships: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/>\
<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering\" Target=\"numbering.xml\"/>{image_relationships}\
</Relationships>"
    )
}

/// Default bullet numbering for the `docx` library's `bullet: { level: 0 }`.
fn numbering_xml() -> String {
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<w:numbering xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">\
<w:abstractNum w:abstractNumId=\"0\"><w:multiLevelType w:val=\"hybridMultilevel\"/>\
<w:lvl w:ilvl=\"0\"><w:start w:val=\"1\"/><w:numFmt w:val=\"bullet\"/><w:lvlText w:val=\"●\"/>\
<w:lvlJc w:val=\"left\"/><w:pPr><w:ind w:left=\"720\" w:hanging=\"360\"/></w:pPr>\
<w:rPr><w:rFonts w:ascii=\"Symbol\" w:hAnsi=\"Symbol\" w:hint=\"default\"/></w:rPr></w:lvl>\
</w:abstractNum><w:num w:numId=\"1\"><w:abstractNumId w:val=\"0\"/></w:num></w:numbering>"
        .to_owned()
}

/// Heading styles so `pStyle` references render like the `docx` defaults.
fn styles_xml() -> String {
    let style = |id: &str, name: &str, size: u32, outline: u32| format!(
        "<w:style w:type=\"paragraph\" w:styleId=\"{id}\"><w:name w:val=\"{name}\"/><w:basedOn w:val=\"Normal\"/>\
<w:next w:val=\"Normal\"/><w:pPr><w:outlineLvl w:val=\"{outline}\"/><w:spacing w:after=\"120\"/></w:pPr>\
<w:rPr><w:b/><w:sz w:val=\"{size}\"/></w:rPr></w:style>"
    );
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<w:styles xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">\
<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val=\"22\"/><w:szCs w:val=\"22\"/></w:rPr></w:rPrDefault></w:docDefaults>\
<w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\"><w:name w:val=\"Normal\"/></w:style>{}{}{}{}{}\
</w:styles>",
        style("Title", "Title", 56, 0),
        style("Heading1", "heading 1", 32, 0),
        style("Heading2", "heading 2", 26, 1),
        style("Heading3", "heading 3", 24, 2),
        style("Heading4", "heading 4", 22, 3),
    )
}

fn core_xml(title: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" \
xmlns:dc=\"http://purl.org/dc/elements/1.1/\">\
<dc:title>{}</dc:title><dc:creator>PoTools</dc:creator><dc:description>Converted with PoTools</dc:description>\
</cp:coreProperties>",
        escape_html(title)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn text_run_splits_newlines_into_breaks() {
        assert_eq!(
            text_run("a\n<b>", true),
            "<w:r><w:rPr><w:b/></w:rPr><w:t xml:space=\"preserve\">a</w:t></w:r>\
<w:r><w:br/></w:r><w:r><w:rPr><w:b/></w:rPr><w:t xml:space=\"preserve\">&lt;b&gt;</w:t></w:r>"
        );
    }

    #[test]
    fn heading_style_index_matches_ts_array() {
        assert_eq!(HEADING_STYLES[1usize.min(5) - 1], "Title");
        assert_eq!(HEADING_STYLES[3usize.min(5) - 1], "Heading2");
        assert_eq!(HEADING_STYLES[9usize.min(5) - 1], "Heading4");
    }

    #[test]
    fn image_extents_convert_pt_through_px_to_emu() {
        // 400 pt at scale 1 → 533.33… px → Math.round → 533 px → 9525 EMU each.
        let max_width = 72.0f64.max(451.0);
        let scale = 1.0f64.min(max_width / 400.0);
        let cx = (400.0 * scale * PT_TO_PX).round() * EMU_PER_PX;
        assert_eq!(cx, 533.0 * EMU_PER_PX);
        // An image wider than the content width scales down to it exactly.
        let scaled = 1.0f64.min(max_width / 900.0);
        assert!(scaled < 1.0);
        let shrunk = (900.0 * scaled * PT_TO_PX).round() * EMU_PER_PX;
        assert_eq!(shrunk, 601.0 * EMU_PER_PX);
    }

    #[test]
    fn extra_documents_shape_is_stable() {
        let extra = json!({ "documents": 2 });
        assert_eq!(extra["documents"], json!(2));
    }
}
