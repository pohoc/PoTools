use super::{valid_network_host, NativeNetworkResult};
use std::{
    process::{Command, Stdio},
    time::{Duration, Instant},
};

pub fn ping_host(host: String, count: usize) -> NativeNetworkResult {
    if !valid_network_host(&host) {
        return NativeNetworkResult {
            error_code: Some("EINVAL".into()),
            connected: Some(false),
            ..NativeNetworkResult::empty()
        };
    }
    let count = count.clamp(1, 10);
    let mut command = Command::new("ping");
    #[cfg(target_os = "windows")]
    command.args(["-n", &count.to_string(), "-w", "2000", &host]);
    #[cfg(target_os = "macos")]
    command.args(["-c", &count.to_string(), "-W", "2000", &host]);
    #[cfg(target_os = "linux")]
    command.args(["-c", &count.to_string(), "-W", "2", &host]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let deadline = Instant::now() + Duration::from_millis((count as u64) * 2300 + 1500);
    let child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    match child {
        Ok(mut child) => {
            let mut timed_out = false;
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) if Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(20))
                    }
                    Ok(None) => {
                        timed_out = true;
                        let _ = child.kill();
                        let _ = child.wait();
                        break;
                    }
                    Err(_) => {
                        let _ = child.kill();
                        let _ = child.wait();
                        break;
                    }
                }
            }
            match child.wait_with_output() {
                Ok(output) => {
                    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                    let error_code = if timed_out {
                        Some("timeout".into())
                    } else if output.status.success() {
                        None
                    } else {
                        Some(format!("exit-{}", output.status.code().unwrap_or(-1)))
                    };
                    NativeNetworkResult {
                        stdout,
                        stderr,
                        error_code,
                        connected: Some(!timed_out && output.status.success()),
                        ..NativeNetworkResult::empty()
                    }
                }
                Err(error) => NativeNetworkResult {
                    stderr: error.to_string(),
                    error_code: Some("error".into()),
                    connected: Some(false),
                    ..NativeNetworkResult::empty()
                },
            }
        }
        Err(error) => NativeNetworkResult {
            stderr: error.to_string(),
            error_code: Some(if error.kind() == std::io::ErrorKind::NotFound {
                "ENOENT".into()
            } else {
                "error".into()
            }),
            connected: Some(false),
            ..NativeNetworkResult::empty()
        },
    }
}
