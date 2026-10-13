//! Negative tests for the privileged path surface (SEC-02 / SEC-03 / SEC-04).
//!
//! Each one calls the same function body a `#[tauri::command]` reaches with an
//! empty or partial grant set, which is the state a script in the WebView faces:
//! authority has to come from a recorded native gesture, never from the
//! arguments.

use crate::access::{ApprovalKind, PathGrants};
use crate::{
    browse_directories_authorized, set_output_dir_authorized, set_temp_dir_authorized,
    temp_clean_authorized, temp_usage_authorized,
};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

fn scratch(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("potools-secure-{label}-{}", Uuid::new_v4()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("scratch dir");
    dir
}

fn reclaim(path: &Path) {
    let _ = fs::remove_dir_all(path);
}

/// SEC-04: usage statistics may only describe a root this app granted.
#[test]
fn temp_usage_is_confined_to_the_app_temp_root() {
    let trusted = scratch("temp-usage-trusted");
    fs::create_dir_all(trusted.join("jobs/job-1")).unwrap();
    fs::write(trusted.join("jobs/job-1/out.pdf"), b"artifact").unwrap();
    let snooped = scratch("temp-usage-snooped");
    fs::create_dir_all(snooped.join("jobs/private-job")).unwrap();
    fs::write(snooped.join("jobs/private-job/secret.pdf"), b"x").unwrap();

    let platform = PathGrants::new();
    platform.grant_temp_root(&std::env::temp_dir());
    let error =
        temp_usage_authorized(&platform, snooped.to_string_lossy().into_owned()).unwrap_err();
    assert!(error.starts_with("temp_root_not_authorized:"), "{error}");

    let grants = PathGrants::new();
    grants.grant_temp_root(&trusted);
    let usage =
        temp_usage_authorized(&grants, trusted.to_string_lossy().into_owned()).expect("usage");
    assert_eq!(usage.jobs, 1);
    assert_eq!(usage.files, 1);
    reclaim(&trusted);
    reclaim(&snooped);
}

/// SEC-02/SEC-04: cleanup takes the app's own temp root, not a caller-chosen
/// directory that happens to contain `jobs/` and `inbox/`.
#[test]
fn temp_clean_refuses_a_root_the_app_never_granted() {
    let attacker = scratch("temp-clean-attacker");
    fs::create_dir_all(attacker.join("jobs/job-1")).unwrap();
    fs::create_dir_all(attacker.join("inbox/job-2")).unwrap();
    fs::write(attacker.join("jobs/job-1/keep.pdf"), b"x").unwrap();
    fs::write(attacker.join("inbox/job-2/keep.pdf"), b"y").unwrap();

    let grants = PathGrants::new();
    let error = temp_clean_authorized(
        &grants,
        attacker.to_string_lossy().into_owned(),
        0.0,
        0,
        Vec::new(),
    )
    .unwrap_err();
    assert!(error.starts_with("temp_root_not_authorized:"), "{error}");
    assert!(
        attacker.join("jobs/job-1/keep.pdf").is_file(),
        "a refused cleanup still removed files"
    );
    assert!(attacker.join("inbox/job-2/keep.pdf").is_file());

    // The same call against a granted root still does its job.
    let trusted = scratch("temp-clean-trusted");
    fs::create_dir_all(trusted.join("jobs/job-3")).unwrap();
    fs::write(trusted.join("jobs/job-3/done.pdf"), b"z").unwrap();
    grants.grant_temp_root(&trusted);
    let cleaned = temp_clean_authorized(
        &grants,
        trusted.to_string_lossy().into_owned(),
        0.0,
        0,
        Vec::new(),
    )
    .expect("clean");
    assert_eq!(cleaned.removed_jobs, 1);
    assert!(!trusted.join("jobs/job-3").exists());
    reclaim(&attacker);
    reclaim(&trusted);
}

/// SEC-02: the persisted output/temp settings are honoured only for directories
/// this process recorded as approved.
#[test]
fn a_configured_directory_grants_nothing_until_it_is_approved() {
    let grants = PathGrants::new();
    let dir = scratch("settings-dir");
    fs::write(dir.join("existing.pdf"), b"x").unwrap();
    let as_string = dir.to_string_lossy().into_owned();

    let error = set_output_dir_authorized(&grants, Some(as_string.clone())).unwrap_err();
    assert!(error.starts_with("directoryNotApproved:"), "{error}");
    assert!(!grants.can_write(&dir.join("new.pdf")));
    assert!(!grants.can_read(&dir.join("existing.pdf")));

    let error = set_temp_dir_authorized(&grants, Some(as_string.clone())).unwrap_err();
    assert!(error.starts_with("directoryNotApproved:"), "{error}");
    assert!(!grants.can_write(&dir.join("jobs/job-1/out.pdf")));

    // A native gesture approves it (the folder dialog does the same call):
    // writes to the output role become possible, reads still are not.
    grants
        .approve_directory(&dir, ApprovalKind::Output)
        .expect("approve");
    set_output_dir_authorized(&grants, Some(as_string.clone())).expect("now honoured");
    assert!(grants.can_write(&dir.join("new.pdf")));
    assert!(
        !grants.can_read(&dir.join("existing.pdf")),
        "an output approval must never become a read capability"
    );

    // Clearing the setting falls back to Rust's own platform temp directory.
    set_temp_dir_authorized(&grants, None).expect("default temp root");
    let temp_root = std::env::temp_dir();
    assert!(
        temp_usage_authorized(&grants, temp_root.to_string_lossy().into_owned()).is_ok(),
        "the platform temp root is Rust's own value, not a WebView claim"
    );
    // An approved temp root is honoured, and it is the root — not its parent —
    // that usage and cleanup are limited to.
    grants
        .approve_directory(&dir, ApprovalKind::Temp)
        .expect("approve");
    set_temp_dir_authorized(&grants, Some(as_string)).expect("now honoured");
    assert!(temp_usage_authorized(&grants, dir.to_string_lossy().into_owned()).is_ok());
    reclaim(&dir);
}

/// The directories this build derives for itself must keep working without an
/// approval entry: the frontend re-states `<Documents>/PoTools` and
/// `<temp>/potools` on every job, and refusing them would break first runs.
#[test]
fn the_derived_default_directories_need_no_approval() {
    let root = scratch("app-defaults");
    fs::create_dir_all(root.join("Documents")).unwrap();
    fs::create_dir_all(root.join("tmp")).unwrap();
    let output = root.join("Documents/PoTools");
    let staging = root.join("tmp/potools");
    let grants = PathGrants::new();
    grants.grant_app_defaults(&output, &staging);

    set_output_dir_authorized(&grants, Some(output.to_string_lossy().into_owned()))
        .expect("the derived output default is honoured");
    set_temp_dir_authorized(&grants, Some(staging.to_string_lossy().into_owned()))
        .expect("the derived staging root is honoured");
    assert!(grants.can_write(&output.join("result.pdf")));
    assert!(
        !grants.can_read(&output.join("earlier-result.pdf")),
        "the default output stays write-only"
    );
    assert!(grants.can_write(&staging.join("jobs/job-1/out.pdf")));
    assert!(temp_usage_authorized(&grants, staging.to_string_lossy().into_owned()).is_ok());

    // "Use the default" returns to the derived root, and does not quietly widen
    // the grant to the bare platform temp directory.
    set_temp_dir_authorized(&grants, None).expect("back to the derived default");
    assert!(
        temp_usage_authorized(&grants, std::env::temp_dir().to_string_lossy().into_owned())
            .is_err()
    );

    // A directory that merely *looks* like the default is still refused.
    let lookalike = root.join("tmp/potools-backup");
    fs::create_dir_all(&lookalike).unwrap();
    let error = set_temp_dir_authorized(&grants, Some(lookalike.to_string_lossy().into_owned()))
        .unwrap_err();
    assert!(error.starts_with("directoryNotApproved:"), "{error}");
    reclaim(&root);
}

/// SEC-03: enumeration follows the grant bookkeeping, not the argument.
#[test]
fn browsing_is_limited_to_the_authorized_subtrees() {
    let picked = scratch("browse-picked");
    fs::create_dir_all(picked.join("inside")).unwrap();
    let elsewhere = scratch("browse-elsewhere");
    fs::create_dir_all(elsewhere.join("private")).unwrap();

    let grants = PathGrants::new();
    assert!(
        browse_directories_authorized(&grants, None).is_err(),
        "nothing is browsable before any grant"
    );

    grants.grant_dir(&picked);
    let listing =
        browse_directories_authorized(&grants, Some(picked.to_string_lossy().into_owned()))
            .expect("browse picked");
    assert_eq!(listing.dirs.len(), 1);
    assert_eq!(listing.dirs[0].name, "inside");
    assert!(
        listing.parent.is_none(),
        "the listing offered a link out of the granted root"
    );

    let error =
        browse_directories_authorized(&grants, Some(elsewhere.to_string_lossy().into_owned()))
            .unwrap_err();
    assert!(error.contains("未授权"), "{error}");
    reclaim(&picked);
    reclaim(&elsewhere);
}

#[test]
fn a_missing_subdirectory_does_not_become_its_parent() {
    let root = scratch("browse-missing");
    fs::create_dir_all(root.join("visible")).unwrap();
    let grants = PathGrants::new();
    grants.grant_dir(&root);

    let listing = browse_directories_authorized(
        &grants,
        Some(root.join("not-yet-created").to_string_lossy().into_owned()),
    )
    .expect("a path inside the granted root stays selectable");
    assert!(listing.unreadable);
    assert!(
        listing.dirs.iter().all(|entry| entry.name != "visible"),
        "the failed read substituted the parent's entries: {:?}",
        listing.dirs
    );
    reclaim(&root);
}

/// RUN-02: the write boundary. `engine_run_file_tool` checks the cancellation
/// flag before every artifact it stages; this is the half that used to be only
/// asserted in prose — a cancelled job must leave nothing in the temp job folder
/// or the output directory.
#[test]
fn a_cancelled_native_job_writes_no_artifacts() {
    let temp = scratch("staging-cancel");
    let output = temp.join("out");
    fs::create_dir_all(&output).unwrap();
    let grants = PathGrants::new();
    grants.grant_temp_root(&temp);
    grants.grant_write_dir(&output);
    let temp_str = temp.to_string_lossy().into_owned();
    let output_str = output.to_string_lossy().into_owned();

    let cancelled = || true;
    let live = || false;
    let artifacts = || {
        vec![
            potools_engine::Artifact::new("one.pdf", "pdf", b"one".to_vec()),
            potools_engine::Artifact::new("two.pdf", "pdf", b"two".to_vec()),
        ]
    };

    let staging = crate::NativeStaging {
        grants: &grants,
        job_id: "job-cancelled",
        temp_root: &temp_str,
        output_dir: Some(&output_str),
        cancelled: &cancelled,
    };
    let error = crate::stage_native_artifacts(staging, artifacts()).unwrap_err();
    assert_eq!(error.code, "cancelled", "{:?}", error.message);
    let job_dir = temp.join("jobs").join("job-cancelled");
    assert!(
        !job_dir.join("one.pdf").exists() && !job_dir.join("two.pdf").exists(),
        "cancelled job staged artifacts anyway"
    );
    assert_eq!(
        fs::read_dir(&output).unwrap().count(),
        0,
        "cancelled job wrote into the output directory"
    );

    // Same call with the flag clear is the ordinary path: the artifacts land in
    // both the temp job folder and the output directory.
    let staging = crate::NativeStaging {
        grants: &grants,
        job_id: "job-live",
        temp_root: &temp_str,
        output_dir: Some(&output_str),
        cancelled: &live,
    };
    let staged = crate::stage_native_artifacts(staging, artifacts()).expect("stage while live");
    assert_eq!(staged.len(), 2);
    assert!(output.join("one.pdf").is_file());
    assert!(temp.join("jobs").join("job-live").join("two.pdf").is_file());
    reclaim(&temp);
}
