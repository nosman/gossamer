pub mod claude_code;
pub mod generic;

use anyhow::{Context, Result};
use std::collections::HashMap;
use std::process::Command;
use uuid::Uuid;

use witchcraft::DB;

use crate::commands::index::{BRANCH, git_show, is_meta_path};

const SESSION_NAMESPACE: Uuid = Uuid::from_bytes([
    0xb1, 0x2f, 0xa3, 0x44, 0x7c, 0x8e, 0x4d, 0x91,
    0xaa, 0x2c, 0x5e, 0x1f, 0x4b, 0x8d, 0x9c, 0x3e,
]);

const REPO_NAMESPACE: Uuid = Uuid::from_bytes([
    0xc3, 0x5a, 0xb7, 0x11, 0x9d, 0x2c, 0x4e, 0x88,
    0xbc, 0x3d, 0x6f, 0x2a, 0x5c, 0x9e, 0xad, 0x4f,
]);

// Same byte value as `claude_code::CLAUDE_CODE_NAMESPACE` — deliberately
// duplicated (not imported) so checkpoint-commit-message doc UUIDs, which
// predate the multi-agent split and cover sessions from every agent, stay
// byte-identical across the refactor. `add_doc` upserts by UUID, so changing
// this would silently orphan every previously-indexed commit-message doc.
const CHECKPOINT_NAMESPACE: Uuid = Uuid::from_bytes([
    0xa3, 0xf7, 0xc8, 0xd1, 0x6e, 0x2b, 0x4a, 0x91, 0xb5, 0xd0, 0x8f, 0x1e, 0x3c, 0x7a, 0x9b,
    0x2d,
]);

/// Ingest sessions from the entire/checkpoints/v1 git branch into the
/// witchcraft search DB. Only processes sessions in tracked repos. Uses a
/// per-repo git commit watermark to skip unchanged content on subsequent
/// runs. Dispatches each session to the Claude Code or generic/agnostic
/// chunker based on `metadata.json`'s `agent` field — see
/// `parsers::dispatch_session` for the equivalent dispatch on the DB-metadata
/// side.
pub fn ingest_checkpoint_sessions(db: &mut DB) -> Result<usize> {
    let gossamer_conn = match crate::db::connect() {
        Ok(c) => c,
        Err(_) => return Ok(0),
    };

    let repos: Vec<String> = gossamer_conn
        .prepare("SELECT directory FROM repositories")?
        .query_map([], |row| row.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .collect();

    if repos.is_empty() {
        return Ok(0);
    }

    let mut total = 0usize;

    for repo_dir in &repos {
        match ingest_repo(db, &gossamer_conn, repo_dir) {
            Ok(n) => total += n,
            Err(e) => eprintln!("  warning: failed to ingest repo {repo_dir}: {e}"),
        }
    }

    Ok(total)
}

/// Index commit messages from the `checkpoints` table for all sessions
/// belonging to `repo_dir`. Called unconditionally on every ingest so that
/// commit messages stay current even when the checkpoint-branch HEAD hasn't
/// moved. `add_doc` is an upsert keyed on a stable UUID, so re-running is safe.
fn index_checkpoint_commits(
    db: &mut DB,
    conn: &rusqlite::Connection,
    repo_dir: &str,
) -> Result<()> {
    let mut stmt = conn.prepare(
        "SELECT c.checkpoint_id, c.commit_message, c.last_turn_ts,
                s.session_id, COALESCE(s.session_name,''), COALESCE(s.cwd,'')
         FROM checkpoints c
         JOIN sessions s ON s.session_id = c.session_id
         WHERE (
             s.repo_id = (SELECT id FROM repositories WHERE directory = ?1)
             OR (s.repo_id IS NULL AND s.cwd LIKE ?2)
         )
         AND c.commit_message IS NOT NULL
         AND c.commit_message != ''"
    )?;

    let pattern = format!("{}%", repo_dir);
    let rows: Vec<(String, String, String, String, String, String)> = stmt
        .query_map(rusqlite::params![repo_dir, pattern], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })?
        .filter_map(|r| r.ok())
        .collect();

    for (checkpoint_id, message, ts, session_id, session_name, cwd) in &rows {
        let project_name = if cwd.is_empty() {
            session_id.chars().take(8).collect::<String>()
        } else {
            cwd.trim_start_matches('/').to_string()
        };
        let body = format!("[{project_name}] {session_name}\n[Checkpoint] {message}\n");
        let uuid = Uuid::new_v5(
            &CHECKPOINT_NAMESPACE,
            format!("{session_id}:cp:{checkpoint_id}").as_bytes(),
        );
        let metadata = serde_json::json!({
            "source": "checkpoint",
            "project": project_name,
            "session_id": session_id,
            "session_name": session_name,
            "checkpoint_id": checkpoint_id,
        }).to_string();
        let date = iso8601_timestamp::Timestamp::parse(ts);
        db.add_doc(&uuid, date, &metadata, &body, None)?;
    }
    Ok(())
}

