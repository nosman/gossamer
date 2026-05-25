use anyhow::Result;
use std::io::Read;

use crate::ingest;

pub fn run() -> Result<()> {
    let mut stdin = String::new();
    let _ = std::io::stdin().read_to_string(&mut stdin);

    let mut wc_db = match ingest::open_search_db() {
        Ok(db) => db,
        Err(_) => return Ok(()),
    };

    let _ = ingest::claude_code::ingest_claude_code(&mut wc_db);
    let _ = ingest::ingest_sessions(&mut wc_db);
    let _ = ingest::embed_and_index(&wc_db);

    Ok(())
}
