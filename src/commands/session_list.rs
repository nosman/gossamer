//! Shared session-list loading for both `gossamer sessions` (top-level) and
//! `gossamer repo` (drilled in). Both views need the same data: DB rows from
//! `sessions`, augmented with fresher info from any local Claude Code JSONLs
//! in `~/.claude/projects`. The only thing that differs is scope.

use chrono::{DateTime, Utc};
use std::io::BufRead;
use std::path::{Path, PathBuf};

use crate::db;
use crate::entity::repository::Repository;

pub struct DisplaySession {
    pub session_id: String,
    pub session_name: String,
    pub cwd: String,
    pub branch: String,
    pub updated_at: DateTime<Utc>,
    pub agent_name: String,
    pub backed_up: bool,
    /// Display name of whoever initiated the session — taken from the author
    /// of the first checkpoint (lowest checkpoint_number). Empty for sessions
    /// that have never been checkpointed (live JSONL only) or whose author
    /// couldn't be resolved.
    pub author: String,
}

/// Collapse interior whitespace (newlines, tabs, runs of spaces) into a single
/// space. session_name flows into fixed-width raw-mode columns; an interior
/// '\n' jumps the cursor and clobbers the row layout — see git history for
/// the bee0c590 incident. Cheap to do everywhere session_name is produced.
pub fn sanitize_one_line(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut prev_space = false;
    for c in text.chars() {
        if c.is_whitespace() {
            if !prev_space && !out.is_empty() {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(c);
            prev_space = false;
        }
    }
    while out.ends_with(' ') { out.pop(); }
    out
}

pub enum Scope<'a> {
    /// All tracked sessions across every repo.
    All,
    /// Sessions belonging to a single repo. Matched primarily by `repo_id`;
    /// older rows without `repo_id` are caught by `cwd LIKE <directory>%`.
    Repo(&'a Repository),
}

/// Load sessions, optionally scoped to one repo. With `include_old = false`,
/// only sessions updated within the last 3 days are returned. Result is sorted
/// most-recent-first; callers are free to re-sort.
pub fn fetch(scope: Scope, include_old: bool) -> Vec<DisplaySession> {
    let cutoff = Utc::now() - chrono::Duration::days(3);
    let mut sessions = query_db(&scope);
    if !include_old {
        sessions.retain(|s| s.updated_at >= cutoff);
    }
    augment_with_jsonls(&mut sessions, &scope, include_old, cutoff);
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    sessions
}

fn query_db(scope: &Scope) -> Vec<DisplaySession> {
    let Ok(conn) = db::connect() else { return Vec::new(); };
    let mut out: Vec<DisplaySession> = Vec::new();
    let map = |row: &rusqlite::Row<'_>| -> rusqlite::Result<DisplaySession> {
        let ts: String = row.get(4)?;
        let author_name: String = row.get(6)?;
        let author_email: String = row.get(7)?;
        let os_user: String = row.get(8)?;
        let raw_name: String = row.get(1)?;
        Ok(DisplaySession {
            session_id: row.get(0)?,
            session_name: sanitize_one_line(&raw_name),
            cwd: row.get(2)?,
            branch: row.get(3)?,
            updated_at: DateTime::parse_from_rfc3339(&ts)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now()),
            agent_name: row.get(5)?,
            backed_up: true,
            author: resolve_author_label(&author_name, &author_email, &os_user),
        })
    };
    // Pull the author of the FIRST checkpoint (lowest checkpoint_number) for
    // each session — that's whoever initiated the first message. Sessions
    // without checkpoints (shadow-only) get NULLs which COALESCE turns into
    // empty strings, leaving `author` blank.
    let cols = "
        s.session_id, s.session_name, s.cwd, COALESCE(s.branch,''),
        s.updated_at, s.agent_name,
        COALESCE(c.author_name, ''), COALESCE(c.author_email, ''), COALESCE(c.os_user, '')
    ";
    let join = "
        LEFT JOIN checkpoints c
          ON c.session_id = s.session_id
         AND c.checkpoint_number = (
               SELECT MIN(checkpoint_number) FROM checkpoints WHERE session_id = s.session_id
             )
    ";
    match scope {
        Scope::All => {
            let Ok(mut stmt) = conn.prepare(
                &format!("SELECT {cols} FROM sessions s {join} ORDER BY s.updated_at DESC")
            ) else { return out; };
            if let Ok(rows) = stmt.query_map([], map) {
                for r in rows.flatten() { out.push(r); }
            }
        }
        Scope::Repo(r) => {
            let Ok(mut stmt) = conn.prepare(&format!(
                "SELECT {cols} FROM sessions s {join}
                 WHERE s.repo_id = ?1 OR (s.repo_id IS NULL AND s.cwd LIKE ?2)
                 ORDER BY s.updated_at DESC"
            )) else { return out; };
            let pattern = format!("{}%", r.directory);
            if let Ok(rows) = stmt.query_map(rusqlite::params![r.id as i64, pattern], map) {
                for row in rows.flatten() { out.push(row); }
            }
        }
    }
    out
}

