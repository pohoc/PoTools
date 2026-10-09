//! PDF object merging and tile placement for invoice imposition.
use super::super::pages;
use super::{err, load, EngineResult};
use crate::InputFile;
use lopdf::{Dictionary, Document, Object, ObjectId};

#[derive(Clone, Copy)]
pub(super) struct Tile {
    pub(super) form: ObjectId,
    pub(super) width: f64,
    pub(super) height: f64,
}

#[derive(Clone, Copy)]
pub(super) struct Slot {
    pub(super) tile: usize,
    pub(super) x: f64,
    pub(super) y: f64,
    pub(super) width: f64,
    pub(super) height: f64,
    pub(super) scale: f64,
}

fn pdf_error(error: impl std::fmt::Display) -> crate::EngineError {
    err("unreadable_file", format!("无法读取 PDF：{error}"))
}

fn inherited_keys() -> [&'static [u8]; 4] {
    [b"MediaBox", b"CropBox", b"Rotate", b"Resources"]
}

/// Joins object tables with disjoint object numbers, then flattens each
/// source page's inherited geometry/resources onto the page dictionary.
pub(super) fn combine(inputs: &[InputFile]) -> EngineResult<(Document, Vec<ObjectId>)> {
    let mut output = Document::with_version("1.7");
    let mut next_id = 1u32;
    let mut catalog_seed: Option<(ObjectId, Dictionary)> = None;
    let mut pages_seed: Option<(ObjectId, Dictionary)> = None;
    let mut page_ids = Vec::new();
    let mut info_ref = None;

    for input in inputs {
        let mut source = load(input)?;
        source.renumber_objects_with(next_id);
        next_id = source.max_id.saturating_add(1);
        let catalog_id = source
            .trailer
            .get(b"Root")
            .and_then(Object::as_reference)
            .map_err(|error| pdf_error(format!("PDF 缺少 Catalog：{error}")))?;
        let catalog = source
            .get_dictionary(catalog_id)
            .map_err(pdf_error)?
            .clone();
        let pages_id = catalog
            .get(b"Pages")
            .and_then(Object::as_reference)
            .map_err(|error| pdf_error(format!("PDF 缺少页面树：{error}")))?;
        let pages_root = source.get_dictionary(pages_id).map_err(pdf_error)?.clone();
        if catalog_seed.is_none() {
            catalog_seed = Some((catalog_id, catalog));
            pages_seed = Some((pages_id, pages_root));
            info_ref = source
                .trailer
                .get(b"Info")
                .ok()
                .and_then(|object| object.as_reference().ok());
        }
        let current: Vec<ObjectId> = source.get_pages().into_values().collect();
        for page_id in &current {
            let mut page = source.get_dictionary(*page_id).map_err(pdf_error)?.clone();
            for key in inherited_keys() {
                if page.get(key).is_err() {
                    if let Some(value) = pages::inherited(&source, *page_id, key) {
                        page.set(key.to_vec(), value);
                    }
                }
            }
            source.objects.insert(*page_id, Object::Dictionary(page));
        }
        page_ids.extend(current);
        for (id, object) in source.objects {
            if !matches!(object.type_name().unwrap_or(b""), b"Catalog" | b"Pages") {
                output.objects.insert(id, object);
            }
        }
    }

    let (catalog_id, mut catalog) =
        catalog_seed.ok_or_else(|| err("bad_request", "请先添加 PDF 文件"))?;
    let (pages_id, mut root) =
        pages_seed.ok_or_else(|| err("unreadable_file", "PDF 缺少页面树"))?;
    for id in &page_ids {
        let mut page = output.get_dictionary(*id).map_err(pdf_error)?.clone();
        page.set("Parent", Object::Reference(pages_id));
        output.objects.insert(*id, Object::Dictionary(page));
    }
    root.set("Type", Object::Name(b"Pages".to_vec()));
    root.set(
        "Kids",
        Object::Array(page_ids.iter().copied().map(Object::Reference).collect()),
    );
    root.set("Count", Object::Integer(page_ids.len() as i64));
    catalog.set("Pages", Object::Reference(pages_id));
    output.objects.insert(pages_id, Object::Dictionary(root));
    output
        .objects
        .insert(catalog_id, Object::Dictionary(catalog));
    output.trailer.set("Root", Object::Reference(catalog_id));
    if let Some(info) = info_ref {
        output.trailer.set("Info", Object::Reference(info));
    }
    output.max_id = next_id.saturating_sub(1);
    Ok((output, page_ids))
}

