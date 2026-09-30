//! EPUB 3 writer ported from `lib/epub.ts` (`chapterize`, `writeEpub`,
//! `chapterXhtml`) onto the `zip` crate. Output must match the TS byte-for-
//! byte where it is deterministic: the exact CSS, opf/nav/ncx templates, the
//! `urn:uuid:` + `Date.now().toString(36)` uid and the `dcterms:modified`
//! timestamp (seconds, no fraction). The `mimetype` entry is written first
//! and STORED, as EPUB requires.

use super::writers::escape_html;
use super::FlowBlock;
use crate::EngineError;
use chrono::Utc;
use std::io::{Cursor, Write};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

type EngineResult<T> = Result<T, EngineError>;

/// Chapter splitting mode (TS `chapterize(flow, by)`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum ChapterBy {
    Heading,
    Page,
}

/// One image carried in the book (TS `EpubImage`).
pub(crate) struct EpubImage {
    pub name: String,
    pub bytes: Vec<u8>,
}

/// One chapter (TS `EpubChapter`): title plus the flow blocks it contains.
pub(crate) struct EpubChapter {
    pub title: String,
    pub blocks: Vec<FlowBlock>,
}

/// Inputs for [`write_epub`] (TS `EpubInput`).
pub(crate) struct EpubInput<'a> {
    pub title: &'a str,
    pub author: &'a str,
    pub chapters: Vec<EpubChapter>,
    pub images: Vec<EpubImage>,
}

/// The exact stylesheet from `lib/epub.ts`.
const CSS: &str = "body{font-family:serif;line-height:1.6;margin:1.5em;color:#1f2430}\n\
h1,h2,h3{line-height:1.3}img{max-width:100%;height:auto}\n\
hr{margin:2em 0;border:0;border-top:1px solid #ccc}\n\
.page{color:#8a93a5;font-size:.8em;margin-top:2em}\n";

/// Ported `chapterize`. In heading mode a level ≤ 2 heading opens a chapter
/// titled with its text and is consumed (not repeated in the body); before
/// any chapter opens, one titled 正文 starts. In page mode every page change
/// opens `第 N 页`, with `chapters.length + 1` when the page is unknown. An
/// empty result falls back to a single 正文 chapter holding the whole flow.
pub(crate) fn chapterize(flow: &[FlowBlock], by: ChapterBy) -> Vec<EpubChapter> {
    let mut chapters: Vec<EpubChapter> = Vec::new();
    for block in flow {
        if matches!(block, FlowBlock::PageBreak) {
            continue;
        }
        match by {
            ChapterBy::Heading => {
                if let FlowBlock::Heading { level, text, .. } = block {
                    if *level <= 2 {
                        chapters.push(EpubChapter {
                            title: text.clone(),
                            blocks: Vec::new(),
                        });
                        continue;
                    }
                }
                if chapters.is_empty() {
                    chapters.push(EpubChapter {
                        title: "正文".to_owned(),
                        blocks: Vec::new(),
                    });
                }
            }
            ChapterBy::Page => {
                let page = block_page(block);
                if chapters.is_empty() || page != last_page(&chapters) {
                    let label = if page == 0 {
                        chapters.len() + 1
                    } else {
                        page as usize
                    };
                    chapters.push(EpubChapter {
                        title: format!("第 {label} 页"),
                        blocks: Vec::new(),
                    });
                }
            }
        }
        chapters
            .last_mut()
            .expect("chapter exists")
            .blocks
            .push(block.clone());
    }
    if chapters.is_empty() {
        chapters.push(EpubChapter {
            title: "正文".to_owned(),
            blocks: flow.to_vec(),
        });
    }
    chapters
}

/// TS `pageOf`: image/heading/paragraph/list blocks carry their page.
fn block_page(block: &FlowBlock) -> u32 {
    match block {
        FlowBlock::Heading { page, .. }
        | FlowBlock::Paragraph { page, .. }
        | FlowBlock::List { page, .. }
        | FlowBlock::Image { page, .. } => *page,
        FlowBlock::PageBreak => 0,
    }
}

/// The TS `lastPage` tracks the previous block's page, persisted across
/// iterations; recomputing it from the last pushed block is equivalent.
fn last_page(chapters: &[EpubChapter]) -> u32 {
    chapters
        .last()
        .and_then(|chapter| chapter.blocks.last())
        .map(block_page)
        .unwrap_or(0)
}

