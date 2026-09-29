//! Native operating-system shell integrations for opening and printing files.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Open a file or directory with the platform's associated application.
pub fn open_path(path: String, reveal: Option<bool>) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err(format!("路径不存在: {}", path));
    }
    #[cfg(target_os = "macos")]
    let spawned = match reveal.unwrap_or(false) {
        true => Command::new("open").arg("-R").arg(&target).spawn(),
        false => Command::new("open").arg(&target).spawn(),
    };
    #[cfg(target_os = "windows")]
    let spawned = {
        let mut command = Command::new("explorer");
        if reveal.unwrap_or(false) {
            command.arg("/select,").arg(&target);
        } else {
            command.arg(&target);
        }
        command.spawn()
    };
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let spawned = {
        let mut command = Command::new("xdg-open");
        command.arg(&target);
        command.spawn()
    };
    spawned.map(|_| ()).map_err(|error| error.to_string())
}

fn output_with_timeout(
    mut command: Command,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let started = Instant::now();
    loop {
        match child.try_wait().map_err(|error| error.to_string())? {
            Some(_) => return child.wait_with_output().map_err(|error| error.to_string()),
            None if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("系统打印命令执行超时".to_string());
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

/// Ask the operating system's configured print command to print a file.
pub fn print_file(path: String) -> Result<serde_json::Value, String> {
    if path.trim().is_empty() {
        return Err("缺少待打印文件路径".to_string());
    }
    let target = PathBuf::from(&path);
    if !target.is_file() {
        return Err(format!("待打印文件不存在：{}", path));
    }

    #[cfg(target_os = "windows")]
    let result = {
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Process -LiteralPath $args[0] -Verb Print",
        ]);
        command.arg(&target);
        output_with_timeout(command, Duration::from_secs(15)).map(|output| {
            if output.status.success() {
                Ok(serde_json::json!({ "started": true }))
            } else {
                Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
            }
        })
    };

    #[cfg(not(target_os = "windows"))]
    let result = {
        let mut command = Command::new("lp");
        command.arg(&target);
        output_with_timeout(command, Duration::from_secs(30)).map(|output| {
            if output.status.success() {
                Ok(serde_json::json!({
                    "started": true,
                    "queue": String::from_utf8_lossy(&output.stdout).trim()
                }))
            } else {
                Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
            }
        })
    };

    result
        .map_err(|error| {
            format!(
                "无法发起系统打印，请确认已配置默认打印机和文件关联：{}",
                error
            )
        })?
        .map_err(|detail| {
            format!(
                "无法发起系统打印，请确认已配置默认打印机和文件关联：{}",
                detail
            )
        })
}
