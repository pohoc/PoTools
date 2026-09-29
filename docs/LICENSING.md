# Licensing and release readiness

## Project license

PoTools-authored source code is licensed under MIT. The canonical text is [`../LICENSE`](../LICENSE), and workspace package metadata declares `MIT`. The Tauri bundle declares the same SPDX identifier and uses the root license file for installer metadata.

This grant covers only material copyrightable by the PoTools authors. Third-party packages, models, fonts, binaries, and other assets keep their original licenses and notices. Do not describe a release as MIT-only unless its complete dependency and distribution path has been reviewed.

## Distribution licensing routes

The macOS DMG does not attach the deprecated system disk-image license panel. On first launch, the app presents the PoTools MIT agreement in its own localized screen; the language selector and acceptance prompt sit below the scrollable agreement. The local processing engine starts only after the user accepts. Windows continues to show the license in the NSIS installer.

All bundled third-party components are permissively licensed; no copyleft component is bundled with the application. The components with dedicated notice obligations are:

| Component | Current use | License | Required before distribution |
| --- | --- | --- | --- |
| Hickory DNS 0.24.4 | Native desktop DNS queries using the OS resolver configuration | MIT OR Apache-2.0 | Keep both upstream license texts and the current version in the installed notices. |
| MediaPipe Tasks Vision + Selfie Segmentation model | Local person masking in the image studio | Apache-2.0 | Retain the Apache-2.0 text (`Apache-2.0.txt`) and model attribution in the installed notices. |
| PaddleOCR PP-OCRv6 models + dictionary | Local OCR detection/recognition | Apache-2.0 | Retain the Apache-2.0 text and model attribution in the installed notices. |
| pdf.js (pdfjs-dist) | Browser PDF rendering and text extraction | Apache-2.0 | Retain the Apache-2.0 text in the installed notices. |
| onnxruntime-web | Local OCR WebAssembly inference | MIT | Retain the copyright notice per the MIT license. |
| WebKitGTK (Linux only) | System webview, provided by the distribution | LGPL-2.1-or-later | Satisfied by platform libraries; PoTools does not bundle it. Verify the target distribution ships a compliant build. |

## Bundled third-party material

- `apps/web/public/licenses/THIRD_PARTY_NOTICES.md` is included in the app and lists the direct runtime components and known exceptions.
- `Apache-2.0.txt` covers MediaPipe Tasks Vision, the bundled segmentation model, and the PaddleOCR PP-OCRv6 models.
- `Hickory-DNS-MIT.txt` and `Hickory-DNS-Apache-2.0.txt` retain the licenses for the native DNS resolver and protocol crates.
- JavaScript and Rust dependency trees include several additional permissive and notice-based licenses. The inventory must be refreshed for each release.

## Release checklist

1. Regenerate `apps/web/public/licenses/DEPENDENCY_LICENSES.json` with `pnpm licenses:inventory`; review it alongside `pnpm licenses list --json -r --long` and `cargo metadata --format-version 1 --manifest-path apps/desktop/Cargo.toml`. The script fails on any `Unknown` npm license or Rust crate without a declared license — resolve those before shipping.
2. Review newly added, unknown, dual-licensed, copyleft, model, and platform-specific components; retain the chosen license text and copyright notices in the installed app. If a copyleft component is ever introduced, document its distribution route here before release.
3. Inspect each platform installer and confirm its About/license view exposes the applicable notices and license texts.
4. Verify the release source archive contains the exact source and build instructions needed for the dependency licensing route.

This checklist records current engineering findings, not a legal opinion. Reassess it when dependency versions, build resources, or release targets change.
