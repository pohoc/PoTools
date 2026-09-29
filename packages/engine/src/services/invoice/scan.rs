use super::crypto::invoice_extension;
use super::paths::invoice_normalize_absolute;
use super::types::{InvoiceCandidateRead, InvoiceScanCandidate, InvoiceScanListing};
use std::fs;
use std::path::{Path, PathBuf};

pub fn invoice_scan_list(
    directory: String,
    recursive: Option<bool>,
    max_files: Option<f64>,
    exclude_directory: Option<String>,
) -> Result<InvoiceScanListing, String> {
    const MAX_FILES: usize = 2000;
    let requested_root = PathBuf::from(&directory);
    if directory.is_empty() || !requested_root.is_absolute() {
        return Err("请选择有效的来源目录".to_string());
    }
    let root = fs::canonicalize(&requested_root).map_err(|_| "无法访问来源目录")?;
    if !fs::metadata(&root)
        .map_err(|error| error.to_string())?
        .is_dir()
    {
        return Err("来源路径不是目录".to_string());
    }
    let excluded = exclude_directory
        .filter(|path| !path.trim().is_empty())
        .map(|path| {
            let raw = PathBuf::from(&path);
            let absolute = if raw.is_absolute() {
                raw
            } else {
                std::env::current_dir().unwrap_or_default().join(raw)
            };
            fs::canonicalize(&absolute)
                .unwrap_or_else(|_| invoice_normalize_absolute(&absolute).unwrap_or(absolute))
        });
    if excluded
        .as_ref()
        .is_some_and(|path| path == &root || path.starts_with(&root))
    {
        return Err("归档目标不能与来源目录相同或位于来源目录内".to_string());
    }
    let requested_limit = max_files.unwrap_or(MAX_FILES as f64);
    let limit = if requested_limit.is_finite() {
        requested_limit.trunc().clamp(1.0, MAX_FILES as f64) as usize
    } else {
        MAX_FILES
    };
    let recurse = recursive != Some(false);
    let mut files = Vec::new();
    let mut skipped = Vec::new();
    let mut total_bytes = 0_u64;
    let mut exceeded = false;

    fn walk(
        directory: &Path,
        root: &Path,
        excluded: Option<&Path>,
        recursive: bool,
        limit: usize,
        total_bytes: &mut u64,
        exceeded: &mut bool,
        files: &mut Vec<InvoiceScanCandidate>,
        skipped: &mut Vec<serde_json::Value>,
    ) {
        const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;
        const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
        const ALLOWED: [&str; 7] = [".pdf", ".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"];
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(error) => {
                let relative = directory
                    .strip_prefix(root)
                    .unwrap_or(directory)
                    .to_string_lossy()
                    .replace('\\', "/");
                skipped.push(serde_json::json!({"relativePath":relative,"reason":format!("无法读取目录：{}", error)}));
                return;
            }
        };
        for result in entries {
            if files.len() >= limit || *total_bytes >= MAX_TOTAL_BYTES {
                *exceeded = true;
                return;
            }
            let Ok(entry) = result else { continue };
            let path = entry.path();
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            if excluded.is_some_and(|excluded| path == excluded || path.starts_with(excluded)) {
                continue;
            }
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => {
                    skipped.push(serde_json::json!({"relativePath":relative,"reason":"文件状态已变化，已跳过"}));
                    continue;
                }
            };
            if file_type.is_symlink() {
                skipped.push(serde_json::json!({"relativePath":relative,"reason":"跳过符号链接"}));
                continue;
            }
            if file_type.is_dir() {
                if recursive {
                    walk(
                        &path,
                        root,
                        excluded,
                        recursive,
                        limit,
                        total_bytes,
                        exceeded,
                        files,
                        skipped,
                    );
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let Some(extension) = invoice_extension(&path) else {
                continue;
            };
            if !ALLOWED.contains(&extension.as_str()) {
                continue;
            }
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                    metadata
                }
                _ => {
                    skipped.push(serde_json::json!({"relativePath":relative,"reason":"文件状态已变化，已跳过"}));
                    continue;
                }
            };
            if metadata.len() > MAX_FILE_BYTES {
                skipped.push(
                    serde_json::json!({"relativePath":relative,"reason":"超过单文件 100 MB 上限"}),
                );
                continue;
            }
            if total_bytes.saturating_add(metadata.len()) > MAX_TOTAL_BYTES {
                *exceeded = true;
                return;
            }
            *total_bytes = total_bytes.saturating_add(metadata.len());
            files.push(InvoiceScanCandidate {
                path: path.to_string_lossy().into_owned(),
                relative_path: relative,
                name: entry.file_name().to_string_lossy().into_owned(),
                extension,
                size_bytes: metadata.len(),
            });
        }
    }

    walk(
        &root,
        &root,
        excluded.as_deref(),
        recurse,
        limit,
        &mut total_bytes,
        &mut exceeded,
        &mut files,
        &mut skipped,
    );
    Ok(InvoiceScanListing {
        source_directory: root.to_string_lossy().into_owned(),
        files,
        skipped,
        exceeded,
    })
}

pub fn invoice_read_candidate(
    path: String,
    expected_size_bytes: u64,
) -> Result<InvoiceCandidateRead, String> {
    const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;
    let source = PathBuf::from(path);
    let metadata = fs::symlink_metadata(&source).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("文件状态已变化，已跳过".to_string());
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err("超过单文件 100 MB 上限".to_string());
    }
    let bytes = fs::read(&source).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("超过单文件 100 MB 上限".to_string());
    }
    let current_size_bytes = fs::metadata(&source)
        .map_err(|error| error.to_string())?
        .len();
    let changed_while_reading =
        bytes.len() as u64 != current_size_bytes || current_size_bytes != expected_size_bytes;
    Ok(InvoiceCandidateRead {
        bytes,
        current_size_bytes,
        changed_while_reading,
    })
}
