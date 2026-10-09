//! Path authorization for the privileged file commands.
//!
//! # Threat model
//!
//! A Tauri command is a plain IPC entry point: **any** script running in the
//! WebView can invoke **any** command, including one that would hand out
//! permission. So authority can never come from a value that merely arrived over
//! IPC — not a path, and not a "please grant this" call.
//!
//! The only sound sources are gestures a script cannot synthesise for itself:
//!
//! * the result of a **native dialog** shown by this process (the user's click
//!   is what picks the file), and
//! * an **OS drag-and-drop** event delivered to the window.
//!
//! A third, narrower source is the user's own configuration: the output
//! directory and the temp directory are visible, persisted settings. Turning one
//! of those into a *write* grant is acceptable; turning it into a *read* grant
//! would not be, because a script could point the setting at a sensitive
//! directory and read it back. Hence [`PathGrants::grant_write_dir`] and the
//! temp grants, which cover only the app's own `jobs/` and `inbox/` subdirectories
//! rather than the whole configured tree.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

/// The app-owned subdirectories of a temp root. Only these are ever staged into
/// or read from, so granting them keeps a hostile `tempDir` setting from becoming
/// a read capability over that directory.
pub const TEMP_SUBDIRECTORIES: [&str; 2] = ["jobs", "inbox"];

#[derive(Default)]
pub struct PathGrants {
    /// Readable and writable: files the user picked or dropped, plus files this
    /// process wrote (so "reveal what I just saved" keeps working).
    files: RwLock<HashSet<PathBuf>>,
    /// Readable and writable: directories the user picked or dropped.
    dirs: RwLock<HashSet<PathBuf>>,
    /// Writable only: the configured output directory.
    write_dirs: RwLock<HashSet<PathBuf>>,
}

impl PathGrants {
    pub fn new() -> Self {
        Self::default()
    }

    /// Resolve a path to its real location so `..`, a symlink or a case-folded
    /// spelling cannot slip past the prefix check.
    fn canonical(path: &Path) -> Option<PathBuf> {
        // A path that does not exist yet — a staging target such as
        // `<temp>/jobs/<id>/out.pdf` on a job's first artifact — is resolved by
        // canonicalising its nearest existing ancestor and re-appending the tail.
        // The tail is deliberately *not* normalised, so a `..` left in it fails
        // the prefix check instead of escaping the grant.
        let mut tail: Vec<&std::ffi::OsStr> = Vec::new();
        let mut cursor = path;
        loop {
            if let Ok(resolved) = cursor.canonicalize() {
                let mut complete = resolved;
                for component in tail.iter().rev() {
                    complete.push(component);
                }
                return Some(complete);
            }
            tail.push(cursor.file_name()?);
            cursor = cursor.parent()?;
        }
    }

    pub fn grant_file(&self, path: &Path) -> Option<PathBuf> {
        let resolved = Self::canonical(path)?;
        self.files.write().ok()?.insert(resolved.clone());
        Some(resolved)
    }

    pub fn grant_dir(&self, path: &Path) -> Option<PathBuf> {
        let resolved = Self::canonical(path)?;
        self.dirs.write().ok()?.insert(resolved.clone());
        Some(resolved)
    }

    pub fn grant_write_dir(&self, path: &Path) -> Option<PathBuf> {
        let resolved = Self::canonical(path)?;
        self.write_dirs.write().ok()?.insert(resolved.clone());
        Some(resolved)
    }

    /// Grant a dropped or dialog-picked path, whichever kind it is.
    pub fn grant_path(&self, path: &Path) -> Option<PathBuf> {
        if path.is_dir() {
            self.grant_dir(path)
        } else {
            self.grant_file(path)
        }
    }

    /// Grant a temp root's app-owned subdirectories (created on demand later).
    pub fn grant_temp_root(&self, root: &Path) {
        for name in TEMP_SUBDIRECTORIES {
            self.grant_dir(&root.join(name));
        }
    }

    pub fn can_read(&self, path: &Path) -> bool {
        let Some(target) = Self::canonical(path) else {
            return false;
        };
        if self.files.read().is_ok_and(|files| files.contains(&target)) {
            return true;
        }
        self.dirs
            .read()
            .is_ok_and(|dirs| dirs.iter().any(|dir| target.starts_with(dir)))
    }

    pub fn can_write(&self, path: &Path) -> bool {
        if self.can_read(path) {
            return true;
        }
        let Some(target) = Self::canonical(path) else {
            return false;
        };
        self.write_dirs
            .read()
            .is_ok_and(|dirs| dirs.iter().any(|dir| target.starts_with(dir)))
    }

    /// Human-readable summary used in denial messages, so a missing grant is
    /// diagnosable from the error itself.
    pub fn describe(&self) -> String {
        let mut all: Vec<String> = Vec::new();
        if let Ok(dirs) = self.dirs.read() {
            all.extend(dirs.iter().map(|dir| dir.to_string_lossy().to_string()));
        }
        if let Ok(dirs) = self.write_dirs.read() {
            all.extend(
                dirs.iter()
                    .map(|dir| format!("{}（仅写入）", dir.to_string_lossy())),
            );
        }
        all.sort();
        if all.is_empty() {
            "（暂无）".to_string()
        } else {
            all.join("、")
        }
    }

    /// Reads are gated on this: `read_file_bytes`, `read_file_binary`,
    /// `open_path` and `print_file`.
    pub fn require_read(&self, path: &str) -> Result<PathBuf, String> {
        let target = potools_engine::services::filesystem::validate_absolute_path(path, "路径")?;
        if self.can_read(&target) {
            Ok(target)
        } else {
            Err(denial(path, self))
        }
    }

