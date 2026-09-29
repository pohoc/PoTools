#[cfg(test)]
mod tests {
    use super::super::*;
    use serde_json::{json, Value};
    use std::path::PathBuf;

    fn fixture() -> Vec<u8> {
        let image = DynamicImage::ImageRgba8(RgbaImage::from_fn(40, 20, |x, y| {
            Rgba([x as u8, y as u8, 30, 255])
        }));
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, ImageFormat::Png).unwrap();
        bytes.into_inner()
    }

    fn invoke(tool: &str, options: Value) -> ToolResult {
        let bytes = fixture();
        let inputs = [crate::InputFile {
            id: "input-1".into(),
            name: "sample.png".into(),
            path: Some(PathBuf::from("sample.png")),
            bytes,
        }];
        let context = RunContext {
            tool,
            options: &options,
            locale: "zh-CN",
            inputs: &inputs,
            name_pattern: None,
            runtime_data: None,
        };
        run(&context).unwrap().unwrap()
    }

    #[test]
    fn resize_obeys_inside_dimensions_and_source_format() {
        let result = invoke("image-resize", json!({ "width": 10, "height": 10 }));
        let bytes = &result.artifacts[0].bytes;
        let image = image::load_from_memory(bytes).unwrap();
        assert_eq!(image.dimensions(), (10, 5));
        assert_eq!(result.artifacts[0].name, "sample-resized.png");
    }

    #[test]
    fn convert_emits_requested_format_and_source_id() {
        let result = invoke("image-convert", json!({ "format": "jpeg", "quality": 85 }));
        let artifact = &result.artifacts[0];
        assert_eq!(artifact.name, "sample-converted.jpg");
        assert_eq!(artifact.source_file_id.as_deref(), Some("input-1"));
        assert_eq!(
            image::guess_format(&artifact.bytes).unwrap(),
            ImageFormat::Jpeg
        );
    }

    #[test]
    fn info_is_json_with_dimensions_and_channels() {
        let result = invoke("image-info", json!({}));
        let rows: Value = serde_json::from_slice(&result.artifacts[0].bytes).unwrap();
        assert_eq!(rows[0]["width"], 40);
        assert_eq!(rows[0]["height"], 20);
        assert_eq!(rows[0]["format"], "png");
    }

    #[test]
    fn cutout_runs_through_native_cleanup() {
        let bytes = fixture();
        let inputs = [crate::InputFile {
            id: "i".into(),
            name: "x.png".into(),
            path: Some(PathBuf::from("x.png")),
            bytes,
        }];
        let options = json!({});
        let context = RunContext {
            tool: "image-cutout",
            options: &options,
            locale: "zh-CN",
            inputs: &inputs,
            name_pattern: None,
            runtime_data: None,
        };
        assert!(run(&context).unwrap().is_some());
    }
}
