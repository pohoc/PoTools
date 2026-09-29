//! Platform-neutral developer utilities implemented in Rust.
#[path = "developer_rust/files.rs"]
mod files;
#[path = "developer_rust/network.rs"]
mod network;
#[path = "developer_rust/network_dns.rs"]
mod network_dns;
#[path = "developer_rust/network_io.rs"]
mod network_io;
#[path = "developer_rust/network_messages.rs"]
mod network_messages;
#[path = "developer_rust/password.rs"]
mod password;
#[path = "developer_rust/regex.rs"]
mod regex_tool;
#[path = "developer_rust/shared.rs"]
mod shared;
#[path = "developer_rust/structured.rs"]
mod structured;
#[path = "developer_rust/text.rs"]
mod text;
#[path = "developer_rust/web.rs"]
mod web;

use crate::{EngineError, RunContext, ToolResult};

pub fn run(ctx: &RunContext<'_>) -> Result<Option<ToolResult>, EngineError> {
    let result = match ctx.tool {
        "json-format" | "xml-format" | "xml-json" | "yaml-json" => structured::run(ctx)?,
        "binary-codec" | "case-convert" | "user-agent" | "ipv4-convert" | "ipv4-subnet"
        | "color-convert" => text::run(ctx)?,
        "robots-txt" | "spf-record" | "dmarc-record" => web::run(ctx)?,
        "url-inspect" | "ipv6-convert" | "port-reference" => network::run(ctx)?,
        "bcrypt" => password::run(ctx)?,
        "file-base64" | "base64-file" => files::run(ctx)?,
        "regex-test" => regex_tool::run(ctx)?,
        "dns-lookup" | "system-network" | "ping-check" | "tcp-check" | "ip-lookup" => {
            network_io::run(ctx)?
        }
        _ => return Ok(None),
    };
    Ok(Some(result))
}