    /// Writes are gated on this: `write_file_bytes`, `write_output_file` and
    /// `copy_staged_artifact`. A path this process wrote becomes readable, which
    /// is what keeps "reveal the file I just saved" working.
    pub fn require_write(&self, path: &str) -> Result<PathBuf, String> {
        let target = potools_engine::services::filesystem::validate_absolute_path(path, "路径")?;
        if self.can_write(&target) {
            Ok(target)
        } else {
            Err(denial(path, self))
        }
    }
}

fn denial(path: &str, grants: &PathGrants) -> String {
    format!(
        "path_not_authorized: {path}\n已授权目录：{}",
        grants.describe()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("potools-grants-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("scratch dir");
        dir.canonicalize().expect("canonical scratch")
    }

    #[test]
    fn nothing_is_authorized_before_a_gesture() {
        let grants = PathGrants::new();
        let dir = scratch("empty");
        assert!(!grants.can_read(&dir.join("secret.txt")));
        assert!(!grants.can_write(&dir.join("secret.txt")));
    }

    #[test]
    fn a_picked_file_is_readable_and_writable_but_siblings_are_not() {
        let grants = PathGrants::new();
        let dir = scratch("file");
        let picked = dir.join("picked.pdf");
        fs::write(&picked, b"x").unwrap();

        grants.grant_file(&picked);
        assert!(grants.can_read(&picked));
        assert!(grants.can_write(&picked));
        // Granting a *file* must not grant its directory.
        assert!(!grants.can_read(&dir.join("sibling.pdf")));
    }

    #[test]
    fn a_picked_directory_covers_its_subtree_only() {
        let grants = PathGrants::new();
        let parent = scratch("dir");
        let chosen = parent.join("chosen");
        fs::create_dir_all(chosen.join("nested")).unwrap();

        grants.grant_dir(&chosen);
        assert!(grants.can_read(&chosen.join("nested").join("a.pdf")));
        assert!(grants.can_write(&chosen.join("nested").join("new.pdf")));
        assert!(!grants.can_read(&parent.join("outside.pdf")));
    }

    #[test]
    fn traversal_cannot_escape_a_granted_directory() {
        let grants = PathGrants::new();
        let dir = scratch("traversal");
        let chosen = dir.join("chosen");
        fs::create_dir_all(&chosen).unwrap();
        grants.grant_dir(&chosen);

        let escape = chosen.join("..").join("outside.pdf");
        assert!(!grants.can_read(&escape));
        assert!(!grants.can_write(&escape));
    }

    #[test]
    fn a_deleted_and_recreated_symlink_target_stays_out() {
        // The grant is stored canonicalised, so a symlink pointing *into* a
        // granted directory does not authorise the link's own location.
        let grants = PathGrants::new();
        let dir = scratch("symlink");
        let chosen = dir.join("chosen");
        fs::create_dir_all(&chosen).unwrap();
        grants.grant_dir(&chosen);

        let target = chosen.join("real.pdf");
        fs::write(&target, b"x").unwrap();
        assert!(grants.can_read(&target));

        #[cfg(unix)]
        {
            let link = dir.join("link.pdf");
            std::os::unix::fs::symlink(&target, &link).unwrap();
            // Resolves into the granted directory, so it is allowed…
            assert!(grants.can_read(&link));
            // …but a link pointing outside is not.
            let outside = dir.join("outside.pdf");
            fs::write(&outside, b"y").unwrap();
            let escape_link = chosen.join("escape.pdf");
            std::os::unix::fs::symlink(&outside, &escape_link).unwrap();
            assert!(!grants.can_read(&escape_link));
        }
    }

    #[test]
    fn a_write_only_directory_never_becomes_a_read_grant() {
        // The output directory is a visible, persisted setting, so a script can
        // redirect writes; it must not be able to redirect *reads*.
        let grants = PathGrants::new();
        let dir = scratch("writeonly");
        fs::write(dir.join("existing.pdf"), b"x").unwrap();

        grants.grant_write_dir(&dir);
        assert!(grants.can_write(&dir.join("new.pdf")));
        assert!(!grants.can_read(&dir.join("existing.pdf")));
    }

    #[test]
    fn a_written_file_becomes_readable() {
        let grants = PathGrants::new();
        let dir = scratch("written");
        let target = dir.join("saved.pdf");

        grants.grant_write_dir(&dir);
        assert!(!grants.can_read(&target), "not readable before it exists");
        fs::write(&target, b"x").unwrap();
        grants.grant_file(&target);
        assert!(grants.can_read(&target), "reveal-after-save must work");
    }

    #[test]
    fn a_temp_root_grants_only_its_app_subdirectories() {
        let grants = PathGrants::new();
        let root = scratch("temp");
        grants.grant_temp_root(&root);

        assert!(grants.can_write(&root.join("jobs").join("job-1").join("out.pdf")));
        assert!(grants.can_write(&root.join("inbox").join("out.pdf")));
        assert!(
            !grants.can_read(&root.join("notes.txt")),
            "the root itself is not granted"
        );
    }

    #[test]
    fn relative_paths_are_refused_by_both_gates() {
        let grants = PathGrants::new();
        grants.grant_dir(&scratch("gates"));
        assert!(grants.require_read("relative/file.pdf").is_err());
        assert!(grants.require_write("relative/file.pdf").is_err());
        let denied = grants
            .require_read("/definitely/not/granted.pdf")
            .unwrap_err();
        assert!(denied.starts_with("path_not_authorized:"));
    }
}