fn grid_cells(
    count: usize,
    sheet: super::Size,
    gap: f64,
    margin: f64,
) -> Vec<(f64, f64, f64, f64)> {
    let columns = if count >= 9 {
        3
    } else if count >= 4 {
        if count == 6 {
            3
        } else {
            2
        }
    } else if count == 2 {
        2
    } else {
        1
    };
    let rows = count.div_ceil(columns);
    let width = (sheet.width - margin * 2.0 - gap * (columns - 1) as f64) / columns as f64;
    let height = (sheet.height - margin * 2.0 - gap * (rows - 1) as f64) / rows as f64;
    (0..count)
        .map(|index| {
            let col = index % columns;
            let row = index / columns;
            (
                margin + col as f64 * (width + gap),
                margin + row as f64 * (height + gap),
                width,
                height,
            )
        })
        .collect()
}

pub(super) fn grid_slots(
    tiles: &[Tile],
    sheet: super::Size,
    per_sheet: usize,
    gap: f64,
    margin: f64,
    column_first: bool,
) -> Vec<Vec<Slot>> {
    let cells = grid_cells(per_sheet, sheet, gap, margin);
    let mut order: Vec<usize> = (0..cells.len()).collect();
    order.sort_by(|left, right| {
        let a = cells[*left];
        let b = cells[*right];
        if column_first {
            a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1))
        } else {
            a.1.total_cmp(&b.1).then(a.0.total_cmp(&b.0))
        }
    });
    tiles
        .chunks(per_sheet)
        .enumerate()
        .map(|(block_index, chunk)| {
            chunk
                .iter()
                .enumerate()
                .map(|(position, tile)| {
                    let cell = cells[order[position]];
                    Slot {
                        tile: block_index * per_sheet + position,
                        x: cell.0,
                        y: cell.1,
                        width: cell.2,
                        height: cell.3,
                        scale: (cell.2 / tile.width).min(cell.3 / tile.height).min(1.0),
                    }
                })
                .collect()
        })
        .collect()
}

pub(super) fn shelf_slots(
    tiles: &[Tile],
    sheet: super::Size,
    gap: f64,
    margin: f64,
    column_first: bool,
) -> Vec<Vec<Slot>> {
    let usable_a = (if column_first {
        sheet.height
    } else {
        sheet.width
    }) - margin * 2.0;
    let usable_b = (if column_first {
        sheet.width
    } else {
        sheet.height
    }) - margin * 2.0;
    let mut sheets: Vec<Vec<Slot>> = Vec::new();
    let mut slots = Vec::new();
    let (mut a_cursor, mut b_used, mut band_b) = (0.0, 0.0, 0.0);
    for (tile_index, tile) in tiles.iter().enumerate() {
        let (along, across) = if column_first {
            (tile.height, tile.width)
        } else {
            (tile.width, tile.height)
        };
        let scale = 1.0f64.min(usable_a / along).min(usable_b / across);
        let (a, b) = (along * scale, across * scale);
        if !slots.is_empty() && a_cursor + gap + a > usable_a {
            b_used += band_b + gap;
            band_b = 0.0;
            a_cursor = 0.0;
        }
        if b_used + b > usable_b && !slots.is_empty() {
            sheets.push(slots);
            slots = Vec::new();
            b_used = 0.0;
            band_b = 0.0;
            a_cursor = 0.0;
        }
        slots.push(Slot {
            tile: tile_index,
            x: if column_first {
                margin + b_used
            } else {
                margin + a_cursor
            },
            y: if column_first {
                margin + a_cursor
            } else {
                margin + b_used
            },
            width: if column_first { b } else { a },
            height: if column_first { a } else { b },
            scale,
        });
        a_cursor += a + gap;
        band_b = band_b.max(b);
    }
    if !slots.is_empty() {
        sheets.push(slots);
    }
    sheets
}

pub(super) fn natural_cmp(left: &str, right: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let a = left.to_lowercase();
    let b = right.to_lowercase();
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        let ca = a[i..].chars().next().unwrap();
        let cb = b[j..].chars().next().unwrap();
        if ca.is_ascii_digit() && cb.is_ascii_digit() {
            let end_a = a[i..]
                .find(|c: char| !c.is_ascii_digit())
                .map(|n| i + n)
                .unwrap_or(a.len());
            let end_b = b[j..]
                .find(|c: char| !c.is_ascii_digit())
                .map(|n| j + n)
                .unwrap_or(b.len());
            let num_a = a[i..end_a].trim_start_matches('0');
            let num_b = b[j..end_b].trim_start_matches('0');
            let cmp = num_a.len().cmp(&num_b.len()).then(num_a.cmp(num_b));
            if cmp != Ordering::Equal {
                return cmp;
            }
            i = end_a;
            j = end_b;
        } else {
            let cmp = ca.cmp(&cb);
            if cmp != Ordering::Equal {
                return cmp;
            }
            i += ca.len_utf8();
            j += cb.len_utf8();
        }
    }
    (a.len() - i).cmp(&(b.len() - j))
}
