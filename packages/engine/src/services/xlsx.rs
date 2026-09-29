//! Minimal XLSX writer ported from the web-only `lib/xlsx-browser.ts` so the
//! Rust engine can emit workbooks (OCR table export today, pdf-to-excel later).
//!
//! Faithful port details: inline-string cells, bold header row (style `s="1"`),
//! auto column widths clamped to `[8, 60]`, `dimension` always anchored at A1,
//! and a deflated zip container at compression level 6 to match the JSZip
//! output characteristics. Sheets are written exactly as given; filtering of
//! empty sheets is a caller decision.

use crate::EngineError;
use std::io::{Cursor, Write};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

/// One worksheet: its (already unique) name and its cell rows.
pub struct Sheet {
    pub name: String,
    pub rows: Vec<Vec<String>>,
}

/// Length of a string in UTF-16 code units, matching JavaScript `.length`.
pub(crate) fn js_len(value: &str) -> usize {
    value.chars().map(char::len_utf16).sum()
}

fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Excel column label: `1` → `A`, `27` → `AA`.
fn column_name(number: usize) -> String {
    let mut result = String::new();
    let mut value = number;
    while value > 0 {
        result.insert(0, char::from(b'A' + ((value - 1) % 26) as u8));
        value = (value - 1) / 26;
    }
    result
}

/// Replaces Excel-hostile sheet name characters, strips leading/trailing
/// apostrophes and truncates to Excel's 31-character limit.
pub fn sanitize_sheet_name(value: &str) -> String {
    let replaced: String = value
        .chars()
        .map(|c| if "\\/?*[]:".contains(c) { '-' } else { c })
        .collect();
    replaced.trim_matches('\'').chars().take(31).collect()
}

/// Case-insensitive sheet name dedupe ported from `ocr-browser.ts`. Appends
/// `" (n)"`, re-truncating the base so the candidate stays within 31 chars.
/// `taken` holds the already-used names lowercased and is updated in place.
pub fn unique_sheet_name(base: &str, taken: &mut std::collections::HashSet<String>) -> String {
    let mut candidate = base.to_string();
    if !taken.contains(&candidate.to_lowercase()) {
        taken.insert(candidate.to_lowercase());
        return candidate;
    }
    let mut suffix = 2;
    loop {
        let marker = format!(" ({suffix})");
        let truncated: String = base.chars().take(31usize.saturating_sub(marker.len())).collect();
        candidate = format!("{truncated}{marker}");
        if !taken.contains(&candidate.to_lowercase()) {
            taken.insert(candidate.to_lowercase());
            return candidate;
        }
        suffix += 1;
    }
}

fn add_file(
    zip: &mut ZipWriter<Cursor<Vec<u8>>>,
    options: SimpleFileOptions,
    name: &str,
    content: &str,
) -> Result<(), EngineError> {
    let failed = |error: zip::result::ZipError| {
        EngineError::new("write_failed", format!("无法生成 XLSX：{error}"))
    };
    zip.start_file(name, options).map_err(failed)?;
    zip.write_all(content.as_bytes())
        .map_err(|error| EngineError::new("write_failed", format!("无法生成 XLSX：{error}")))
}

/// Builds the workbook bytes for the given sheets, in order.
pub fn write_xlsx(sheets: &[Sheet]) -> Result<Vec<u8>, EngineError> {
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .compression_level(Some(6));
    let names: Vec<String> = sheets
        .iter()
        .enumerate()
        .map(|(index, sheet)| {
            let name: String = sheet.name.chars().take(31).collect();
            if name.is_empty() {
                format!("Sheet{}", index + 1)
            } else {
                name
            }
        })
        .collect();
    let sheet_overrides: String = sheets
        .iter()
        .enumerate()
        .map(|(index, _)| format!(
            "<Override PartName=\"/xl/worksheets/sheet{}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>",
            index + 1
        ))
        .collect();
    let relationships: String = sheets
        .iter()
        .enumerate()
        .map(|(index, _)| format!(
            "<Relationship Id=\"rId{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet{}.xml\"/>",
            index + 1,
            index + 1
        ))
        .collect();
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    add_file(&mut zip, options, "[Content_Types].xml", &format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/><Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/>{sheet_overrides}</Types>"
    ))?;
    add_file(&mut zip, options, "_rels/.rels", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>")?;
    let workbook_sheets: String = names
        .iter()
        .enumerate()
        .map(|(index, name)| format!(
            "<sheet name=\"{}\" sheetId=\"{}\" r:id=\"rId{}\"/>",
            xml(name),
            index + 1,
            index + 1
        ))
        .collect();
    add_file(&mut zip, options, "xl/workbook.xml", &format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets>{workbook_sheets}</sheets></workbook>"
    ))?;
    add_file(&mut zip, options, "xl/styles.xml", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><fonts count=\"2\"><font><sz val=\"11\"/><name val=\"Calibri\"/></font><font><b/><sz val=\"11\"/><name val=\"Calibri\"/></font></fonts><fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill></fills><borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs><cellXfs count=\"2\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/><xf numFmtId=\"0\" fontId=\"1\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/></cellXfs><cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles></styleSheet>")?;
    add_file(&mut zip, options, "xl/_rels/workbook.xml.rels", &format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">{relationships}<Relationship Id=\"rId{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/></Relationships>",
        sheets.len() + 1
    ))?;
    for (index, sheet) in sheets.iter().enumerate() {
        add_file(&mut zip, options, &format!("xl/worksheets/sheet{}.xml", index + 1), &sheet_xml(sheet))?;
    }
    zip.finish()
        .map_err(|error| EngineError::new("write_failed", format!("无法生成 XLSX：{error}")))
        .map(Cursor::into_inner)
}

fn sheet_xml(sheet: &Sheet) -> String {
    let row_count = sheet.rows.len();
    let column_count = sheet.rows.iter().map(Vec::len).max().unwrap_or(0).max(1);
    let mut widths = vec![0.0f64; sheet.rows.iter().map(Vec::len).max().unwrap_or(0)];
    for row in &sheet.rows {
        for (column, cell) in row.iter().enumerate() {
            let candidate = ((js_len(cell) as f64 * 1.15).round() + 2.0).min(60.0);
            widths[column] = widths[column].max(8.0).max(candidate);
        }
    }
    let cols: String = widths
        .iter()
        .enumerate()
        .map(|(column, width)| format!(
            "<col min=\"{}\" max=\"{}\" width=\"{}\" customWidth=\"1\"/>",
            column + 1,
            column + 1,
            width
        ))
        .collect();
    let rows: String = sheet
        .rows
        .iter()
        .enumerate()
        .map(|(row_index, row)| {
            let cells: String = row
                .iter()
                .enumerate()
                .map(|(column, cell)| format!(
                    "<c r=\"{}{}\" t=\"inlineStr\"{}><is><t xml:space=\"preserve\">{}</t></is></c>",
                    column_name(column + 1),
                    row_index + 1,
                    if row_index == 0 { " s=\"1\"" } else { "" },
                    xml(cell)
                ))
                .collect();
            format!("<row r=\"{}\">{}</row>", row_index + 1, cells)
        })
        .collect();
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><dimension ref=\"A1:{}{}\"/><sheetViews><sheetView workbookViewId=\"0\"/></sheetViews><sheetFormatPr defaultRowHeight=\"15\"/><cols>{cols}</cols><sheetData>{rows}</sheetData><pageMargins left=\"0.7\" right=\"0.7\" top=\"0.75\" bottom=\"0.75\" header=\"0.3\" footer=\"0.3\"/></worksheet>",
        column_name(column_count),
        row_count.max(1)
    )
}
