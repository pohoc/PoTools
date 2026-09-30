//! Minimal OOXML `.pptx` writer standing in for the `pptxgenjs` build in
//! `lib/pptx.ts`: one custom page-sized layout (from the first slide), one
//! full-bleed picture per slide plus a bordered-less text box per merged
//! text line (`fit: 'shrink'` becomes `<a:normAutofit/>`, `valign: 'top'`
//! becomes `anchor="t"`). Sizes convert inches → EMU (×914400, rounded).

use crate::EngineError;
use std::io::{Cursor, Write};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

type EngineResult<T> = Result<T, EngineError>;

const EMU_PER_INCH: f64 = 914400.0;

/// One text box line already reduced to inches + the computed point size.
pub(crate) struct PptLine {
    pub text: String,
    pub x_in: f64,
    pub y_in: f64,
    pub w_in: f64,
    pub h_in: f64,
    /// Font size in points (`max(5, round(size * 0.72))`).
    pub font_size: i64,
    pub bold: bool,
    pub color: &'static str,
}

pub(crate) struct PptSlide<'a> {
    pub width_in: f64,
    pub height_in: f64,
    pub image: &'a [u8],
    pub lines: Vec<PptLine>,
}

pub(crate) struct PptxInput<'a> {
    pub slides: Vec<PptSlide<'a>>,
    pub title: &'a str,
}

fn emu(inches: f64) -> i64 {
    (inches * EMU_PER_INCH).round() as i64
}

fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Builds the `.pptx` package bytes (slide sizes come from the first slide,
/// exactly like the TS `defineLayout` call).
pub(crate) fn write_pptx(input: &PptxInput<'_>) -> EngineResult<Vec<u8>> {
    let failed = |error: zip::result::ZipError| {
        EngineError::new("write_failed", format!("无法生成 PPTX：{error}"))
    };
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .compression_level(Some(6));
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let add =
        |zip: &mut ZipWriter<Cursor<Vec<u8>>>, name: &str, content: &str| -> EngineResult<()> {
            zip.start_file(name, options).map_err(failed)?;
            zip.write_all(content.as_bytes()).map_err(|error| {
                EngineError::new("write_failed", format!("无法生成 PPTX：{error}"))
            })
        };

    let slide_overrides: String = (0..input.slides.len())
        .map(|index| format!(
            "<Override PartName=\"/ppt/slides/slide{}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slide+xml\"/>",
            index + 1
        ))
        .collect();
    add(&mut zip, "[Content_Types].xml", &format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
<Default Extension=\"xml\" ContentType=\"application/xml\"/>\
<Default Extension=\"png\" ContentType=\"image/png\"/>\
<Override PartName=\"/ppt/presentation.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml\"/>\
<Override PartName=\"/ppt/slideMasters/slideMaster1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml\"/>\
<Override PartName=\"/ppt/slideLayouts/slideLayout1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml\"/>\
<Override PartName=\"/ppt/theme/theme1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.theme+xml\"/>\
{slide_overrides}\
<Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/>\
<Override PartName=\"/docProps/app.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.extended-properties+xml\"/>\
</Types>"
    ))?;
    add(&mut zip, "_rels/.rels",
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"ppt/presentation.xml\"/>\
<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/>\
<Relationship Id=\"rId3\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties\" Target=\"docProps/app.xml\"/>\
</Relationships>")?;
    add(&mut zip, "docProps/core.xml", &format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" \
xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\" \
xmlns:dcmitype=\"http://purl.org/dc/dcmitype/\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">\
<dc:title>{}</dc:title><dc:creator>PoTools</dc:creator><cp:lastModifiedBy>PoTools</cp:lastModifiedBy>\
</cp:coreProperties>",
        xml(input.title)
    ))?;
    add(&mut zip, "docProps/app.xml",
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\" \
xmlns:vt=\"http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes\">\
<Application>Microsoft Office PowerPoint</Application><PresentationFormat>Custom</PresentationFormat>\
</Properties>")?;

    let (layout_w, layout_h) = input
        .slides
        .first()
        .map(|slide| (slide.width_in, slide.height_in))
        .unwrap_or((10.0, 7.5));
    let slide_ids: String = (0..input.slides.len())
        .map(|index| {
            format!(
                "<p:sldId id=\"{}\" r:id=\"rId{}\"/>",
                256 + index,
                index + 2
            )
        })
        .collect();
    add(
        &mut zip,
        "ppt/presentation.xml",
        &format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<p:presentation xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" \
xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" \
xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" saveSubsetFonts=\"1\">\
<p:sldMasterIdLst><p:sldMasterId id=\"2147483648\" r:id=\"rId1\"/></p:sldMasterIdLst>\
<p:sldIdLst>{slide_ids}</p:sldIdLst>\
<p:sldSz cx=\"{}\" cy=\"{}\" type=\"custom\"/>\
<p:notesSz cx=\"6858000\" cy=\"9144000\"/></p:presentation>",
            emu(layout_w),
            emu(layout_h)
        ),
    )?;
    let presentation_rels: String = (0..input.slides.len())
        .map(|index| format!(
            "<Relationship Id=\"rId{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"slides/slide{}.xml\"/>",
            index + 2,
            index + 1
        ))
        .collect();
    add(&mut zip, "ppt/_rels/presentation.xml.rels", &format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster\" Target=\"slideMasters/slideMaster1.xml\"/>\
{presentation_rels}\
<Relationship Id=\"rId{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme\" Target=\"theme/theme1.xml\"/>\
</Relationships>",
        input.slides.len() + 2
    ))?;
    add(&mut zip, "ppt/slideMasters/slideMaster1.xml",
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<p:sldMaster xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" \
xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" \
xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\">\
<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>\
<p:clrMap bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" accent1=\"accent1\" accent2=\"accent2\" accent3=\"accent3\" accent4=\"accent4\" accent5=\"accent5\" accent6=\"accent6\" hlink=\"hlink\" folHlink=\"folHlink\"/>\
<p:sldLayoutIdLst><p:sldLayoutId id=\"2147483649\" r:id=\"rId1\"/></p:sldLayoutIdLst>\
</p:sldMaster>")?;
    add(&mut zip, "ppt/slideMasters/_rels/slideMaster1.xml.rels",
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout\" Target=\"../slideLayouts/slideLayout1.xml\"/>\
<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme\" Target=\"../theme/theme1.xml\"/>\
</Relationships>")?;
    add(&mut zip, "ppt/slideLayouts/slideLayout1.xml",
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<p:sldLayout xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" \
xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" \
xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\">\
<p:cSld name=\"Blank\"><p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>\
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>")?;
    add(&mut zip, "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster\" Target=\"../slideMasters/slideMaster1.xml\"/>\
</Relationships>")?;
    add(&mut zip, "ppt/theme/theme1.xml", THEME_XML)?;

    for (index, slide) in input.slides.iter().enumerate() {
        let number = index + 1;
        let (cx, cy) = (emu(slide.width_in), emu(slide.height_in));
        let mut shapes = String::new();
        let mut id = 2usize;
        shapes.push_str(&format!(
            "<p:pic><p:nvPicPr><p:cNvPr id=\"{id}\" name=\"image{number}.png\"/>\
<p:cNvPicPr><a:picLocks noChangeAspect=\"1\"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>\
<p:blipFill><a:blip r:embed=\"rId2\"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>\
<p:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm>\
<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></p:spPr></p:pic>"
        ));
        for line in &slide.lines {
            id += 1;
            shapes.push_str(&text_box(line, id));
        }
        add(
            &mut zip,
            &format!("ppt/slides/slide{number}.xml"),
            &format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<p:sld xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" \
xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" \
xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\">\
<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>{shapes}</p:spTree></p:cSld>\
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"
            ),
        )?;
        add(
            &mut zip,
            &format!("ppt/slides/_rels/slide{number}.xml.rels"),
            &format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout\" Target=\"../slideLayouts/slideLayout1.xml\"/>\
<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"../media/image{number}.png\"/>\
</Relationships>"
            ),
        )?;
        zip.start_file(format!("ppt/media/image{number}.png"), options)
            .map_err(failed)?;
        zip.write_all(slide.image)
            .map_err(|error| EngineError::new("write_failed", format!("无法生成 PPTX：{error}")))?;
    }

    zip.finish().map_err(failed).map(Cursor::into_inner)
}

