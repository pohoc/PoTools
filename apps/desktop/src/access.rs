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
//! A fourth, narrower source is the user's own configuration: the output
//! directory and the temp directory are visible, persisted settings. Turning one
//! of those into a *write* grant is acceptable; turning it into a *read* grant
//! would not be, because a script could point the setting at a sensitive
//! directory and read it back. Hence [`PathGrants::grant_write_dir`] and the
//! temp grants, which cover only the app's own `jobs/` and `inbox/` subdirectories
//! rather than the whole configured tree.
//!
//! Honouring a setting is still not the same as accepting a path over IPC, so a
//! directory only becomes *approvable* once a native gesture picked it or the
//! user confirmed it in a native dialog ([`PathGrants::approve_directory`]).
//! That approval list is written by this process into its own config directory
//! and re-applied at startup, which keeps a saved setting working across restarts
//! while `set_output_dir` / `set_temp_dir` can no longer mint authority for a
//! path a script invented.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

/// The app-owned subdirectories of a temp root. Only these are ever staged into
/// or read from, so granting them keeps a hostile `tempDir` setting from becoming
/// a read capability over that directory.
pub const TEMP_SUBDIRECTORIES: [&str; 2] = ["jobs", "inbox"];

/// Which privileged purpose a user-approved directory may serve.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalKind {
    /// Receives written output files.
    Output,
    /// Holds the app's own `jobs/` and `inbox/` staging directories.
    Temp,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryApproval {
    /// Canonical path, recorded and revalidated by this process.
    path: String,
    kind: ApprovalKind,
}

#[derive(Default)]
pub struct PathGrants {
    /// Readable only: files the user picked or dropped, OS paths this process
    /// enumerated, and files this process wrote (so "reveal what I just saved"
    /// keeps working). Read authority must never imply write authority — see the
    /// threat model above.
    files: RwLock<HashSet<PathBuf>>,
    /// Writable: only the save-dialog targets this process handed to a native
    /// dialog, i.e. a file the user explicitly agreed to overwrite.
    writable_files: RwLock<HashSet<PathBuf>>,
    /// Readable and writable: directories the user picked or dropped.
    dirs: RwLock<HashSet<PathBuf>>,
    /// Writable only: the configured output directory.
    write_dirs: RwLock<HashSet<PathBuf>>,
    /// Roots the in-app folder browser may enumerate. Never implied by a file
    /// pick of a single file, and never a whole-filesystem walk.
    browsable: RwLock<HashSet<PathBuf>>,
    /// Temp roots this process handed grants for, so usage and cleanup cannot be
    /// aimed at an arbitrary directory.
    temp_roots: RwLock<HashSet<PathBuf>>,
    /// The output folder this build derived at startup. A setting that merely
    /// re-states it needs no approval entry, because the value never came from
    /// the WebView.
    app_default_output: RwLock<Option<PathBuf>>,
    app_default_temp: RwLock<Option<PathBuf>>,
    approvals: RwLock<Vec<DirectoryApproval>>,
    approvals_file: RwLock<Option<PathBuf>>,
}

impl PathGrants {
    pub fn new() -> Self {
        Self::default()
    }

    /// Resolve a path to its real location so `..`, a symlink or a case-folded
    /// spelling cannot slip past the prefix check. Shared with the engine's
    /// `resolve_path`, which is also what `browse_directories` compares against.
    fn canonical(path: &Path) -> Option<PathBuf> {
        potools_engine::services::filesystem::resolve_path(path)
    }

    /// Grant **read** authority over one file. Deliberately not writable: the
    /// font enumeration and the file picker both hand over paths the user never
    /// agreed to have overwritten.
    pub fn grant_file(&self, path: &Path) -> Option<PathBuf> {
        let resolved = Self::canonical(path)?;
        self.files.write().ok()?.insert(resolved.clone());
        Some(resolved)
    }

    /// Grant read **and write** over one file: use only for the result of a
    /// native save dialog, where the user chose that exact destination.
    pub fn grant_writable_file(&self, path: &Path) -> Option<PathBuf> {
        let resolved = Self::canonical(path)?;
        if let Ok(mut files) = self.files.write() {
            files.insert(resolved.clone());
        }
        self.writable_files.write().ok()?.insert(resolved.clone());
        Some(resolved)
    }

