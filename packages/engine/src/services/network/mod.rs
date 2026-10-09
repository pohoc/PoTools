mod dns;
mod ping;
mod probe;
mod tcp;
mod types;
mod validation;

pub use dns::dns_lookup;
pub use ping::ping_host;
pub use probe::system_network_probe;
pub use tcp::tcp_check_host;
pub use types::NativeNetworkResult;
pub(crate) use validation::valid_network_host;

#[cfg(test)]
mod tests {
    use super::{tcp_check_host, validation::valid_network_host};
    use std::net::TcpListener;

    #[test]
    fn validates_hostnames_and_ip_literals() {
        assert!(valid_network_host("example.com"));
        assert!(valid_network_host("127.0.0.1"));
        assert!(valid_network_host("::1"));
        assert!(!valid_network_host("bad host"));
        assert!(!valid_network_host("-invalid.example"));
    }

    #[test]
    fn connects_to_a_local_tcp_listener() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind local listener");
        let port = listener.local_addr().expect("listener address").port();
        let accept =
            std::thread::spawn(move || listener.accept().expect("accept local connection"));
        let result = tcp_check_host("127.0.0.1".into(), port);
        let _ = accept.join().expect("listener thread");
        assert_eq!(result.connected, Some(true));
        assert_eq!(result.error_code, None);
    }
}
