use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct StagedArtifact {
    pub staged_path: String,
    pub output_path: Option<String>,
    pub name: String,
}

#[derive(Serialize)]
pub struct WrittenFile {
    pub path: String,
    pub name: String,
}

#[derive(Serialize)]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
}

#[derive(Serialize)]
pub struct QuickDirectory {
    pub id: &'static str,
    pub path: String,
}

#[derive(Serialize)]
pub struct DirectoryListing {
    pub path: String,
    pub requested: String,
    pub parent: Option<String>,
    pub dirs: Vec<DirectoryEntry>,
    pub quick: Vec<QuickDirectory>,
}

pub fn write_file_bytes(path: String, bytes: Vec<u8>) -> Result<(), String> {
    let target = PathBuf::from(path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&target, bytes).map_err(|error| error.to_string())
}

pub fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|error| error.to_string())
}

pub fn browse_directories(path: Option<String>) -> Result<DirectoryListing, String> {
    let home = home_directory();
    let requested_path = path.unwrap_or_default();
    let requested = if requested_path.trim().is_empty() {
        home.clone()
    } else {
        let candidate = PathBuf::from(requested_path.trim());
        if candidate.is_absolute() {
            normalize_absolute_path(&candidate)
        } else {
            normalize_absolute_path(
                &std::env::current_dir()
                    .map_err(|error| error.to_string())?
                    .join(candidate),
            )
        }
    };

    let mut listed = requested.clone();
    let entries = loop {
        match fs::read_dir(&listed) {
            Ok(entries) => break entries,
            Err(_) => {
                let Some(parent) = listed.parent() else {
                    return Err(format!("无法读取目录：{}", listed.display()));
                };
                if parent == listed {
                    return Err(format!("无法读取目录：{}", listed.display()));
                }
                listed = parent.to_path_buf();
            }
        }
    };

    let mut dirs = entries
        .filter_map(Result::ok)
        .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|entry| {
            entry
                .file_type()
                .ok()
                .filter(|kind| kind.is_dir())
                .map(|_| DirectoryEntry {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    path: entry.path().to_string_lossy().into_owned(),
                })
        })
        .collect::<Vec<_>>();
    dirs.sort_by(|left, right| natural_directory_order(&left.name, &right.name));

    let mut quick = vec![QuickDirectory {
        id: "home",
        path: home.to_string_lossy().into_owned(),
    }];
    for (id, folder) in [
        ("documents", "Documents"),
        ("downloads", "Downloads"),
        ("desktop", "Desktop"),
    ] {
        let candidate = home.join(folder);
        if candidate.is_dir() {
            quick.push(QuickDirectory {
                id,
                path: candidate.to_string_lossy().into_owned(),
            });
        }
    }

    Ok(DirectoryListing {
        path: listed.to_string_lossy().into_owned(),
        requested: requested.to_string_lossy().into_owned(),
        parent: listed
            .parent()
            .map(|parent| parent.to_string_lossy().into_owned()),
        dirs,
        quick,
    })
}

pub fn stage_artifact(
    temp_root: String,
    job_id: String,
    name: String,
    output_dir: Option<String>,
    bytes: &[u8],
) -> Result<StagedArtifact, String> {
    let file_name = safe_artifact_name(&name);
    let job_dir = PathBuf::from(temp_root)
        .join("jobs")
        .join(safe_temp_segment(&job_id));
    fs::create_dir_all(&job_dir).map_err(|error| error.to_string())?;
    let (staged_path, _) = write_unique(&job_dir, &file_name, bytes)?;
    let (output_path, final_name) = if let Some(dir) = output_dir {
        let directory = PathBuf::from(dir);
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let (path, name) = write_unique(&directory, &file_name, bytes)?;
        (Some(path.to_string_lossy().to_string()), name)
    } else {
        (None, file_name)
    };
    Ok(StagedArtifact {
        staged_path: staged_path.to_string_lossy().to_string(),
        output_path,
        name: final_name,
    })
}

