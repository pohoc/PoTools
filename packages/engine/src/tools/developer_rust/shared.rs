use crate::{Artifact, EngineError, RunContext, ToolResult};
use serde_json::{Map, Value};

pub fn string<'a>(ctx: &'a RunContext<'_>, key: &str, default: &'a str) -> &'a str {
    ctx.options
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or(default)
}
pub fn number(ctx: &RunContext<'_>, key: &str, default: f64) -> f64 {
    ctx.options.get(key).and_then(js_number).unwrap_or(default)
}
pub fn js_number(value: &Value) -> Option<f64> {
    let parsed = match value {
        Value::Number(n) => n.as_f64()?,
        Value::Null => 0.0,
        Value::Bool(v) => {
            if *v {
                1.0
            } else {
                0.0
            }
        }
        Value::String(s) => {
            let s = s.trim();
            if s.is_empty() {
                0.0
            } else if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
                u64::from_str_radix(hex, 16).ok()? as f64
            } else if let Some(bin) = s.strip_prefix("0b").or_else(|| s.strip_prefix("0B")) {
                u64::from_str_radix(bin, 2).ok()? as f64
            } else if let Some(oct) = s.strip_prefix("0o").or_else(|| s.strip_prefix("0O")) {
                u64::from_str_radix(oct, 8).ok()? as f64
            } else {
                s.parse::<f64>().ok()?
            }
        }
        _ => return None,
    };
    parsed.is_finite().then_some(parsed)
}
pub fn boolean(ctx: &RunContext<'_>, key: &str, default: bool) -> bool {
    match ctx.options.get(key) {
        None => default,
        Some(Value::Bool(v)) => *v,
        Some(Value::String(v)) => v == "true" || v == "1",
        Some(Value::Number(v)) => v.as_i64() == Some(1),
        _ => false,
    }
}
pub fn required<'a>(ctx: &RunContext<'a>) -> Result<&'a str, EngineError> {
    let input = ctx
        .options
        .get("input")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| error(ctx, "dev.error.empty"))?;
    Ok(input.trim())
}
pub fn err(message: impl Into<String>) -> EngineError {
    EngineError::new("bad_request", message)
}
pub fn output(name: impl Into<String>, text: String, extra: Map<String, Value>) -> ToolResult {
    let mut result = ToolResult::default();
    result.artifacts.push(Artifact::new(
        name,
        "text",
        format!("{}\n", text.trim_end()).into_bytes(),
    ));
    result.text = Some(text);
    result.extra = extra;
    result
}
pub fn utf8_len(s: &str) -> usize {
    s.as_bytes().len()
}
pub fn msg(ctx: &RunContext<'_>, key: &str) -> &'static str {
    let zh = ctx.locale.starts_with("zh");
    if let Some(value) = super::network_messages::message(ctx, key) {
        return value;
    }
    match key {
        "dev.error.empty" => {
            if zh {
                "请输入要处理的内容。"
            } else {
                "Enter some content to process."
            }
        }
        "dev.error.json" => {
            if zh {
                "JSON 格式无效，请检查引号、逗号和括号。"
            } else {
                "Invalid JSON. Check quotes, commas, and brackets."
            }
        }
        "dev.error.xml" => {
            if zh {
                "XML 格式无效，请检查标签闭合和属性引号。"
            } else {
                "Invalid XML. Check that tags are closed and attributes are quoted."
            }
        }
        "dev.error.yaml" => {
            if zh {
                "YAML 格式无效，请检查缩进、冒号和列表项。"
            } else {
                "Invalid YAML. Check indentation, colons, and list items."
            }
        }
        "dev.error.jsonRoot" => {
            if zh {
                "JSON 转 XML 需要以对象作为根节点。"
            } else {
                "JSON to XML requires an object at the root."
            }
        }
        "dev.error.binary" => {
            if zh {
                "请输入以空格或逗号分隔的 8 位二进制字节，例如 01001000 01101001。"
            } else {
                "Enter 8-bit binary bytes separated by spaces or commas, such as 01001000 01101001."
            }
        }
        "dev.error.binaryUtf8" => {
            if zh {
                "这些字节不是有效的 UTF-8 文本。"
            } else {
                "These bytes are not valid UTF-8 text."
            }
        }
        "dev.error.ipv4" => {
            if zh {
                "请输入有效的 IPv4 地址，例如 192.168.1.1。"
            } else {
                "Enter a valid IPv4 address, such as 192.168.1.1."
            }
        }
        "dev.error.cidr" => {
            if zh {
                "CIDR 前缀必须是 0 到 32 的整数。"
            } else {
                "The CIDR prefix must be an integer from 0 to 32."
            }
        }
        "dev.error.color" => {
            if zh {
                "请输入 #RGB、#RRGGBB 或 rgb(12, 34, 56) 格式的颜色。"
            } else {
                "Enter a color as #RGB, #RRGGBB, or rgb(12, 34, 56)."
            }
        }
        "dev.error.sitemap" => {
            if zh {
                "请输入有效的 HTTP 或 HTTPS Sitemap 地址。"
            } else {
                "Enter a valid HTTP or HTTPS sitemap URL."
            }
        }
        "dev.error.domain" => {
            if zh {
                "请输入有效的域名。"
            } else {
                "Enter a valid domain name."
            }
        }
        "dev.error.email" => {
            if zh {
                "请输入有效的报告邮箱地址。"
            } else {
                "Enter a valid report email address."
            }
        }
        "dev.error.spfLookups" => {
            if zh {
                "SPF 的 DNS 查询项超过 10 个，请减少 include、a 或 mx 项。"
            } else {
                "SPF has more than 10 DNS lookup terms. Reduce include, a, or mx terms."
            }
        }
        "dev.error.ipv6" => {
            if zh {
                "请输入有效的 IPv6 地址。"
            } else {
                "Enter a valid IPv6 address."
            }
        }
        "dev.error.port" => {
            if zh {
                "端口必须是 1 到 65535 之间的整数。"
            } else {
                "Port must be an integer from 1 to 65535."
            }
        }
        "dev.error.url" => {
            if zh {
                "请输入带 http:// 或 https:// 的完整网址。"
            } else {
                "Enter a complete URL beginning with http:// or https://."
            }
        }
        "dev.network.protocol" => {
            if zh {
                "协议"
            } else {
                "Scheme"
            }
        }
        "dev.network.hostname" => {
            if zh {
                "主机名"
            } else {
                "Hostname"
            }
        }
        "dev.network.path" => {
            if zh {
                "路径"
            } else {
                "Path"
            }
        }
        "dev.network.query" => {
            if zh {
                "查询参数"
            } else {
                "Query parameters"
            }
        }
        "dev.network.fragment" => {
            if zh {
                "片段"
            } else {
                "Fragment"
            }
        }
        "dev.ua.browser" => {
            if zh {
                "浏览器"
            } else {
                "Browser"
            }
        }
        "dev.ua.os" => {
            if zh {
                "操作系统"
            } else {
                "Operating system"
            }
        }
        "dev.ua.device" => {
            if zh {
                "设备类型"
            } else {
                "Device type"
            }
        }
        "dev.ua.raw" => {
            if zh {
                "原始值"
            } else {
                "Original value"
            }
        }
        "dev.ipv4.address" => {
            if zh {
                "IPv4 地址"
            } else {
                "IPv4 address"
            }
        }
        "dev.ipv4.input" => {
            if zh {
                "输入网络"
            } else {
                "Input network"
            }
        }
        "dev.ipv4.decimal" => {
            if zh {
                "无符号整数"
            } else {
                "Unsigned integer"
            }
        }
        "dev.ipv4.hex" => {
            if zh {
                "十六进制"
            } else {
                "Hexadecimal"
            }
        }
        "dev.ipv4.binary" => {
            if zh {
                "二进制"
            } else {
                "Binary"
            }
        }
        "dev.ipv4.network" => {
            if zh {
                "网络地址"
            } else {
                "Network address"
            }
        }
        "dev.ipv4.mask" => {
            if zh {
                "子网掩码"
            } else {
                "Subnet mask"
            }
        }
        "dev.ipv4.broadcast" => {
            if zh {
                "广播地址"
            } else {
                "Broadcast address"
            }
        }
        "dev.ipv4.usable" => {
            if zh {
                "可用地址范围"
            } else {
                "Usable range"
            }
        }
        "dev.ipv4.hostCount" => {
            if zh {
                "可用地址数"
            } else {
                "Usable addresses"
            }
        }
        "dev.dmarc.host" => {
            if zh {
                "DNS 主机名"
            } else {
                "DNS hostname"
            }
        }
        "dev.dmarc.value" => {
            if zh {
                "TXT 记录值"
            } else {
                "TXT record value"
            }
        }
        "dev.network.ipv6.input" => {
            if zh {
                "输入地址"
            } else {
                "Input address"
            }
        }
        "dev.network.ipv6.compressed" => {
            if zh {
                "压缩格式"
            } else {
                "Compressed form"
            }
        }
        "dev.network.ipv6.expanded" => {
            if zh {
                "完整格式"
            } else {
                "Fully expanded form"
            }
        }
        "dev.network.port" => {
            if zh {
                "端口"
            } else {
                "Port"
            }
        }
        "dev.network.port.service" => {
            if zh {
                "常见服务"
            } else {
                "Common service"
            }
        }
        "dev.network.port.transport" => {
            if zh {
                "传输协议"
            } else {
                "Transport"
            }
        }
        "dev.network.port.description" => {
            if zh {
                "说明"
            } else {
                "Description"
            }
        }
        "dev.network.port.unknown" => {
            if zh {
                "未收录常见服务；端口本身不标识具体应用。"
            } else {
                "No common service is listed; a port number alone does not identify an application."
            }
        }
        _ => "Invalid input.",
    }
}
pub fn error(ctx: &RunContext<'_>, key: &str) -> EngineError {
    EngineError::new("bad_request", msg(ctx, key))
}
pub fn ipv4(ctx: &RunContext<'_>, input: &str) -> Result<u32, EngineError> {
    let parts: Vec<_> = input.split('.').collect();
    if parts.len() != 4 {
        return Err(error(ctx, "dev.error.ipv4"));
    }
    let mut n = 0u32;
    for p in parts {
        if p.is_empty() || p.len() > 3 || !p.bytes().all(|b| b.is_ascii_digit()) {
            return Err(error(ctx, "dev.error.ipv4"));
        }
        let octet: u32 = p.parse().map_err(|_| error(ctx, "dev.error.ipv4"))?;
        if octet > 255 {
            return Err(error(ctx, "dev.error.ipv4"));
        }
        n = (n << 8) | octet;
    }
    Ok(n)
}
pub fn ipv4_text(n: u32) -> String {
    format!(
        "{}.{}.{}.{}",
        n >> 24,
        (n >> 16) & 255,
        (n >> 8) & 255,
        n & 255
    )
}
pub fn extra(entries: impl IntoIterator<Item = (String, Value)>) -> Map<String, Value> {
    entries.into_iter().collect()
}
