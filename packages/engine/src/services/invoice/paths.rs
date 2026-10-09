use std::fs;
use std::path::{Path, PathBuf};

pub fn invoice_within(root: &Path, path: &Path) -> bool {
    path != root && path.starts_with(root)
}

pub fn invoice_normalize_absolute(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("请选择有效的归档目标目录".to_string());
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            std::path::Component::RootDir => normalized.push(component.as_os_str()),
            std::path::Component::CurDir => (),
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            std::path::Component::Normal(part) => normalized.push(part),
        }
    }
    Ok(normalized)
}

pub fn invoice_safe_segments(value: &str) -> Result<Vec<String>, String> {
    if value.is_empty()
        || value.len() > 2048
        || value.starts_with(['/', '\\'])
        || value.as_bytes().get(1) == Some(&b':')
    {
        return Err("目标路径必须是相对路径".to_string());
    }
    let mut segments = Vec::new();
    for raw in value.replace('\\', "/").split('/') {
        if raw.is_empty() {
            continue;
        }
        if raw == "." || raw == ".." {
            return Err("目标路径不能包含 . 或 ..".to_string());
        }
        let mut safe: String = raw
            .chars()
            .map(|ch| {
                if ch.is_control() || "<>:\"|?*".contains(ch) {
                    '_'
                } else {
                    ch
                }
            })
            .collect();
        while safe.ends_with([' ', '.']) {
            safe.pop();
        }
        safe = safe.chars().take(120).collect();
        if safe.is_empty() {
            safe.push('_');
        }
        let stem = safe.split('.').next().unwrap_or("");
        let upper_stem = stem.to_ascii_uppercase();
        let bytes = upper_stem.as_bytes();
        let reserved_numbered = bytes.len() == 4
            && (bytes.starts_with(b"COM") || bytes.starts_with(b"LPT"))
            && (b'1'..=b'9').contains(&bytes[3]);
        if ["CON", "PRN", "AUX", "NUL"].contains(&upper_stem.as_str()) || reserved_numbered {
            safe.insert(0, '_');
        }
        segments.push(safe);
    }
    if segments.is_empty() || segments.len() > 24 {
        return Err("目标路径层级无效".to_string());
    }
    Ok(segments)
}

pub fn invoice_ensure_safe_directory(root: &Path, directory: &Path) -> Result<(), String> {
    if !directory.starts_with(root) {
        return Err("目标目录超出归档目录".to_string());
    }
    let relative = directory
        .strip_prefix(root)
        .map_err(|_| "目标目录超出归档目录")?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let std::path::Component::Normal(segment) = component else {
            return Err("目标路径包含无效目录".to_string());
        };
        current.push(segment);
        match fs::create_dir(&current) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(error) => return Err(error.to_string()),
        }
        let metadata = fs::symlink_metadata(&current).map_err(|error| error.to_string())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("目标目录包含符号链接或非目录".to_string());
        }
    }
    Ok(())
}

pub fn invoice_free_destination(requested: &Path) -> Result<PathBuf, String> {
    let parent = requested.parent().ok_or("目标路径无效")?;
    let stem = requested
        .file_stem()
        .and_then(|v| v.to_str())
        .unwrap_or("output");
    let extension = requested
        .extension()
        .and_then(|v| v.to_str())
        .map(|v| format!(".{v}"))
        .unwrap_or_default();
    for suffix in 1..=9999 {
        let name = if suffix == 1 {
            requested.file_name().unwrap_or_default().to_os_string()
        } else {
            format!("{stem} ({suffix}){extension}").into()
        };
        let candidate = parent.join(name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("同名文件过多，无法自动生成不冲突的名称".to_string())
}
