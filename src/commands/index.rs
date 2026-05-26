use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::process::Command;

use crate::{db, ingest};

pub(crate) const BRANCH: &str = "entire/checkpoints/v1";

#[derive(Clone)]
pub(crate) struct CommitAuthor {
    pub sha: String,
    pub name: String,
    pub email: String,
}

struct PendingCheckpoint {
    session_id: String,
    checkpoint_number: u32,
    jsonl_path: String,
    last_turn_ts: String,
    os_user: Option<String>,
    direct: Option<CommitAuthor>,
}

/// Extract the OS username from a session's cwd. The JSONL captures the cwd
/// on the machine that ran the conversation, so `/Users/sholodak/...` reliably
/// identifies Scott even when the checkpoint reached us via a merge commit.
pub(crate) fn cwd_to_os_user(cwd: &str) -> Option<String> {
    let rest = cwd.strip_prefix("/Users/")
        .or_else(|| cwd.strip_prefix("/home/"))?;
    let user = rest.split('/').next()?;
    if user.is_empty() { None } else { Some(user.to_string()) }
}

pub fn run(json: bool) -> Result<()> {
    let conn = db::connect()?;

    let mut stmt = conn.prepare("SELECT id, directory, name FROM repositories")?;
    let repos: Vec<(i64, String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<Result<_, _>>()?;

    if repos.is_empty() {
        if json {
            println!("{}", serde_json::json!({"sessions_indexed": 0, "log_turns": 0}));
        } else {
            println!("No repositories tracked. Run `gossamer init` first.");
        }
        return Ok(());
    }

    let mut grand_total = 0usize;

    for (repo_id, dir, name) in &repos {
        match index_repo(&conn, *repo_id, dir, name) {
            Ok(0) => { if !json { println!("'{}': no {} branch found.", name, BRANCH); } }
            Ok(n) => {
                if !json { println!("'{}': indexed {} session(s).", name, n); }
                grand_total += n;
            }
            Err(e) => eprintln!("'{}': error — {}", name, e),
        }
    }

    if !json { println!("\n{} session(s) indexed.", grand_total); }

    if !json { println!("\nIndexing into search DB..."); }
    let mut wc_db = ingest::open_search_db()?;
    let turns    = ingest::claude_code::ingest_claude_code(&mut wc_db)?;
    let sessions = ingest::ingest_sessions(&mut wc_db).unwrap_or(0);
    let repos_n  = ingest::ingest_repos(&mut wc_db).unwrap_or(0);
    if !json { println!("{turns} log turn(s), {sessions} session name(s), {repos_n} repo(s) indexed."); }
    ingest::embed_and_index(&wc_db)?;

    if json {
        println!("{}", serde_json::to_string_pretty(&serde_json::json!({
            "sessions_indexed": grand_total,
            "log_turns": turns,
            "session_names": sessions,
            "repos": repos_n,
        }))?);
    }

    Ok(())
}

pub(crate) fn is_meta_path(l: &str) -> bool {
    l.ends_with("/metadata.json")
        && l.matches('/').count() == 3
        && l.split('/').nth(2).map_or(false, |s| s.chars().all(|c| c.is_ascii_digit()))
}

fn index_repo(conn: &rusqlite::Connection, repo_id: i64, repo_dir: &str, _repo_name: &str) -> Result<usize> {
    fetch_checkpoint_branch(repo_dir);

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

    // Path→author map built from non-merge commits only. Sessions that
    // arrived via "Merge remote session logs" batch imports are not in here —
    // they fall back to cwd-derived attribution below.
    let direct_authors = build_commit_authors(repo_dir).unwrap_or_default();

    // Pass 1: parse every session, register session row, and accumulate
    // checkpoint info. We also learn os_user→author mappings from sessions
    // that have a direct (non-merge) commit, so we can attribute merge-only
    // sessions to the right human in pass 2.
    let mut pending: Vec<PendingCheckpoint> = Vec::new();
    let mut os_user_authors: HashMap<String, CommitAuthor> = HashMap::new();

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

        let parsed = match parse_session(&meta_bytes, &jsonl_bytes, &user) {
            Ok(p) => p,
            Err(e) => { eprintln!("  skipping {}: {}", meta_path, e); continue; }
        };
        let (session_id, agent_name, created_at, updated_at, cwd, session_name, branch) = parsed;

        upsert_session(conn, &session_id, &agent_name, &user,
                       &created_at, &updated_at, &cwd, &session_name,
                       &branch, Some(repo_id))?;

        let checkpoint_number = checkpoint_number_from_path(meta_path).unwrap_or(0);
        let os_user = cwd_to_os_user(&cwd);
        let direct = direct_authors.get(&jsonl_path)
            .or_else(|| direct_authors.get(meta_path))
            .cloned();

        if let (Some(u), Some(a)) = (&os_user, &direct) {
            os_user_authors.entry(u.clone()).or_insert_with(|| a.clone());
        }

        pending.push(PendingCheckpoint {
            session_id,
            checkpoint_number,
            jsonl_path,
            last_turn_ts: updated_at,
            os_user,
            direct,
        });
    }

    let mut count = pending.len();

    // Pass 2: resolve authors and persist. A merge-only session inherits
    // the author we learned from another session sharing its os_user.
    for p in pending {
        let author = p.direct.or_else(|| {
            p.os_user.as_ref().and_then(|u| os_user_authors.get(u).cloned())
        });
        let os_user_str = p.os_user.unwrap_or_default();
        upsert_checkpoint(conn, &p.session_id, p.checkpoint_number,
                          author.as_ref(), &p.last_turn_ts,
                          &p.jsonl_path, repo_dir, &os_user_str)?;
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

    // Then sweep shadow branches for in-progress sessions that haven't been
    // checkpointed yet. These often advance several prompts ahead of the
    // checkpoint branch.
    count += index_shadow_branches(conn, repo_id, repo_dir)?;

    Ok(count)
}

pub(crate) fn git_show(repo_dir: &str, path: &str) -> Result<Vec<u8>> {
    git_show_at(repo_dir, BRANCH, path)
}

pub(crate) fn git_show_at(repo_dir: &str, branch: &str, path: &str) -> Result<Vec<u8>> {
    let out = Command::new("git")
        .args(["show", &format!("{}:{}", branch, path)])
        .current_dir(repo_dir)
        .output()
        .context("failed to run git show")?;

    if !out.status.success() {
        anyhow::bail!("object not found: {}:{}", branch, path);
    }
    Ok(out.stdout)
}

/// Match the in-progress session layout entireio writes to shadow branches:
/// `.entire/metadata/<session-uuid>/full.jsonl`. Returns the session UUID.
pub(crate) fn shadow_session_id(path: &str) -> Option<&str> {
    let rest = path.strip_prefix(".entire/metadata/")?;
    let (uuid, tail) = rest.split_once('/')?;
    if tail != "full.jsonl" {
        return None;
    }
    if uuid.is_empty() || uuid.contains('/') {
        return None;
    }
    Some(uuid)
}

/// List all `entire/*` branches that aren't the canonical checkpoint branch.
/// These are the per-worktree shadow branches entireio commits to on every
/// prompt, so they advance long before the next checkpoint commit lands.
pub(crate) fn list_shadow_branches(repo_dir: &str) -> Vec<String> {
    let out = Command::new("git")
        .args(["for-each-ref", "--format=%(refname:short)", "refs/heads/entire/"])
        .current_dir(repo_dir)
        .output();

    let Ok(out) = out else { return vec![]; };
    if !out.status.success() { return vec![]; }

    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .filter(|b| !b.starts_with("entire/checkpoints/"))
        .map(str::to_string)
        .collect()
}

/// Parse a shadow-branch session purely from its `full.jsonl`. There's no
/// `metadata.json` here, so created_at, session_name, etc. all come from the
/// JSONL itself.
pub(crate) fn parse_shadow_session(
    jsonl_bytes: &[u8],
    session_id: &str,
) -> Result<(String, String, String, String, String, String, String)> {
    let mut earliest: Option<DateTime<Utc>> = None;
    let mut latest: Option<DateTime<Utc>> = None;
    let mut cwd = String::new();
    let mut first_meaningful_prompt: Option<String> = None;
    let mut first_any_prompt: Option<String> = None;
    let mut custom_title: Option<String> = None;
    let mut branch = String::new();

    for line in jsonl_bytes.split(|&b| b == b'\n') {
        if line.is_empty() { continue; }
        let v: Value = match serde_json::from_slice(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if let Some(ts) = v.get("timestamp").and_then(Value::as_str) {
            if let Ok(dt) = DateTime::parse_from_rfc3339(ts) {
                let dt: DateTime<Utc> = dt.with_timezone(&Utc);
                if earliest.map_or(true, |e| dt < e) { earliest = Some(dt); }
                if latest.map_or(true, |l| dt > l)   { latest   = Some(dt); }
            }
        }

        if cwd.is_empty() {
            if let Some(c) = v.get("cwd").and_then(Value::as_str) { cwd = c.to_string(); }
        }

        if let Some(b) = v.get("gitBranch").and_then(Value::as_str) {
            if !b.is_empty() { branch = b.to_string(); }
        }

        match v.get("type").and_then(Value::as_str) {
            Some("custom-title") => {
                if let Some(t) = v.get("customTitle").and_then(Value::as_str) {
                    if !t.trim().is_empty() { custom_title = Some(t.trim().to_string()); }
                }
            }
            Some("user") => {
                if let Some(text) = extract_user_text(&v["message"]["content"]) {
                    if first_any_prompt.is_none() { first_any_prompt = Some(text.clone()); }
                    if first_meaningful_prompt.is_none() && !is_wrapper_prompt(&text) {
                        first_meaningful_prompt = Some(text);
                    }
                }
            }
            _ => {}
        }
    }

    let created_at = earliest.unwrap_or_else(Utc::now);
    let updated_at = latest.unwrap_or(created_at);
    let session_name = custom_title
        .or(first_meaningful_prompt)
        .or(first_any_prompt)
        .unwrap_or_else(|| format!("session:{}", &session_id[..session_id.len().min(8)]));
    let session_name = crate::commands::session_list::sanitize_one_line(&session_name);

    // No reliable agent identifier on the shadow branch — default to Claude Code
    // since that's the primary supported agent. upsert_session preserves any
    // existing non-empty agent_name set by the checkpoint scan or the
    // session-start hook, so this default only sticks for sessions seen
    // exclusively via the shadow path.
    let agent_name = "Claude Code".to_string();

    Ok((
        session_id.to_string(),
        agent_name,
        created_at.to_rfc3339(),
        updated_at.to_rfc3339(),
        cwd,
        session_name,
        branch,
    ))
}

/// Scan every shadow branch in the repo and upsert any sessions found. Shadow
/// branches commit on every prompt, so this picks up in-progress sessions long
/// before they reach `entire/checkpoints/v1`.
pub(crate) fn index_shadow_branches(conn: &rusqlite::Connection, repo_id: i64, repo_dir: &str) -> Result<usize> {
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "unknown".to_string());

    let mut count = 0usize;

    for branch in list_shadow_branches(repo_dir) {
        let ls = Command::new("git")
            .args(["ls-tree", "-r", "--name-only", &branch, "--", ".entire/metadata/"])
            .current_dir(repo_dir)
            .output();
        let Ok(ls) = ls else { continue };
        if !ls.status.success() { continue }
        let listing = String::from_utf8_lossy(&ls.stdout);

        for line in listing.lines() {
            let Some(session_id) = shadow_session_id(line) else { continue };

            let jsonl_bytes = match git_show_at(repo_dir, &branch, line) {
                Ok(b) => b,
                Err(_) => continue,
            };

            match parse_shadow_session(&jsonl_bytes, session_id) {
                Ok((sid, agent_name, created_at, updated_at, cwd, session_name, shadow_branch)) => {
                    upsert_session(conn, &sid, &agent_name, &user,
                                   &created_at, &updated_at, &cwd, &session_name,
                                   &shadow_branch, Some(repo_id))?;
                    count += 1;
                }
                Err(e) => eprintln!("  skipping {}:{} — {}", branch, line, e),
            }
        }
    }

    Ok(count)
}

/// Pull `entire/checkpoints/v1` from wherever it lives. entireio supports two
/// deployment modes:
///   1. Separate checkpoint repo: `.entire/settings.json` has
///      `strategy_options.checkpoint_remote.repo = "<owner>/<repo>"`.
///   2. Same as main repo: entire pushes the checkpoint branch directly to
///      `origin`. This is the default for newer setups (cosmos-agents).
/// Try both — fetches are idempotent and no-op when up to date. We ignore
/// failures so an offline run or a missing remote doesn't abort indexing.
pub(crate) fn fetch_checkpoint_branch(repo_dir: &str) {
    let refspec = format!("{}:{}", BRANCH, BRANCH);
    if let Some(remote_url) = checkpoint_remote_url(repo_dir) {
        let _ = Command::new("git")
            .args(["fetch", &remote_url, &refspec])
            .current_dir(repo_dir)
            .output();
    }
    let _ = Command::new("git")
        .args(["fetch", "origin", &refspec])
        .current_dir(repo_dir)
        .output();
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
) -> Result<(String, String, String, String, String, String, String)> {
    #[derive(Deserialize)]
    struct SessionMetadata {
        session_id: String,
        agent: Option<String>,
        created_at: Option<String>,
        branch: Option<String>,
        summary: Option<Summary>,
    }
    #[derive(Deserialize)]
    struct Summary {
        intent: Option<String>,
    }

    let _ = user; // signature kept for callers; user comes from env at upsert time

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
    let meta_branch = meta.branch.unwrap_or_default();

    let mut latest: Option<DateTime<Utc>> = None;
    let mut cwd = String::new();
    let mut first_meaningful_prompt: Option<String> = None;
    let mut first_any_prompt: Option<String> = None;
    let mut custom_title: Option<String> = None;
    let mut jsonl_branch = String::new();

    for line in jsonl_bytes.split(|&b| b == b'\n') {
        if line.is_empty() { continue; }
        let v: Value = match serde_json::from_slice(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if let Some(ts) = v.get("timestamp").and_then(Value::as_str) {
            if let Ok(dt) = DateTime::parse_from_rfc3339(ts) {
                let dt: DateTime<Utc> = dt.with_timezone(&Utc);
                if latest.map_or(true, |l| dt > l) { latest = Some(dt); }
            }
        }

        if cwd.is_empty() {
            if let Some(c) = v.get("cwd").and_then(Value::as_str) { cwd = c.to_string(); }
        }

        if let Some(b) = v.get("gitBranch").and_then(Value::as_str) {
            if !b.is_empty() { jsonl_branch = b.to_string(); }
        }

        match v.get("type").and_then(Value::as_str) {
            Some("custom-title") => {
                if let Some(t) = v.get("customTitle").and_then(Value::as_str) {
                    if !t.trim().is_empty() { custom_title = Some(t.trim().to_string()); }
                }
            }
            Some("user") => {
                if let Some(text) = extract_user_text(&v["message"]["content"]) {
                    if first_any_prompt.is_none() { first_any_prompt = Some(text.clone()); }
                    if first_meaningful_prompt.is_none() && !is_wrapper_prompt(&text) {
                        first_meaningful_prompt = Some(text);
                    }
                }
            }
            _ => {}
        }
    }

    let updated_at = latest.unwrap_or(created_at);
    // Priority: explicit rename > first meaningful prompt > first prompt of any kind > metadata summary
    let session_name = custom_title
        .or(first_meaningful_prompt)
        .or(first_any_prompt)
        .unwrap_or(session_name);
    let session_name = crate::commands::session_list::sanitize_one_line(&session_name);
    // Prefer the JSONL's last gitBranch (it tracks branch switches mid-session);
    // metadata.json's branch is captured at session start and may be stale.
    let branch = if !jsonl_branch.is_empty() { jsonl_branch } else { meta_branch };

    Ok((
        meta.session_id,
        agent_name,
        created_at.to_rfc3339(),
        updated_at.to_rfc3339(),
        cwd,
        session_name,
        branch,
    ))
}

/// Walk `entire/checkpoints/v1` once and map every added file path to the
/// commit that introduced it. We restrict to commits whose subject begins
/// with "Checkpoint:" — entireio's standard prefix for the direct, single-
/// session commit produced by the local agent. Batch imports such as
/// "Merge remote session logs" carry the importer's identity, not the
/// conversation author's, so we ignore them here and fall back to a
/// cwd-derived attribution for the sessions they bring in.
///
/// Note: `--no-merges` is not sufficient because the checkpoint remote
/// often ships these merge commits without their parents in our local
/// clone, so git treats them as parentless and includes them anyway.
pub(crate) fn build_commit_authors(repo_dir: &str) -> Result<HashMap<String, CommitAuthor>> {
    let out = Command::new("git")
        .args([
            "log",
            "--grep=^Checkpoint: ",
            "--diff-filter=A",
            "--name-only",
            "--format=__COMMIT__%x09%H%x09%an%x09%ae",
            BRANCH,
        ])
        .current_dir(repo_dir)
        .output()
        .context("git log --diff-filter=A failed")?;

    if !out.status.success() {
        return Ok(HashMap::new());
    }

    let text = String::from_utf8(out.stdout)?;
    let mut map: HashMap<String, CommitAuthor> = HashMap::new();
    let mut current: Option<CommitAuthor> = None;

    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("__COMMIT__\t") {
            let mut parts = rest.splitn(3, '\t');
            let sha = parts.next().unwrap_or("").to_string();
            let name = parts.next().unwrap_or("").to_string();
            let email = parts.next().unwrap_or("").to_string();
            current = Some(CommitAuthor { sha, name, email });
            continue;
        }
        if line.is_empty() { continue; }
        if let Some(a) = &current {
            map.entry(line.to_string()).or_insert_with(|| a.clone());
        }
    }

    Ok(map)
}

/// Extract `<num>` from `<prefix>/<sessuuid>/<num>/metadata.json`.
pub(crate) fn checkpoint_number_from_path(meta_path: &str) -> Option<u32> {
    meta_path.split('/').nth(2)?.parse().ok()
}

/// Pull a user message's text out of either the string or block-array shape
/// that Claude Code uses. Trims and returns None for empty content.
fn extract_user_text(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() { None } else { Some(t.to_string()) }
        }
        Value::Array(blocks) => {
            let texts: Vec<&str> = blocks.iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect();
            let joined = texts.join("\n");
            let t = joined.trim();
            if t.is_empty() { None } else { Some(t.to_string()) }
        }
        _ => None,
    }
}

