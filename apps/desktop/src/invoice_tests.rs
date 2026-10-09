//! Integration tests for the privileged invoice service, exercised through the
//! same `#[tauri::command]` entry points the webview calls.
//!
//! The module is declared as `#[cfg(test)] mod invoice_tests;` in `lib.rs`, so
//! the file body *is* the test module. It must import crate-root items
//! explicitly: a nested `mod` would make `use super::*` resolve to this file's
//! scope instead of the crate root.
use crate::{invoice_archive, invoice_read_candidate, invoice_scan_list, invoice_undo};
use potools_engine::services::invoice::{
    invoice_safe_segments, invoice_sha256, InvoiceArchiveFile, InvoiceArchiveInput,
};
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

fn test_root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!("potools-{label}-{}", Uuid::new_v4()))
}

#[test]
fn invoice_archive_and_undo_preserve_verified_files() {
    let root = test_root("invoice-archive");
    let source = root.join("source");
    let target = root.join("target");
    fs::create_dir_all(source.join("2026")).unwrap();
    let source_file = source.join("2026/invoice.pdf");
    let contents = b"invoice-pdf-fixture";
    fs::write(&source_file, contents).unwrap();
    let result = invoice_archive(InvoiceArchiveInput {
        source_directory: source.to_string_lossy().into_owned(),
        target_directory: target.to_string_lossy().into_owned(),
        conflict: "rename".into(),
        files: vec![InvoiceArchiveFile {
            path: source_file.to_string_lossy().into_owned(),
            sha256: invoice_sha256(contents),
            relative_path: "2026/invoice.pdf".into(),
            enabled: true,
            fields: None,
        }],
    })
    .unwrap();
    assert_eq!(result["copied"].as_array().unwrap().len(), 1);
    let copied_path = PathBuf::from(result["copied"][0]["target"].as_str().unwrap());
    assert_eq!(fs::read(&copied_path).unwrap(), contents);
    assert!(PathBuf::from(result["reportPath"].as_str().unwrap()).is_file());
    assert!(PathBuf::from(result["csvReportPath"].as_str().unwrap()).is_file());

    let undo = invoice_undo(result["archiveId"].as_str().unwrap().to_string()).unwrap();
    assert_eq!(undo["removed"].as_array().unwrap().len(), 1);
    assert!(!copied_path.exists());
    assert_eq!(fs::read(&source_file).unwrap(), contents);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn invoice_archive_skip_conflict_does_not_replace_destination() {
    let root = test_root("invoice-conflict");
    let source = root.join("source");
    let target = root.join("target");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&target).unwrap();
    let source_file = source.join("invoice.pdf");
    let target_file = target.join("invoice.pdf");
    fs::write(&source_file, b"new").unwrap();
    fs::write(&target_file, b"existing").unwrap();
    let result = invoice_archive(InvoiceArchiveInput {
        source_directory: source.to_string_lossy().into_owned(),
        target_directory: target.to_string_lossy().into_owned(),
        conflict: "skip".into(),
        files: vec![InvoiceArchiveFile {
            path: source_file.to_string_lossy().into_owned(),
            sha256: invoice_sha256(b"new"),
            relative_path: "invoice.pdf".into(),
            enabled: true,
            fields: None,
        }],
    })
    .unwrap();
    assert_eq!(result["skipped"].as_array().unwrap().len(), 1);
    assert_eq!(fs::read(&target_file).unwrap(), b"existing");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn invoice_relative_paths_reject_traversal_and_sanitize_windows_names() {
    assert!(invoice_safe_segments("../escape.pdf").is_err());
    assert!(invoice_safe_segments("C:/escape.pdf").is_err());
    assert_eq!(
        invoice_safe_segments("2026/CON.pdf").unwrap(),
        ["2026", "_CON.pdf"]
    );
}

#[test]
fn invoice_scan_lists_allowed_files_and_honors_recursion_limit() {
    let root = test_root("invoice-scan");
    fs::create_dir_all(root.join("nested")).unwrap();
    fs::write(root.join("root.pdf"), b"root").unwrap();
    fs::write(root.join("notes.txt"), b"ignored").unwrap();
    fs::write(root.join("nested/child.jpg"), b"child").unwrap();

    let shallow =
        invoice_scan_list(root.to_string_lossy().into_owned(), Some(false), None, None).unwrap();
    assert_eq!(shallow.files.len(), 1);
    assert_eq!(shallow.files[0].name, "root.pdf");

    let recursive = invoice_scan_list(
        root.to_string_lossy().into_owned(),
        Some(true),
        Some(1.0),
        None,
    )
    .unwrap();
    assert_eq!(recursive.files.len(), 1);
    assert!(recursive.exceeded);
    let read = invoice_read_candidate(
        recursive.files[0].path.clone(),
        recursive.files[0].size_bytes,
    )
    .unwrap();
    assert_eq!(read.bytes.len() as u64, read.current_size_bytes);
    assert!(!read.changed_while_reading);
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn invoice_scan_skips_symbolic_links() {
    let root = test_root("invoice-scan-symlink");
    fs::create_dir_all(&root).unwrap();
    let real = root.join("real.pdf");
    fs::write(&real, b"pdf").unwrap();
    std::os::unix::fs::symlink(&real, root.join("linked.pdf")).unwrap();
    let listing = invoice_scan_list(root.to_string_lossy().into_owned(), None, None, None).unwrap();
    assert_eq!(listing.files.len(), 1);
    assert_eq!(listing.skipped.len(), 1);
    assert_eq!(listing.skipped[0]["reason"], "跳过符号链接");
    fs::remove_dir_all(root).unwrap();
}
