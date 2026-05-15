use anyhow::Result;
use chrono::Utc;
use serde::Deserialize;
use std::io::Read;

use crate::db;

#[derive(Deserialize)]
struct HookInput {
    session_id: String,
    cwd: Option<String>,
}

pub fn run() -> Result<()> {
    let mut stdin = String::new();
    std::io::stdin().read_to_string(&mut stdin)?;

    let input: HookInput = serde_json::from_str(stdin.trim())?;

    let conn = db::connect()?;
    let now = Utc::now().to_rfc3339();
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "unknown".to_string());

    conn.execute(
        "INSERT OR IGNORE INTO sessions (session_id, agent_name, user, created_at, updated_at, cwd, session_name)
         VALUES (?1, 'Claude Code', ?2, ?3, ?3, ?4, '')",
        rusqlite::params![input.session_id, user, now, input.cwd.unwrap_or_default()],
    )?;

    Ok(())
}
