use super::shared::*;
use crate::{EngineError, RunContext, ToolResult};
use serde_json::json;
use url::Url;

pub fn run(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    match ctx.tool {
        "url-inspect" => url_inspect(ctx),
        "ipv6-convert" => ipv6_convert(ctx),
        "port-reference" => port_reference(ctx),
        _ => Err(err("Unsupported developer network tool")),
    }
}
fn url_inspect(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let parsed = Url::parse(string(ctx, "url", "")).map_err(|_| error(ctx, "dev.error.url"))?;
    if !["http", "https"].contains(&parsed.scheme()) || parsed.host_str().is_none() {
        return Err(error(ctx, "dev.error.url"));
    }
    let host = parsed.host_str().unwrap_or_default();
    let port = parsed.port().map(|p| p.to_string()).unwrap_or_else(|| {
        if parsed.scheme() == "https" {
            "443 (default)".into()
        } else {
            "80 (default)".into()
        }
    });
    let entries: Vec<String> = parsed
        .query_pairs()
        .map(|(key, value)| format!("{key} = {value}"))
        .collect();
    let query = if entries.is_empty() {
        "—".to_string()
    } else {
        entries.join("\n  ")
    };
    let fragment = parsed.fragment().filter(|s| !s.is_empty()).unwrap_or("—");
    let text = format!(
        "{}: {}\n{}: {}\n{}: {}\n{}: {}\n{}: {}\n{}: {}",
        msg(ctx, "dev.network.protocol"),
        parsed.scheme(),
        msg(ctx, "dev.network.hostname"),
        host,
        msg(ctx, "dev.network.port"),
        port,
        msg(ctx, "dev.network.path"),
        parsed.path(),
        msg(ctx, "dev.network.query"),
        query,
        msg(ctx, "dev.network.fragment"),
        fragment,
    );
    Ok(output(
        "url-analysis.txt",
        text,
        extra([
            (String::from("hostname"), json!(host)),
            (String::from("parameters"), json!(entries.len())),
        ]),
    ))
}
fn ipv6_groups(ctx: &RunContext<'_>, input: &str) -> Result<Vec<u16>, EngineError> {
    if input.is_empty() || input.contains('%') || input.contains(":::") {
        return Err(error(ctx, "dev.error.ipv6"));
    }
    let mut source = input.to_ascii_lowercase();
    if let Some((_pre, v4)) = source.rsplit_once(':') {
        if v4.contains('.') {
            let n = ipv4(ctx, v4).map_err(|_| error(ctx, "dev.error.ipv6"))?;
            let prefix = &source[..source.len() - v4.len()];
            source = format!("{prefix}{:x}:{:x}", n >> 16, n & 0xffff)
        }
    }
    let halves: Vec<_> = source.split("::").collect();
    if halves.len() > 2 {
        return Err(error(ctx, "dev.error.ipv6"));
    }
    let left: Vec<_> = if halves[0].is_empty() {
        vec![]
    } else {
        halves[0].split(':').collect()
    };
    let right: Vec<_> = if halves.len() == 2 && !halves[1].is_empty() {
        halves[1].split(':').collect()
    } else {
        vec![]
    };
    if halves.len() == 1 && (left.len() != 8 || source.starts_with(':') || source.ends_with(':')) {
        return Err(error(ctx, "dev.error.ipv6"));
    }
    let missing = 8usize.saturating_sub(left.len() + right.len());
    if (halves.len() == 2 && missing == 0) || (left.len() + right.len() > 8) {
        return Err(error(ctx, "dev.error.ipv6"));
    }
    let mut groups = Vec::new();
    for item in left
        .iter()
        .chain(std::iter::repeat(&"0").take(missing))
        .chain(right.iter())
    {
        if item.is_empty() || item.len() > 4 || !item.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(error(ctx, "dev.error.ipv6"));
        }
        groups.push(u16::from_str_radix(item, 16).map_err(|_| error(ctx, "dev.error.ipv6"))?)
    }
    if groups.len() != 8 {
        return Err(error(ctx, "dev.error.ipv6"));
    }
    Ok(groups)
}
fn ipv6_convert(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let input = string(ctx, "input", "");
    let g = ipv6_groups(ctx, input)?;
    let expanded = g
        .iter()
        .map(|v| format!("{v:04x}"))
        .collect::<Vec<_>>()
        .join(":");
    let compact = g.iter().map(|v| format!("{v:x}")).collect::<Vec<_>>();
    let mut best = None;
    let (mut i, mut best_len) = (0, 1);
    while i < 8 {
        if g[i] != 0 {
            i += 1;
            continue;
        }
        let start = i;
        while i < 8 && g[i] == 0 {
            i += 1
        }
        if i - start > best_len {
            best = Some((start, i));
            best_len = i - start
        }
    }
    let compressed = if let Some((a, b)) = best {
        format!("{}::{}", compact[..a].join(":"), compact[b..].join(":"))
    } else {
        compact.join(":")
    };
    let text = format!(
        "{}: {input}\n{}: {compressed}\n{}: {expanded}",
        msg(ctx, "dev.network.ipv6.input"),
        msg(ctx, "dev.network.ipv6.compressed"),
        msg(ctx, "dev.network.ipv6.expanded")
    );
    Ok(output(
        "ipv6-conversion.txt",
        text,
        extra([
            (String::from("compressed"), json!(compressed)),
            (String::from("expanded"), json!(expanded)),
        ]),
    ))
}
const PORTS: &[(u16, &str, &str, &str)] = &[
    (20, "FTP data", "TCP", "File transfer data channel"),
    (21, "FTP control", "TCP", "File transfer control channel"),
    (22, "SSH", "TCP", "Secure shell"),
    (23, "Telnet", "TCP", "Unencrypted remote terminal"),
    (25, "SMTP", "TCP", "Mail transfer"),
    (53, "DNS", "TCP/UDP", "Domain name system"),
    (67, "DHCP server", "UDP", "Dynamic host configuration"),
    (68, "DHCP client", "UDP", "Dynamic host configuration"),
    (80, "HTTP", "TCP", "Web traffic"),
    (110, "POP3", "TCP", "Mail retrieval"),
    (123, "NTP", "UDP", "Network time"),
    (143, "IMAP", "TCP", "Mail retrieval"),
    (161, "SNMP", "UDP", "Network management"),
    (389, "LDAP", "TCP", "Directory service"),
    (443, "HTTPS", "TCP", "Encrypted web traffic"),
    (445, "SMB", "TCP", "Windows file sharing"),
    (465, "SMTPS", "TCP", "SMTP over implicit TLS"),
    (587, "SMTP submission", "TCP", "Mail submission"),
    (993, "IMAPS", "TCP", "IMAP over TLS"),
    (995, "POP3S", "TCP", "POP3 over TLS"),
    (1433, "Microsoft SQL Server", "TCP", "Database service"),
    (3306, "MySQL", "TCP", "Database service"),
    (3389, "RDP", "TCP", "Remote desktop"),
    (5432, "PostgreSQL", "TCP", "Database service"),
    (6379, "Redis", "TCP", "In-memory data store"),
    (8080, "HTTP alternate", "TCP", "Common alternate web port"),
    (
        8443,
        "HTTPS alternate",
        "TCP",
        "Common alternate secure web port",
    ),
    (27017, "MongoDB", "TCP", "Database service"),
];
fn port_reference(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let value = number(ctx, "port", 0.0);
    if !value.is_finite() || value.fract() != 0.0 || !(1.0..=65535.0).contains(&value) {
        return Err(error(ctx, "dev.error.port"));
    }
    let p = value as u16;
    let info = PORTS.iter().find(|x| x.0 == p);
    let text = if let Some((_, service, transport, description)) = info {
        format!(
            "{}: {p}\n{}: {service}\n{}: {transport}\n{}: {description}",
            msg(ctx, "dev.network.port"),
            msg(ctx, "dev.network.port.service"),
            msg(ctx, "dev.network.port.transport"),
            msg(ctx, "dev.network.port.description")
        )
    } else {
        format!(
            "{}: {p}\n{}: {}",
            msg(ctx, "dev.network.port"),
            msg(ctx, "dev.network.port.service"),
            msg(ctx, "dev.network.port.unknown")
        )
    };
    Ok(output(
        "port-reference.txt",
        text,
        extra([
            (String::from("port"), json!(p)),
            (
                String::from("service"),
                json!(info.map(|x| x.1).unwrap_or("unknown")),
            ),
        ]),
    ))
}
