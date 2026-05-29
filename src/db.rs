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
    let _ = conn.execute("ALTER TABLE sessions ADD COLUMN name_is_explicit INTEGER NOT NULL DEFAULT 0", []);

    // Correct sessions whose stored repo_id doesn't match their cwd. Done in
    // two passes so cross-machine sessions (Scott's `/Users/sholodak/…`) also
    // get re-attributed instead of stranding on whichever repo's index pass
    // last touched them.
    correct_session_repo_attribution(&conn);

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

/// Re-resolve `sessions.repo_id` using path-only heuristics: cwd longest-
/// prefix match, then user-home-stripped suffix match (so Scott's
/// `/Users/sholodak/cosmos/cosmos-graphql` attaches to our local
/// `/Users/stsoucas/cosmos/cosmos-graphql` clone). Mirrors steps 1 and 1b of
/// `index::RepoResolver` but skips the git-remote subprocess — the migration
/// runs on every connect and must stay cheap.
fn correct_session_repo_attribution(conn: &Connection) {
    let repos: Vec<(i64, String)> = match conn.prepare("SELECT id, directory FROM repositories") {
        Ok(mut stmt) => stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map(|rs| rs.flatten().collect())
            .unwrap_or_default(),
        Err(_) => return,
    };
    if repos.is_empty() { return; }

    let sessions: Vec<(String, String, Option<i64>)> = match conn.prepare(
        "SELECT session_id, cwd, repo_id FROM sessions WHERE cwd IS NOT NULL AND cwd != ''"
    ) {
        Ok(mut stmt) => stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map(|rs| rs.flatten().collect())
            .unwrap_or_default(),
        Err(_) => return,
    };

    for (sid, cwd, current) in sessions {
        let resolved = resolve_by_path(&repos, &cwd);
        if let Some(new_id) = resolved {
            if current != Some(new_id) {
                let _ = conn.execute(
                    "UPDATE sessions SET repo_id = ?1 WHERE session_id = ?2",
                    rusqlite::params![new_id, sid],
                );
            }
        }
    }
}

fn resolve_by_path(repos: &[(i64, String)], cwd: &str) -> Option<i64> {
    let mut best: Option<(usize, i64)> = None;
    for (id, dir) in repos {
        if cwd.starts_with(dir.as_str()) {
            let n = dir.len();
            if best.map_or(true, |(b, _)| n > b) { best = Some((n, *id)); }
        }
    }
    if let Some((_, id)) = best { return Some(id); }

    let cwd_suffix = strip_user_home(cwd)?;
    let mut best: Option<(usize, i64)> = None;
    for (id, dir) in repos {
        if let Some(dir_suffix) = strip_user_home(dir) {
            if path_prefix_match(cwd_suffix, dir_suffix) {
                let n = dir_suffix.len();
                if best.map_or(true, |(b, _)| n > b) { best = Some((n, *id)); }
            }
        }
    }
    best.map(|(_, id)| id)
}

fn strip_user_home(path: &str) -> Option<&str> {
    for home_root in ["/Users/", "/home/"] {
        if let Some(rest) = path.strip_prefix(home_root) {
            return rest.split_once('/').map(|(_user, after)| after);
        }
    }
    None
}

fn path_prefix_match(haystack: &str, needle: &str) -> bool {
    if haystack == needle { return true; }
    if !haystack.starts_with(needle) { return false; }
    haystack.as_bytes().get(needle.len()) == Some(&b'/')
}
