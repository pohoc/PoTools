//! Tool ids dispatched by the engine, shared by the WASM capability probe and
//! the drift tests that keep the three registries in sync:
//! `packages/core/catalog/*.json` (what the UI offers), `SUPPORTED` +
//! `ENGINE_ONLY` (what Rust routes), and `ADAPTER_HANDLED` (what the web host
//! serves without `run_tool`).

/// Catalog tools the Rust engine routes. A tool listed here must never return
/// `Ok(None)` from `run_tool` — validation errors are fine, "unhandled" is not.
pub const SUPPORTED: &[&str] = &[
    "timestamp",
    "date-diff",
    "date-math",
    "workdays",
    "timezone-board",
    "duration",
    "cron",
    "date-format",
    "relative-time",
    "amount-convert",
    "hash",
    "hmac",
    "file-checksum",
    "base64",
    "radix",
    "hex",
    "url-codec",
    "unicode-escape",
    "jwt",
    "aes",
    "rsa",
    "totp",
    "x509",
    "password-gen",
    "password-strength",
    "uuid-gen",
    "file-base64",
    "base64-file",
    "bcrypt",
    "json-format",
    "xml-format",
    "xml-json",
    "yaml-json",
    "binary-codec",
    "regex-test",
    "case-convert",
    "color-convert",
    "user-agent",
    "ipv4-convert",
    "ipv4-subnet",
    "url-inspect",
    "ipv6-convert",
    "port-reference",
    "robots-txt",
    "spf-record",
    "dmarc-record",
    "dns-lookup",
    "system-network",
    "ping-check",
    "tcp-check",
    "ip-lookup",
    "image-compress",
    "image-resize",
    "image-crop",
    "image-rotate",
    "image-convert",
    "image-info",
    "image-metadata-clean",
    "image-print",
    "image-id-photo",
    "image-cutout",
    "image-watermark-clean",
    "merge",
    "split",
    "organize",
    "rotate",
    "extract-pages",
    "delete-pages",
    "watermark",
    "page-numbers",
    "header-footer",
    "resize",
    "margins",
    "nup",
    "invoice-merge",
    "compress",
    "metadata",
    "crop",
    "repair",
    "extract-text",
    "extract-images",
    "images-to-pdf",
    "remove-blank",
    // PDF text conversions fed by runtimeData (pdfText plus the pdfImages/
    // pdfPageImages/pdfOcrPages image contracts, adapter-supplied).
    "pdf-to-csv",
    "pdf-to-rtf",
    "pdf-to-excel",
    "pdf-to-markdown",
    "pdf-to-word",
    "pdf-to-epub",
    "pdf-to-html",
    // C3 conversions: presentation/OFD writers and the OFD/markdown PDF
    // producers (fonts and markdown assets arrive via runtimeData).
    "pdf-to-ppt",
    "pdf-to-ofd",
    "ofd-to-pdf",
    "markdown-to-pdf",
];

/// Engine entry points that are deliberately *not* in the tool catalog.
///
/// `tiff-preview` / `tiff-convert` are dispatched by `tools::image` but no
/// catalog entry exposes them and nothing in `apps/web` calls them, so they are
/// reachable only through a direct engine call. They stay listed here (and in
/// the capability probe) so the behaviour is explicit rather than an accidental
/// hole; promoting them to the catalog would move them into `SUPPORTED`.
pub const ENGINE_ONLY: &[&str] = &["tiff-preview", "tiff-convert"];

/// Catalog tools served by the web host instead of `run_tool`.
///
/// These have no Rust dispatch arm on purpose:
/// - `pdf-to-images` renders pages with PDF.js in the engine Worker
///   (`apps/web/src/lib/page-images.ts`).
/// - `ocr-text` / `ocr-table` recognise text with the bundled PaddleOCR models
///   and then hand the result back to the engine's table/XLSX builders.
/// - `invoice-organize` is a privileged desktop workflow (`services::invoice`)
///   surfaced through dedicated Tauri commands.
pub const ADAPTER_HANDLED: &[&str] =
    &["pdf-to-images", "ocr-text", "ocr-table", "invoice-organize"];

