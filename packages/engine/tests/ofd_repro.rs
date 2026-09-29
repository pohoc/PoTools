//! Repro for the ofd-to-pdf wasm panic with base64 host fonts.

use base64::Engine as _;
use potools_engine::{InputFile, RunContext};
use serde_json::json;

#[test]
fn ofd_to_pdf_with_base64_host_font_does_not_panic() {
    let ofd = std::fs::read("../../samples/sample-office.ofd").expect("sample ofd");
    let Ok(font_bytes) = std::fs::read("/Library/Fonts/Arial Unicode.ttf") else {
        // Font-dependent regression probe; skip on machines without the font.
        return;
    };
    let font_b64 = base64::engine::general_purpose::STANDARD.encode(font_bytes);
    let runtime_data = json!({
        "systemFonts": [{ "name": "Arial Unicode.ttf", "bytesBase64": font_b64 }],
    });
    let options = json!({});
    let inputs = [InputFile {
        id: "sample-office.ofd".into(),
        name: "sample-office.ofd".into(),
        path: None,
        bytes: ofd,
    }];
    let context = RunContext {
        tool: "ofd-to-pdf",
        options: &options,
        locale: "zh-CN",
        inputs: &inputs,
        name_pattern: None,
        runtime_data: Some(&runtime_data),
    };
    let _ = potools_engine::run_tool(&context);
}
