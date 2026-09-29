use super::{valid_network_host, NativeNetworkResult};
use std::{
    net::{Shutdown, TcpStream, ToSocketAddrs},
    time::{Duration, Instant},
};

pub fn tcp_check_host(host: String, port: u16) -> NativeNetworkResult {
    if !valid_network_host(&host) || port == 0 {
        return NativeNetworkResult {
            error_code: Some("EINVAL".into()),
            connected: Some(false),
            elapsed_ms: Some(0),
            ..NativeNetworkResult::empty()
        };
    }
    let started = Instant::now();
    let result = (host.as_str(), port)
        .to_socket_addrs()
        .and_then(|addresses| {
            let mut last_error = None;
            for address in addresses.take(16) {
                let remaining = Duration::from_secs(5).saturating_sub(started.elapsed());
                if remaining.is_zero() {
                    break;
                }
                match TcpStream::connect_timeout(&address, remaining) {
                    Ok(stream) => {
                        let _ = stream.shutdown(Shutdown::Both);
                        return Ok(());
                    }
                    Err(error) => last_error = Some(error),
                }
            }
            Err(last_error
                .unwrap_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no address")))
        });
    let elapsed_ms = started.elapsed().as_millis();
    let (connected, error_code) = match result {
        Ok(()) => (true, None),
        Err(error) => {
            let code = match error.kind() {
                std::io::ErrorKind::ConnectionRefused => "ECONNREFUSED",
                std::io::ErrorKind::TimedOut => "ETIMEDOUT",
                std::io::ErrorKind::NotFound => "ENOTFOUND",
                std::io::ErrorKind::AddrNotAvailable => "EADDRNOTAVAIL",
                _ => "error",
            };
            (false, Some(code.to_string()))
        }
    };
    NativeNetworkResult {
        error_code,
        connected: Some(connected),
        elapsed_ms: Some(elapsed_ms),
        ..NativeNetworkResult::empty()
    }
}
