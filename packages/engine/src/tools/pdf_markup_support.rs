use crate::EngineError;
use lopdf::Document;
use serde_json::Value;

pub(super) fn parse_pages(raw: &str, total: usize) -> Result<Vec<u32>, EngineError> {
    potools_core::pages::parse_page_ranges(raw, total)
        .map(|pages| pages.into_iter().map(|page| page as u32).collect())
        .map_err(|error| EngineError::new("bad_page_range", error.to_string()))
}

pub(super) fn string<'a>(o: &'a Value, key: &str, default: &'a str) -> &'a str {
    o.get(key).and_then(Value::as_str).unwrap_or(default)
}
pub(super) fn number(o: &Value, key: &str, default: f64) -> f64 {
    o.get(key).and_then(Value::as_f64).unwrap_or(default)
}
pub(super) fn boolean(o: &Value, key: &str, default: bool) -> bool {
    o.get(key).and_then(Value::as_bool).unwrap_or(default)
}
pub(super) fn parse_color(raw: &str) -> Result<[f64; 3], EngineError> {
    let h = raw.trim().trim_start_matches('#');
    let Ok(n) = u32::from_str_radix(h, 16) else {
        return Ok([0.0, 0.0, 0.0]);
    };
    if h.len() != 6 {
        return Ok([0.0, 0.0, 0.0]);
    }
    Ok([
        ((n >> 16) & 255) as f64 / 255.0,
        ((n >> 8) & 255) as f64 / 255.0,
        (n & 255) as f64 / 255.0,
    ])
}
pub(super) fn align(raw: &str) -> &'static str {
    if raw == "left" {
        "left"
    } else if raw == "right" {
        "right"
    } else {
        "center"
    }
}
pub(super) fn position_center(
    position: &str,
    width: f64,
    height: f64,
    margin: f64,
    text_width: f64,
    line_height: f64,
) -> (f64, f64) {
    let (vertical, horizontal) = if position == "center" {
        ("middle", "center")
    } else {
        position.split_once('-').unwrap_or(("middle", "center"))
    };
    let x = match horizontal {
        "left" => margin + text_width / 2.0,
        "right" => width - margin - text_width / 2.0,
        _ => width / 2.0,
    };
    let y = match vertical {
        "top" => margin + line_height / 2.0,
        "bottom" => height - margin - line_height / 2.0,
        _ => height / 2.0,
    };
    (x, y)
}
pub(super) fn user_space(width: f64, height: f64, rotation: f64, x: f64, y: f64) -> (f64, f64) {
    match (rotation.round() as i32).rem_euclid(360) {
        90 => (y, x),
        180 => (width - x, height - y),
        270 => (width - y, height - x),
        _ => (x, height - y),
    }
}
pub(super) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect()
}
pub(super) fn save(doc: &mut Document) -> Result<Vec<u8>, EngineError> {
    let mut out = std::io::Cursor::new(Vec::new());
    doc.save_to(&mut out)
        .map_err(|e| EngineError::new("write_failed", format!("无法写入 PDF：{e}")))?;
    Ok(out.into_inner())
}
pub(super) fn bad(message: &str) -> EngineError {
    EngineError::new("bad_request", message)
}
pub(super) fn pdf_error(message: &str) -> EngineError {
    let encrypted = message.to_ascii_lowercase().contains("encrypt")
        || message.to_ascii_lowercase().contains("password");
    EngineError::new(
        if encrypted {
            "encrypted_document"
        } else {
            "unreadable_file"
        },
        if encrypted {
            format!("PDF 受密码保护，无法读取：{message}")
        } else {
            format!("无法读取 PDF：{message}")
        },
    )
}
