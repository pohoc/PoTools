use super::shared::*;
use crate::{EngineError, RunContext, ToolResult};
use serde_json::{json, Value};
use std::net::IpAddr;

pub fn run(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    match ctx.tool {
        "dns-lookup" => super::network_dns::run(ctx),
        "system-network" => system_network(ctx),
        "ping-check" => ping_check(ctx),
        "tcp-check" => tcp_check(ctx),
        "ip-lookup" => ip_lookup(ctx),
        _ => Err(err("Unsupported developer network inspection tool")),
    }
}

fn system_network(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let (dns_servers, stdout, stderr, count) =
        if let Some(probe) = runtime_data(ctx, "nativeNetwork") {
            if probe.get("kind").and_then(Value::as_str) != Some("system-network") {
                return Err(error(ctx, "dev.error.networkUnavailable"));
            }
            (
                value_string(probe.get("dnsServers")),
                value_string(probe.get("stdout")),
                value_string(probe.get("stderr")),
                probe
                    .get("interfaceCount")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            )
        } else {
            #[cfg(feature = "native")]
            {
                let probe = crate::services::network::system_network_probe();
                (
                    probe.dns_servers.unwrap_or_default(),
                    probe.stdout,
                    probe.stderr,
                    probe.interface_count.unwrap_or(0) as u64,
                )
            }
            #[cfg(not(feature = "native"))]
            {
                return Err(error(ctx, "dev.error.networkUnavailable"));
            }
        };
    let mut rows = vec![format!(
        "{}: {}",
        msg(ctx, "dev.localNetwork.dns"),
        if dns_servers.is_empty() {
            "—"
        } else {
            &dns_servers
        }
    )];
    if !stdout.trim().is_empty() {
        rows.push(stdout.trim().to_string());
    }
    if !stderr.trim().is_empty() {
        rows.push(stderr.trim().to_string());
    }
    Ok(output(
        "local-network-info.txt",
        rows.join("\n\n"),
        extra([(String::from("interfaces"), json!(count))]),
    ))
}

fn ping_check(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let host = string(ctx, "host", "");
    if !valid_network_host(host) {
        return Err(error(ctx, "dev.error.hostname"));
    }
    let count = number(ctx, "count", 4.0).trunc().clamp(1.0, 10.0) as usize;
    let (stdout, stderr, error_code, connected) =
        if let Some(probe) = runtime_network(ctx, "ping-check") {
            (
                value_string(probe.get("stdout")),
                value_string(probe.get("stderr")),
                nullable_string(probe.get("errorCode")),
                probe
                    .get("connected")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            )
        } else {
            #[cfg(feature = "native")]
            {
                let result = crate::services::network::ping_host(host.to_string(), count);
                (
                    result.stdout,
                    result.stderr,
                    result.error_code,
                    result.connected.unwrap_or(false),
                )
            }
            #[cfg(not(feature = "native"))]
            {
                return Err(error(ctx, "dev.error.networkUnavailable"));
            }
        };
    if error_code.as_deref() == Some("ENOENT") {
        return Err(error(ctx, "dev.error.pingUnavailable"));
    }
    let detail = if !stdout.trim().is_empty() {
        stdout.trim().to_string()
    } else if !stderr.trim().is_empty() {
        stderr.trim().to_string()
    } else {
        error_code.clone().unwrap_or_default()
    };
    let mut rows = vec![
        format!("{}: {host}", msg(ctx, "dev.localNetwork.target")),
        format!(
            "{}: {}",
            msg(ctx, "dev.localNetwork.status"),
            msg(
                ctx,
                if connected {
                    "dev.localNetwork.reachable"
                } else {
                    "dev.localNetwork.unreachable"
                }
            )
        ),
    ];
    if !detail.is_empty() {
        rows.push(String::new());
        rows.push(detail);
    }
    Ok(output(
        "ping-result.txt",
        rows.join("\n"),
        extra([
            (
                String::from("reachable"),
                json!(if connected { 1 } else { 0 }),
            ),
            (String::from("count"), json!(count)),
        ]),
    ))
}

fn tcp_check(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let host = string(ctx, "host", "");
    if !valid_network_host(host) {
        return Err(error(ctx, "dev.error.hostname"));
    }
    let port = number(ctx, "port", 0.0).trunc();
    if !(1.0..=65535.0).contains(&port) {
        return Err(error(ctx, "dev.error.port"));
    }
    let port = port as u16;
    let (error_code, connected, elapsed) = if let Some(probe) = runtime_network(ctx, "tcp-check") {
        (
            nullable_string(probe.get("errorCode")),
            probe
                .get("connected")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            probe.get("elapsedMs").and_then(Value::as_u64).unwrap_or(0),
        )
    } else {
        #[cfg(feature = "native")]
        {
            let result = crate::services::network::tcp_check_host(host.to_string(), port);
            (
                result.error_code,
                result.connected.unwrap_or(false),
                result.elapsed_ms.unwrap_or(0) as u64,
            )
        }
        #[cfg(not(feature = "native"))]
        {
            return Err(error(ctx, "dev.error.networkUnavailable"));
        }
    };
    let state = if connected {
        "dev.localNetwork.connected"
    } else if error_code.as_deref() == Some("ETIMEDOUT") {
        "dev.localNetwork.timeout"
    } else {
        "dev.localNetwork.refused"
    };
    let mut rows = vec![
        format!("{}: {host}:{port}", msg(ctx, "dev.localNetwork.target")),
        format!(
            "{}: {}",
            msg(ctx, "dev.localNetwork.status"),
            msg(ctx, state)
        ),
        format!("{}: {elapsed} ms", msg(ctx, "dev.localNetwork.elapsed")),
    ];
    if let Some(code) = error_code.filter(|code| code != "ETIMEDOUT") {
        rows.push(format!(
            "{}: {code}",
            msg(ctx, "dev.localNetwork.errorCode")
        ));
    }
    Ok(output(
        "tcp-connection-result.txt",
        rows.join("\n"),
        extra([
            (
                String::from("connected"),
                json!(if connected { 1 } else { 0 }),
            ),
            (String::from("elapsedMs"), json!(elapsed)),
        ]),
    ))
}

