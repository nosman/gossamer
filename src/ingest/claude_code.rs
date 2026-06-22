use anyhow::Result;
use regex::Regex;
use serde::Deserialize;
use std::collections::HashSet;
use std::process::Command;
use uuid::Uuid;

use witchcraft::DB;

use crate::commands::index::{BRANCH, git_show, is_meta_path};

const MIN_CHUNK_CODEPOINTS: usize = 5;
const MAX_CHUNK_CODEPOINTS: usize = 4000;

const CLAUDE_CODE_NAMESPACE: Uuid = Uuid::from_bytes([
    0xa3, 0xf7, 0xc8, 0xd1, 0x6e, 0x2b, 0x4a, 0x91, 0xb5, 0xd0, 0x8f, 0x1e, 0x3c, 0x7a, 0x9b,
    0x2d,
]);

#[derive(Deserialize)]
struct SessionEntry {
    #[serde(rename = "type")]
    entry_type: String,
    timestamp: Option<String>,
    uuid: Option<String>,
    message: Option<Message>,
    #[serde(rename = "gitBranch")]
    git_branch: Option<String>,
    #[serde(rename = "customTitle")]
    custom_title: Option<String>,
    cwd: Option<String>,
}

#[derive(Deserialize)]
struct Message {
    role: Option<String>,
    content: Option<Content>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Content {
    Text(String),
    Blocks(Vec<ContentBlock>),
}

#[derive(Deserialize)]
struct ContentBlock {
    #[serde(rename = "type")]
    block_type: String,
    #[serde(default)]
    text: Option<String>,
}

struct Chunk {
    role: String,
    text: String,
    timestamp: String,
    msg_uuid: Option<String>,
    ts_ms: i64,
    byte_offset: u64,
    byte_len: u64,
    git_branch: Option<String>,
}

struct SessionInfo {
    custom_title: Option<String>,
    cwd: Option<String>,
}

fn codepoint_len(s: &str) -> usize {
    s.chars().count()
}

fn extract_text(content: &Content) -> Option<String> {
    match content {
        Content::Text(s) => Some(s.clone()),
        Content::Blocks(blocks) => {
            let texts: Vec<&str> = blocks
                .iter()
                .filter(|b| b.block_type == "text")
                .filter_map(|b| b.text.as_deref())
                .collect();
            if texts.is_empty() {
                None
            } else {
                Some(texts.join("\n"))
            }
        }
    }
}

fn sanitize(text: &str) -> String {
    let s = strip_system_content(text);
    let s = strip_code(&s);
    let s = strip_tables(&s);
    compact(&s)
}

fn strip_system_content(text: &str) -> String {
    let mut s = text.to_string();
    let re_open = Regex::new(r"<([a-z][a-z0-9]*(?:[-:][a-z0-9_]+)+)[\s>]").unwrap();
    loop {
        let m = match re_open.find(&s) {
            Some(m) => m,
            None => break,
        };
        let start = m.start();
        let caps = re_open.captures(&s[start..]).unwrap();
        let tag_name = caps.get(1).unwrap().as_str().to_string();
        let close_tag = format!("</{tag_name}>");
        let after_open = match s[start..].find('>') {
            Some(i) => start + i + 1,
            None => break,
        };
        let end = match s[after_open..].find(&close_tag) {
            Some(i) => after_open + i + close_tag.len(),
            None => {
                let line_end = s[start..].find('\n').map(|i| start + i + 1).unwrap_or(s.len());
                s.replace_range(start..line_end, "");
                continue;
            }
        };
        s.replace_range(start..end, "");
    }
    let re = Regex::new(r"\[Request interrupted by user[^\]]*\]").unwrap();
    s = re.replace_all(&s, "").to_string();
    if let Some(idx) = s.find("This session is being continued from a previous conversation") {
        s.truncate(idx);
    }
    s
}

fn strip_code(text: &str) -> String {
    let re = Regex::new(r"```[\s\S]*?```").unwrap();
    let s = re.replace_all(text, " ").to_string();
    let re = Regex::new(r"```[\s\S]*$").unwrap();
    let s = re.replace_all(&s, " ").to_string();
    // Strip the backticks but keep the inner text so words like `index` stay
    // readable in search excerpts rather than turning into blank spaces.
    let re = Regex::new(r"`([^`]*)`").unwrap();
    re.replace_all(&s, "$1").to_string()
}

fn strip_tables(text: &str) -> String {
    text.lines()
        .filter(|line| {
            let t = line.trim();
            !(t.starts_with('|') && t.ends_with('|'))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn compact(text: &str) -> String {
    let re = Regex::new(r"\s{2,}").unwrap();
    re.replace_all(text, " ").trim().to_string()
}

fn parse_session_content(content: &str) -> (SessionInfo, Vec<Chunk>) {
    let mut chunks = Vec::new();
    let mut info = SessionInfo { custom_title: None, cwd: None };
    let mut offset: u64 = 0;

    for line in content.lines() {
        let line_offset = offset;
        offset += line.len() as u64 + 1;

        if line.trim().is_empty() {
            continue;
        }

        let entry: SessionEntry = match serde_json::from_str(line) {
            Ok(e) => e,
            Err(_) => continue,
        };

        if entry.entry_type == "custom-title" {
            if let Some(ref title) = entry.custom_title {
                info.custom_title = Some(title.clone());
            }
            continue;
        }

        if info.cwd.is_none() {
            if let Some(ref cwd) = entry.cwd {
                info.cwd = Some(cwd.clone());
            }
        }

        if entry.entry_type != "user" && entry.entry_type != "assistant" {
            continue;
        }

        let msg = match &entry.message {
            Some(m) => m,
            None => continue,
        };

        let role = match &msg.role {
            Some(r) if r == "user" || r == "assistant" => r.clone(),
            _ => continue,
        };

        let content_field = match &msg.content {
            Some(c) => c,
            None => continue,
        };

        let raw_text = match extract_text(content_field) {
            Some(t) => t,
            None => continue,
        };

        let text = sanitize(&raw_text);
        if text.is_empty() {
            continue;
        }

        // "[Image: source: /path]" is a synthetic label Claude Code emits for
        // image attachments — it's not searchable content and produces spurious
        // vector-search hits. Skip the whole chunk if that's all it is.
        if text.trim_start().starts_with("[Image:") || text.trim_start().starts_with("[image:") {
            continue;
        }

        if !(MIN_CHUNK_CODEPOINTS..=MAX_CHUNK_CODEPOINTS).contains(&codepoint_len(&text)) {
            continue;
        }

        let timestamp = match &entry.timestamp {
            Some(ts) if !ts.is_empty() => ts.clone(),
            _ => continue,
        };

        let ts_ms = chrono::DateTime::parse_from_rfc3339(&timestamp)
            .map(|dt| dt.timestamp_millis())
            .unwrap_or(0);

        if ts_ms <= 0 {
            continue;
        }

        chunks.push(Chunk {
            role,
            text,
            timestamp,
            msg_uuid: entry.uuid,
            ts_ms,
            byte_offset: line_offset,
            byte_len: line.len() as u64,
            git_branch: entry.git_branch,
        });
    }

    chunks.sort_by_key(|c| c.ts_ms);
    (info, chunks)
}

fn ingest_session(
    db: &mut DB,
    session_id: &str,
    content: &str,
    project_name: &str,
) -> Result<(usize, Option<String>)> {
    let (info, chunks) = parse_session_content(content);
    if chunks.is_empty() {
        return Ok((0, info.custom_title));
    }

    let project_name = info
        .cwd
        .as_deref()
        .map(|cwd| cwd.trim_start_matches('/').to_string())
        .unwrap_or_else(|| project_name.to_string());

    let custom_title = info.custom_title.clone();

    let session_title: String = info.custom_title.unwrap_or_else(|| {
        chunks
            .iter()
            .find(|c| c.role == "user")
            .map(|c| c.text.chars().take(240).collect())
            .unwrap_or_default()
    });

    let mut interactions: Vec<&[Chunk]> = Vec::new();
    let mut start = 0;
    for (i, chunk) in chunks.iter().enumerate() {
        if chunk.role == "user" && i > start {
            interactions.push(&chunks[start..i]);
            start = i;
        }
    }
    interactions.push(&chunks[start..]);

    let mut count = 0;
    for (turn_idx, interaction) in interactions.iter().enumerate() {
        let header = format!("[{project_name}] {session_title}\n");
        let mut all_parts = vec![header];
        let mut turns_meta: Vec<serde_json::Value> = Vec::new();

        for chunk in *interaction {
            let label = if chunk.role == "user" { "[User]" } else { "[Claude]" };
            all_parts.push(format!("{label} {}\n", chunk.text));
            turns_meta.push(serde_json::json!({
                "role": chunk.role,
                "timestamp": chunk.timestamp,
                "uuid": chunk.msg_uuid,
                "off": chunk.byte_offset,
                "len": chunk.byte_len,
            }));
        }

        let lengths: Vec<usize> = all_parts.iter().map(|p| p.chars().count()).collect();
        let body = all_parts.join("");

        if body.trim().is_empty() {
            continue;
        }

        let uuid = Uuid::new_v5(
            &CLAUDE_CODE_NAMESPACE,
            format!("{session_id}:{turn_idx}").as_bytes(),
        );

        let branch: Option<&str> = interaction
            .iter()
            .filter_map(|c| c.git_branch.as_deref())
            .last();

        let metadata = serde_json::json!({
            "source": "claude",
            "project": project_name,
            "session_id": session_id,
            "session_name": session_title,
            "turn": turn_idx,
            "turns": turns_meta,
            "branch": branch,
        })
        .to_string();

        let date = iso8601_timestamp::Timestamp::parse(&interaction[0].timestamp);
        db.add_doc(&uuid, date, &metadata, &body, Some(lengths))?;
        count += 1;
    }

    Ok((count, custom_title))
}

/// Ingest sessions from the entire/checkpoints/v1 git branch into the
/// witchcraft search DB. Only processes sessions in tracked repos. Uses a
/// per-repo git commit watermark to skip unchanged content on subsequent runs.
pub fn ingest_claude_code(db: &mut DB) -> Result<usize> {
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
            &CLAUDE_CODE_NAMESPACE,
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
    let mut latest: std::collections::HashMap<String, (u32, String)> = std::collections::HashMap::new();
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
        eprintln!("{jsonl_path}");

        match ingest_session(db, &session_id, &content, "") {
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
