pub(crate) fn valid_network_host(host: &str) -> bool {
    if host.is_empty() || host.len() > 253 || host.chars().any(char::is_whitespace) {
        return false;
    }
    host.parse::<std::net::IpAddr>().is_ok()
        || host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label.chars().all(|character| {
                    character.is_ascii_alphanumeric() || character == '-' || character == '_'
                })
                && !label.starts_with('-')
                && !label.ends_with('-')
        })
}
