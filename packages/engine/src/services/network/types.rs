use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeNetworkResult {
    pub stdout: String,
    pub stderr: String,
    pub error_code: Option<String>,
    pub connected: Option<bool>,
    pub elapsed_ms: Option<u128>,
    pub interface_count: Option<usize>,
    pub dns_servers: Option<String>,
}

impl NativeNetworkResult {
    pub(super) fn empty() -> Self {
        Self {
            stdout: String::new(),
            stderr: String::new(),
            error_code: None,
            connected: None,
            elapsed_ms: None,
            interface_count: None,
            dns_servers: None,
        }
    }
}
