use anyhow::Result;
use std::collections::HashSet;
use std::path::PathBuf;
use std::process::Command;

use crate::{db, ingest};
use witchcraft::types::{
    SqlConditionInternal, SqlOperator, SqlStatementInternal, SqlStatementType, SqlValue,
};

pub fn run(dry_run: bool, json: bool) -> Result<()> {
    let conn = db::connect()?;

    // All session IDs in the DB.
    let db_ids: Vec<String> = {
        let mut stmt = conn.prepare("SELECT session_id FROM sessions")?;
        stmt.query_map([], |row| row.get(0))?
            .collect::<Result<_, _>>()?
    };

    if db_ids.is_empty() {
        if json { println!("{}", serde_json::json!({"removed": []})); }
        else     { println!("No sessions in database."); }
        return Ok(());
    }

    let mut live: HashSet<String> = HashSet::new();

    // ── Claude Code JSONL files (~/.claude/projects/**/*.jsonl) ──────────────
    if let Ok(home) = std::env::var("HOME") {
        let projects = PathBuf::from(&home).join(".claude/projects");
        if let Ok(dirs) = std::fs::read_dir(&projects) {
            for dir in dirs.flatten() {
                if let Ok(files) = std::fs::read_dir(dir.path()) {
                    for file in files.flatten() {
                        let path = file.path();
                        if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                                live.insert(stem.to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    // ── Checkpoint branches and shadow branches of tracked repos ──────────────
    let repos: Vec<String> = {
        let mut stmt = conn.prepare("SELECT directory FROM repositories")?;
        stmt.query_map([], |row| row.get(0))?
            .collect::<Result<_, _>>()?
    };

    for repo_dir in &repos {
        // Checkpoint branch: paths are <prefix>/<session-uuid>/<num>/metadata.json
        if let Ok(out) = Command::new("git")
            .args(["ls-tree", "-r", "--name-only", super::index::BRANCH])
            .current_dir(repo_dir)
            .output()
        {
            if out.status.success() {
                for line in String::from_utf8_lossy(&out.stdout).lines() {
                    if super::index::is_meta_path(line) {
                        if let Some(id) = line.split('/').nth(1) {
                            live.insert(id.to_string());
                        }
                    }
                }
            }
        }

        // Shadow branches: paths are .entire/metadata/<session-uuid>/full.jsonl
        for branch in super::index::list_shadow_branches(repo_dir) {
            if let Ok(out) = Command::new("git")
                .args(["ls-tree", "-r", "--name-only", &branch, "--", ".entire/metadata/"])
                .current_dir(repo_dir)
                .output()
            {
                if out.status.success() {
                    for line in String::from_utf8_lossy(&out.stdout).lines() {
                        if let Some(id) = super::index::shadow_session_id(line) {
                            live.insert(id.to_string());
                        }
                    }
                }
            }
        }
    }

    // Stale = in DB but not found in any live source.
    let mut stale: Vec<String> = db_ids.into_iter().filter(|id| !live.contains(id)).collect();
    stale.sort();

    if stale.is_empty() {
        if json { println!("{}", serde_json::json!({"removed": []})); }
        else     { println!("No stale sessions found."); }
        return Ok(());
    }

    if !json {
        let action = if dry_run { "Would remove" } else { "Removing" };
        println!("{} {} stale session(s):", action, stale.len());
        for id in &stale { println!("  {id}"); }
    }

    if dry_run {
        if json {
            println!("{}", serde_json::to_string_pretty(&serde_json::json!({
                "dry_run": true,
                "would_remove": stale,
            }))?);
        }
        return Ok(());
    }

    // ── Delete from DB ────────────────────────────────────────────────────────
    for id in &stale {
        conn.execute("DELETE FROM sessions   WHERE session_id = ?1", rusqlite::params![id])?;
        conn.execute("DELETE FROM event_log  WHERE session_id = ?1", rusqlite::params![id])?;
        conn.execute("DELETE FROM checkpoints WHERE session_id = ?1", rusqlite::params![id])?;
    }

    // ── Delete from search index ──────────────────────────────────────────────
    if let Ok(mut wc_db) = ingest::open_search_db() {
        for id in &stale {
            let filter = SqlStatementInternal {
                statement_type: SqlStatementType::Condition,
                condition: Some(SqlConditionInternal {
                    key: "$.session_id".to_string(),
                    operator: SqlOperator::Equals,
                    value: Some(SqlValue::String(id.to_string())),
                }),
                logic: None,
                statements: None,
            };
            let _ = wc_db.delete_with_filter(&filter);
        }
    }

    if json {
        println!("{}", serde_json::to_string_pretty(&serde_json::json!({
            "removed": stale,
        }))?);
    } else {
        println!("Done.");
    }

    Ok(())
}
