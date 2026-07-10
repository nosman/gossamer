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
    /// True when session_name came from an explicit `/rename` (custom-title
    /// entry in the JSONL); false when it's the derived first-prompt fallback.
    /// Drives the italic/plain distinction in the list renderers.
    pub name_is_explicit: bool,
    /// Sum of output tokens generated across all assistant turns. 0 when the
    /// session has never been indexed or has no local JSONL.
    pub tokens_used: i64,
}

/// SGR color for a token count — a graduated sequence using standard 16-color
/// ANSI so the terminal's own palette controls the actual RGB values.
///
/// Dark theme: dim → progressively brighter (more tokens = more visible).
/// Light theme: muted → progressively darker/more saturated.
pub fn token_color(tokens: i64) -> &'static str {
    if crate::theme::get().is_dark {
        match tokens {
            t if t < 5_000   => "90",   // dim gray   — trace usage
            t if t < 20_000  => "37",   // white      — light
            t if t < 100_000 => "33",   // yellow     — moderate
            t if t < 500_000 => "93",   // bright yellow — heavy
            _                => "1;31", // bold red   — very heavy
        }
    } else {
        match tokens {
            t if t < 5_000   => "90",   // light gray — trace usage
            t if t < 20_000  => "36",   // cyan       — light
            t if t < 100_000 => "34",   // blue       — moderate
            t if t < 500_000 => "35",   // magenta    — heavy
            _                => "1;31", // bold red   — very heavy
        }
    }
}

/// Format a token count compactly for display (empty string for zero).
pub fn fmt_tokens(n: i64) -> String {
    if n <= 0 { return String::new(); }
    if n < 1_000 { return format!("{n}"); }
    if n < 10_000 { return format!("{:.1}k", n as f64 / 1_000.0); }
    if n < 1_000_000 { return format!("{}k", n / 1_000); }
    format!("{:.1}M", n as f64 / 1_000_000.0)
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
/// returns the 10 most-recent sessions. Result is sorted most-recent-first;
/// callers are free to re-sort.
pub fn fetch(scope: Scope, include_old: bool) -> Vec<DisplaySession> {
    let mut sessions = query_db(&scope);
    augment_with_jsonls(&mut sessions, &scope);
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    if !include_old {
        sessions.truncate(10);
    }
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
        let name_is_explicit: i64 = row.get(9)?;
        let tokens_used: i64 = row.get(10)?;
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
            name_is_explicit: name_is_explicit != 0,
            tokens_used,
        })
    };
    // Pull the author of the FIRST checkpoint (lowest checkpoint_number) for
    // each session — that's whoever initiated the first message. Sessions
    // without checkpoints (shadow-only) get NULLs which COALESCE turns into
    // empty strings, leaving `author` blank.
    let cols = "
        s.session_id, s.session_name, s.cwd, COALESCE(s.branch,''),
        s.updated_at, s.agent_name,
        COALESCE(c.author_name, ''), COALESCE(c.author_email, ''), COALESCE(c.os_user, ''),
        s.name_is_explicit, COALESCE(s.tokens_used, 0)
    ";
    let join = "
        LEFT JOIN checkpoints c
          ON c.session_id = s.session_id
         AND c.checkpoint_id = (
               SELECT checkpoint_id FROM checkpoints
               WHERE session_id = s.session_id
               ORDER BY last_turn_ts ASC
               LIMIT 1
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

            let parsed = parse_jsonl(&path);

            if let Some(existing) = sessions.iter_mut().find(|s| s.session_id == session_id) {
                if !parsed.session_name.is_empty() { existing.session_name = parsed.session_name; }
                if file_mtime > existing.updated_at { existing.updated_at = file_mtime; }
                if !parsed.branch.is_empty() { existing.branch = parsed.branch; }
                // A custom-title in the JSONL outranks the DB flag. Without
                // this, /rename'd sessions stay tagged as "derived" until the
                // next index run, so they render gray in the lists.
                if parsed.name_is_explicit { existing.name_is_explicit = true; }
                // JSONL token count is authoritative when present (live data).
                if parsed.tokens_used > 0 { existing.tokens_used = parsed.tokens_used; }
                // Sessions inserted by the SessionStart hook but never indexed
                // from a checkpoint branch have no `checkpoints` row, so the
                // author column came back empty. Fall back to the cwd's
                // os-user — same fallback used for brand-new untracked rows.
                if existing.author.is_empty() {
                    let cwd = if !existing.cwd.is_empty() { existing.cwd.as_str() } else { parsed.cwd.as_str() };
                    existing.author = cwd_os_user(cwd).unwrap_or_default();
                }
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
                name_is_explicit: parsed.name_is_explicit,
                tokens_used: parsed.tokens_used,
            });
        }
    }
}

struct ParsedJsonl {
    session_name: String,
    cwd: String,
    branch: String,
    name_is_explicit: bool,
    tokens_used: i64,
}

fn parse_jsonl(path: &Path) -> ParsedJsonl {
    let mut out = ParsedJsonl {
        session_name: String::new(),
        cwd: String::new(),
        branch: String::new(),
        name_is_explicit: false,
        tokens_used: 0,
    };
    let Ok(file) = std::fs::File::open(path) else { return out; };
    let reader = std::io::BufReader::new(file);
    let mut last_prompt = String::new();
    let mut custom_title = String::new();

    for line in reader.lines().flatten() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        match v["type"].as_str() {
            Some("custom-title") => {
                if let Some(t) = v["customTitle"].as_str() {
                    if !t.trim().is_empty() { custom_title = t.to_string(); }
                }
            }
            Some("user") | Some("system") => {
                if out.cwd.is_empty() {
                    if let Some(c) = v["cwd"].as_str() { out.cwd = c.to_string(); }
                }
            }
            Some("assistant") => {
                if let Some(n) = v["message"]["usage"]["output_tokens"].as_i64() {
                    out.tokens_used += n;
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
    if !custom_title.is_empty() {
        out.session_name = custom_title;
        out.name_is_explicit = true;
    } else {
        out.session_name = last_prompt;
    }
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
