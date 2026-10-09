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

/// Reject path shapes that no legitimate caller can produce.
///
/// Every one of these services takes a path as a plain string over IPC, so a
/// script running in the WebView can ask them to touch anything the process can
/// reach. The callers only ever hand over absolute paths that came from a native
/// file dialog, an OS drag-and-drop event, or `desktop_runtime_info`, so
/// requiring an absolute, NUL-free path rejects the cheap string tricks
/// (`../`, `~`, drive-relative `C:foo`, embedded NUL) without changing any real
/// flow.
///
/// This is shape validation, **not** authorization: it does not decide which
/// absolute paths are allowed, and a UNC/network path is still accepted because
/// picking a file from a share is a supported flow.
pub fn validate_absolute_path(path: &str, what: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err(format!("{what}不能为空"));
    }
    if path.contains('\0') {
        return Err(format!("{what}包含非法字符"));
    }
    let candidate = PathBuf::from(path);
    if !candidate.is_absolute() {
        return Err(format!("{what}必须是绝对路径：{path}"));
    }
    Ok(candidate)
}

pub fn write_file_bytes(path: String, bytes: Vec<u8>) -> Result<(), String> {
    // The parent is deliberately *not* created here: the only caller writes to a
    // path returned by the native save dialog, whose directory already exists.
    // Creating parents turned this into an arbitrary-directory-tree primitive.
    let target = validate_absolute_path(&path, "待写入路径")?;
    fs::write(&target, bytes).map_err(|error| error.to_string())
}

pub fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    let target = validate_absolute_path(&path, "待读取路径")?;
    fs::read(target).map_err(|error| error.to_string())
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
    let job_dir = validate_absolute_path(&temp_root, "临时目录")?
        .join("jobs")
        .join(safe_temp_segment(&job_id));
    fs::create_dir_all(&job_dir).map_err(|error| error.to_string())?;
    let (staged_path, _) = write_unique(&job_dir, &file_name, bytes)?;
    let (output_path, final_name) = if let Some(dir) = output_dir {
        let directory = validate_absolute_path(&dir, "输出目录")?;
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
    let directory = validate_absolute_path(&dir, "输出目录")?;
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
    let root = validate_absolute_path(&temp_root, "临时目录")?.join("jobs");
    let source = validate_absolute_path(&from, "临时产物路径")?;
    if !source.starts_with(&root) || !source.is_file() {
        return Err("找不到该临时产物".to_string());
    }
    let destination = validate_absolute_path(&dir, "输出目录")?;
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
    // `.` and `..` contain no separator, so they survive the character filter and
    // would still address a directory when joined; a name made only of dots is
    // never a real output name, so fall back to the default instead of producing
    // a file called `.. (2)`.
    if trimmed.is_empty() || trimmed.chars().all(|character| character == '.') {
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

#[cfg(test)]
mod path_guard_tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// Unique scratch directory per call, so `create_new` name-collision retries
    /// in `write_unique` cannot make assertions depend on test order.
    fn scratch(tag: &str) -> PathBuf {
        let id = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("potools-guard-{tag}-{}-{id}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    #[test]
    fn relative_paths_are_rejected_everywhere() {
        let relative = "some/relative/file.pdf".to_string();
        assert!(write_file_bytes(relative.clone(), vec![1]).is_err());
        assert!(read_file_bytes(relative.clone()).is_err());
        assert!(write_output_file(relative.clone(), "a.pdf".into(), vec![1]).is_err());
        assert!(copy_staged_artifact(
            relative.clone(),
            relative.clone(),
            "a.pdf".into(),
            relative.clone()
        )
        .is_err());
        assert!(
            stage_artifact(relative.clone(), "job".into(), "a.pdf".into(), None, &[1]).is_err()
        );
        assert!(stage_artifact(
            "/tmp".into(),
            "job".into(),
            "a.pdf".into(),
            Some(relative),
            &[1]
        )
        .is_err());
    }

    #[test]
    fn empty_and_nul_paths_are_rejected() {
        assert!(read_file_bytes(String::new()).is_err());
        assert!(read_file_bytes("   ".into()).is_err());
        assert!(read_file_bytes("/tmp/with\0nul".into()).is_err());
        assert!(write_file_bytes("/tmp/with\0nul".into(), vec![]).is_err());
    }

    #[test]
    fn absolute_paths_still_round_trip() {
        let dir = scratch("roundtrip");
        let target = dir.join("payload.bin");
        write_file_bytes(target.to_string_lossy().to_string(), vec![7, 8, 9])
            .expect("absolute write");
        assert_eq!(
            read_file_bytes(target.to_string_lossy().to_string()).unwrap(),
            vec![7, 8, 9]
        );
    }

    #[test]
    fn write_file_bytes_no_longer_creates_missing_parents() {
        // Dropping `create_dir_all` removed an arbitrary directory-tree primitive;
        // a save dialog always returns a path whose directory exists.
        let dir = scratch("noparents");
        let nested = dir.join("missing").join("deep.bin");
        assert!(write_file_bytes(nested.to_string_lossy().to_string(), vec![1]).is_err());
        assert!(!dir.join("missing").exists());
    }

    #[test]
    fn a_traversal_name_cannot_escape_the_output_directory() {
        let dir = scratch("traversal");
        let written = write_output_file(
            dir.to_string_lossy().to_string(),
            "../../escaped.pdf".into(),
            vec![1],
        )
        .expect("write");
        let parent = Path::new(&written.path)
            .parent()
            .expect("parent")
            .to_path_buf();
        assert_eq!(
            parent, dir,
            "output escaped its directory: {}",
            written.path
        );
        // Separators are neutralised in the stored name, so it stays one component.
        assert!(!written.name.contains('/'));
        assert!(!written.name.contains('\\'));
        assert!(!dir.parent().unwrap().join("escaped.pdf").exists());
    }

    #[test]
    fn a_dot_only_name_is_replaced_rather_than_addressing_a_directory() {
        let dir = scratch("dottier");
        let written = write_output_file(dir.to_string_lossy().to_string(), "..".into(), vec![1])
            .expect("write");
        assert_eq!(Path::new(&written.path).parent().unwrap(), dir);
        assert_eq!(written.name, "output.pdf");
    }
}
