//! OFD (GB/T 33190) writer, ported from `lib/ofd.ts` `writeOfd` — the zip
//! layout, element order and string templates match the TS byte-for-byte:
//! `OFD.xml` (DocID from the current time in hex, UTC creation stamp),
//! `Doc_0/Document.xml` (MaxUnitID snapshot, page table), `DocumentRes.xml`
//! (font + multimedia registry), the font/image payloads and per-page
//! `Content.xml`/`Page.xml` pairs (text objects carry a uniform `DeltaX`
//! advance split across the code points).

use crate::EngineError;
use chrono::Utc;
use std::io::{Cursor, Write};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

const NS: &str = "http://www.ofdspec.org/2016";

/// Point → millimetre (`lib/ofd.ts` `ptToMm`).
pub(crate) fn pt_to_mm(value: f64) -> f64 {
    value * (25.4 / 72.0)
}

/// Millimetre → point (`lib/ofd.ts` `mmToPt`).
pub(crate) fn mm_to_pt(value: f64) -> f64 {
    value / (25.4 / 72.0)
}

/// One text line placed in millimetres from the page's top-left corner.
pub(crate) struct OfdText {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub size: f64,
}

/// One full-rect image in millimetres.
pub(crate) struct OfdImage<'a> {
    pub bytes: &'a [u8],
    pub name: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub(crate) struct OfdPage<'a> {
    pub width: f64,
    pub height: f64,
    pub texts: Vec<OfdText>,
    pub images: Vec<OfdImage<'a>>,
}

/// The bundled font: `None` bytes means "register the name only" (oversize
/// fonts, matching the TS `{ name }` payload).
pub(crate) struct OfdFont<'a> {
    pub name: &'a str,
    pub bytes: Option<&'a [u8]>,
}

