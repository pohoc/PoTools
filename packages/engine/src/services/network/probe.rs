use super::NativeNetworkResult;
use std::process::Command;

pub fn system_network_probe() -> NativeNetworkResult {
    #[cfg(target_os = "windows")]
    let output = Command::new("ipconfig").arg("/all").output();
    #[cfg(target_os = "macos")]
    let output = Command::new("/sbin/ifconfig").arg("-a").output();
    #[cfg(target_os = "linux")]
    let output = Command::new("ip")
        .args(["address"])
        .output()
        .or_else(|_| Command::new("ifconfig").arg("-a").output());

    let dns_servers = {
        #[cfg(target_os = "windows")]
        {
            let text = output
                .as_ref()
                .ok()
                .map(|value| String::from_utf8_lossy(&value.stdout).into_owned())
                .unwrap_or_default();
            text.lines()
                .filter(|line| {
                    line.to_lowercase().contains("dns servers") || line.contains("DNS 服务器")
                })
                .map(|line| {
                    line.split_once(':')
                        .map(|(_, value)| value.trim())
                        .unwrap_or("")
                        .to_string()
                })
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join(", ")
        }
        #[cfg(target_os = "macos")]
        {
            Command::new("/usr/sbin/scutil")
                .arg("--dns")
                .output()
                .ok()
                .map(|value| {
                    String::from_utf8_lossy(&value.stdout)
                        .lines()
                        .filter_map(|line| {
                            line.trim()
                                .strip_prefix("nameserver[")
                                .and_then(|rest| rest.split_once(':'))
                                .map(|(_, value)| value.trim().to_string())
                        })
                        .filter(|value| !value.is_empty())
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default()
        }
        #[cfg(target_os = "linux")]
        {
            fs::read_to_string("/etc/resolv.conf")
                .unwrap_or_default()
                .lines()
                .filter_map(|line| line.trim().strip_prefix("nameserver ").map(str::to_string))
                .collect::<Vec<_>>()
                .join(", ")
        }
    };
    match output {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            #[cfg(target_os = "windows")]
            let interface_count = stdout
                .lines()
                .filter(|line| {
                    let lower = line.to_lowercase();
                    lower.contains("adapter ") || lower.contains("适配器")
                })
                .count();
            #[cfg(target_os = "macos")]
            let interface_count = stdout
                .lines()
                .filter(|line| !line.starts_with(char::is_whitespace) && line.contains(": flags="))
                .count();
            #[cfg(target_os = "linux")]
            let interface_count = stdout
                .lines()
                .filter(|line| {
                    line.split_once(':').is_some_and(|(index, _)| {
                        index
                            .trim()
                            .chars()
                            .all(|character| character.is_ascii_digit())
                            && !index.trim().is_empty()
                    })
                })
                .count();
            NativeNetworkResult {
                stdout,
                stderr,
                error_code: (!output.status.success())
                    .then(|| format!("exit-{}", output.status.code().unwrap_or(-1))),
                connected: None,
                elapsed_ms: None,
                interface_count: Some(interface_count),
                dns_servers: Some(dns_servers),
            }
        }
        Err(error) => NativeNetworkResult {
            stdout: String::new(),
            stderr: error.to_string(),
            error_code: Some(error.to_string()),
            connected: None,
            elapsed_ms: None,
            interface_count: Some(0),
            dns_servers: Some(dns_servers),
        },
    }
}
