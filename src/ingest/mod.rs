pub mod claude_code;

use anyhow::{Context, Result};
use uuid::Uuid;

const SESSION_NAMESPACE: Uuid = Uuid::from_bytes([
    0xb1, 0x2f, 0xa3, 0x44, 0x7c, 0x8e, 0x4d, 0x91,
    0xaa, 0x2c, 0x5e, 0x1f, 0x4b, 0x8d, 0x9c, 0x3e,
]);

const REPO_NAMESPACE: Uuid = Uuid::from_bytes([
    0xc3, 0x5a, 0xb7, 0x11, 0x9d, 0x2c, 0x4e, 0x88,
    0xbc, 0x3d, 0x6f, 0x2a, 0x5c, 0x9e, 0xad, 0x4f,
]);

pub fn embed_and_index(wc_db: &witchcraft::DB) -> Result<()> {
    let Some(assets) = crate::config::resolve_warp_assets() else {
        println!("Run `gossamer config <path>` pointing at the witchcraft assets directory to enable semantic search.");
        return Ok(());
    };
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

pub fn ingest_sessions(wc_db: &mut witchcraft::DB) -> Result<usize> {
    let conn = crate::db::connect()?;
    let mut stmt = conn.prepare(
        "SELECT session_id, session_name, cwd, agent_name, updated_at FROM sessions",
    )?;

    let rows: Vec<(String, String, String, String, String)> = stmt
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
        })?
        .flatten()
        .collect();

    let mut count = 0;
    for (session_id, session_name, cwd, agent_name, updated_at) in rows {
        let name = session_name.trim().to_string();
        if name.is_empty() {
            continue;
        }

        let uuid = Uuid::new_v5(&SESSION_NAMESPACE, session_id.as_bytes());
        let metadata = serde_json::json!({
            "source": "session",
            "session_id": session_id,
            "session_name": name,
            "cwd": cwd,
            "agent_name": agent_name,
        })
        .to_string();

        let body = format!("{name}\n{cwd}\n{agent_name}");
        let date = iso8601_timestamp::Timestamp::parse(&updated_at);
        wc_db.add_doc(&uuid, date, &metadata, &body, None)?;
        count += 1;
    }

    Ok(count)
}

pub fn ingest_repos(wc_db: &mut witchcraft::DB) -> Result<usize> {
    let conn = crate::db::connect()?;
    let mut stmt = conn.prepare("SELECT directory, remote, name FROM repositories")?;

    let rows: Vec<(String, String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .flatten()
        .collect();

    let mut count = 0;
    for (directory, remote, name) in rows {
        let uuid = Uuid::new_v5(&REPO_NAMESPACE, directory.as_bytes());
        let metadata = serde_json::json!({
            "source": "repo",
            "repo_name": name,
            "repo_dir": directory,
            "repo_remote": remote,
        })
        .to_string();

        let body = format!("{name}\n{directory}\n{remote}");
        wc_db.add_doc(&uuid, None, &metadata, &body, None)?;
        count += 1;
    }

    Ok(count)
}
