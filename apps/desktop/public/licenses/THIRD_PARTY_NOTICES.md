# Third-party notices

PoTools-authored source code is licensed under the MIT License in the repository root. This does not relicense third-party code, binaries, or models included in the application; each component below remains under its own terms. The app bundles a copy of this notice and the listed license texts.

The machine-readable JavaScript and Rust dependency inventory is `DEPENDENCY_LICENSES.json`. It records package versions and declared SPDX license expressions; it is an inventory, not a replacement for the license texts or the release review.

## MuPDF.js 1.28.1

The local engine bundles MuPDF.js for PDF parsing, rasterization, and document inspection. It is licensed under AGPL-3.0-or-later. The license text is included as `MuPDF-AGPL-3.0.txt` and is also available from the [upstream repository](https://github.com/ArtifexSoftware/mupdf.js/blob/master/LICENSE).

PoTools may be distributed with this component through an AGPL-compliant open-source route, under an applicable commercial license, or after replacing MuPDF. A combined installer containing it must not be described as MIT-only. See `docs/LICENSING.md` in the source tree.

## Node.js runtime

Windows x64 and macOS builds bundle Node.js 22.20.0. Windows x86 bundles Node.js 20.20.2 to retain 32-bit Sharp support. The matching Node.js license and third-party notices are in `Node.js-22.20.0.txt` and `Node.js-20.20.2.txt`; each build stages the matching text beside its runtime as `engine/node-runtime-LICENSE.txt`.

- Sources: https://github.com/nodejs/node/tree/v22.20.0 and https://github.com/nodejs/node/tree/v20.20.2

## sharp and libvips

Image processing uses sharp under Apache-2.0 and platform-specific libvips binaries under LGPL-3.0-or-later. Runtime staging preserves the upstream package license files. Check the actual platform package versions and notices when producing each release target.

- sharp: https://github.com/lovell/sharp
- libvips: https://github.com/libvips/libvips

## MediaPipe Tasks Vision and Selfie Segmentation model

PoTools bundles `@mediapipe/tasks-vision` 1.0.1 from Google AI Edge and the Selfie Segmentation model used for local person masking. The code and model are provided under the Apache License, Version 2.0. The license text is in `Apache-2.0.txt`.

- Code: https://github.com/google-ai-edge/mediapipe
- Model: https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite
- Model card: https://developers.google.com/static/ml-kit/images/vision/selfie-segmentation/selfie-model-card.pdf

## Other dependencies

The JavaScript and Rust dependency trees include components under MIT, Apache-2.0, BSD, ISC, MPL-2.0, Unicode-3.0, Zlib, Unlicense, BlueOak-1.0.0, and other SPDX expressions. Individual package license files are retained with staged Node modules where those modules are copied. `jszip` is dual-licensed; PoTools uses its MIT option.

The transitive `buffers@0.1.1` package omits a license field in its npm archive. Its upstream metadata history and Debian copyright record identify it as MIT; its notice is included in `MIT-buffers-0.1.1.txt`. Refresh and review the dependency inventory for every release as described in `docs/LICENSING.md` in the source tree.

## Hickory DNS

PoTools uses Hickory DNS 0.24.4 and `hickory-proto` 0.24.4 in the native desktop host to query records through the operating system's configured DNS resolvers. Both crates are dual-licensed under MIT OR Apache-2.0; their license texts are included as `Hickory-DNS-MIT.txt` and `Hickory-DNS-Apache-2.0.txt`.

- Source: https://github.com/hickory-dns/hickory-dns

## node-forge 1.4.0

PoTools uses node-forge for browser-worker RSA compatibility and RSA X.509 certificate parsing. The project offers a choice of the New BSD License (3-clause) or GNU GPL version 2; PoTools uses the New BSD License option. The upstream license text is included as `node-forge-LICENSE.txt`.

- Source: https://github.com/digitalbazaar/forge

## UTIF.js 3.1.0

PoTools uses UTIF.js to decode TIFF images and write TIFF containers in the embedded Worker. It is licensed under the MIT License; the license text is included as `utif-LICENSE.txt`.

- Source: https://github.com/photopea/UTIF.js

## jpeg-js 0.4.4

PoTools uses jpeg-js in the embedded Worker to encode the JPEG strip for TIFF output. It is licensed under BSD-3-Clause; the license text is included as `jpeg-js-LICENSE.txt`.

- Source: https://github.com/jpeg-js/jpeg-js
