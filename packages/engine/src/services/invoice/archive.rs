use super::crypto::invoice_sha256;
use super::paths::{
    invoice_ensure_safe_directory, invoice_free_destination, invoice_normalize_absolute,
    invoice_safe_segments,
};
use super::report::{invoice_csv_cell, invoice_iso_now, invoice_report_path};
use super::types::InvoiceArchiveInput;
use super::undo::{record_archive, InvoiceUndoFile};

fn destination_exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub fn invoice_archive(input: InvoiceArchiveInput) -> Result<serde_json::Value, String> {
    const MAX_FILES: usize = 2000;
    const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;
    if input.files.len() > MAX_FILES || !input.files.iter().any(|item| item.enabled) {
        return Err(format!("请选择 1 至 {MAX_FILES} 个归档文件"));
    }
    if input.target_directory.is_empty() {
        return Err("请选择有效的归档目标目录".to_string());
    }
    let requested_source = PathBuf::from(&input.source_directory);
    let requested_target = invoice_normalize_absolute(Path::new(&input.target_directory))?;
    if !requested_source.is_absolute() {
        return Err("来源目录已不可用，请重新扫描".to_string());
    }
    let source_root =
        fs::canonicalize(&requested_source).map_err(|_| "来源目录已不可用，请重新扫描")?;
    let source_meta = fs::metadata(&source_root).map_err(|error| error.to_string())?;
    if !source_meta.is_dir() {
        return Err("来源路径不是目录".to_string());
    }
    if requested_target == source_root
        || requested_target.starts_with(&source_root)
        || source_root.starts_with(&requested_target)
    {
        return Err("归档目标必须是来源目录之外的独立目录".to_string());
    }
    fs::create_dir_all(&requested_target).map_err(|error| error.to_string())?;
    let target_root = fs::canonicalize(&requested_target).map_err(|error| error.to_string())?;
    if target_root == source_root
        || target_root.starts_with(&source_root)
        || source_root.starts_with(&target_root)
    {
        return Err("归档目标与来源目录不能重叠".to_string());
    }
    let mut copied = Vec::new();
    let mut skipped = Vec::new();
    let mut failed = Vec::new();
    for item in input.files.iter().filter(|item| item.enabled) {
        let mut temporary: Option<PathBuf> = None;
        let result = (|| -> Result<(PathBuf, String), String> {
            let source = PathBuf::from(&item.path);
            if !source.is_absolute() {
                return Err("源文件不在已扫描目录内".to_string());
            }
            let source_abs = source;
            let source_real = fs::canonicalize(&source_abs).map_err(|e| e.to_string())?;
            if !source_real.starts_with(&source_root) {
                return Err("源文件已移出来源目录".to_string());
            }
            let source_info = fs::symlink_metadata(&source_abs).map_err(|e| e.to_string())?;
            if !source_info.is_file() || source_info.file_type().is_symlink() {
                return Err("源文件不再是普通文件".to_string());
            }
            if source_info.len() > MAX_FILE_BYTES {
                return Err("源文件超过 100 MB 上限".to_string());
            }
            if item.sha256.len() != 64 || !item.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("扫描校验信息无效，请重新扫描".to_string());
            }
            let bytes = fs::read(&source_real).map_err(|e| e.to_string())?;
            let digest = invoice_sha256(&bytes);
            if digest != item.sha256.to_ascii_lowercase() {
                return Err("源文件内容已变化，请重新扫描".to_string());
            }
            let segments = invoice_safe_segments(&item.relative_path)?;
            let mut requested = target_root.clone();
            for segment in segments {
                requested.push(segment);
            }
            if !requested.starts_with(&target_root) {
                return Err("目标路径超出归档目录".to_string());
            }
            let parent = requested.parent().ok_or("目标路径无效")?;
            invoice_ensure_safe_directory(&target_root, parent)?;
            let destination = if input.conflict == "skip" {
                if destination_exists(&requested) {
                    return Err("conflict:目标文件已存在".to_string());
                }
                requested
            } else {
                invoice_free_destination(&requested)?
            };
            let temp = destination.with_file_name(format!(".potools-{}.tmp", Uuid::new_v4()));
            temporary = Some(temp.clone());
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)
                .map_err(|e| e.to_string())?;
            file.write_all(&bytes).map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
            let copied_bytes = fs::read(&temp).map_err(|e| e.to_string())?;
            if invoice_sha256(&copied_bytes) != digest {
                return Err("复制校验失败".to_string());
            }
            fs::hard_link(&temp, &destination).map_err(|e| e.to_string())?;
            // The destination is now safely linked and digest-verified. A
            // cleanup failure must not report a failed copy while leaving an
            // untracked destination behind.
            let _ = fs::remove_file(&temp);
            temporary = None;
            Ok((destination, digest))
        })();
        match result {
            Ok((target, digest)) => copied.push(serde_json::json!({ "source": item.path, "target": target.to_string_lossy(), "sha256": digest, "fields": item.fields.clone().unwrap_or_else(|| serde_json::json!({"date":"","seller":"","buyer":"","invoiceNo":"","amount":"","type":""})) })),
            Err(reason) => {
                if let Some(temp) = temporary { let _ = fs::remove_file(temp); }
                if let Some(message) = reason.strip_prefix("conflict:") { skipped.push(serde_json::json!({"source": item.path, "reason": message})); }
                else { failed.push(serde_json::json!({"source": item.path, "reason": reason})); }
            }
        }
    }
    let archive_id = Uuid::new_v4().to_string();
    let undo_files = copied
        .iter()
        .filter_map(|item| {
            Some(InvoiceUndoFile {
                path: PathBuf::from(item.get("target")?.as_str()?),
                sha256: item.get("sha256")?.as_str()?.to_string(),
            })
        })
        .collect::<Vec<_>>();
    {
        record_archive(archive_id.clone(), target_root.clone(), undo_files)?;
    }
    let created_at = invoice_iso_now();
    let report = serde_json::json!({"archiveId":archive_id,"createdAt":created_at,"sourceDirectory":source_root.to_string_lossy(),"targetDirectory":target_root.to_string_lossy(),"conflict":input.conflict,"copied":copied,"skipped":skipped,"failed":failed});
    let mut csv = String::from(
        "\u{feff}source,target,sha256,date,seller,buyer,invoiceNo,amount,type,result,reason\r\n",
    );
    for item in report["copied"].as_array().into_iter().flatten() {
        let fields = &item["fields"];
        let values = [
            item["source"].as_str().unwrap_or(""),
            item["target"].as_str().unwrap_or(""),
            item["sha256"].as_str().unwrap_or(""),
            fields["date"].as_str().unwrap_or(""),
            fields["seller"].as_str().unwrap_or(""),
            fields["buyer"].as_str().unwrap_or(""),
            fields["invoiceNo"].as_str().unwrap_or(""),
            fields["amount"].as_str().unwrap_or(""),
            fields["type"].as_str().unwrap_or(""),
            "copied",
            "",
        ];
        csv.push_str(&values.map(invoice_csv_cell).join(","));
        csv.push_str("\r\n");
    }
    for item in report["skipped"].as_array().into_iter().flatten() {
        let values = [
            item["source"].as_str().unwrap_or(""),
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "skipped",
            item["reason"].as_str().unwrap_or(""),
        ];
        csv.push_str(&values.map(invoice_csv_cell).join(","));
        csv.push_str("\r\n");
    }
    for item in report["failed"].as_array().into_iter().flatten() {
        let values = [
            item["source"].as_str().unwrap_or(""),
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "failed",
            item["reason"].as_str().unwrap_or(""),
        ];
        csv.push_str(&values.map(invoice_csv_cell).join(","));
        csv.push_str("\r\n");
    }
    let mut warnings = Vec::new();
    let mut report_path: Option<PathBuf> = None;
    let mut csv_report_path: Option<PathBuf> = None;
    let report_result = invoice_report_path(&target_root).and_then(|path| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        file.write_all(
            serde_json::to_string_pretty(&report)
                .map_err(|e| e.to_string())?
                .as_bytes(),
        )
        .map_err(|e| e.to_string())?;
        Ok(path)
    });
    match report_result {
        Ok(path) => {
            let csv_path = path.with_extension("csv");
            let csv_result = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&csv_path)
                .and_then(|mut file| file.write_all(csv.as_bytes()));
            report_path = Some(path);
            if csv_result.is_ok() {
                csv_report_path = Some(csv_path);
            } else {
                warnings.push("report-write-failed");
            }
        }
        Err(_) => warnings.push("report-write-failed"),
    }
    Ok(
        serde_json::json!({"archiveId":archive_id,"copied":report["copied"],"skipped":report["skipped"],"failed":report["failed"],"reportPath":report_path.map(|v|v.to_string_lossy().into_owned()),"csvReportPath":csv_report_path.map(|v|v.to_string_lossy().into_owned()),"warnings":warnings}),
    )
}
