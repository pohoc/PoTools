use super::shared::*;
use crate::{EngineError, RunContext, ToolResult};
use serde_json::json;
use url::Url;

pub fn run(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    match ctx.tool {
        "robots-txt" => robots(ctx),
        "spf-record" => spf(ctx),
        "dmarc-record" => dmarc(ctx),
        _ => Err(err("Unsupported developer web tool")),
    }
}
fn lines(s: &str) -> Vec<String> {
    s.lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}
fn robots(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let agent = string(ctx, "userAgent", "").trim();
    let agent = if agent.is_empty() { "*" } else { agent };
    let allow = lines(string(ctx, "allow", ""));
    let deny = lines(string(ctx, "disallow", ""));
    let sitemap = string(ctx, "sitemap", "").trim();
    if !sitemap.is_empty() {
        let parsed = Url::parse(sitemap).map_err(|_| error(ctx, "dev.error.sitemap"))?;
        if !["http", "https"].contains(&parsed.scheme()) || parsed.host_str().is_none() {
            return Err(error(ctx, "dev.error.sitemap"));
        }
    }
    let mut rows = vec![format!("User-agent: {agent}")];
    for p in &allow {
        rows.push(format!(
            "Allow: {}",
            if p.starts_with('/') {
                p.clone()
            } else {
                format!("/{p}")
            }
        ))
    }
    for p in &deny {
        rows.push(format!(
            "Disallow: {}",
            if p.starts_with('/') {
                p.clone()
            } else {
                format!("/{p}")
            }
        ))
    }
    if !sitemap.is_empty() {
        rows.push(String::new());
        rows.push(format!("Sitemap: {sitemap}"))
    }
    Ok(output(
        "robots.txt",
        rows.join("\n"),
        extra([(String::from("rules"), json!(allow.len() + deny.len()))]),
    ))
}
fn valid_domain(d: &str) -> bool {
    d.len() <= 253
        && d.split('.').count() >= 2
        && d.split('.').all(|l| {
            !l.is_empty()
                && l.len() <= 63
                && l.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
                && !l.starts_with('-')
                && !l.ends_with('-')
        })
        && d.rsplit('.').next().is_some_and(|t| {
            t.len() >= 2 && t.len() <= 63 && t.bytes().all(|c| c.is_ascii_alphabetic())
        })
}
fn spf(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let domain = string(ctx, "domain", "").trim();
    if !valid_domain(domain) {
        return Err(error(ctx, "dev.error.domain"));
    }
    let inc = lines(string(ctx, "includes", ""));
    let ips = lines(string(ctx, "ipv4", ""));
    let mx = boolean(ctx, "mx", false);
    let a = boolean(ctx, "a", false);
    let mut terms = vec!["v=spf1".to_string()];
    if mx {
        terms.push("mx".into())
    }
    if a {
        terms.push("a".into())
    }
    for ip in &ips {
        let (address, prefix) = ip.split_once('/').unwrap_or((ip, "32"));
        ipv4(ctx, address)?;
        if prefix.is_empty()
            || !prefix.bytes().all(|b| b.is_ascii_digit())
            || prefix.parse::<u32>().ok().is_none_or(|n| n > 32)
        {
            return Err(error(ctx, "dev.error.cidr"));
        }
        terms.push(format!("ip4:{ip}"))
    }
    for d in &inc {
        let d = d
            .strip_prefix("include:")
            .or_else(|| d.strip_prefix("INCLUDE:"))
            .or_else(|| {
                d.get(..8)
                    .filter(|p| p.eq_ignore_ascii_case("include:"))
                    .map(|_| &d[8..])
            })
            .unwrap_or(d);
        if !valid_domain(d) {
            return Err(error(ctx, "dev.error.domain"));
        }
        terms.push(format!("include:{d}"))
    }
    if inc.len() + usize::from(mx) + usize::from(a) > 10 {
        return Err(error(ctx, "dev.error.spfLookups"));
    }
    terms.push(string(ctx, "policy", "-all").to_string());
    let text = terms.join(" ");
    Ok(output(
        "spf-record.txt",
        text,
        extra([
            (String::from("domain"), json!(domain)),
            (String::from("terms"), json!(terms.len())),
        ]),
    ))
}
fn dmarc(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let domain = string(ctx, "domain", "").trim();
    if !valid_domain(domain) {
        return Err(error(ctx, "dev.error.domain"));
    }
    let email = string(ctx, "reportEmail", "").trim();
    let email_valid = |s: &str| {
        !s.chars().any(char::is_whitespace)
            && s.split_once('@').is_some_and(|(local, domain)| {
                !local.is_empty()
                    && !domain.is_empty()
                    && domain.contains('.')
                    && !domain.ends_with('.')
            })
            && s.matches('@').count() == 1
    };
    if !email.is_empty() && !email_valid(email) {
        return Err(error(ctx, "dev.error.email"));
    }
    let p = number(ctx, "percent", 100.).trunc().clamp(0., 100.) as u32;
    let raw = string(ctx, "policy", "quarantine");
    let policy = if ["none", "quarantine", "reject"].contains(&raw) {
        raw
    } else {
        "quarantine"
    };
    let value = format!(
        "v=DMARC1; p={policy}; pct={p}{}",
        if email.is_empty() {
            String::new()
        } else {
            format!("; rua=mailto:{email}")
        }
    );
    let text = format!(
        "{}: _dmarc.{domain}\n{}: {value}",
        msg(ctx, "dev.dmarc.host"),
        msg(ctx, "dev.dmarc.value")
    );
    Ok(output(
        "dmarc-record.txt",
        text,
        extra([
            (String::from("domain"), json!(domain)),
            (String::from("policy"), json!(policy)),
            (String::from("percent"), json!(p)),
        ]),
    ))
}
