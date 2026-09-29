use super::shared::*;
use crate::{EngineError, RunContext, ToolResult};
use serde_json::{json, Value};

pub fn run(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    dns_lookup(ctx)
}

fn dns_lookup(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let hostname = string(ctx, "hostname", "")
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if !valid_hostname(&hostname) {
        return Err(error(ctx, "dev.error.hostname"));
    }
    let record_type = string(ctx, "recordType", "").to_ascii_uppercase();
    if !["A", "AAAA", "MX", "TXT", "NS", "CNAME", "SOA"].contains(&record_type.as_str()) {
        return Err(error(ctx, "dev.error.dnsType"));
    }
    let records = if let Some(native) = runtime_data(ctx, "nativeDns") {
        let matches = native.get("hostname").and_then(Value::as_str) == Some(hostname.as_str())
            && native.get("recordType").and_then(Value::as_str) == Some(record_type.as_str());
        if matches {
            native
                .get("records")
                .and_then(Value::as_array)
                .map(|records| {
                    records
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };
    let records = if records.is_empty() {
        native_dns_lookup(ctx, &hostname, &record_type)?
    } else {
        records
    };
    if records.is_empty() {
        return Err(error(ctx, "dev.error.dnsLookup"));
    }
    let lines = records
        .iter()
        .map(|record| normalize_dns_record(&record_type, record))
        .collect::<Vec<_>>();
    let text = lines.join("\n");
    Ok(output(
        format!("dns-{}-records.txt", record_type.to_ascii_lowercase()),
        text,
        extra([
            (String::from("hostname"), json!(hostname)),
            (String::from("type"), json!(record_type)),
            (String::from("count"), json!(lines.len())),
        ]),
    ))
}

fn runtime_data<'a>(ctx: &'a RunContext<'_>, key: &str) -> Option<&'a Value> {
    ctx.runtime_data?.get(key)
}

fn valid_hostname(hostname: &str) -> bool {
    !hostname.is_empty()
        && hostname.len() <= 253
        && hostname.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
                && !label.starts_with('-')
                && !label.ends_with('-')
        })
}

fn native_dns_lookup(
    ctx: &RunContext<'_>,
    hostname: &str,
    record_type: &str,
) -> Result<Vec<String>, EngineError> {
    #[cfg(feature = "native")]
    {
        use hickory_resolver::{config::ResolverOpts, proto::rr::RecordType, Resolver};
        use std::time::Duration;
        let record_type = match record_type {
            "A" => RecordType::A,
            "AAAA" => RecordType::AAAA,
            "MX" => RecordType::MX,
            "TXT" => RecordType::TXT,
            "NS" => RecordType::NS,
            "CNAME" => RecordType::CNAME,
            "SOA" => RecordType::SOA,
            _ => return Err(error(ctx, "dev.error.dnsType")),
        };
        let mut options = ResolverOpts::default();
        options.timeout = Duration::from_millis(2500);
        options.attempts = 1;
        let (config, _) = hickory_resolver::system_conf::read_system_conf()
            .map_err(|_| error(ctx, "dev.error.dnsLookup"))?;
        let resolver =
            Resolver::new(config, options).map_err(|_| error(ctx, "dev.error.dnsLookup"))?;
        let query = format!("{hostname}.");
        let result = resolver
            .lookup(query, record_type)
            .map_err(|_| error(ctx, "dev.error.dnsLookup"))?;
        let records = result.iter().map(ToString::to_string).collect::<Vec<_>>();
        if records.is_empty() {
            return Err(error(ctx, "dev.error.dnsLookup"));
        }
        Ok(records)
    }
    #[cfg(not(feature = "native"))]
    {
        let _ = (hostname, record_type);
        Err(error(ctx, "dev.error.dnsLookup"))
    }
}

fn normalize_dns_record(record_type: &str, record: &str) -> String {
    let value = record.trim();
    match record_type {
        "NS" | "CNAME" => value.trim_end_matches('.').to_string(),
        "MX" => {
            let parts = value.split_whitespace().collect::<Vec<_>>();
            if parts.len() >= 2 {
                let priority = parts[0].parse::<u16>().unwrap_or(0);
                json!({"exchange": parts[1].trim_end_matches('.'), "priority": priority})
                    .to_string()
            } else {
                value.to_string()
            }
        }
        "SOA" => {
            let parts = value.split_whitespace().collect::<Vec<_>>();
            if parts.len() >= 7 {
                json!({
                    "nsname": parts[0].trim_end_matches('.'),
                    "hostmaster": parts[1].trim_end_matches('.'),
                    "serial": number_or_zero(parts[2]),
                    "refresh": number_or_zero(parts[3]),
                    "retry": number_or_zero(parts[4]),
                    "expire": number_or_zero(parts[5]),
                    "minttl": number_or_zero(parts[6]),
                })
                .to_string()
            } else {
                value.to_string()
            }
        }
        "TXT" => decode_txt(value),
        _ => value.to_string(),
    }
}

fn number_or_zero(value: &str) -> u32 {
    value.parse().unwrap_or(0)
}

fn decode_txt(value: &str) -> String {
    let mut result = String::new();
    let mut quoted = false;
    let mut chars = value.chars().peekable();
    while let Some(character) = chars.next() {
        match character {
            '"' => quoted = !quoted,
            '\\' if quoted => {
                let mut digits = String::new();
                while digits.len() < 3 && chars.peek().is_some_and(|ch| ch.is_ascii_digit()) {
                    digits.push(chars.next().unwrap_or_default());
                }
                if digits.len() == 3 {
                    if let Ok(value) = digits.parse::<u8>() {
                        result.push(char::from(value));
                    }
                } else if let Some(escaped) = digits.chars().next() {
                    result.push(escaped);
                    if digits.len() > 1 {
                        result.extend(digits.chars().skip(1));
                    }
                } else if let Some(escaped) = chars.next() {
                    result.push(escaped);
                }
            }
            character if quoted => result.push(character),
            _ => {}
        }
    }
    if result.is_empty() && !value.contains('"') {
        value.to_string()
    } else {
        result
    }
}
