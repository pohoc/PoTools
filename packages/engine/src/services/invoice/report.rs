use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn invoice_csv_cell(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

pub fn invoice_iso_now() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let days = (now.as_secs() / 86_400) as i64;
    let seconds = now.as_secs() % 86_400;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        seconds / 3600,
        (seconds / 60) % 60,
        seconds % 60,
        now.subsec_millis()
    )
}

pub fn invoice_report_path(root: &Path) -> Result<PathBuf, String> {
    let base = format!(
        "potools-invoice-report-{}",
        invoice_iso_now().replace([':', '.'], "-")
    );
    for suffix in 1..=100 {
        let name = if suffix == 1 {
            format!("{base}.json")
        } else {
            format!("{base}-{suffix}.json")
        };
        let path = root.join(name);
        if !path.exists() {
            return Ok(path);
        }
    }
    Err("无法创建归档报告文件".to_string())
}
