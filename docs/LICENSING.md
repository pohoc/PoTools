# Licensing and release readiness

## Project license

PoTools-authored source code is licensed under MIT. The canonical text is [`../LICENSE`](../LICENSE), and workspace package metadata declares `MIT`. The Tauri bundle declares the same SPDX identifier and uses the root license file for installer metadata.

This grant covers only material copyrightable by the PoTools authors. Third-party packages, models, fonts, binaries, and other assets keep their original licenses and notices. Do not describe a release as MIT-only unless its complete dependency and distribution path has been reviewed.

## Distribution licensing routes

| Component | Current use | License | Required before distribution |
| --- | --- | --- | --- |
| MuPDF.js 1.28.1 | Bundled in the local engine for PDF processing | AGPL-3.0-or-later | May be distributed through an AGPL-compliant open-source route, under an applicable commercial license, or replaced. |

The table row applies to the current packaged app. An AGPL-compliant open-source distribution is a valid route for these components; the project does not have to obtain a commercial license solely to publish open source. The MIT project license covers PoTools-authored code, while the combined installer must meet the terms of every bundled component and must not be represented as MIT-only.

## Bundled third-party material

- `apps/desktop/public/licenses/THIRD_PARTY_NOTICES.md` is included in the app and lists the direct runtime components and known exceptions.
- `MuPDF-AGPL-3.0.txt` contains the license text for the bundled MuPDF.js package.
- `Node.js-22.20.0.txt` contains the upstream Node runtime license and third-party notices. Desktop runtime preparation copies it beside the bundled Node executable.
- `Apache-2.0.txt` is retained for MediaPipe Tasks Vision and the bundled segmentation model.
- sharp and platform-specific libvips package license files are retained when the runtime modules are staged. Recheck target-specific binaries and versions for every platform build.
- JavaScript and Rust dependency trees include several additional permissive and notice-based licenses. Staged Node module trees retain their package license files; the inventory must still be refreshed for each release.

## Release checklist

1. Choose and document an AGPL-compliant open-source route, an applicable commercial license, or a replacement for MuPDF for the exact runtime and app distribution model.
2. Regenerate `apps/desktop/public/licenses/DEPENDENCY_LICENSES.json` with `pnpm licenses:inventory`; review it alongside `pnpm licenses list --json -r --long` and `cargo metadata --format-version 1 --manifest-path apps/desktop/src-tauri/Cargo.toml`.
3. Review newly added, unknown, dual-licensed, copyleft, model, and platform-specific components; retain the chosen license text and copyright notices in the installed app.
4. Inspect each platform installer and confirm its About/license view exposes the applicable notices and license texts.
5. Verify the release source archive contains the exact source and build instructions needed for whichever dependency licensing route was selected.

This checklist records current engineering findings, not a legal opinion. Reassess it when dependency versions, build resources, or release targets change.
