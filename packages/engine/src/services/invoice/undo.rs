use super::crypto::invoice_sha256;
use super::paths::invoice_within;
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use uuid::Uuid;

#[derive(Clone)]
pub(super) struct InvoiceUndoFile {
    pub(super) path: PathBuf,
    pub(super) sha256: String,
}

#[derive(Clone)]
struct InvoiceUndoArchive {
    target_root: PathBuf,
    files: Vec<InvoiceUndoFile>,
}

#[derive(Default)]
struct InvoiceUndoState {
    archives: HashMap<String, InvoiceUndoArchive>,
    order: VecDeque<String>,
}

fn invoice_undo_archives() -> &'static Mutex<InvoiceUndoState> {
    static ARCHIVES: OnceLock<Mutex<InvoiceUndoState>> = OnceLock::new();
    ARCHIVES.get_or_init(|| Mutex::new(InvoiceUndoState::default()))
}

pub(super) fn record_archive(
    archive_id: String,
    target_root: PathBuf,
    files: Vec<InvoiceUndoFile>,
) -> Result<(), String> {
    let mut state = invoice_undo_archives()
        .lock()
        .map_err(|_| "撤销记录锁不可用")?;
    state.archives.insert(
        archive_id.clone(),
        InvoiceUndoArchive { target_root, files },
    );
    state.order.push_back(archive_id);
    while state.archives.len() > 32 {
        if let Some(oldest) = state.order.pop_front() {
            state.archives.remove(&oldest);
        } else {
            break;
        }
    }
    Ok(())
}

pub fn invoice_undo(archive_id: String) -> Result<serde_json::Value, String> {
    let archive = invoice_undo_archives()
        .lock()
        .map_err(|_| "撤销记录锁不可用")?
        .archives
        .get(&archive_id)
        .cloned()
        .ok_or("本次归档记录已过期或不存在")?;
    let mut removed = Vec::new();
    let mut skipped = Vec::new();
    for item in archive.files {
        let result = (|| -> Result<(), String> {
            if !invoice_within(&archive.target_root, &item.path) {
                return Err("文件不在本次归档目录内".to_string());
            }
            let meta =
                fs::symlink_metadata(&item.path).map_err(|_| "目标已不存在或不再是普通文件")?;
            if !meta.is_file() || meta.file_type().is_symlink() {
                return Err("目标已不存在或不再是普通文件".to_string());
            }
            let tombstone = item
                .path
                .with_file_name(format!(".potools-undo-{}.tmp", Uuid::new_v4()));
            fs::rename(&item.path, &tombstone).map_err(|e| e.to_string())?;
            let restore = |reason: String| -> String {
                match fs::hard_link(&tombstone, &item.path)
                    .and_then(|_| fs::remove_file(&tombstone))
                {
                    Ok(()) => reason,
                    Err(error) => format!(
                        "{reason}；未能恢复原路径，文件保留在 {} ({error})",
                        tombstone.display()
                    ),
                }
            };
            let moved_meta =
                fs::symlink_metadata(&tombstone).map_err(|e| restore(e.to_string()))?;
            if !moved_meta.is_file() || moved_meta.file_type().is_symlink() {
                return Err(restore("撤销目标已被替换，已保留临时文件".to_string()));
            }
            let real = fs::canonicalize(&tombstone).map_err(|e| restore(e.to_string()))?;
            if !real.starts_with(&archive.target_root) {
                return Err(restore("目标路径已被重定向到归档目录之外".to_string()));
            }
            let digest = invoice_sha256(&fs::read(&real).map_err(|e| restore(e.to_string()))?);
            if digest != item.sha256 {
                return Err(restore("文件内容已变化，已保留该文件".to_string()));
            }
            fs::remove_file(&tombstone).map_err(|e| restore(e.to_string()))?;
            Ok(())
        })();
        match result {
            Ok(()) => removed.push(item.path.to_string_lossy().into_owned()),
            Err(reason) => skipped
                .push(serde_json::json!({"path":item.path.to_string_lossy(),"reason":reason})),
        }
    }
    let mut state = invoice_undo_archives()
        .lock()
        .map_err(|_| "撤销记录锁不可用")?;
    state.archives.remove(&archive_id);
    state.order.retain(|id| id != &archive_id);
    Ok(serde_json::json!({"removed":removed,"skipped":skipped}))
}
