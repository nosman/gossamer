use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::Value;
use std::process::Command;

use crate::{db, ingest};

pub(crate) const BRANCH: &str = "entire/checkpoints/v1";

pub fn run() -> Result<()> {
    let conn = db::connect()?;

    let mut stmt = conn.prepare("SELECT directory, name FROM repositories")?;
    let repos: Vec<(String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<_, _>>()?;

    if repos.is_empty() {
        println!("No repositories tracked. Run `gossamer init` first.");
        return Ok(());
    }

    let mut grand_total = 0usize;

    for (dir, name) in &repos {
        match index_repo(&conn, dir, name) {
            Ok(0) => println!("'{}': no {} branch found.", name, BRANCH),
            Ok(n) => {
                println!("'{}': indexed {} session(s).", name, n);
                grand_total += n;
            }
            Err(e) => eprintln!("'{}': error — {}", name, e),
        }
    }

    println!("\n{} session(s) indexed.", grand_total);

    // Ingest Claude Code sessions into the witchcraft semantic search DB.
    println!("\nIndexing Claude Code sessions into search DB...");
    let mut wc_db = ingest::open_search_db()?;
    let turns = ingest::claude_code::ingest_claude_code(&mut wc_db)?;
    if turns > 0 {
        println!("{turns} turn(s) ingested.");
        ingest::embed_and_index(&wc_db)?;
    } else {
        println!("No new Claude Code sessions to index.");
    }

    Ok(())
}

pub(crate) fn is_meta_path(l: &str) -> bool {
    l.ends_with("/metadata.json")
        && l.matches('/').count() == 3
        && l.split('/').nth(2).map_or(false, |s| s.chars().all(|c| c.is_ascii_digit()))
}

fn index_repo(conn: &rusqlite::Connection, repo_dir: &str, _repo_name: &str) -> Result<usize> {
    if let Some(remote_url) = checkpoint_remote_url(repo_dir) {
        let _ = Command::new("git")
            .args(["fetch", &remote_url, &format!("{}:{}", BRANCH, BRANCH)])
            .current_dir(repo_dir)
            .output();
    }

    let check = Command::new("git")
        .args(["rev-parse", "--verify", BRANCH])
        .current_dir(repo_dir)
        .output()
        .context("failed to run git")?;

    if !check.status.success() {
        return Ok(0);
    }

    let ls = Command::new("git")
        .args(["ls-tree", "-r", "--name-only", BRANCH])
        .current_dir(repo_dir)
        .output()
        .context("git ls-tree failed")?;

    let listing = String::from_utf8(ls.stdout)?;

    let meta_paths: Vec<&str> = listing.lines().filter(|l| is_meta_path(l)).collect();

    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "unknown".to_string());

    let mut count = 0;

    for meta_path in meta_paths {
        let jsonl_path = format!("{}full.jsonl", &meta_path[..meta_path.len() - "metadata.json".len()]);

        let meta_bytes = match git_show(repo_dir, meta_path) {
            Ok(b) => b,
            Err(e) => { eprintln!("  skipping {}: {}", meta_path, e); continue; }
        };
        let jsonl_bytes = match git_show(repo_dir, &jsonl_path) {
            Ok(b) => b,
            Err(_) => continue,
        };

        match parse_session(&meta_bytes, &jsonl_bytes, &user) {
            Ok((session_id, agent_name, created_at, updated_at, cwd, session_name)) => {
                upsert_session(conn, &session_id, &agent_name, &user, &created_at, &updated_at, &cwd, &session_name)?;
                count += 1;
            }
            Err(e) => eprintln!("  skipping {}: {}", meta_path, e),
        }
    }

    // Save commit watermark so `gossamer refresh` knows where to start next time.
    if let Ok(out) = Command::new("git").args(["rev-parse", BRANCH]).current_dir(repo_dir).output() {
        if out.status.success() {
            let head = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let _ = conn.execute(
                "UPDATE repositories SET last_indexed_commit = ?1 WHERE directory = ?2",
                rusqlite::params![head, repo_dir],
            );
        }
    }

    Ok(count)
}

