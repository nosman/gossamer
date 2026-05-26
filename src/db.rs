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
    let _ = conn.execute("ALTER TABLE checkpoints ADD COLUMN jsonl_path TEXT", []);
    let _ = conn.execute("ALTER TABLE checkpoints ADD COLUMN repo_dir TEXT", []);
    let _ = conn.execute("ALTER TABLE checkpoints ADD COLUMN os_user TEXT", []);
    let _ = conn.execute("ALTER TABLE sessions ADD COLUMN branch TEXT", []);
    let _ = conn.execute("ALTER TABLE sessions ADD COLUMN repo_id INTEGER", []);

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
        CREATE TABLE IF NOT EXISTS checkpoints (
            session_id        TEXT NOT NULL,
            checkpoint_number INTEGER NOT NULL,
            commit_sha        TEXT NOT NULL,
            author_name       TEXT NOT NULL,
            author_email      TEXT NOT NULL,
            last_turn_ts      TEXT NOT NULL,
            jsonl_path        TEXT,
            repo_dir          TEXT,
            PRIMARY KEY (session_id, checkpoint_number)
        );
        CREATE INDEX IF NOT EXISTS checkpoints_session_idx
            ON checkpoints (session_id, last_turn_ts);
    ")
    .context("failed to run schema migrations")?;

    Ok(conn)
}