/// Ported `chapterXhtml`: one XHTML body with heading/paragraph/list/figure/
/// rule rendering. Figures render only when the book carries images; the
/// `figure N` alt counter only counts rendered figures (TS behavior).
fn chapter_xhtml(chapter: &EpubChapter, has_images: bool) -> String {
    let mut body: Vec<String> = Vec::new();
    let mut open_list: Option<&'static str> = None;
    let close_list = |body: &mut Vec<String>, open_list: &mut Option<&'static str>| {
        if let Some(tag) = open_list {
            body.push(format!("</{tag}>"));
        }
        *open_list = None;
    };
    let mut image_index = 0usize;
    for block in &chapter.blocks {
        match block {
            FlowBlock::Heading { level, text, .. } => {
                close_list(&mut body, &mut open_list);
                let level = (*level).clamp(2, 6);
                body.push(format!("<h{level}>{}</h{level}>", escape_html(text)));
            }
            FlowBlock::Paragraph { text, bold, .. } => {
                close_list(&mut body, &mut open_list);
                let content = escape_html(text);
                body.push(if *bold {
                    format!("<p><strong>{content}</strong></p>")
                } else {
                    format!("<p>{content}</p>")
                });
            }
            FlowBlock::List { ordered, items, .. } => {
                let tag = if *ordered { "ol" } else { "ul" };
                if open_list != Some(tag) {
                    close_list(&mut body, &mut open_list);
                    body.push(format!("<{tag}>"));
                    open_list = Some(tag);
                }
                for item in items {
                    body.push(format!("<li>{}</li>", escape_html(item)));
                }
            }
            FlowBlock::Image { src, .. } => {
                close_list(&mut body, &mut open_list);
                if let Some(name) = src {
                    if has_images {
                        image_index += 1;
                        body.push(format!(
                            "<figure><img src=\"../images/{}\" alt=\"figure {image_index}\"/></figure>",
                            escape_html(name)
                        ));
                    }
                }
            }
            FlowBlock::PageBreak => {
                close_list(&mut body, &mut open_list);
                body.push("<hr/>".to_owned());
            }
        }
    }
    close_list(&mut body, &mut open_list);
    format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n\
<!DOCTYPE html>\n\
<html xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:epub=\"http://www.idpf.org/2007/ops\" xml:lang=\"zh\">\n\
<head><title>{}</title><link rel=\"stylesheet\" type=\"text/css\" href=\"../style.css\"/></head>\n\
<body>{}</body></html>\n",
        escape_html(&chapter.title),
        body.join("\n")
    )
}

fn media_type(name: &str) -> &'static str {
    if name.ends_with(".png") {
        "image/png"
    } else if name.ends_with(".jpeg") || name.ends_with(".jpg") {
        "image/jpeg"
    } else {
        "image/webp"
    }
}

/// `Date.now().toString(36)` — lowercase base-36 of the epoch milliseconds.
fn timestamp_base36() -> String {
    let millis = Utc::now().timestamp_millis();
    let negative = millis < 0;
    let mut value = millis.unsigned_abs();
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
        if value == 0 {
            break;
        }
    }
    if negative {
        out.push(b'-');
    }
    out.reverse();
    String::from_utf8(out).expect("base-36 digits are ASCII")
}