pub(crate) fn git_show(repo_dir: &str, path: &str) -> Result<Vec<u8>> {
    let out = Command::new("git")
        .args(["show", &format!("{}:{}", BRANCH, path)])
        .current_dir(repo_dir)
        .output()
        .context("failed to run git show")?;

    if !out.status.success() {
        anyhow::bail!("object not found: {}", path);
    }
    Ok(out.stdout)
}

pub(crate) fn checkpoint_remote_url(repo_dir: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct EntireSettings {
        strategy_options: Option<StrategyOptions>,
    }
    #[derive(Deserialize)]
    struct StrategyOptions {
        checkpoint_remote: Option<CheckpointRemote>,
    }
    #[derive(Deserialize)]
    struct CheckpointRemote {
        repo: String,
    }

    let settings_path = std::path::Path::new(repo_dir).join(".entire").join("settings.json");
    let raw = std::fs::read_to_string(settings_path).ok()?;
    let settings: EntireSettings = serde_json::from_str(&raw).ok()?;
    let cp_repo = settings.strategy_options?.checkpoint_remote?.repo;

    let use_ssh = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(repo_dir)
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|u| u.trim_start().starts_with("git@") || u.trim_start().starts_with("ssh://"))
        .unwrap_or(true);

    let url = if use_ssh {
        format!("git@github.com:{}.git", cp_repo)
    } else {
        format!("https://github.com/{}.git", cp_repo)
    };

    Some(url)
}

#[allow(clippy::type_complexity)]
pub(crate) fn parse_session(
    meta_bytes: &[u8],
    jsonl_bytes: &[u8],
    user: &str,
) -> Result<(String, String, String, String, String, String)> {
    #[derive(Deserialize)]
    struct SessionMetadata {
        session_id: String,
        agent: Option<String>,
        created_at: Option<String>,
        summary: Option<Summary>,
    }
    #[derive(Deserialize)]
    struct Summary {
        intent: Option<String>,
    }

    let meta: SessionMetadata = serde_json::from_slice(meta_bytes)
        .context("failed to parse metadata.json")?;

    let created_at: DateTime<Utc> = meta
        .created_at
        .as_deref()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(Utc::now);

    let session_name = meta
        .summary
        .and_then(|s| s.intent)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("session:{}", &meta.session_id[..8]));

    let agent_name = meta.agent.unwrap_or_else(|| "unknown".to_string());

    let mut latest: Option<DateTime<Utc>> = None;
    let mut cwd = String::new();
    let mut last_prompt: Option<String> = None;

    for line in jsonl_bytes.split(|&b| b == b'\n') {
        if line.is_empty() {
            continue;
        }
        let v: Value = match serde_json::from_slice(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if let Some(ts) = v.get("timestamp").and_then(Value::as_str) {
            if let Ok(dt) = DateTime::parse_from_rfc3339(ts) {
                let dt: DateTime<Utc> = dt.with_timezone(&Utc);
                if latest.map_or(true, |l| dt > l) {
                    latest = Some(dt);
                }
            }
        }

        if cwd.is_empty() {
            if let Some(c) = v.get("cwd").and_then(Value::as_str) {
                cwd = c.to_string();
            }
        }

        if v.get("type").and_then(Value::as_str) == Some("user") {
            if let Some(Value::String(text)) = v.get("message").and_then(|m| m.get("content")) {
                let text = text.trim().to_string();
                if !text.is_empty() {
                    last_prompt = Some(text);
                }
            }
        }
    }

    let updated_at = latest.unwrap_or(created_at);
    let session_name = last_prompt.unwrap_or(session_name);

    Ok((
        meta.session_id,
        agent_name,
        created_at.to_rfc3339(),
        updated_at.to_rfc3339(),
        cwd,
        session_name,
    ))
}

pub(crate) fn upsert_session(
    conn: &rusqlite::Connection,
    session_id: &str,
    agent_name: &str,
    user: &str,
    created_at: &str,
    updated_at: &str,
    cwd: &str,
    session_name: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO sessions (session_id, agent_name, user, created_at, updated_at, cwd, session_name)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(session_id) DO UPDATE SET
           agent_name   = excluded.agent_name,
           updated_at   = excluded.updated_at,
           cwd          = excluded.cwd,
           session_name = excluded.session_name",
        rusqlite::params![session_id, agent_name, user, created_at, updated_at, cwd, session_name],
    )?;
    Ok(())
}