/// Catalog tools the **desktop host** runs through `engine_run_file_tool`:
/// inputs are read by path inside Rust and artifacts are staged straight to disk.
///
/// This is the only place the routing decision is made. `apps/web` used to keep
/// its own copy of the list with nothing comparing the two, so a tool added on one
/// side quietly ran on the other host — or on none (audit RUN-03); the WebView now
/// reads it from [`host_routes`] at startup instead.
pub const NATIVE_FILE_TOOLS: &[&str] = &[
    "image-compress",
    "image-resize",
    "image-crop",
    "image-rotate",
    "image-convert",
    "image-info",
    "image-metadata-clean",
    "image-print",
    "image-cutout",
    "image-watermark-clean",
    "image-id-photo",
    "merge",
    "split",
    "organize",
    "rotate",
    "extract-pages",
    "delete-pages",
    "metadata",
    "crop",
    "repair",
    "invoice-merge",
    "watermark",
    "page-numbers",
    "header-footer",
    "remove-blank",
];

/// Where one catalog tool actually executes, as a stable id for the UI, the
/// capability probe and the cross-host contract tests.
///
/// - `native-file`: the desktop command reads the file on disk (desktop only).
/// - `adapter`: the web host serves it (PDF.js pixels, OCR models, privileged
///   invoice commands) and hands results back to Rust.
/// - `engine`: Rust `run_tool`, in the Worker on Web and in the host process on
///   desktop.
/// - `unrouted`: offered by the catalog but implemented nowhere.
pub fn route_of(tool: &str) -> &'static str {
    if NATIVE_FILE_TOOLS.contains(&tool) {
        "native-file"
    } else if ADAPTER_HANDLED.contains(&tool) {
        "adapter"
    } else if SUPPORTED.contains(&tool) {
        "engine"
    } else {
        "unrouted"
    }
}

/// The route of every catalog tool as `(tool, route)` pairs, exported to the
/// WebView through `coreHostRoutes` so the routing decision exists in one place.
pub fn host_routes() -> Vec<(&'static str, &'static str)> {
    potools_core::tools::all_tools()
        .map(|tools| {
            tools
                .iter()
                .map(|tool| (tool.id.as_str(), route_of(&tool.id)))
                .collect()
        })
        .unwrap_or_default()
}

/// The frozen display list exposed by `toolCapabilities()`.
pub fn advertised() -> Vec<&'static str> {
    SUPPORTED.iter().chain(ENGINE_ONLY).copied().collect()
}

#[cfg(test)]
mod tests {
    use super::{advertised, route_of, ADAPTER_HANDLED, ENGINE_ONLY, NATIVE_FILE_TOOLS, SUPPORTED};
    use crate::RunContext;
    use serde_json::json;
    use std::collections::BTreeSet;

    fn catalog_ids() -> BTreeSet<String> {
        potools_core::tools::all_tools()
            .expect("embedded catalog must parse")
            .iter()
            .map(|tool| tool.id.clone())
            .collect()
    }

    /// The host route list is now the only copy, so it has to be consistent with
    /// the engine it depends on: every native tool must be an engine tool that the
    /// catalog actually offers.
    #[test]
    fn native_routes_are_catalog_tools_the_engine_handles() {
        let catalog = catalog_ids();
        let mut seen = BTreeSet::new();
        for tool in NATIVE_FILE_TOOLS {
            assert!(seen.insert(*tool), "duplicate native route entry: {tool}");
            assert!(
                SUPPORTED.contains(tool),
                "'{tool}' is routed to the native host but has no engine dispatch"
            );
            assert!(
                catalog.contains(*tool),
                "'{tool}' is routed natively but is not in the catalog"
            );
        }
    }