/// Ported `writeEpub`: EPUB 3 archive with the NCX fallback, mimetype STORED
/// first, everything else DEFLATE.
pub(crate) fn write_epub(input: &EpubInput<'_>) -> EngineResult<Vec<u8>> {
    let failed = |error: zip::result::ZipError| {
        EngineError::new("write_failed", format!("无法生成 EPUB：{error}"))
    };
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let deflated = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .compression_level(Some(6));
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));

    let mut add = |name: &str, options: SimpleFileOptions, content: &[u8]| -> EngineResult<()> {
        zip.start_file(name, options).map_err(failed)?;
        zip.write_all(content)
            .map_err(|error| EngineError::new("write_failed", format!("无法生成 EPUB：{error}")))
    };
    add("mimetype", stored, b"application/epub+zip")?;
    add(
        "META-INF/container.xml",
        deflated,
        b"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<container version=\"1.0\" xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\"><rootfiles><rootfile full-path=\"OEBPS/content.opf\" media-type=\"application/oebps-package+xml\"/></rootfiles></container>",
    )?;
    add("OEBPS/style.css", deflated, CSS.as_bytes())?;

    let fallback;
    let chapters: &[EpubChapter] = if input.chapters.is_empty() {
        fallback = vec![EpubChapter {
            title: input.title.to_owned(),
            blocks: Vec::new(),
        }];
        &fallback
    } else {
        &input.chapters
    };
    let uid = format!("urn:uuid:{}", timestamp_base36());
    let manifest_items: String = chapters
        .iter()
        .enumerate()
        .map(|(index, _)| format!(
            "<item id=\"ch{index}\" href=\"text/chapter{}.xhtml\" media-type=\"application/xhtml+xml\"/>",
            index + 1
        ))
        .collect();
    let image_items: String = input
        .images
        .iter()
        .enumerate()
        .map(|(index, image)| {
            format!(
                "<item id=\"img{index}\" href=\"images/{}\" media-type=\"{}\"/>",
                escape_html(&image.name),
                media_type(&image.name)
            )
        })
        .collect();
    let spine: String = chapters
        .iter()
        .enumerate()
        .map(|(index, _)| format!("<itemref idref=\"ch{index}\" linear=\"yes\"/>"))
        .collect();
    let modified = Utc::now().format("%Y-%m-%dT%H:%M:%S");

    add(
        "OEBPS/content.opf",
        deflated,
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<package xmlns=\"http://www.idpf.org/2007/opf\" version=\"3.0\" unique-identifier=\"pub-id\" xml:lang=\"zh\">\n\
<metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\">\n\
<dc:identifier id=\"pub-id\">{}</dc:identifier>\n\
<dc:title>{}</dc:title>\n\
<dc:creator>{}</dc:creator>\n\
<dc:language>zh</dc:language>\n\
<meta property=\"dcterms:modified\">{modified}</meta>\n\
</metadata>\n\
<manifest><item id=\"nav\" href=\"nav.xhtml\" media-type=\"application/xhtml+xml\" properties=\"nav\"/><item id=\"ncx\" href=\"toc.ncx\" media-type=\"application/x-dtbncx+xml\"/>{manifest_items}{image_items}</manifest>\n\
<spine toc=\"ncx\">{spine}</spine>\n\
</package>",
            escape_html(&uid),
            escape_html(input.title),
            escape_html(input.author)
        )
        .as_bytes(),
    )?;
    add(
        "OEBPS/nav.xhtml",
        deflated,
        format!(
            "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!DOCTYPE html>\n<html xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:epub=\"http://www.idpf.org/2007/ops\" xml:lang=\"zh\"><head><title>{}</title></head><body><nav epub:type=\"toc\" id=\"toc\"><h1>{}</h1><ol>{}</ol></nav></body></html>",
            escape_html(input.title),
            escape_html(input.title),
            chapters
                .iter()
                .enumerate()
                .map(|(index, chapter)| format!(
                    "<li><a href=\"text/chapter{}.xhtml\">{}</a></li>",
                    index + 1,
                    escape_html(&chapter.title)
                ))
                .collect::<String>()
        )
        .as_bytes(),
    )?;
    add(
        "OEBPS/toc.ncx",
        deflated,
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<ncx xmlns=\"http://www.daisy.org/z3986/2005/ncx/\" version=\"2005-1\"><head><meta name=\"dtb:uid\" content=\"{}\"/></head><docTitle><text>{}</text></docTitle><navMap>{}</navMap></ncx>",
            escape_html(&uid),
            escape_html(input.title),
            chapters
                .iter()
                .enumerate()
                .map(|(index, chapter)| format!(
                    "<navPoint id=\"np{index}\" playOrder=\"{}\"><navLabel><text>{}</text></navLabel><content src=\"text/chapter{}.xhtml\"/></navPoint>",
                    index + 1,
                    escape_html(&chapter.title),
                    index + 1
                ))
                .collect::<String>()
        )
        .as_bytes(),
    )?;
    let has_images = !input.images.is_empty();
    for (index, chapter) in chapters.iter().enumerate() {
        add(
            &format!("OEBPS/text/chapter{}.xhtml", index + 1),
            deflated,
            chapter_xhtml(chapter, has_images).as_bytes(),
        )?;
    }
    for image in &input.images {
        add(
            &format!("OEBPS/images/{}", image.name),
            deflated,
            &image.bytes,
        )?;
    }
    zip.finish().map_err(failed).map(Cursor::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn heading(level: usize, text: &str) -> FlowBlock {
        FlowBlock::Heading {
            level,
            text: text.to_owned(),
            page: 1,
        }
    }

    #[test]
    fn heading_mode_consumes_top_headings_and_defaults_to_body() {
        let flow = vec![
            heading(1, "第一章"),
            FlowBlock::Paragraph {
                text: "a".into(),
                page: 1,
                bold: false,
            },
            heading(3, "小节"),
        ];
        let chapters = chapterize(&flow, ChapterBy::Heading);
        assert_eq!(chapters.len(), 1);
        assert_eq!(chapters[0].title, "第一章");
        assert!(matches!(chapters[0].blocks[0], FlowBlock::Paragraph { .. }));
        assert!(matches!(
            chapters[0].blocks[1],
            FlowBlock::Heading { level: 3, .. }
        ));
    }

    #[test]
    fn page_mode_titles_and_empty_fallback() {
        let flow = vec![
            FlowBlock::Paragraph {
                text: "a".into(),
                page: 1,
                bold: false,
            },
            FlowBlock::Paragraph {
                text: "b".into(),
                page: 2,
                bold: false,
            },
        ];
        let chapters = chapterize(&flow, ChapterBy::Page);
        assert_eq!(
            chapters
                .iter()
                .map(|c| c.title.as_str())
                .collect::<Vec<_>>(),
            vec!["第 1 页", "第 2 页"]
        );
        let fallback = chapterize(&[], ChapterBy::Page);
        assert_eq!(fallback.len(), 1);
        assert_eq!(fallback[0].title, "正文");
    }

    #[test]
    fn uid_base36_matches_js_shape() {
        let uid = timestamp_base36();
        assert!(!uid.is_empty());
        assert!(uid
            .chars()
            .all(|c: char| c.is_ascii_digit() || c.is_ascii_lowercase()));
    }

    #[test]
    fn media_type_covers_book_images() {
        assert_eq!(media_type("p1-01.png"), "image/png");
        assert_eq!(media_type("x.jpeg"), "image/jpeg");
        assert_eq!(media_type("x.webp"), "image/webp");
    }
}