pub(crate) struct OfdInput<'a> {
    pub font: Option<OfdFont<'a>>,
    pub pages: Vec<OfdPage<'a>>,
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Packs the pages into the OFD zip (all entries DEFLATE, like JSZip).
pub(crate) fn write_ofd(input: &OfdInput<'_>) -> Result<Vec<u8>, EngineError> {
    let failed = |error: zip::result::ZipError| {
        EngineError::new("write_failed", format!("无法生成 OFD：{error}"))
    };
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .compression_level(Some(6));
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let add = |zip: &mut ZipWriter<Cursor<Vec<u8>>>, name: &str, content: &[u8]| -> Result<(), EngineError> {
        zip.start_file(name, options).map_err(failed)?;
        zip.write_all(content)
            .map_err(|error| EngineError::new("write_failed", format!("无法生成 OFD：{error}")))
    };

    // TS: new Date().toISOString().slice(0, 19) — UTC.
    let stamp = Utc::now().format("%Y-%m-%dT%H:%M:%S").to_string();
    // TS: Date.now().toString(16).padStart(16, '0').
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0);
    let doc_id = format!("{millis:016x}");
    let mut next_id = 10u64;
    let ids = |next_id: &mut u64| {
        *next_id += 1;
        *next_id
    };

    add(
        &mut zip,
        "OFD.xml",
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<ofd:OFD xmlns:ofd=\"{NS}\" DocType=\"OFD\" Version=\"1.0\"><ofd:DocBody><ofd:DocInfo><ofd:DocID>{doc_id}</ofd:DocID><ofd:Creator>PoTools</ofd:Creator><ofd:CreationDate>{stamp}</ofd:CreationDate></ofd:DocInfo><ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot></ofd:DocBody></ofd:OFD>"
        )
        .as_bytes(),
    )?;

    let font_id = if input.font.is_some() { ids(&mut next_id) } else { 0 };
    let mut media_ids: Vec<(String, u64)> = Vec::new();
    for page in &input.pages {
        for image in &page.images {
            if !media_ids.iter().any(|(name, _)| *name == image.name) {
                let id = ids(&mut next_id);
                media_ids.push((image.name.clone(), id));
            }
        }
    }
    let media_id_of = |name: &str| media_ids.iter().find(|(key, _)| key == name).map(|(_, id)| *id);

    // MaxUnitID snapshots nextId + 10 at this point (after font + media ids,
    // before the per-page object ids), exactly like the TS evaluation order.
    let first = input.pages.first();
    add(
        &mut zip,
        "Doc_0/Document.xml",
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<ofd:Document xmlns:ofd=\"{NS}\"><ofd:CommonData><ofd:MaxUnitID>{}</ofd:MaxUnitID><ofd:PageArea><ofd:PhysicalBox>0 0 {} {}</ofd:PhysicalBox></ofd:PageArea><ofd:DocumentRes>DocumentRes.xml</ofd:DocumentRes></ofd:CommonData><ofd:Pages>{}</ofd:Pages></ofd:Document>",
            next_id + 10,
            first.map(|page| page.width).unwrap_or(210.0),
            first.map(|page| page.height).unwrap_or(297.0),
            input
                .pages
                .iter()
                .enumerate()
                .map(|(index, _)| format!(
                    "<ofd:Page ID=\"{}\" BaseLoc=\"Pages/Page_{index}/Content.xml\"/>",
                    100 + index
                ))
                .collect::<String>()
        )
        .as_bytes(),
    )?;

    let fonts = input.font.as_ref().map(|font| {
        format!(
            "<ofd:Fonts><ofd:Font ID=\"{font_id}\" FontName=\"{}\" Family=\"PoTools\" Style=\"Normal\" Weight=\"Normal\">{}</ofd:Font></ofd:Fonts>",
            escape_xml(font.name),
            font.bytes
                .map(|_| format!("<ofd:FontFile>fonts/{}</ofd:FontFile>", escape_xml(font.name)))
                .unwrap_or_default()
        )
    });
    let media = media_ids
        .iter()
        .map(|(name, id)| format!(
            "<ofd:MultiMedia ID=\"{id}\" Type=\"Image\"><ofd:MediaFile>Imgs/{}</ofd:MediaFile></ofd:MultiMedia>",
            escape_xml(name)
        ))
        .collect::<String>();
    add(
        &mut zip,
        "Doc_0/DocumentRes.xml",
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<ofd:Res xmlns:ofd=\"{NS}\" BaseLoc=\"Res\">{}{}</ofd:Res>",
            fonts.unwrap_or_default(),
            if media.is_empty() {
                String::new()
            } else {
                format!("<ofd:MultiMedias>{media}</ofd:MultiMedias>")
            }
        )
        .as_bytes(),
    )?;
    if let Some(font) = input.font.as_ref().filter(|font| font.bytes.is_some()) {
        add(
            &mut zip,
            &format!("Doc_0/Res/fonts/{}", font.name),
            font.bytes.unwrap_or_default(),
        )?;
    }
    for page in &input.pages {
        for image in &page.images {
            add(&mut zip, &format!("Doc_0/Res/Imgs/{}", image.name), image.bytes)?;
        }
    }

    for (index, page) in input.pages.iter().enumerate() {
        let mut objects = String::new();
        for image in &page.images {
            let Some(id) = media_id_of(&image.name) else { continue };
            let object_id = ids(&mut next_id);
            objects.push_str(&format!(
                "<ofd:ImageObject ID=\"{object_id}\" CTM=\"{} 0 0 {}\" BBox=\"{} {} {} {}\" ResourceID=\"{id}\"/>",
                image.width, image.height, image.x, image.y, image.width, image.height
            ));
        }
        for line in &page.texts {
            // TS: Array.from(line.text).length || 1 — code points, not UTF-16.
            let chars = line.text.chars().count().max(1) as f64;
            let delta = format!("{:.3}", line.width / chars);
            let object_id = ids(&mut next_id);
            objects.push_str(&format!(
                "<ofd:TextObject ID=\"{object_id}\" XBound=\"{:.2}\" YBound=\"{:.2}\" Font=\"{font_id}\" Size=\"{:.2}\"><ofd:TextCode X=\"0\" Y=\"0\" DeltaX=\"1 {delta}\">{}</ofd:TextCode></ofd:TextObject>",
                line.x,
                line.y,
                line.size,
                escape_xml(&line.text)
            ));
        }
        let layer_id = ids(&mut next_id);
        add(
            &mut zip,
            &format!("Doc_0/Pages/Page_{index}/Content.xml"),
            format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<ofd:Page xmlns:ofd=\"{NS}\"><ofd:Content><ofd:Layer ID=\"{layer_id}\" Type=\"Body\">{objects}</ofd:Layer></ofd:Content></ofd:Page>"
            )
            .as_bytes(),
        )?;
        // BaseLoc points at a directory, so the page size lives beside
        // Content.xml (TS comment preserved).
        add(
            &mut zip,
            &format!("Doc_0/Pages/Page_{index}/Page.xml"),
            format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<ofd:Page xmlns:ofd=\"{NS}\"><ofd:Area><ofd:PhysicalBox>0 0 {:.2} {:.2}</ofd:PhysicalBox></ofd:Area></ofd:Page>",
                page.width, page.height
            )
            .as_bytes(),
        )?;
    }

    zip.finish().map_err(failed).map(Cursor::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conversions_match_lib_ofd() {
        assert!((pt_to_mm(72.0) - 25.4).abs() < 1e-9);
        assert!((mm_to_pt(25.4) - 72.0).abs() < 1e-9);
    }

    #[test]
    fn text_delta_splits_over_code_points() {
        let chars = "中文ab".chars().count().max(1) as f64;
        assert_eq!(format!("{:.3}", 20.0 / chars), "5.000");
        let empty = "".chars().count().max(1) as f64;
        assert_eq!(empty, 1.0);
    }
}