    pub fn grant_dir(&self, path: &Path) -> Option<PathBuf> {
        let resolved = Self::canonical(path)?;
        self.dirs.write().ok()?.insert(resolved.clone());
        if let Ok(mut browsable) = self.browsable.write() {
            browsable.insert(resolved.clone());
        }
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
        let Some(canonical) = Self::canonical(root) else {
            return;
        };
        for name in TEMP_SUBDIRECTORIES {
            self.grant_dir(&canonical.join(name));
        }
        if let Ok(mut roots) = self.temp_roots.write() {
            roots.insert(canonical);
        }
    }

    /// Let the folder browser enumerate this subtree (the user's own home and
    /// standard folders, seeded by Rust rather than by a value from the WebView).
    pub fn allow_browsing(&self, root: &Path) {
        if let (Some(canonical), Ok(mut browsable)) =
            (Self::canonical(root), self.browsable.write())
        {
            browsable.insert(canonical);
        }
    }

    /// The roots `browse_directories` may list, canonicalized.
    pub fn browse_roots(&self) -> Vec<PathBuf> {
        self.browsable
            .read()
            .map(|roots| roots.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Grant the directories **this build derives itself**: the default output
    /// folder and the default staging root. Their values come from Rust rather
    /// than from a WebView claim, which is the distinction the threat model rests
    /// on, so they need no entry in the approval store — and must not gain one,
    /// because they are recomputed on every launch.
    pub fn grant_app_defaults(&self, output_dir: &Path, temp_root: &Path) {
        if let Some(canonical) = Self::canonical(output_dir) {
            if let Ok(mut slot) = self.app_default_output.write() {
                *slot = Some(canonical);
            }
        }
        if let Some(canonical) = Self::canonical(temp_root) {
            if let Ok(mut slot) = self.app_default_temp.write() {
                *slot = Some(canonical);
            }
        }
        self.grant_write_dir(output_dir);
        self.grant_temp_root(temp_root);
    }

    /// The staging root this build derives (`<temp>/potools` on a standard
    /// install). Clearing the temp setting returns here rather than to the bare
    /// platform temp directory, so no wider grant than the app's own folder is
    /// ever implied by "use the default".
    pub fn app_default_temp(&self) -> Option<PathBuf> {
        self.app_default_temp
            .read()
            .ok()
            .and_then(|slot| slot.clone())
    }

    /// Load the approval list this process recorded on an earlier run and
    /// re-apply its grants, so a saved output/temp directory keeps working.
    /// Entries whose directory has since disappeared are dropped.
    pub fn load_approvals(&self, file: &Path) -> Result<(), String> {
        *self
            .approvals_file
            .write()
            .map_err(|_| "授权记录锁不可用")? = Some(file.to_path_buf());
        let raw = match std::fs::read(file) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(format!("无法读取目录授权记录：{error}")),
        };
        let stored: Vec<DirectoryApproval> =
            serde_json::from_slice(&raw).map_err(|error| format!("目录授权记录已损坏：{error}"))?;
        let stored_count = stored.len();
        let mut kept = Vec::new();
        for entry in &stored {
            let path = Path::new(&entry.path);
            let Some(canonical) = Self::canonical(path) else {
                continue;
            };
            if !canonical.is_dir() {
                continue;
            }
            kept.push(DirectoryApproval {
                path: canonical.to_string_lossy().into_owned(),
                kind: entry.kind,
            });
            self.apply_approval(&canonical, entry.kind);
        }
        *self.approvals.write().map_err(|_| "授权记录锁不可用")? = kept.clone();
        if kept.len() != stored_count {
            self.store_approvals()?;
        }
        Ok(())
    }

    /// Record a directory as approved for `kind`, then grant what that implies.
    /// Callers must only reach this through a native gesture: the folder dialog
    /// or an explicit confirmation prompt shown by this process.
    pub fn approve_directory(&self, path: &Path, kind: ApprovalKind) -> Result<PathBuf, String> {
        let canonical = Self::canonical(path).ok_or_else(|| {
            format!(
                "directoryNotApproved: 目录不存在或无法解析：{}",
                path.display()
            )
        })?;
        if !canonical.is_dir() {
            return Err(format!("目录不是文件夹：{}", canonical.display()));
        }
        {
            let approvals = self.approvals.read().map_err(|_| "授权记录锁不可用")?;
            let known = approvals
                .iter()
                .any(|entry| entry.kind == kind && Path::new(&entry.path) == canonical.as_path());
            drop(approvals);
            if !known {
                self.approvals
                    .write()
                    .map_err(|_| "授权记录锁不可用")?
                    .push(DirectoryApproval {
                        path: canonical.to_string_lossy().into_owned(),
                        kind,
                    });
                self.store_approvals()?;
            }
        }
        self.apply_approval(&canonical, kind);
        Ok(canonical)
    }

    fn apply_approval(&self, canonical: &Path, kind: ApprovalKind) {
        match kind {
            ApprovalKind::Output => {
                self.grant_write_dir(canonical);
            }
            ApprovalKind::Temp => self.grant_temp_root(canonical),
        }
        self.allow_browsing(canonical);
    }

    fn store_approvals(&self) -> Result<(), String> {
        let Some(file) = self
            .approvals_file
            .read()
            .ok()
            .and_then(|slot| slot.clone())
        else {
            return Ok(());
        };
        let entries = self.approvals.read().map_err(|_| "授权记录锁不可用")?;
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let json = serde_json::to_vec_pretty(&*entries).map_err(|error| error.to_string())?;
        std::fs::write(&file, json).map_err(|error| error.to_string())
    }

    /// True once the user has, through a native gesture, approved this directory
    /// for that purpose. A path that merely arrived over IPC is never approved.
    pub fn is_approved(&self, path: &Path, kind: ApprovalKind) -> bool {
        let Some(canonical) = Self::canonical(path) else {
            return false;
        };
        self.approvals.read().is_ok_and(|entries| {
            entries
                .iter()
                .any(|entry| entry.kind == kind && Path::new(&entry.path) == canonical.as_path())
        })
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
        let Some(target) = Self::canonical(path) else {
            return false;
        };
        if self
            .writable_files
            .read()
            .is_ok_and(|files| files.contains(&target))
        {
            return true;
        }
        // A directory the user picked or dropped is read+write for its whole
        // subtree; a single granted *file* is not, which is the difference this
        // method used to get wrong.
        if self
            .dirs
            .read()
            .is_ok_and(|dirs| dirs.iter().any(|dir| target.starts_with(dir)))
        {
            return true;
        }
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
        all.dedup();
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
    /// `copy_staged_artifact`. Read authority never implies write authority:
    /// only save-dialog targets ([`PathGrants::grant_writable_file`], picked
    /// directories and the write-only configured folders are writable.
    pub fn require_write(&self, path: &str) -> Result<PathBuf, String> {
        let target = potools_engine::services::filesystem::validate_absolute_path(path, "路径")?;
        if self.can_write(&target) {
            Ok(target)
        } else {
            Err(denial(path, self))
        }
    }

    /// A directory the caller wants to *enumerate or read inside*: the grant must
    /// cover the directory itself, so `invoice_scan_list` cannot be aimed at any
    /// folder on disk by handing over its absolute path.
    pub fn require_source_dir(&self, path: &str, what: &str) -> Result<PathBuf, String> {
        let target = self.require_read(path)?;
        if !target.is_dir() {
            return Err(format!("{what}不是目录：{path}"));
        }
        Ok(target)
    }

    /// One file taken from a source the user granted.
    pub fn require_source_file(&self, path: &str) -> Result<PathBuf, String> {
        self.require_read(path)
    }

    /// A directory the caller wants to write into.
    pub fn require_destination_dir(&self, path: &str) -> Result<PathBuf, String> {
        self.require_write(path)
    }

    /// Only a temp root this process granted may be measured or cleaned up;
    /// otherwise `temp_clean` would delete `jobs/` and `inbox/` under any path a
    /// script names.
    pub fn require_app_temp_root(&self, path: &str) -> Result<PathBuf, String> {
        let target =
            potools_engine::services::filesystem::validate_absolute_path(path, "临时目录")?;
        let canonical = Self::canonical(&target)
            .ok_or_else(|| format!("temp_root_not_authorized: 临时目录不存在：{path}"))?;
        if self
            .temp_roots
            .read()
            .is_ok_and(|roots| roots.contains(&canonical))
        {
            Ok(canonical)
        } else {
            Err(format!("temp_root_not_authorized: {path}"))
        }
    }

    /// A configured directory may only be honoured once the user approved it;
    /// the error text is what the settings UI shows next to the field.
    pub fn require_approved(
        &self,
        path: &str,
        kind: ApprovalKind,
        what: &str,
    ) -> Result<PathBuf, String> {
        let target = potools_engine::services::filesystem::validate_absolute_path(path, what)?;
        if self.is_approved(&target, kind) || self.is_app_default(&target, kind) {
            Ok(target)
        } else {
            Err(format!(
                "directoryNotApproved: {path} 尚未经用户确认允许 PoTools 使用，请在设置中重新选择该目录"
            ))
        }
    }

    /// A setting that simply re-states a directory **this build derived** is
    /// trusted without an approval entry: the value originated in Rust, not in a
    /// WebView argument. `temp_roots` only ever holds roots `grant_temp_root` was
    /// called with, so membership is already proof of that provenance.
    fn is_app_default(&self, path: &Path, kind: ApprovalKind) -> bool {
        let Some(canonical) = Self::canonical(path) else {
            return false;
        };
        match kind {
            ApprovalKind::Temp => self
                .temp_roots
                .read()
                .is_ok_and(|roots| roots.contains(&canonical)),
            ApprovalKind::Output => self
                .app_default_output
                .read()
                .is_ok_and(|slot| slot.as_deref() == Some(canonical.as_path())),
        }
    }

    /// Resolve the folder `browse_directories` is allowed to list. With no path
    /// the user's own home is used — it is seeded by Rust, not claimed by the
    /// WebView — and any explicit path has to sit inside a browsable root.
    pub fn resolve_browsable(&self, path: Option<&str>) -> Result<PathBuf, String> {
        let roots = self
            .browsable
            .read()
            .map(|entries| entries.iter().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        if roots.is_empty() {
            return Err("没有可供浏览的已授权目录".to_string());
        }
        let requested = match path.map(str::trim) {
            Some(value) if !value.is_empty() => {
                let raw =
                    potools_engine::services::filesystem::validate_absolute_path(value, "目录")?;
                Self::canonical(&raw).ok_or_else(|| format!("目录无法解析：{value}"))?
            }
            _ => Self::canonical(&potools_engine::services::filesystem::home_directory())
                .filter(|home| roots.iter().any(|root| home.starts_with(root)))
                .ok_or_else(|| "没有可供浏览的已授权目录".to_string())?,
        };
        if roots.iter().any(|root| requested.starts_with(root)) {
            Ok(requested)
        } else {
            Err(format!("目录未授权浏览：{}", requested.display()))
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
    fn a_picked_file_is_readable_but_never_writable() {
        let grants = PathGrants::new();
        let dir = scratch("file");
        let picked = dir.join("picked.pdf");
        fs::write(&picked, b"x").unwrap();

        grants.grant_file(&picked);
        assert!(grants.can_read(&picked));
        // SEC-06: picking a file to process it is not agreeing to have it
        // overwritten in place.
        assert!(!grants.can_write(&picked));
        assert!(!grants.can_read(&dir.join("sibling.pdf")));
    }

    #[test]
    fn only_a_save_dialog_target_is_writable_and_stays_revealed() {
        let grants = PathGrants::new();
        let dir = scratch("save-target");
        let target = dir.join("result.pdf");

        grants.grant_writable_file(&target);
        assert!(grants.can_write(&target));
        assert!(
            grants.can_read(&target),
            "reveal-after-save must keep working"
        );
        assert!(!grants.can_write(&dir.join("other.pdf")));
        assert!(!grants.can_read(&dir.join("other.pdf")));
    }

    #[test]
    fn an_enumerated_font_path_is_not_a_write_target() {
        // The shape of the old hole: `system_font_candidates` grants read over
        // every font it enumerates, including user-writable ~/Library/Fonts.
        let grants = PathGrants::new();
        let dir = scratch("fonts");
        let font = dir.join("fallback.ttf");
        fs::write(&font, b"ttcf").unwrap();
        grants.grant_file(&font);
        assert!(grants.can_read(&font));
        let denied = grants.require_write(&font.to_string_lossy()).unwrap_err();
        assert!(denied.starts_with("path_not_authorized:"), "{denied}");
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

    #[test]
    fn an_unapproved_directory_cannot_be_honoured_as_a_setting() {
        // The shape of the SEC-02 attack: a script calls `set_output_dir` with a
        // path the user never approved. Approval is a separate, gesture-backed
        // step, so the setting alone must not produce a write grant.
        let grants = PathGrants::new();
        let dir = scratch("unapproved-setting");
        fs::write(dir.join("existing.pdf"), b"x").unwrap();
        assert!(!grants.is_approved(&dir, ApprovalKind::Output));
        let error = grants
            .require_approved(&dir.to_string_lossy(), ApprovalKind::Output, "输出目录")
            .unwrap_err();
        assert!(error.starts_with("directoryNotApproved:"), "{error}");
        assert!(!grants.can_write(&dir.join("existing.pdf")));
    }

    #[test]
    fn an_approval_is_recorded_granted_and_survives_a_restart() {
        let grants = PathGrants::new();
        let root = scratch("approval-store");
        let output = root.join("out");
        fs::create_dir_all(&output).unwrap();
        let store = root.join("config").join("directory-approvals.json");
        grants.load_approvals(&store).expect("empty store loads");

        grants
            .approve_directory(&output, ApprovalKind::Output)
            .expect("approve");
        assert!(grants.is_approved(&output, ApprovalKind::Output));
        assert!(grants.can_write(&output.join("new.pdf")));
        assert!(
            !grants.can_read(&output.join("new.pdf")),
            "an output approval stays write-only"
        );
        assert!(store.is_file(), "the approval is persisted by this process");

        // A fresh grant set — the state after an app restart — restores the same
        // capability from the recorded approval and nothing else.
        let restarted = PathGrants::new();
        restarted.load_approvals(&store).expect("load");
        assert!(restarted.can_write(&output.join("new.pdf")));
        assert!(!restarted.can_read(&root.join("notes.txt")));
        assert!(!restarted.is_approved(&root, ApprovalKind::Output));
    }

    #[test]
    fn a_stale_approval_is_dropped_when_its_directory_is_gone() {
        let root = scratch("stale-approval");
        let output = root.join("out");
        fs::create_dir_all(&output).unwrap();
        let store = root.join("config").join("directory-approvals.json");
        let grants = PathGrants::new();
        grants.load_approvals(&store).expect("empty store");
        grants
            .approve_directory(&output, ApprovalKind::Output)
            .expect("approve");
        fs::remove_dir_all(&output).unwrap();

        let restarted = PathGrants::new();
        restarted.load_approvals(&store).expect("load");
        assert!(!restarted.is_approved(&output, ApprovalKind::Output));
        assert!(!restarted.can_write(&output.join("any.pdf")));
    }

    #[test]
    fn only_a_temp_root_this_process_granted_can_be_used_or_cleaned() {
        let grants = PathGrants::new();
        let trusted = scratch("trusted-temp");
        grants.grant_temp_root(&trusted);
        let attacker = scratch("attacker-temp");
        fs::create_dir_all(attacker.join("jobs").join("job-1")).unwrap();

        assert!(grants
            .require_app_temp_root(&trusted.to_string_lossy())
            .is_ok());
        let error = grants
            .require_app_temp_root(&attacker.to_string_lossy())
            .unwrap_err();
        assert!(error.starts_with("temp_root_not_authorized:"), "{error}");
        assert!(!grants.can_write(&attacker.join("jobs")));
    }

    #[test]
    fn browsing_follows_picked_directories_and_explicit_roots_only() {
        let grants = PathGrants::new();
        let root = scratch("browse");
        let picked = root.join("picked");
        let elsewhere = root.join("elsewhere");
        fs::create_dir_all(picked.join("nested")).unwrap();
        fs::create_dir_all(&elsewhere).unwrap();

        assert!(grants.browse_roots().is_empty());
        grants.grant_dir(&picked);
        grants.allow_browsing(&elsewhere);
        let roots = grants.browse_roots();
        assert!(roots.contains(&picked.canonicalize().unwrap()));
        assert!(roots.contains(&elsewhere.canonicalize().unwrap()));
        // A single picked file never opens its directory for browsing.
        let lone = root.join("lone.pdf");
        fs::write(&lone, b"x").unwrap();
        grants.grant_file(&lone);
        let roots_after = grants.browse_roots();
        assert_eq!(roots_after.len(), roots.len());
    }

    #[test]
    fn a_source_directory_gate_needs_the_directory_itself() {
        let grants = PathGrants::new();
        let root = scratch("source-dir");
        let file = root.join("invoice.pdf");
        fs::write(&file, b"x").unwrap();
        grants.grant_file(&file);
        // Granting one file must not let the invoice scanner enumerate its folder.
        assert!(grants
            .require_source_dir(&file.to_string_lossy(), "来源目录")
            .is_err());
        grants.grant_dir(&root);
        assert!(grants
            .require_source_dir(&root.to_string_lossy(), "来源目录")
            .is_ok());
    }
}
