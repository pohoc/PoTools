use hickory_resolver::{proto::rr::RecordType, system_conf, TokioAsyncResolver};
use std::time::Duration;

pub async fn dns_lookup(hostname: String, record_type: String) -> Result<Vec<String>, String> {
    let query_type = match record_type.to_ascii_uppercase().as_str() {
        "A" => RecordType::A,
        "AAAA" => RecordType::AAAA,
        "MX" => RecordType::MX,
        "TXT" => RecordType::TXT,
        "NS" => RecordType::NS,
        "CNAME" => RecordType::CNAME,
        "SOA" => RecordType::SOA,
        _ => return Err("不支持的 DNS 记录类型".into()),
    };
    let (config, mut options) = system_conf::read_system_conf()
        .map_err(|error| format!("无法读取系统 DNS 配置：{error}"))?;
    options.timeout = Duration::from_millis(2500);
    options.attempts = 1;
    let resolver = TokioAsyncResolver::tokio(config, options);
    let query_name = if hostname.ends_with('.') {
        hostname
    } else {
        format!("{hostname}.")
    };
    let lookup = resolver
        .lookup(query_name, query_type)
        .await
        .map_err(|error| format!("DNS 查询失败：{error}"))?;
    let records = lookup.iter().map(ToString::to_string).collect::<Vec<_>>();
    if records.is_empty() {
        return Err("未查询到 DNS 记录".into());
    }
    Ok(records)
}