fn ip_lookup(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let requested_ip = string(ctx, "ip", "");
    if !requested_ip.is_empty() && requested_ip.parse::<IpAddr>().is_err() {
        return Err(error(ctx, "dev.error.ipLookupAddress"));
    }
    let response =
        runtime_data(ctx, "ipLookup").ok_or_else(|| error(ctx, "dev.error.ipLookupNetwork"))?;
    match response.get("status").and_then(Value::as_str) {
        Some("network") => return Err(error(ctx, "dev.error.ipLookupNetwork")),
        Some("response") => return Err(error(ctx, "dev.error.ipLookupResponse")),
        Some("ok") => {}
        _ => return Err(error(ctx, "dev.error.ipLookupResponse")),
    }
    let payload = response
        .get("payload")
        .ok_or_else(|| error(ctx, "dev.error.ipLookupResponse"))?;
    let data = payload
        .get("data")
        .and_then(Value::as_object)
        .ok_or_else(|| error(ctx, "dev.error.ipLookupResponse"))?;
    let info = data
        .get("info")
        .and_then(Value::as_object)
        .ok_or_else(|| error(ctx, "dev.error.ipLookupResponse"))?;
    if payload.get("code").and_then(Value::as_i64) != Some(200) {
        return Err(error(ctx, "dev.error.ipLookupResponse"));
    }
    let field = |key: &str| info.get(key).and_then(Value::as_str).unwrap_or("").trim();
    let response_ip = data.get("ip").and_then(Value::as_str).unwrap_or("");
    let ip = if response_ip.is_empty() {
        requested_ip
    } else {
        response_ip
    };
    let country = field("country");
    let country_en = field("country_en");
    let coordinates = if !field("lng").is_empty() && !field("lat").is_empty() {
        format!("{}, {}", field("lat"), field("lng"))
    } else {
        "—".into()
    };
    let rows = [
        format!(
            "{}: {}",
            msg(ctx, "dev.ipLookup.queryType"),
            msg(
                ctx,
                if requested_ip.is_empty() {
                    "dev.ipLookup.localPublicIP"
                } else {
                    "dev.ipLookup.customIP"
                }
            )
        ),
        format!("{}: {ip}", msg(ctx, "dev.ipLookup.ip")),
        format!(
            "{}: {}",
            msg(ctx, "dev.ipLookup.continent"),
            blank(field("continent"))
        ),
        format!(
            "{}: {}{}",
            msg(ctx, "dev.ipLookup.country"),
            blank(country),
            if country_en.is_empty() {
                String::new()
            } else {
                format!(" ({country_en})")
            }
        ),
        format!(
            "{}: {}",
            msg(ctx, "dev.ipLookup.countryCode"),
            blank(field("country_code"))
        ),
        format!(
            "{}: {}",
            msg(ctx, "dev.ipLookup.region"),
            blank(field("region"))
        ),
        format!(
            "{}: {}",
            msg(ctx, "dev.ipLookup.city"),
            blank(field("city"))
        ),
        format!(
            "{}: {}",
            msg(ctx, "dev.ipLookup.county"),
            blank(field("county"))
        ),
        format!("{}: {}", msg(ctx, "dev.ipLookup.isp"), blank(field("isp"))),
        format!(
            "{}: {}",
            msg(ctx, "dev.ipLookup.zipcode"),
            blank(field("zipcode"))
        ),
        format!("{}: {coordinates}", msg(ctx, "dev.ipLookup.coordinates")),
        format!("{}: ip.bt.cn", msg(ctx, "dev.ipLookup.source")),
    ];
    Ok(output(
        "ip-lookup.txt",
        rows.join("\n"),
        extra([
            (String::from("ip"), json!(ip)),
            (
                String::from("queryType"),
                json!(if requested_ip.is_empty() {
                    "local-public"
                } else {
                    "custom"
                }),
            ),
            (String::from("country"), json!(country)),
            (String::from("city"), json!(field("city"))),
            (String::from("isp"), json!(field("isp"))),
        ]),
    ))
}

fn blank(value: &str) -> &str {
    if value.is_empty() {
        "—"
    } else {
        value
    }
}

fn runtime_data<'a>(ctx: &'a RunContext<'_>, key: &str) -> Option<&'a Value> {
    ctx.runtime_data?.get(key)
}

fn runtime_network<'a>(ctx: &'a RunContext<'_>, kind: &str) -> Option<&'a Value> {
    let value = runtime_data(ctx, "nativeNetwork")?;
    (value.get("kind").and_then(Value::as_str) == Some(kind)).then_some(value)
}

fn value_string(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).unwrap_or("").to_string()
}

fn nullable_string(value: Option<&Value>) -> Option<String> {
    value.and_then(|value| match value {
        Value::String(string) => Some(string.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    })
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

fn valid_network_host(hostname: &str) -> bool {
    if hostname.parse::<IpAddr>().is_ok() {
        return true;
    }
    valid_hostname(hostname)
}
