use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

fn gossamer_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".gossamer")
}

pub fn claude_path() -> PathBuf {
    gossamer_dir().join("claude.watermark")
}

pub fn mtime_ms(path: &Path) -> i64 {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn touch(path: &Path) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(path, "");
}

pub fn file_newer_than(file: &Path, watermark_ts: i64) -> bool {
    mtime_ms(file) > watermark_ts
}
