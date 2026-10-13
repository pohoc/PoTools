//! Integration tests for the privileged invoice service, exercised through the
//! same command bodies the webview reaches (`*_authorized` is what the
//! `#[tauri::command]` wrapper calls once its `State` extractor is satisfied).
//!
//! The module is declared as `#[cfg(test)] mod invoice_tests;` in `lib.rs`, so
//! the file body *is* the test module. It must import crate-root items
//! explicitly: a nested `mod` would make `use super::*` resolve to this file's
//! scope instead of the crate root.
use crate::{
    access::PathGrants, invoice_archive_authorized, invoice_read_candidate_authorized,
    invoice_scan_list_authorized, invoice_undo_authorized,
};
use potools_engine::services::invoice::{
    invoice_safe_segments, invoice_sha256, InvoiceArchiveFile, InvoiceArchiveInput,
};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

fn test_root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!("potools-{label}-{}", Uuid::new_v4()))
}

/// The grant state after a user picked both folders in the native dialog:
/// `pick_directory` → `grant_dir` on the source and the destination.
fn picked_grants(directories: &[&Path]) -> PathGrants {
    let grants = PathGrants::new();
    for directory in directories {
        grants.grant_dir(directory);
    }
    grants
}

fn archive_input(source: &Path, target: &Path, contents: &[u8]) -> InvoiceArchiveInput {
    InvoiceArchiveInput {
        source_directory: source.to_string_lossy().into_owned(),
        target_directory: target.to_string_lossy().into_owned(),
        conflict: "rename".into(),
        files: vec![InvoiceArchiveFile {
            path: source
                .join("2026/invoice.pdf")
                .to_string_lossy()
                .into_owned(),
            sha256: invoice_sha256(contents),
            relative_path: "2026/invoice.pdf".into(),
            enabled: true,
            fields: None,
        }],
    }
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
    let grants = picked_grants(&[source.as_path(), target.as_path()]);
    let result =
        invoice_archive_authorized(&grants, archive_input(&source, &target, contents)).unwrap();
    assert_eq!(result["copied"].as_array().unwrap().len(), 1);
    let copied_path = PathBuf::from(result["copied"][0]["target"].as_str().unwrap());
    assert_eq!(fs::read(&copied_path).unwrap(), contents);
    assert!(PathBuf::from(result["reportPath"].as_str().unwrap()).is_file());
    assert!(PathBuf::from(result["csvReportPath"].as_str().unwrap()).is_file());

    let undo = invoice_undo_authorized(&grants, result["archiveId"].as_str().unwrap().to_string())
        .unwrap();
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
    let grants = picked_grants(&[source.as_path(), target.as_path()]);
    let input = InvoiceArchiveInput {
        conflict: "skip".into(),
        files: vec![InvoiceArchiveFile {
            path: source_file.to_string_lossy().into_owned(),
            sha256: invoice_sha256(b"new"),
            relative_path: "invoice.pdf".into(),
            enabled: true,
            fields: None,
        }],
        ..archive_input(&source, &target, b"new")
    };
    let result = invoice_archive_authorized(&grants, input).unwrap();
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
    let grants = picked_grants(&[root.as_path()]);

    let shallow = invoice_scan_list_authorized(
        &grants,
        root.to_string_lossy().into_owned(),
        Some(false),
        None,
        None,
    )
    .unwrap();
    assert_eq!(shallow.files.len(), 1);
    assert_eq!(shallow.files[0].name, "root.pdf");

    let recursive = invoice_scan_list_authorized(
        &grants,
        root.to_string_lossy().into_owned(),
        Some(true),
        Some(1.0),
        None,
    )
    .unwrap();
    assert_eq!(recursive.files.len(), 1);
    assert!(recursive.exceeded);
    let read = invoice_read_candidate_authorized(
        &grants,
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
    let grants = picked_grants(&[root.as_path()]);
    let listing = invoice_scan_list_authorized(
        &grants,
        root.to_string_lossy().into_owned(),
        None,
        None,
        None,
    )
    .unwrap();
    assert_eq!(listing.files.len(), 1);
    assert_eq!(listing.skipped.len(), 1);
    assert_eq!(listing.skipped[0]["reason"], "跳过符号链接");
    fs::remove_dir_all(root).unwrap();
}

/// SEC-01: a directory nobody picked must not be enumerable through the invoice
/// IPC, and the refusal must not leak its contents.
#[test]
fn scanning_an_unauthorized_source_directory_is_refused() {
    let root = test_root("invoice-scan-denied");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("invoice.pdf"), b"secret").unwrap();
    let grants = PathGrants::new();

    let error = invoice_scan_list_authorized(
        &grants,
        root.to_string_lossy().into_owned(),
        None,
        None,
        None,
    )
    .unwrap_err();
    assert!(error.starts_with("path_not_authorized:"), "{error}");
    assert!(
        !error.contains("invoice.pdf"),
        "the denial echoed the directory contents"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn reading_an_unauthorized_candidate_returns_no_bytes() {
    let root = test_root("invoice-read-denied");
    fs::create_dir_all(&root).unwrap();
    let file = root.join("invoice.pdf");
    fs::write(&file, b"top-secret-invoice").unwrap();
    let grants = PathGrants::new();

    let error = invoice_read_candidate_authorized(&grants, file.to_string_lossy().into_owned(), 16)
        .unwrap_err();
    assert!(error.starts_with("path_not_authorized:"), "{error}");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn archiving_without_source_or_target_grants_writes_nothing() {
    let root = test_root("invoice-archive-denied");
    let source = root.join("source");
    let target = root.join("target");
    fs::create_dir_all(source.join("2026")).unwrap();
    fs::create_dir_all(&target).unwrap();
    let contents = b"invoice-pdf-fixture";
    let source_file = source.join("2026/invoice.pdf");
    fs::write(&source_file, contents).unwrap();
    let input = || archive_input(&source, &target, contents);

    // No grants at all.
    let error = invoice_archive_authorized(&PathGrants::new(), input()).unwrap_err();
    assert!(error.starts_with("path_not_authorized:"), "{error}");

    // Source granted for reads only: the target is still nobody's to write into.
    let read_only = PathGrants::new();
    read_only.grant_dir(&source);
    let error = invoice_archive_authorized(&read_only, input()).unwrap_err();
    assert!(error.starts_with("path_not_authorized:"), "{error}");

    assert_eq!(fs::read(&source_file).unwrap(), contents);
    assert_eq!(
        fs::read_dir(&target).unwrap().count(),
        0,
        "denial left files"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn undo_is_refused_once_the_archive_directory_grant_is_gone() {
    let root = test_root("invoice-undo-denied");
    let source = root.join("source");
    let target = root.join("target");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&target).unwrap();
    let contents = b"invoice-pdf-fixture";
    fs::write(source.join("invoice.pdf"), contents).unwrap();
    let grants = picked_grants(&[source.as_path(), target.as_path()]);
    let result = invoice_archive_authorized(
        &grants,
        InvoiceArchiveInput {
            files: vec![InvoiceArchiveFile {
                path: source.join("invoice.pdf").to_string_lossy().into_owned(),
                sha256: invoice_sha256(contents),
                relative_path: "invoice.pdf".into(),
                enabled: true,
                fields: None,
            }],
            ..archive_input(&source, &target, contents)
        },
    )
    .unwrap();
    let archive_id = result["archiveId"].as_str().unwrap().to_string();
    assert_eq!(fs::read_dir(&target).unwrap().count(), 3);

    // A caller that no longer holds the archive directory cannot delete from it,
    // and an unknown id is refused the same way.
    let error = invoice_undo_authorized(&PathGrants::new(), archive_id.clone()).unwrap_err();
    assert!(error.contains("授权已失效"), "{error}");
    assert_eq!(fs::read_dir(&target).unwrap().count(), 3);
    assert!(invoice_undo_authorized(&grants, "not-an-archive".to_string()).is_err());

    let unknown_root = test_root("invoice-unknown-root");
    assert!(
        invoice_undo_authorized(&picked_grants(&[unknown_root.as_path()]), archive_id).is_err()
    );
    fs::remove_dir_all(root).unwrap();
    let _ = fs::remove_dir_all(unknown_root);
}
