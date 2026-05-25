use anyhow::{Context, Result};
use dirs::home_dir;
use rusqlite::Connection;
use std::fs;

pub fn connect() -> Result<Connection> {
    let gossamer_dir = home_dir()
        .context("cannot determine home directory")?
        .join(".gossamer");

    fs::create_dir_all(&gossamer_dir).context("failed to create ~/.gossamer")?;

    let db_path = gossamer_dir.join("gossamer.db");
    let conn = Connection::open(&db_path).context("failed to open database")?;

    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS repositories (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            directory TEXT NOT NULL UNIQUE,
            remote   TEXT NOT NULL,
            name     TEXT NOT NULL
        );")
    .context("failed to run schema migrations")?;

    // Idempotent column additions (ignored if column already exists)
    let _ = conn.execute("ALTER TABLE repositories ADD COLUMN last_indexed_commit TEXT", []);
    let _ = conn.execute("ALTER TABLE repositories ADD COLUMN last_search_commit TEXT", []);

    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS sessions (
            session_id   TEXT PRIMARY KEY,
            agent_name   TEXT NOT NULL,
            user         TEXT NOT NULL,
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL,
            cwd          TEXT NOT NULL,
            session_name TEXT NOT NULL,
            tokens_used  INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS event_log (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            type       TEXT NOT NULL,
            data       TEXT NOT NULL
        );
    ")
    .context("failed to run schema migrations")?;

    Ok(conn)
}
