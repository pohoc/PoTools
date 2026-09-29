//! Tool ids dispatched by the engine, shared by the WASM capability probe and
//! the drift test that keeps the list in sync with the dispatch arms.

/// Catalog tools the Rust engine routes. A tool listed here must never return
/// `Ok(None)` from `run_tool` — validation errors are fine, "unhandled" is not.
pub const SUPPORTED: &[&str] = &[
    "timestamp", "date-diff", "date-math", "workdays", "timezone-board", "duration",
    "cron", "date-format", "relative-time", "amount-convert",
    "hash", "hmac", "file-checksum", "base64", "radix", "hex", "url-codec",
    "unicode-escape", "jwt", "aes", "rsa", "totp", "x509", "password-gen",
    "password-strength", "uuid-gen", "file-base64", "base64-file", "bcrypt",
    "json-format", "xml-format", "xml-json", "yaml-json", "binary-codec", "regex-test",
    "case-convert", "color-convert", "user-agent", "ipv4-convert", "ipv4-subnet",
    "url-inspect", "ipv6-convert", "port-reference", "robots-txt", "spf-record",
    "dmarc-record", "dns-lookup", "system-network", "ping-check", "tcp-check", "ip-lookup",
    "image-compress", "image-resize", "image-crop", "image-rotate", "image-convert",
    "image-info", "image-metadata-clean", "image-print", "image-id-photo", "image-cutout",
    "image-watermark-clean", "merge", "split", "organize", "rotate", "extract-pages",
    "delete-pages", "watermark", "page-numbers", "header-footer", "resize", "margins",
    "nup", "invoice-merge", "compress", "metadata", "crop", "repair", "extract-text", "tiff-preview",
    "tiff-convert", "extract-images", "images-to-pdf", "remove-blank",
    // PDF text conversions fed by runtimeData (pdfText plus the pdfImages/
    // pdfPageImages/pdfOcrPages image contracts, adapter-supplied).
    "pdf-to-csv", "pdf-to-rtf", "pdf-to-excel",
    "pdf-to-markdown", "pdf-to-word", "pdf-to-epub", "pdf-to-html",
    // C3 conversions: presentation/OFD writers and the OFD/markdown PDF
    // producers (fonts and markdown assets arrive via runtimeData).
    "pdf-to-ppt", "pdf-to-ofd", "ofd-to-pdf", "markdown-to-pdf",
];

#[cfg(test)]
mod tests {
    use super::SUPPORTED;
    use crate::RunContext;
    use serde_json::json;

    /// Drift tripwire: every advertised capability must actually be routed.
    /// With no inputs a routed tool answers with a validation error (or a
    /// result); only an unrouted tool id falls through every domain runner to
    /// `Ok(None)`.
    #[test]
    fn every_supported_tool_is_dispatched() {
        for tool in SUPPORTED {
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
}
