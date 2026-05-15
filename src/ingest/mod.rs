pub mod claude_code;

use anyhow::{Context, Result};
use std::path::PathBuf;

/// Embed any un-embedded documents and rebuild the centroid index.
/// Does nothing (with a message) if WARP_ASSETS is not set to a valid path.
pub fn embed_and_index(wc_db: &witchcraft::DB) -> Result<()> {
    let assets = PathBuf::from(
        std::env::var("WARP_ASSETS").unwrap_or_else(|_| "assets".into()),
    );
    if !assets.exists() {
        println!("Set WARP_ASSETS to the witchcraft assets directory to enable semantic search.");
        return Ok(());
    }
    let device = witchcraft::make_device();
    let embedder = witchcraft::Embedder::new(&device, &assets)
        .context("failed to load embedder")?;
    witchcraft::embed_chunks(wc_db, &embedder, None)?;
    witchcraft::index_chunks(wc_db, &device)?;
    println!("Search index updated.");
    Ok(())
}

pub fn open_search_db() -> Result<witchcraft::DB> {
    let path = dirs::home_dir()
        .context("cannot determine home directory")?
        .join(".gossamer/search.db");
    Ok(witchcraft::DB::new(path)?)
}
