use sha2::{Digest, Sha256};
use std::path::Path;

pub fn invoice_sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn invoice_extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}").to_ascii_lowercase())
}
