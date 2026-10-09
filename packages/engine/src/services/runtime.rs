use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRuntimeInfo {
    pub platform: &'static str,
    pub default_output_dir: String,
    pub default_temp_dir: String,
}

pub fn desktop_runtime_info() -> DesktopRuntimeInfo {
    let home = home_directory();
    let mut output_parents = Vec::new();
    #[cfg(target_os = "windows")]
    {
        if let Some(one_drive) = std::env::var_os("OneDrive") {
            output_parents.push(PathBuf::from(one_drive).join("Documents"));
        }
        output_parents.push(home.join("Documents"));
    }
    #[cfg(not(target_os = "windows"))]
    {
        for folder in ["Documents", "文档", "Skrivbord", "Schreibtisch", "Bureau"] {
            output_parents.push(home.join(folder));
        }
    }
    output_parents.push(home.clone());
    let parent = output_parents
        .iter()
        .find(|path| path.exists())
        .unwrap_or(&home);
    DesktopRuntimeInfo {
        platform: if cfg!(target_os = "windows") {
            "win32"
        } else if cfg!(target_os = "macos") {
            "darwin"
        } else {
            "linux"
        },
        default_output_dir: parent.join("PoTools").to_string_lossy().to_string(),
        default_temp_dir: std::env::temp_dir()
            .join("potools")
            .to_string_lossy()
            .to_string(),
    }
}

pub fn system_font_candidates() -> Vec<String> {
    let mut candidates = Vec::new();
    if let Some(explicit) = std::env::var_os("POTOOLS_FONT") {
        candidates.push(PathBuf::from(explicit));
    }
    #[cfg(target_os = "windows")]
    {
        let system_root = std::env::var_os("SystemRoot")
            .or_else(|| std::env::var_os("WINDIR"))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        let mut directories = vec![system_root.join("Fonts")];
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            directories.push(
                PathBuf::from(local)
                    .join("Microsoft")
                    .join("Windows")
                    .join("Fonts"),
            );
        }
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            directories.push(
                PathBuf::from(profile)
                    .join("AppData")
                    .join("Local")
                    .join("Microsoft")
                    .join("Windows")
                    .join("Fonts"),
            );
        }
        for name in [
            "msyh.ttc",
            "msyh.ttf",
            "msyhl.ttc",
            "msyhbd.ttc",
            "simhei.ttf",
            "simsun.ttc",
            "simsun.ttf",
            "simfang.ttf",
            "simkai.ttf",
            "Deng.ttf",
            "Dengb.ttf",
            "Dengl.ttf",
            "msjh.ttc",
            "mingliu.ttc",
        ] {
            candidates.extend(directories.iter().map(|directory| directory.join(name)));
        }
        for directory in &directories {
            append_font_files(&mut candidates, directory, 0);
        }
    }
    #[cfg(target_os = "macos")]
    {
        candidates.extend(
            [
                "/Library/Fonts/Arial Unicode.ttf",
                "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
                "/System/Library/Fonts/STHeiti Light.ttc",
                "/System/Library/Fonts/Hiragino Sans GB.ttc",
                "/System/Library/Fonts/Supplemental/Songti.ttc",
            ]
            .into_iter()
            .map(PathBuf::from),
        );
        for directory in [
            PathBuf::from("/Library/Fonts"),
            PathBuf::from("/System/Library/Fonts"),
            PathBuf::from("/System/Library/Fonts/Supplemental"),
        ] {
            append_font_files(&mut candidates, &directory, 0);
        }
        if let Some(home) = std::env::var_os("HOME") {
            append_font_files(
                &mut candidates,
                &PathBuf::from(home).join("Library/Fonts"),
                0,
            );
        }
    }
    #[cfg(target_os = "linux")]
    {
        let font_directories = [
            PathBuf::from("/usr/share/fonts"),
            PathBuf::from("/usr/local/share/fonts"),
        ];
        candidates.extend(
            [
                "/usr/share/fonts/truetype/arphic/uming.ttc",
                "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
                "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
                "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
                "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            ]
            .into_iter()
            .map(PathBuf::from),
        );
        for directory in &font_directories {
            append_font_files(&mut candidates, directory, 0);
        }
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            for directory in [home.join(".local/share/fonts"), home.join(".fonts")] {
                append_font_files(&mut candidates, &directory, 0);
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    candidates
        .into_iter()
        .filter(|path| path.is_file())
        .filter_map(|path| {
            let value = path.to_string_lossy().into_owned();
            seen.insert(value.to_lowercase()).then_some(value)
        })
        .collect()
}

fn home_directory() -> PathBuf {
    if cfg!(target_os = "windows") {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    } else {
        std::env::var_os("HOME").map(PathBuf::from)
    }
    .unwrap_or_else(std::env::temp_dir)
}

fn append_font_files(candidates: &mut Vec<PathBuf>, directory: &Path, depth: u8) {
    if depth > 5 || candidates.len() >= 2048 {
        return;
    }
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
    paths.sort();
    for path in paths {
        if candidates.len() >= 2048 {
            return;
        }
        let Ok(file_type) = fs::symlink_metadata(&path).map(|metadata| metadata.file_type()) else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            append_font_files(candidates, &path, depth + 1);
        } else if file_type.is_file()
            && path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| {
                    matches!(
                        extension.to_ascii_lowercase().as_str(),
                        "ttf" | "otf" | "ttc"
                    )
                })
        {
            candidates.push(path);
        }
    }
}