/// Prompts whose first line is just a wrapper tag carry no user intent —
/// they're slash-command metadata, bash output captured by Claude Code, task
/// notifications, etc. Skip these when deciding the session's display name.
fn is_wrapper_prompt(text: &str) -> bool {
    let first_line = text.lines().next().unwrap_or("").trim_start();
    const TAGS: &[&str] = &[
        "<command-message",
        "<command-name",
        "<local-command-caveat",
        "<task-notification",
        "<system-reminder",
        "<bash-input",
        "<bash-stdout",
        "<bash-stderr",
    ];
    TAGS.iter().any(|tag| first_line.starts_with(tag))
}

pub(crate) fn upsert_checkpoint(
    conn: &rusqlite::Connection,
    session_id: &str,
    checkpoint_number: u32,
    author: Option<&CommitAuthor>,
    last_turn_ts: &str,
    jsonl_path: &str,
    repo_dir: &str,
    os_user: &str,
) -> Result<()> {
    let (sha, name, email) = author
        .map(|a| (a.sha.as_str(), a.name.as_str(), a.email.as_str()))
        .unwrap_or(("", "", ""));
    conn.execute(
        "INSERT INTO checkpoints
            (session_id, checkpoint_number, commit_sha, author_name, author_email,
             last_turn_ts, jsonl_path, repo_dir, os_user)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(session_id, checkpoint_number) DO UPDATE SET
            commit_sha   = excluded.commit_sha,
            author_name  = excluded.author_name,
            author_email = excluded.author_email,
            last_turn_ts = excluded.last_turn_ts,
            jsonl_path   = excluded.jsonl_path,
            repo_dir     = excluded.repo_dir,
            os_user      = excluded.os_user",
        rusqlite::params![
            session_id,
            checkpoint_number as i64,
            sha,
            name,
            email,
            last_turn_ts,
            jsonl_path,
            repo_dir,
            os_user,
        ],
    )?;
    Ok(())
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
    branch: &str,
    repo_id: Option<i64>,
) -> Result<()> {
    // agent_name is preserved on update if the existing row already has one —
    // shadow branches don't carry a reliable agent identifier, so we don't want
    // a shadow upsert to clobber an agent_name that the checkpoint scan or the
    // session-start hook already set authoritatively. Same idea for branch
    // and repo_id: a checkpoint pass that doesn't have these shouldn't wipe
    // out values previously written by a more authoritative pass.
    conn.execute(
        "INSERT INTO sessions
            (session_id, agent_name, user, created_at, updated_at, cwd, session_name, branch, repo_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(session_id) DO UPDATE SET
           agent_name   = CASE WHEN COALESCE(sessions.agent_name, '') = ''
                               THEN excluded.agent_name
                               ELSE sessions.agent_name END,
           updated_at   = MAX(sessions.updated_at, excluded.updated_at),
           cwd          = CASE WHEN excluded.cwd != '' THEN excluded.cwd ELSE sessions.cwd END,
           session_name = excluded.session_name,
           branch       = CASE WHEN excluded.branch != '' THEN excluded.branch ELSE sessions.branch END,
           repo_id      = COALESCE(excluded.repo_id, sessions.repo_id)",
        rusqlite::params![
            session_id, agent_name, user, created_at, updated_at,
            cwd, session_name, branch, repo_id
        ],
    )?;
    Ok(())
}