/// One text box shape: `wrap="none"` + `normAutofit` (the `fit: 'shrink'`
/// analogue), top-anchored, one run with the TS font size / bold / color.
fn text_box(line: &PptLine, id: usize) -> String {
    let bold = if line.bold { "1" } else { "0" };
    format!(
        "<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"TextBox {id}\"/><p:cNvSpPr txBox=\"1\"/><p:nvPr/></p:nvSpPr>\
<p:spPr><a:xfrm><a:off x=\"{}\" y=\"{}\"/><a:ext cx=\"{}\" cy=\"{}\"/></a:xfrm>\
<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></p:spPr>\
<p:txBody><a:bodyPr wrap=\"none\" anchor=\"t\"><a:normAutofit/></a:bodyPr><a:lstStyle/>\
<a:p><a:r><a:rPr lang=\"en-US\" sz=\"{}\" b=\"{bold}\" dirty=\"0\">\
<a:solidFill><a:srgbClr val=\"{}\"/></a:solidFill></a:rPr><a:t>{}</a:t></a:r></a:p></p:txBody></p:sp>",
        emu(line.x_in),
        emu(line.y_in),
        emu(line.w_in),
        emu(line.h_in),
        line.font_size * 100,
        line.color,
        xml(&line.text)
    )
}

/// Compact but valid DrawingML theme (clr/font/fmt schemes).
const THEME_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="PoTools"><a:themeElements><a:clrScheme name="PoTools"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="PoTools"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="PoTools"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>"#;
