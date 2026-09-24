// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(all(target_os = "windows", feature = "node-embed"))]
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--engine-child")) {
        let exit_code = potools_lib::run_embedded_engine_child(std::env::args().skip(2).collect());
        std::process::exit(exit_code);
    }

    #[cfg(target_os = "windows")]
    if let Err(error) = ensure_webview2_runtime() {
        show_webview2_error(&error);
        std::process::exit(1);
    }

    potools_lib::run()
}

#[cfg(target_os = "windows")]
fn ensure_webview2_runtime() -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    let registry_keys = [
        r"HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        r"HKLM\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        r"HKCU\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    ];
    if registry_keys.iter().any(|key| {
        Command::new("reg.exe")
            .args(["query", key, "/v", "pv"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }) {
        return Ok(());
    }

    const SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$guid = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$keys = @(
  "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$guid",
  "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$guid",
  "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$guid"
)
foreach ($key in $keys) {
  try {
    $version = (Get-ItemProperty -LiteralPath $key -Name pv -ErrorAction Stop).pv
    if ($version) { exit 0 }
  } catch {}
}

$installer = Join-Path $env:TEMP 'PoTools-WebView2-Bootstrapper.exe'
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $installer -UseBasicParsing
  $process = Start-Process -FilePath $installer -ArgumentList '/silent', '/install' -Wait -PassThru
  if ($process.ExitCode -ne 0) { exit $process.ExitCode }
  foreach ($key in $keys) {
    try {
      $version = (Get-ItemProperty -LiteralPath $key -Name pv -ErrorAction Stop).pv
      if ($version) { exit 0 }
    } catch {}
  }
  exit 1
} finally {
  Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
}
"#;

    let status = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            SCRIPT,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x0800_0000)
        .status()
        .map_err(|error| format!("Could not start the WebView2 setup: {error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "Microsoft Edge WebView2 Runtime could not be installed (setup exit code: {}). Check your internet connection and try again.",
            status.code().unwrap_or(-1)
        ))
    }
}

#[cfg(target_os = "windows")]
fn show_webview2_error(message: &str) {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetUserDefaultUILanguage() -> u16;
    }
    #[link(name = "user32")]
    unsafe extern "system" {
        fn MessageBoxW(
            hwnd: *mut std::ffi::c_void,
            text: *const u16,
            caption: *const u16,
            kind: u32,
        ) -> i32;
    }

    let is_chinese = unsafe { GetUserDefaultUILanguage() & 0x03ff == 0x0004 };
    let localized_message = if is_chinese {
        "PoTools 无法自动安装 Microsoft Edge WebView2 Runtime。请检查网络连接后重试。"
    } else {
        message
    };
    let text = OsStr::new(localized_message)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let caption = OsStr::new("PoTools")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    unsafe {
        MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), 0x10);
    }
}