    /// Every catalog tool resolves to a real host route. This is the direction that
    /// used to be unprovable: the UI's list and Rust's registry could disagree and
    /// nothing reported the tool that fell through.
    #[test]
    fn every_catalog_tool_resolves_to_a_route() {
        let unrouted: Vec<String> = catalog_ids()
            .into_iter()
            .filter(|id| route_of(id) == "unrouted")
            .collect();
        assert!(
            unrouted.is_empty(),
            "catalog tools with no host route: {unrouted:?}"
        );
        assert_eq!(route_of("no-such-tool"), "unrouted");
        assert_eq!(route_of("merge"), "native-file");
        assert_eq!(route_of("pdf-to-images"), "adapter");
        assert_eq!(route_of("json-format"), "engine");
    }

    /// Drift tripwire: a tool the engine claims to handle must actually be
    /// routed. With no inputs a routed tool answers with a validation error (or
    /// a result); only an unrouted tool id falls through every domain runner to
    /// `Ok(None)`.
    #[test]
    fn every_supported_tool_is_dispatched() {
        for tool in advertised() {
            let options = json!({});
            let context = RunContext {
                tool,
                options: &options,
                locale: "zh-CN",
                inputs: &[],
                name_pattern: None,
                runtime_data: None,
            };
            let outcome = crate::run_tool(&context);
            assert!(
                !matches!(outcome, Ok(None)),
                "tool '{tool}' is advertised in toolCapabilities but no dispatcher handles it"
            );
        }
    }

    /// The other direction, which nothing used to check: every tool the catalog
    /// offers must have an implementation somewhere. Without this, adding a
    /// catalog entry and forgetting the handler only surfaces as an
    /// `unsupported` error in front of a user at runtime.
    #[test]
    fn every_catalog_tool_has_an_implementation() {
        let implemented: BTreeSet<&str> =
            SUPPORTED.iter().chain(ADAPTER_HANDLED).copied().collect();
        let missing: Vec<String> = catalog_ids()
            .into_iter()
            .filter(|id| !implemented.contains(id.as_str()))
            .collect();
        assert!(
            missing.is_empty(),
            "catalog tools with no engine handler and no adapter: {missing:?}\n\
             Add a dispatch arm (and list it in SUPPORTED) or document it in ADAPTER_HANDLED."
        );
    }

    /// `SUPPORTED` is the catalog-facing half of the registry; anything routed
    /// but hidden from the catalog belongs in `ENGINE_ONLY`.
    #[test]
    fn supported_is_exactly_the_catalog_bridge() {
        let catalog = catalog_ids();
        let stray: Vec<&&str> = SUPPORTED
            .iter()
            .filter(|id| !catalog.contains(**id))
            .collect();
        assert!(
            stray.is_empty(),
            "SUPPORTED ids absent from the catalog (move them to ENGINE_ONLY if intentional): {stray:?}"
        );
        let dead: Vec<String> = catalog
            .iter()
            .filter(|id| {
                !SUPPORTED.contains(&id.as_str()) && !ADAPTER_HANDLED.contains(&id.as_str())
            })
            .cloned()
            .collect();
        assert!(
            dead.is_empty(),
            "catalog ids with no registry entry: {dead:?}"
        );
    }

    #[test]
    fn the_three_registries_are_disjoint_and_duplicate_free() {
        let all = advertised();
        assert_eq!(
            all.iter().copied().collect::<BTreeSet<_>>().len(),
            all.len(),
            "toolCapabilities contains duplicate ids"
        );
        let supported: BTreeSet<&str> = SUPPORTED.iter().copied().collect();
        let engine_only: BTreeSet<&str> = ENGINE_ONLY.iter().copied().collect();
        let adapter: BTreeSet<&str> = ADAPTER_HANDLED.iter().copied().collect();
        assert!(
            supported.is_disjoint(&engine_only),
            "an id is listed as both a catalog tool and engine-only"
        );
        assert!(
            supported.is_disjoint(&adapter),
            "an id is listed as both engine-routed and adapter-handled"
        );
        assert!(
            engine_only.is_disjoint(&adapter),
            "an id is listed as both engine-only and adapter-handled"
        );
    }
}