fn ingest_repo(
    db: &mut DB,
    conn: &rusqlite::Connection,
    repo_dir: &str,
) -> Result<usize> {
    let head_out = Command::new("git")
        .args(["rev-parse", BRANCH])
        .current_dir(repo_dir)
        .output()?;

    if !head_out.status.success() {
        return Ok(0);
    }
    let current_head = String::from_utf8_lossy(&head_out.stdout).trim().to_string();

    let stored_head: Option<String> = conn.query_row(
        "SELECT last_search_commit FROM repositories WHERE directory = ?1",
        [repo_dir],
        |row| row.get(0),
    ).ok().flatten();

    // Always refresh commit messages regardless of JSONL watermark state.
    if let Err(e) = index_checkpoint_commits(db, conn, repo_dir) {
        eprintln!("  warning: failed to index checkpoint commits for {repo_dir}: {e}");
    }

    if stored_head.as_deref() == Some(current_head.as_str()) {
        return Ok(0);
    }

    // Find meta paths changed since last search index run
    let meta_paths: Vec<String> = if let Some(ref last) = stored_head {
        let out = Command::new("git")
            .args(["diff", "--name-only", "--diff-filter=AM", last, BRANCH])
            .current_dir(repo_dir)
            .output()?;
        String::from_utf8(out.stdout)?
            .lines()
            .filter(|l| is_meta_path(l))
            .map(str::to_string)
            .collect()
    } else {
        let out = Command::new("git")
            .args(["ls-tree", "-r", "--name-only", BRANCH])
            .current_dir(repo_dir)
            .output()?;
        String::from_utf8(out.stdout)?
            .lines()
            .filter(|l| is_meta_path(l))
            .map(str::to_string)
            .collect()
    };

    // Deduplicate: keep only the latest checkpoint per session (highest num in path)
    // Path: <prefix2>/<id10>/<num>/metadata.json
    let mut latest: HashMap<String, (u32, String)> = HashMap::new();
    for meta_path in &meta_paths {
        let parts: Vec<&str> = meta_path.splitn(4, '/').collect();
        if parts.len() != 4 { continue }
        let checkpoint_key = format!("{}/{}", parts[0], parts[1]);
        let num: u32 = parts[2].parse().unwrap_or(0);
        let entry = latest.entry(checkpoint_key).or_insert((0, meta_path.clone()));
        if num >= entry.0 {
            *entry = (num, meta_path.clone());
        }
    }

    let mut count = 0usize;

    for (_key, (_num, meta_path)) in &latest {
        let jsonl_path = format!(
            "{}full.jsonl",
            &meta_path[..meta_path.len() - "metadata.json".len()]
        );

        let meta_bytes = match git_show(repo_dir, meta_path) {
            Ok(b) => b,
            Err(e) => { eprintln!("  skipping {meta_path}: {e}"); continue }
        };
        let jsonl_bytes = match git_show(repo_dir, &jsonl_path) {
            Ok(b) => b,
            Err(_) => continue,
        };

        let meta: serde_json::Value = match serde_json::from_slice(&meta_bytes) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let session_id = match meta["session_id"].as_str() {
            Some(s) => s.to_string(),
            None => continue,
        };

        let content = String::from_utf8_lossy(&jsonl_bytes);
        let agent = meta["agent"].as_str().unwrap_or("");

        let result = if agent.to_lowercase().contains("claude") || agent.is_empty() {
            claude_code::ingest_session(db, &session_id, &content, "")
        } else {
            generic::ingest_session(db, &session_id, agent, &content, "")
        };

        match result {
            Ok((n, custom_title)) => {
                count += n;
                if let Some(title) = custom_title {
                    let _ = conn.execute(
                        "UPDATE sessions SET session_name = ?1 WHERE session_id = ?2",
                        rusqlite::params![title, session_id.as_str()],
                    );
                }
            }
            Err(e) => eprintln!("  warning: failed to ingest {session_id}: {e}"),
        }
    }

    conn.execute(
        "UPDATE repositories SET last_search_commit = ?1 WHERE directory = ?2",
        rusqlite::params![current_head, repo_dir],
    )?;

    Ok(count)
}

pub fn embed_and_index(wc_db: &witchcraft::DB) -> Result<()> {
    let Some(assets) = crate::config::resolve_warp_assets() else {
        println!("Run `entire gossamer assets <path>` pointing at the witchcraft assets directory to enable semantic search.");
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

/// Scan live JSONL files in ~/.claude/projects/ and backfill session_name for
/// any sessions in the DB whose name is currently blank.
pub fn backfill_session_names() -> Result<usize> {
    let home = std::env::var("HOME").context("HOME not set")?;
    let projects_dir = std::path::PathBuf::from(&home).join(".claude/projects");

    let conn = crate::db::connect()?;

    // Collect session IDs that need a name.
    let mut stmt = conn.prepare(
        "SELECT session_id FROM sessions WHERE session_name = '' OR session_name IS NULL",
    )?;
    let nameless: std::collections::HashSet<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .flatten()
        .collect();

    if nameless.is_empty() {
        return Ok(0);
    }

    let mut updated = 0usize;

    let Ok(project_dirs) = std::fs::read_dir(&projects_dir) else { return Ok(0) };
    for project in project_dirs.flatten() {
        let Ok(files) = std::fs::read_dir(project.path()) else { continue };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") { continue }
            let session_id = match path.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            if !nameless.contains(&session_id) { continue }

            let Ok(f) = std::fs::File::open(&path) else { continue };
            let reader = std::io::BufReader::new(f);
            let mut custom_title: Option<String> = None;
            for line in std::io::BufRead::lines(reader).flatten() {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                    if v["type"].as_str() == Some("custom-title") {
                        if let Some(t) = v["customTitle"].as_str() {
                            custom_title = Some(t.to_string());
                            break;
                        }
                    }
                }
            }
            let Some(title) = custom_title else { continue };
            conn.execute(
                "UPDATE sessions SET session_name = ?1 WHERE session_id = ?2",
                rusqlite::params![title, session_id],
            )?;
            updated += 1;
        }
    }

    Ok(updated)
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
