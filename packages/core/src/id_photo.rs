//! Identity photo preset data and pure sizing helpers.

use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdPhotoSize {
    pub id: String,
    pub label_key: String,
    pub description_key: String,
    pub width_mm: f64,
    pub height_mm: f64,
    pub width: u32,
    pub height: u32,
    pub dpi: Option<u16>,
    pub file_label: String,
}

const PRESETS: &str = include_str!("../catalog/id-photo.json");

pub fn id_photo_sizes() -> &'static [IdPhotoSize] {
    static SIZES: OnceLock<Vec<IdPhotoSize>> = OnceLock::new();
    SIZES.get_or_init(|| serde_json::from_str(PRESETS).expect("bundled ID photo presets are valid"))
}

pub fn get_id_photo_size(id: Option<&str>) -> &'static IdPhotoSize {
    let sizes = id_photo_sizes();
    sizes
        .iter()
        .find(|size| Some(size.id.as_str()) == id)
        .unwrap_or(&sizes[0])
}

pub fn print_size_300_dpi(id: Option<&str>) -> (u32, u32) {
    let size = get_id_photo_size(id);
    (
        ((size.width_mm / 25.4) * 300.0).round() as u32,
        ((size.height_mm / 25.4) * 300.0).round() as u32,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_parse_and_cover_known_ids() {
        let sizes = id_photo_sizes();
        assert!(sizes.len() >= 20);
        assert!(sizes.iter().any(|size| size.id == "one-inch"));
        assert!(sizes.iter().any(|size| size.id == "china-id-card"));
    }

    #[test]
    fn lookup_falls_back_to_first_preset() {
        assert_eq!(get_id_photo_size(None).id, id_photo_sizes()[0].id);
        assert_eq!(
            get_id_photo_size(Some("no-such-preset")).id,
            id_photo_sizes()[0].id
        );
        assert_eq!(get_id_photo_size(Some("one-inch")).id, "one-inch");
    }

    #[test]
    fn print_size_matches_one_inch_at_300_dpi() {
        let size = get_id_photo_size(Some("one-inch"));
        let (width, height) = print_size_300_dpi(Some("one-inch"));
        assert_eq!(
            (width, height),
            (
                (size.width_mm / 25.4 * 300.0).round() as u32,
                (size.height_mm / 25.4 * 300.0).round() as u32,
            )
        );
        assert_eq!((width, height), (295, 413));
    }
}
