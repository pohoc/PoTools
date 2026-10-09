# Third-party notices

PoTools-authored source code is licensed under the MIT License in the repository root. This does not relicense third-party code, binaries, or models included in the application; each component below remains under its own terms. The app bundles a copy of this notice and the listed license texts.

The machine-readable JavaScript and Rust dependency inventory is `DEPENDENCY_LICENSES.json`. It records package versions and declared SPDX license expressions; it is an inventory, not a replacement for the license texts or the release review.

## Rust engine (potools-engine / potools-core)

All tool logic runs in Rust crates authored for PoTools. Their third-party crate dependencies (PDF handling, imaging, cryptography, time zones, DNS, OOXML/zip writers) are dual-licensed permissive crates — predominantly MIT OR Apache-2.0 — and are enumerated with versions and license expressions in `DEPENDENCY_LICENSES.json`. Review the inventory for each release; retain license texts for any component whose SPDX expression requires notices.

## Tauri

The desktop host is built on Tauri 2 (MIT OR Apache-2.0). Platform webviews (WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux) are system-provided components; WebKitGTK is LGPL-2.1-or-later on Linux distributions and is satisfied by the platform libraries, not bundled by PoTools.

- https://tauri.app / https://github.com/tauri-apps/tauri

## pdf.js (pdfjs-dist)

The web worker renders PDF pages and extracts positioned text with pdf.js, licensed under the Apache License, Version 2.0.

- https://github.com/mozilla/pdf.js

## onnxruntime-web and PaddleOCR

Local OCR runs the PaddleOCR pipeline (`paddleocr`, MIT) on `onnxruntime-web` (MIT) with WebAssembly inference. The bundled PP-OCRv6 detection and recognition ONNX models and the character dictionary are from PaddleOCR, licensed under the Apache License, Version 2.0; the model files ship under `models/ocr/` in the app assets.

- https://github.com/microsoft/onnxruntime
- https://www.npmjs.com/package/paddleocr (pipeline) · https://github.com/PaddlePaddle/PaddleOCR (models)

## MediaPipe Tasks Vision and Selfie Segmentation model

PoTools bundles `@mediapipe/tasks-vision` 1.0.1 from Google AI Edge and the Selfie Segmentation model used for local person masking. The code and model are provided under the Apache License, Version 2.0. The license text is in `Apache-2.0.txt`.

- Code: https://github.com/google-ai-edge/mediapipe
- Model: https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite
- Model card: https://developers.google.com/static/ml-kit/images/vision/selfie-segmentation/selfie-model-card.pdf

## Hickory DNS

PoTools uses Hickory DNS 0.24.4 and `hickory-proto` 0.24.4 in the native desktop host to query records through the operating system's configured DNS resolvers. Both crates are dual-licensed under MIT OR Apache-2.0; their license texts are included as `Hickory-DNS-MIT.txt` and `Hickory-DNS-Apache-2.0.txt`.

- Source: https://github.com/hickory-dns/hickory-dns

## UTIF.js 3.1.0

PoTools uses UTIF.js to decode TIFF images in the Web application. It is licensed under the MIT License; the license text is included as `utif-LICENSE.txt`.

- Source: https://github.com/photopea/UTIF.js

## MPL-2.0 components (desktop binary)

The desktop binary statically links MPL-2.0 code that arrives through Tauri's own stack: `cssparser` and `selectors` (via `wry`/`tauri-utils` → `dom_query`), `dtoa-short` (via `cssparser`) and `option-ext` (via `dirs-sys`). MPL-2.0 is file-level copyleft: those files are not relicensed, their license text is included as `MPL-2.0.txt`, and their unmodified sources are the corresponding crates.io releases listed in `DEPENDENCY_LICENSES.json`.

- Source: https://crates.io/crates/cssparser, https://crates.io/crates/selectors, https://crates.io/crates/dtoa-short, https://crates.io/crates/option-ext

## Other dependencies

The JavaScript and Rust dependency trees include components under MIT, Apache-2.0, BSD, ISC, MPL-2.0, Unicode-3.0, Zlib, Unlicense, BlueOak-1.0.0, and other SPDX expressions. Individual package license files are retained with staged Node modules where those modules are copied.

The transitive `buffers@0.1.1` package omits a license field in its npm archive. Its upstream metadata history and Debian copyright record identify it as MIT; its notice is included in `MIT-buffers-0.1.1.txt`. Refresh and review the dependency inventory for every release as described in `docs/LICENSING.md` in the source tree.
