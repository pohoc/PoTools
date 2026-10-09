//! End-to-end regression for `ofd-to-pdf` with a base64 host font, which used to
//! panic the wasm build.
//!
//! The font is the app's own bundled OFL asset rather than a macOS system file,
//! so the probe runs on every platform instead of silently returning early (and
//! therefore passing vacuously) wherever `/Library/Fonts` does not exist.
//!
//! The assertion is deliberately on the *result*: `run_tool` converts a panic
//! into an `internal` error, so a bare "did not crash" check would no longer
//! detect a regression.

use base64::Engine as _;
use potools_engine::{InputFile, RunContext};
use serde_json::json;

const SAMPLE_OFD: &str = "../../samples/sample-office.ofd";
const BUNDLED_FONT: &str = "../../apps/web/public/fonts/NotoSansSC-Regular.ttf";

#[test]
fn ofd_to_pdf_embeds_a_base64_host_font() {
    let ofd = std::fs::read(SAMPLE_OFD).expect("sample OFD is committed");
    let font_bytes = std::fs::read(BUNDLED_FONT).expect("bundled CJK font is committed");
    let font_b64 = base64::engine::general_purpose::STANDARD.encode(font_bytes);
    let runtime_data = json!({
        "systemFonts": [{ "name": "NotoSansSC-Regular.ttf", "bytesBase64": font_b64 }],
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

    let result = potools_engine::run_tool(&context)
        .expect("ofd-to-pdf must not fail with a base64 host font")
        .expect("ofd-to-pdf must be routed by the engine");

    let artifact = result
        .artifacts
        .first()
        .expect("ofd-to-pdf must produce an artifact");
    assert_eq!(artifact.kind, "pdf");
    assert!(
        artifact.name.ends_with(".pdf"),
        "unexpected artifact name: {}",
        artifact.name
    );
    assert!(
        artifact.bytes.starts_with(b"%PDF-"),
        "artifact is not a PDF document"
    );
}