fn cwd_os_user(cwd: &str) -> Option<String> {
    let rest = cwd.strip_prefix("/Users/").or_else(|| cwd.strip_prefix("/home/"))?;
    let user = rest.split('/').next()?;
    if user.is_empty() { None } else { Some(user.to_string()) }
}

fn resolve_author_label(name: &str, email: &str, os_user: &str) -> String {
    if !name.trim().is_empty() { return name.to_string(); }
    if !email.trim().is_empty() { return email.to_string(); }
    if !os_user.trim().is_empty() { return os_user.to_string(); }
    String::new()
}

fn augment_with_jsonls(
    sessions: &mut Vec<DisplaySession>,
    scope: &Scope,
    include_old: bool,
    cutoff: DateTime<Utc>,
) {
    let Ok(home) = std::env::var("HOME") else { return; };
    let projects = PathBuf::from(&home).join(".claude/projects");
    let Ok(dirs) = std::fs::read_dir(&projects) else { return; };

    for dir_entry in dirs.flatten() {
        let dir = dir_entry.path();
        if !dir.is_dir() { continue }
        let Ok(files) = std::fs::read_dir(&dir) else { continue };
        for f in files.flatten() {
            let path = f.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") { continue }
            let Some(session_id) = path.file_stem().and_then(|s| s.to_str()).map(str::to_string)
                else { continue };

            let file_mtime = f.metadata().ok()
                .and_then(|m| m.modified().ok())
                .map(DateTime::<Utc>::from)
                .unwrap_or_else(Utc::now);
            if !include_old && file_mtime < cutoff { continue }

            let parsed = parse_jsonl(&path);

            if let Some(existing) = sessions.iter_mut().find(|s| s.session_id == session_id) {
                if !parsed.session_name.is_empty() { existing.session_name = parsed.session_name; }
                if file_mtime > existing.updated_at { existing.updated_at = file_mtime; }
                if !parsed.branch.is_empty() { existing.branch = parsed.branch; }
                continue;
            }

            // Untracked session (only in local JSONL). When scoped to one
            // repo, only include if its cwd actually belongs to that repo.
            if let Scope::Repo(r) = scope {
                if !parsed.cwd.starts_with(r.directory.as_str()) { continue }
            }

            let author = cwd_os_user(&parsed.cwd).unwrap_or_default();
            sessions.push(DisplaySession {
                session_id,
                session_name: parsed.session_name,
                cwd: parsed.cwd,
                branch: parsed.branch,
                updated_at: file_mtime,
                agent_name: "Claude Code".to_string(),
                backed_up: false,
                author,
            });
        }
    }
}

struct ParsedJsonl {
    session_name: String,
    cwd: String,
    branch: String,
}

fn parse_jsonl(path: &Path) -> ParsedJsonl {
    let mut out = ParsedJsonl {
        session_name: String::new(),
        cwd: String::new(),
        branch: String::new(),
    };
    let Ok(file) = std::fs::File::open(path) else { return out; };
    let reader = std::io::BufReader::new(file);
    let mut last_prompt = String::new();

    for line in reader.lines().flatten() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        match v["type"].as_str() {
            Some("custom-title") => {
                if let Some(t) = v["customTitle"].as_str() { out.session_name = t.to_string(); }
            }
            Some("user") | Some("system") => {
                if out.cwd.is_empty() {
                    if let Some(c) = v["cwd"].as_str() { out.cwd = c.to_string(); }
                }
            }
            _ => {}
        }
        if v["type"].as_str() == Some("user") {
            if let Some(t) = user_text(&v["message"]["content"]) {
                last_prompt = t;
            }
        }
        if let Some(b) = v["gitBranch"].as_str() {
            if !b.is_empty() { out.branch = b.to_string(); }
        }
    }
    if out.session_name.is_empty() { out.session_name = last_prompt; }
    out.session_name = sanitize_one_line(&out.session_name);
    out
}

fn user_text(content: &serde_json::Value) -> Option<String> {
    match content {
        serde_json::Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        serde_json::Value::Array(blocks) => {
            blocks.iter().find_map(|b| {
                if b["type"].as_str() == Some("text") {
                    b["text"].as_str().filter(|t| !t.trim().is_empty()).map(|t| t.trim().to_string())
                } else { None }
            })
        }
        _ => None,
    }
}
