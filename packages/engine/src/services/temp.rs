use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TempUsage {
    pub dir: String,
    pub jobs: usize,
    pub files: u64,
    pub bytes: u64,
    pub oldest_at: Option<u64>,
    pub newest_at: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TempCleanResult {
    pub removed_jobs: usize,
    pub removed_files: u64,
    pub freed_bytes: u64,
    pub kept_jobs: usize,
}

type TempEntry = (PathBuf, String, u64);

fn temp_groups(root: &Path, subdirectory: &str) -> Vec<TempEntry> {
    let Ok(entries) = fs::read_dir(root.join(subdirectory)) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            if !entry.file_type().ok()?.is_dir() {
                return None;
            }
            let path = entry.path();
            let modified = entry.metadata().ok()?.modified().unwrap_or(UNIX_EPOCH);
            let modified_ms = modified
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .min(u64::MAX as u128) as u64;
            Some((
                path,
                entry.file_name().to_string_lossy().into_owned(),
                modified_ms,
            ))
        })
        .collect()
}

fn temp_groups_all(root: &Path) -> Vec<TempEntry> {
    ["jobs", "inbox"]
        .into_iter()
        .flat_map(|sub| temp_groups(root, sub))
        .collect()
}

fn temp_dir_size(path: &Path) -> (u64, u64) {
    let mut files = 0_u64;
    let mut bytes = 0_u64;
    let mut pending = vec![path.to_path_buf()];
    while let Some(current) = pending.pop() {
        let Ok(entries) = fs::read_dir(current) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                pending.push(entry.path());
            } else {
                files = files.saturating_add(1);
                bytes = bytes.saturating_add(entry.metadata().map(|info| info.len()).unwrap_or(0));
            }
        }
    }
    (files, bytes)
}

pub fn temp_usage(root: String) -> TempUsage {
    let path = PathBuf::from(root);
    let groups = temp_groups_all(&path);
    let (files, bytes) = groups
        .iter()
        .fold((0_u64, 0_u64), |(files, bytes), (dir, _, _)| {
            let (next_files, next_bytes) = temp_dir_size(dir);
            (
                files.saturating_add(next_files),
                bytes.saturating_add(next_bytes),
            )
        });
    let oldest_at = groups.iter().map(|(_, _, modified)| *modified).min();
    let newest_at = groups.iter().map(|(_, _, modified)| *modified).max();
    TempUsage {
        dir: path.to_string_lossy().into_owned(),
        jobs: groups.len(),
        files,
        bytes,
        oldest_at,
        newest_at,
    }
}

pub fn temp_clean(
    root: String,
    older_than_days: f64,
    keep_jobs: usize,
    protect_jobs: Vec<String>,
) -> TempCleanResult {
    let path = PathBuf::from(root);
    let cutoff = if older_than_days.is_finite() && older_than_days > 0.0 {
        Duration::try_from_secs_f64(older_than_days * 86_400.0)
            .ok()
            .and_then(|age| SystemTime::now().checked_sub(age))
    } else {
        None
    };
    let protected: std::collections::HashSet<String> = protect_jobs.into_iter().collect();
    let mut removed_jobs = 0;
    let mut removed_files = 0_u64;
    let mut freed_bytes = 0_u64;
    let mut kept_jobs = 0;
    for subdirectory in ["jobs", "inbox"] {
        let mut groups = temp_groups(&path, subdirectory);
        groups.sort_by_key(|group| std::cmp::Reverse(group.2));
        for (index, (directory, name, modified_ms)) in groups.into_iter().enumerate() {
            let modified = UNIX_EPOCH + Duration::from_millis(modified_ms);
            let too_recent = cutoff.is_some_and(|limit| modified > limit);
            if index < keep_jobs || protected.contains(&name) || too_recent {
                kept_jobs += 1;
                continue;
            }
            let (files, bytes) = temp_dir_size(&directory);
            if fs::remove_dir_all(directory).is_ok() {
                removed_jobs += 1;
                removed_files = removed_files.saturating_add(files);
                freed_bytes = freed_bytes.saturating_add(bytes);
            } else {
                kept_jobs += 1;
            }
        }
    }
    TempCleanResult {
        removed_jobs,
        removed_files,
        freed_bytes,
        kept_jobs,
    }
}
