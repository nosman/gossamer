use anyhow::Result;
use serde::Deserialize;
use std::io::{BufRead, Read};

use crate::ingest;

#[derive(Deserialize, Default)]
struct HookInput {
    session_id: Option<String>,
    transcript_path: Option<String>,
}

pub fn run() -> Result<()> {
    let mut stdin = String::new();
    let _ = std::io::stdin().read_to_string(&mut stdin);

    let input: HookInput = serde_json::from_str(stdin.trim()).unwrap_or_default();
    if let (Some(session_id), Some(transcript_path)) = (&input.session_id, &input.transcript_path) {
        let _ = backfill_session_name(session_id, transcript_path);
    }

    let mut wc_db = match ingest::open_search_db() {
        Ok(db) => db,
        Err(_) => return Ok(()),
    };

    let _ = ingest::claude_code::ingest_claude_code(&mut wc_db);
    let _ = ingest::ingest_sessions(&mut wc_db);
    let _ = ingest::embed_and_index(&wc_db);

    Ok(())
}

/// Read the session's live JSONL and update session_name in the DB if a
/// customTitle entry is present and the stored name is still empty.
fn backfill_session_name(session_id: &str, transcript_path: &str) -> Result<()> {
    let file = std::fs::File::open(transcript_path)?;
    let reader = std::io::BufReader::new(file);
    let mut custom_title: Option<String> = None;
    for line in reader.lines().flatten() {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
            if v["type"].as_str() == Some("custom-title") {
                if let Some(t) = v["customTitle"].as_str() {
                    custom_title = Some(t.to_string());
                    break;
                }
            }
        }
    }

    let Some(title) = custom_title else { return Ok(()) };

    let conn = crate::db::connect()?;
    conn.execute(
        "UPDATE sessions SET session_name = ?1 WHERE session_id = ?2 AND (session_name = '' OR session_name IS NULL)",
        rusqlite::params![title, session_id],
    )?;

    Ok(())
}