pub fn write_output_file(dir: String, name: String, bytes: Vec<u8>) -> Result<WrittenFile, String> {
    let directory = PathBuf::from(dir);
    if !directory.is_dir() {
        return Err(format!("输出目录不存在：{}", directory.display()));
    }
    let (path, name) = write_unique(&directory, &safe_artifact_name(&name), &bytes)?;
    Ok(WrittenFile {
        path: path.to_string_lossy().to_string(),
        name,
    })
}

pub fn copy_staged_artifact(
    from: String,
    dir: String,
    name: String,
    temp_root: String,
) -> Result<String, String> {
    let root = PathBuf::from(temp_root).join("jobs");
    let source = PathBuf::from(from);
    if !source.starts_with(&root) || !source.is_file() {
        return Err("找不到该临时产物".to_string());
    }
    let destination = PathBuf::from(dir);
    if !destination.is_dir() {
        return Err(format!("输出目录不存在：{}", destination.display()));
    }
    let bytes = fs::read(source).map_err(|error| error.to_string())?;
    let (path, _) = write_unique(&destination, &safe_artifact_name(&name), &bytes)?;
    Ok(path.to_string_lossy().to_string())
}

fn home_directory() -> PathBuf {
    if cfg!(target_os = "windows") {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    } else {
        std::env::var_os("HOME").map(PathBuf::from)
    }
    .unwrap_or_else(std::env::temp_dir)
}

fn normalize_absolute_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            std::path::Component::RootDir => normalized.push(component.as_os_str()),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if !normalized.pop() {
                    normalized.push(component.as_os_str());
                }
            }
            std::path::Component::Normal(part) => normalized.push(part),
        }
    }
    normalized
}

fn natural_directory_order(left: &str, right: &str) -> std::cmp::Ordering {
    fn chunks(value: &str) -> Vec<(bool, String)> {
        let mut result = Vec::new();
        let mut current = String::new();
        let mut digits = None;
        for character in value.chars() {
            let is_digit = character.is_ascii_digit();
            if digits.is_some_and(|previous| previous != is_digit) {
                result.push((digits.unwrap_or(false), std::mem::take(&mut current)));
            }
            digits = Some(is_digit);
            current.push(character);
        }
        if !current.is_empty() {
            result.push((digits.unwrap_or(false), current));
        }
        result
    }

    let left_chunks = chunks(left);
    let right_chunks = chunks(right);
    for (left_chunk, right_chunk) in left_chunks.iter().zip(&right_chunks) {
        let order = if left_chunk.0 && right_chunk.0 {
            let left_digits = left_chunk.1.trim_start_matches('0');
            let right_digits = right_chunk.1.trim_start_matches('0');
            left_digits
                .len()
                .cmp(&right_digits.len())
                .then_with(|| left_digits.cmp(right_digits))
                .then_with(|| left_chunk.1.len().cmp(&right_chunk.1.len()))
        } else {
            left_chunk
                .1
                .to_lowercase()
                .cmp(&right_chunk.1.to_lowercase())
        };
        if order != std::cmp::Ordering::Equal {
            return order;
        }
    }
    left_chunks
        .len()
        .cmp(&right_chunks.len())
        .then_with(|| left.cmp(right))
}

fn safe_artifact_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|character| {
            if character.is_control() || "\\/:*?\"<>|".contains(character) {
                '_'
            } else {
                character
            }
        })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "output.pdf".to_string()
    } else {
        trimmed.chars().take(120).collect()
    }
}

fn safe_temp_segment(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    if cleaned.is_empty() {
        "job".to_string()
    } else {
        cleaned
    }
}

fn write_unique(directory: &Path, name: &str, bytes: &[u8]) -> Result<(PathBuf, String), String> {
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem.to_string(), format!(".{extension}")),
        _ => (name.to_string(), String::new()),
    };
    for index in 1..=10_000 {
        let candidate = if index == 1 {
            name.to_string()
        } else {
            format!("{stem} ({index}){extension}")
        };
        let path = directory.join(&candidate);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                if let Err(error) = file.write_all(bytes) {
                    let _ = fs::remove_file(&path);
                    return Err(error.to_string());
                }
                return Ok((path, candidate));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("无法为输出文件生成不冲突的名称".to_string())
}
