use anyhow::{Context, Result};
use std::path::PathBuf;

/// Resolves the witchcraft assets directory. Priority:
///   1. WARP_ASSETS environment variable
///   2. ~/.gossamer/warp_assets config file
pub fn resolve_warp_assets() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("WARP_ASSETS") {
        let path = PathBuf::from(p);
        if path.exists() {
            return Some(path);
        }
    }
    if let Some(home) = dirs::home_dir() {
        let cfg = home.join(".gossamer/warp_assets");
        if let Ok(s) = std::fs::read_to_string(cfg) {
            let path = PathBuf::from(s.trim());
            if path.exists() {
                return Some(path);
            }
        }
    }
    None
}

pub fn set_warp_assets(path: &str) -> Result<()> {
    let p = PathBuf::from(path);
    if !p.exists() {
        anyhow::bail!("path does not exist: {path}");
    }
    let home = dirs::home_dir().context("cannot determine home directory")?;
    let dir = home.join(".gossamer");
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("warp_assets"), path.trim())?;
    println!("Assets path saved: {path}");
    Ok(())
}

pub fn show() {
    match resolve_warp_assets() {
        Some(p) => println!("assets: {}", p.display()),
        None => println!(
            "assets: (not set)\n\
             Run `entire gossamer assets <path>` or set $WARP_ASSETS to the witchcraft assets directory."
        ),
    }
}
