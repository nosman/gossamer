use anyhow::{Context, Result};
use chrono::{DateTime, Local, Utc};
use crossterm::{
    cursor,
    event::{self, Event, KeyCode, KeyModifiers},
    execute,
    terminal::{self, ClearType, EnterAlternateScreen, LeaveAlternateScreen},
};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::OnceLock;

// ── Data model ────────────────────────────────────────────────────────────────

enum Card {
    RepoLink  { name: String, dir: String, branch: String },
    Header    { title: Option<String>, cwd: String, branch: String, ts: String, agent: String },
    UserMsg   { ts: String, parts: Vec<UserPart>, author: Option<String> },
    AsstMsg   { ts: String, parts: Vec<AsstPart> },
    ToolRound { parts: Vec<AsstPart> },
    System    { ts: String, subtype: String, content: String },
}

/// One entry per checkpoint commit, ordered oldest first. A turn with
/// timestamp T is attributed to the first entry whose `last_turn_ts >= T`.
struct CheckpointAuthor {
    last_turn_ts: DateTime<Utc>,
    label: String, // display name; email as fallback
}

enum UserPart {
    Text(String),
    ToolResult { id: String, name: String, content: String, is_error: bool },
}

enum AsstPart {
    Text(String),
    ToolCall { id: String, name: String, input: Value, result: Option<(String, bool)> },
}

#[derive(Clone, PartialEq)]
enum Selectable {
    Card(usize),
    ToolHeader(usize),
    ToolCall(usize, usize), // (card_idx, tool_idx)
}

// ── Entry point ───────────────────────────────────────────────────────────────

/// Returns `Ok(true)` if the user pressed `q` (or Ctrl+C) — callers in a
/// parent TUI loop should treat that as a full-app exit. `Ok(false)` means
/// the user backed out normally (Esc/Left) and the parent should keep going.
pub fn run(session_id: &str) -> Result<bool> {
    run_at(session_id, None)
}

pub fn run_at(session_id: &str, start_ts: Option<&str>) -> Result<bool> {
    let path = find_session(session_id)
        .with_context(|| format!("no session file found for '{session_id}'"))?;

    let raw = std::fs::read_to_string(&path)
        .with_context(|| format!("cannot read {}", path.display()))?;

    // Look up agent name and DB-stored session_name from the gossamer DB.
    let uuid = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let (agent, db_session_name) = if let Ok(conn) = crate::db::connect() {
        conn.query_row(
            "SELECT agent_name, COALESCE(session_name, '') FROM sessions WHERE session_id = ?1",
            [uuid],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        ).unwrap_or_default()
    } else { (String::new(), String::new()) };

    let mut cards = parse(&raw, &agent);
    if cards.is_empty() {
        println!("No messages found.");
        return Ok(false);
    }

    // Title fallback chain: JSONL custom-title (already set by parse) →
    // DB session_name (the indexer's first-meaningful-prompt) → first user
    // prompt in the JSONL. Covers sessions that were never /rename'd.
    let mut need_prompt_fallback = false;
    if let Some(Card::Header { title, .. }) = cards.iter_mut().find(|c| matches!(c, Card::Header { .. })) {
        if title.as_deref().map_or(true, str::is_empty) {
            if !db_session_name.trim().is_empty() {
                *title = Some(db_session_name);
            } else {
                need_prompt_fallback = true;
            }
        }
    }
    if need_prompt_fallback {
        let first_user_text: Option<String> = cards.iter().find_map(|c| {
            if let Card::UserMsg { parts, .. } = c {
                parts.iter().find_map(|p| {
                    if let UserPart::Text(t) = p {
                        let trimmed = t.trim();
                        if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
                    } else { None }
                })
            } else { None }
        });
        if let Some(text) = first_user_text {
            if let Some(Card::Header { title, .. }) = cards.iter_mut().find(|c| matches!(c, Card::Header { .. })) {
                *title = Some(text);
            }
        }
    }

    // Attribute each user message to the author of the checkpoint commit that
    // first captured it. Falls back to a plain "user" label when the session
    // has no checkpoint rows (shadow-branch-only sessions).
    let authors = fetch_authors(uuid);
    if !authors.is_empty() {
        for card in cards.iter_mut() {
            if let Card::UserMsg { ts, author, .. } = card {
                *author = attribute(&authors, ts);
            }
        }
    }

    // Extract branch and cwd from the Header before cards are consumed by pager.
    let session_branch = cards.iter().find_map(|c| {
        if let Card::Header { branch, .. } = c { Some(branch.clone()) } else { None }
    }).unwrap_or_default();
    let session_cwd = cards.iter().find_map(|c| {
        if let Card::Header { cwd, .. } = c { Some(cwd.clone()) } else { None }
    }).unwrap_or_default();

    // Look up the repo that owns this session's cwd and prepend a RepoLink card.
    if let Ok(conn) = crate::db::connect() {
        if let Ok((repo_name, repo_dir)) = conn.query_row(
            "SELECT name, directory FROM repositories
             WHERE ?1 LIKE (directory || '%')
             ORDER BY LENGTH(directory) DESC LIMIT 1",
            [&session_cwd],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        ) {
            cards.insert(0, Card::RepoLink { name: repo_name, dir: repo_dir, branch: session_branch.clone() });
        }
    }

    let mut quit_app = false;
    loop {
        match pager(&cards, start_ts)? {
            PagerOutcome::Resume => {
                do_resume(&agent, session_id, &session_branch, &session_cwd);
                break;
            }
            PagerOutcome::Delete => { super::clean::run(session_id, false)?; break; }
            PagerOutcome::Quit   => { quit_app = true; break; }
            PagerOutcome::Back   => break,
            PagerOutcome::GoToSessions => {
                if super::sessions::run(false, false)? { quit_app = true; }
                break;
            }
            PagerOutcome::GoToRepo(dir) => {
                if super::status::run_for_dir(&dir)? { quit_app = true; break; }
            }
        }
    }

    Ok(quit_app)
}

fn fetch_authors(session_id: &str) -> Vec<CheckpointAuthor> {
    let Ok(conn) = crate::db::connect() else { return Vec::new(); };
    let Ok(mut stmt) = conn.prepare(
        "SELECT last_turn_ts, author_name, author_email, COALESCE(os_user, '')
           FROM checkpoints
          WHERE session_id = ?1
       ORDER BY checkpoint_number ASC"
    ) else { return Vec::new(); };

    let rows = stmt.query_map([session_id], |row| {
        let ts: String = row.get(0)?;
        let name: String = row.get(1)?;
        let email: String = row.get(2)?;
        let os_user: String = row.get(3)?;
        Ok((ts, name, email, os_user))
    });
    let Ok(rows) = rows else { return Vec::new(); };

    let mut out = Vec::new();
    for r in rows.flatten() {
        let (ts_s, name, email, os_user) = r;
        let Ok(dt) = DateTime::parse_from_rfc3339(&ts_s) else { continue };
        let label = if !name.trim().is_empty() {
            name
        } else if !email.trim().is_empty() {
            email
        } else {
            os_user
        };
        if label.is_empty() { continue; }
        out.push(CheckpointAuthor {
            last_turn_ts: dt.with_timezone(&Utc),
            label,
        });
    }
    out
}

fn attribute(authors: &[CheckpointAuthor], ts: &str) -> Option<String> {
    let dt = DateTime::parse_from_rfc3339(ts).ok()?.with_timezone(&Utc);
    // Earliest checkpoint whose last_turn_ts >= the card's timestamp.
    for a in authors {
        if a.last_turn_ts >= dt {
            return Some(a.label.clone());
        }
    }
    // Card's timestamp is past every checkpoint we've seen — attribute to
    // the most recent author (latest checkpoint).
    authors.last().map(|a| a.label.clone())
}

fn find_session(id: &str) -> Option<PathBuf> {
    let p = PathBuf::from(id);
    if p.exists() { return Some(p); }
    if let Ok(home) = std::env::var("HOME") {
        let projects = PathBuf::from(&home).join(".claude/projects");
        if let Ok(entries) = std::fs::read_dir(&projects) {
            for entry in entries.flatten() {
                let candidate = entry.path().join(format!("{id}.jsonl"));
                if candidate.exists() { return Some(candidate); }
            }
        }
    }
    // Fall back to extracting the latest checkpoint's full.jsonl from the
    // entire/checkpoints/v1 branch. Used when this session was authored on
    // another machine and never produced a local Claude Code log.
    extract_from_checkpoint(id)
}

fn extract_from_checkpoint(session_id: &str) -> Option<PathBuf> {
    let conn = crate::db::connect().ok()?;
    let jsonl_path: String = conn.query_row(
        "SELECT jsonl_path FROM checkpoints
         WHERE session_id = ?1
           AND jsonl_path IS NOT NULL
         ORDER BY checkpoint_number DESC
         LIMIT 1",
        [session_id],
        |row| row.get(0),
    ).ok()?;

    // The stored `repo_dir` is whichever repo's index pass last wrote this
    // checkpoint row — sometimes stale (the file may since have been removed
    // from that repo's branch, or the same file lives in multiple repos'
    // shared checkpoint branch). Try the recorded repo_dir first, then fall
    // back to every other tracked repo. Whichever clone actually has the path
    // in its checkpoint branch wins.
    let preferred: Option<String> = conn.query_row(
        "SELECT repo_dir FROM checkpoints
         WHERE session_id = ?1 AND repo_dir IS NOT NULL
         ORDER BY checkpoint_number DESC LIMIT 1",
        [session_id], |row| row.get(0),
    ).ok();

    let mut candidates: Vec<String> = Vec::new();
    if let Some(p) = preferred { candidates.push(p); }
    if let Ok(mut stmt) = conn.prepare("SELECT directory FROM repositories") {
        if let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) {
            for r in rows.flatten() {
                if !candidates.contains(&r) { candidates.push(r); }
            }
        }
    }

    let bytes = candidates.iter()
        .find_map(|dir| crate::commands::index::git_show(dir, &jsonl_path).ok())?;

    let home = std::env::var("HOME").ok()?;
    let cache_dir = PathBuf::from(&home).join(".gossamer").join("sessions");
    std::fs::create_dir_all(&cache_dir).ok()?;
    let cache_path = cache_dir.join(format!("{session_id}.jsonl"));
    std::fs::write(&cache_path, &bytes).ok()?;
    Some(cache_path)
}

// ── Parsing ───────────────────────────────────────────────────────────────────

fn parse(raw: &str, agent: &str) -> Vec<Card> {
    let mut tool_names: HashMap<String, String> = HashMap::new();
    for line in raw.lines() {
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            if let Some(blocks) = v["message"]["content"].as_array() {
                for b in blocks {
                    if b["type"].as_str() == Some("tool_use") {
                        if let (Some(id), Some(name)) = (b["id"].as_str(), b["name"].as_str()) {
                            tool_names.insert(id.to_string(), name.to_string());
                        }
                    }
                }
            }
        }
    }

    let mut cards: Vec<Card> = Vec::new();
    let mut first_cwd    = String::new();
    let mut first_branch = String::new();
    let mut first_ts     = String::new();
    let mut title: Option<String> = None;

    for line in raw.lines() {
        if line.trim().is_empty() { continue; }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let ts = v["timestamp"].as_str().unwrap_or("").to_string();
        if first_ts.is_empty() && !ts.is_empty() { first_ts = ts.clone(); }

        match v["type"].as_str() {
            Some("custom-title") => {
                title = v["customTitle"].as_str().map(str::to_string);
            }
            Some("system") => {
                if let Some(c) = v["cwd"].as_str() { if first_cwd.is_empty() { first_cwd = c.to_string(); } }
                let content = v["content"].as_str().unwrap_or("").to_string();
                if !content.is_empty() {
                    let subtype = v["subtype"].as_str().unwrap_or("system").replace('_', " ");
                    cards.push(Card::System { ts, subtype, content });
                }
            }
            Some("user") => {
                if let Some(c) = v["cwd"].as_str()       { if first_cwd.is_empty()    { first_cwd    = c.to_string(); } }
                if let Some(b) = v["gitBranch"].as_str() { if first_branch.is_empty() { first_branch = b.to_string(); } }
                let parts = parse_user(&v["message"]["content"], &tool_names);
                if !parts.is_empty() { cards.push(Card::UserMsg { ts, parts, author: None }); }
            }
            Some("assistant") => {
                let parts = parse_asst(&v["message"]["content"]);
                if !parts.is_empty() { cards.push(Card::AsstMsg { ts, parts }); }
            }
            _ => {}
        }
    }

    let mut result = vec![Card::Header { title, cwd: first_cwd, branch: first_branch, ts: first_ts, agent: agent.to_string() }];
    result.extend(cards);

    // Merge each pure tool-result UserMsg into the preceding AsstMsg.
    let mut i = 1;
    while i < result.len() {
        let is_pure_results = if let Card::UserMsg { parts, .. } = &result[i] {
            parts.iter().all(|p| matches!(p, UserPart::ToolResult { .. }))
        } else { false };

        if is_pure_results && matches!(&result[i - 1], Card::AsstMsg { .. }) {
            let tool_results: Vec<(String, String, bool)> =
                if let Card::UserMsg { parts, .. } = &result[i] {
                    parts.iter().filter_map(|p| {
                        if let UserPart::ToolResult { id, content, is_error, .. } = p {
                            Some((id.clone(), content.clone(), *is_error))
                        } else { None }
                    }).collect()
                } else { vec![] };

            if let Card::AsstMsg { parts: asst_parts, .. } = &mut result[i - 1] {
                for part in asst_parts.iter_mut() {
                    if let AsstPart::ToolCall { id, result: res, .. } = part {
                        if let Some((_, content, is_error)) =
                            tool_results.iter().find(|(rid, _, _)| rid == id)
                        {
                            *res = Some((content.clone(), *is_error));
                        }
                    }
                }
            }
            result.remove(i);
        } else {
            i += 1;
        }
    }

    // Merge consecutive AsstMsg cards so the assistant name appears only once per run.
    let mut i = 1;
    while i < result.len() {
        if matches!(&result[i - 1], Card::AsstMsg { .. }) && matches!(&result[i], Card::AsstMsg { .. }) {
            if let Card::AsstMsg { parts: new_parts, .. } = result.remove(i) {
                if let Card::AsstMsg { parts, .. } = &mut result[i - 1] {
                    parts.extend(new_parts);
                }
            }
        } else {
            i += 1;
        }
    }

    // Split each AsstMsg into a text-only AsstMsg (if any text) + a ToolRound (if any tools).
    let mut split: Vec<Card> = Vec::with_capacity(result.len());
    for card in result {
        match card {
            Card::AsstMsg { ts, parts } => {
                let (text_parts, tool_parts): (Vec<AsstPart>, Vec<AsstPart>) =
                    parts.into_iter().partition(|p| matches!(p, AsstPart::Text(_)));
                if !text_parts.is_empty() { split.push(Card::AsstMsg  { ts, parts: text_parts }); }
                if !tool_parts.is_empty() { split.push(Card::ToolRound { parts: tool_parts }); }
            }
            other => split.push(other),
        }
    }
    let mut result = split;

    // Merge adjacent ToolRound cards (can arise when consecutive asst turns were all-tools).
    let mut i = 1;
    while i < result.len() {
        if matches!(&result[i - 1], Card::ToolRound { .. }) && matches!(&result[i], Card::ToolRound { .. }) {
            if let Card::ToolRound { parts: new_parts } = result.remove(i) {
                if let Card::ToolRound { parts } = &mut result[i - 1] {
                    parts.extend(new_parts);
                }
            }
        } else {
            i += 1;
        }
    }

    result
}

fn parse_user(content: &Value, tool_names: &HashMap<String, String>) -> Vec<UserPart> {
    let mut out = Vec::new();
    match content {
        Value::String(s) if !s.trim().is_empty() => out.push(UserPart::Text(s.clone())),
        Value::Array(blocks) => {
            for b in blocks {
                match b["type"].as_str() {
                    Some("text") => {
                        if let Some(t) = b["text"].as_str() {
                            if !t.trim().is_empty() { out.push(UserPart::Text(t.to_string())); }
                        }
                    }
                    Some("tool_result") => {
                        let id = b["tool_use_id"].as_str().unwrap_or("").to_string();
                        let name = tool_names.get(&id).cloned().unwrap_or_else(|| "tool".to_string());
                        let is_error = b["is_error"].as_bool().unwrap_or(false);
                        let content = match &b["content"] {
                            Value::String(s) => s.clone(),
                            Value::Array(arr) => arr.iter()
                                .filter(|x| x["type"].as_str() == Some("text"))
                                .filter_map(|x| x["text"].as_str())
                                .collect::<Vec<_>>().join("\n"),
                            _ => String::new(),
                        };
                        out.push(UserPart::ToolResult { id, name, content, is_error });
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    out
}

fn parse_asst(content: &Value) -> Vec<AsstPart> {
    let mut out = Vec::new();
    match content {
        Value::String(s) if !s.trim().is_empty() => out.push(AsstPart::Text(s.clone())),
        Value::Array(blocks) => {
            for b in blocks {
                match b["type"].as_str() {
                    Some("text") => {
                        if let Some(t) = b["text"].as_str() {
                            if !t.trim().is_empty() { out.push(AsstPart::Text(t.to_string())); }
                        }
                    }
                    Some("tool_use") => {
                        out.push(AsstPart::ToolCall {
                            id:     b["id"].as_str().unwrap_or("").to_string(),
                            name:   b["name"].as_str().unwrap_or("unknown").to_string(),
                            input:  b["input"].clone(),
                            result: None,
                        });
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    out
}

// ── Text extraction (for clipboard) ──────────────────────────────────────────

fn card_text(card: &Card) -> String {
    let mut out = String::new();
    match card {
        Card::RepoLink { name, dir, branch } => {
            out.push_str(name); out.push('\n');
            out.push_str(dir);  out.push('\n');
            if !branch.is_empty() { out.push_str(branch); out.push('\n'); }
        }
        Card::Header { title, cwd, branch, agent, .. } => {
            if let Some(t) = title { out.push_str(t); out.push('\n'); }
            if !cwd.is_empty()    { out.push_str(cwd);               out.push('\n'); }
            if !branch.is_empty() { out.push_str(&format!("[{branch}]")); out.push('\n'); }
            if !agent.is_empty()  { out.push_str(agent); out.push('\n'); }
        }
        Card::System { content, .. } => { if !content.is_empty() { out.push_str(content); out.push('\n'); } }
        Card::UserMsg { parts, .. } => {
            for part in parts {
                match part {
                    UserPart::Text(t) => { out.push_str(t); out.push('\n'); }
                    UserPart::ToolResult { name, content, .. } => {
                        out.push_str(&format!("[Result: {name}]\n{content}\n"));
                    }
                }
            }
        }
        Card::AsstMsg { parts, .. } => {
            for part in parts {
                if let AsstPart::Text(t) = part { out.push_str(t); out.push('\n'); }
            }
        }
        Card::ToolRound { parts } => {
            for part in parts {
                if let AsstPart::ToolCall { name, input, result, .. } = part {
                    out.push_str(&format!("[Tool: {name}]\n"));
                    if let Some(obj) = input.as_object() {
                        for (k, v) in obj {
                            let val = if let Value::String(s) = v { s.clone() } else { v.to_string() };
                            out.push_str(&format!("{k}: {val}\n"));
                        }
                    }
                    if let Some((content, _)) = result {
                        out.push_str(&format!("[Result]\n{content}\n"));
                    }
                }
            }
        }
    }
    out
}

fn tool_call_text(part: &AsstPart) -> String {
    let mut out = String::new();
    if let AsstPart::ToolCall { name, input, result, .. } = part {
        out.push_str(&format!("[Tool: {name}]\n"));
        if let Some(obj) = input.as_object() {
            for (k, v) in obj {
                let val = if let Value::String(s) = v { s.clone() } else { v.to_string() };
                out.push_str(&format!("{k}: {val}\n"));
            }
        }
        if let Some((content, _)) = result { out.push_str(&format!("[Result]\n{content}\n")); }
    }
    out
}

fn copy_to_clipboard(text: &str) {
    use std::io::Write as _;
    use std::process::{Command, Stdio};
    if let Ok(mut child) = Command::new("pbcopy").stdin(Stdio::piped()).spawn() {
        if let Some(stdin) = child.stdin.take() {
            let mut stdin = stdin;
            let _ = stdin.write_all(text.as_bytes());
        }
        let _ = child.wait();
    }
}

// ── Markdown rendering ────────────────────────────────────────────────────────

static MD_SKIN: OnceLock<termimad::MadSkin> = OnceLock::new();

fn md_skin() -> &'static termimad::MadSkin {
    MD_SKIN.get_or_init(|| {
        use crossterm::style::Attribute;
        let t = crate::theme::get();
        let mut skin = termimad::MadSkin::default();
        skin.bold.set_fg(t.md_bold);
        skin.bold.add_attr(Attribute::Bold);
        skin.italic.set_fg(t.md_italic);
        skin.italic.add_attr(Attribute::Italic);
        skin.inline_code.set_fg(t.md_code);
        skin.inline_code.object_style.background_color = None;
        skin.code_block.compound_style.set_fg(t.md_code);
        skin.code_block.compound_style.object_style.background_color = None;
        skin.paragraph.compound_style.set_fg(t.md_text);
        skin.headers[0].compound_style.set_fg(t.md_h1);
        skin.headers[0].compound_style.add_attr(Attribute::Bold);
        skin.headers[1].compound_style.set_fg(t.md_h2);
        skin.headers[1].compound_style.add_attr(Attribute::Bold);
        skin.headers[2].compound_style.set_fg(t.md_h3);
        skin.headers[2].compound_style.add_attr(Attribute::Bold);
        skin.bullet.set_fg(t.md_text);
        skin
    })
}

fn render_md(text: &str, width: usize) -> Vec<String> {
    let rendered = format!("{}", md_skin().text(text, Some(width)));
    // termimad appends a trailing newline; drop it to avoid spurious blank lines
    let trimmed = rendered.trim_end_matches('\n');
    trimmed.lines().map(str::to_string).collect()
}

// ── Rendering ─────────────────────────────────────────────────────────────────

use super::agent_color;

fn render_card(card: &Card, width: usize, agent: &str) -> Vec<String> {
    let th = crate::theme::get();
    let mut lines: Vec<String> = Vec::new();
    let w = width.saturating_sub(2);

    match card {
        Card::RepoLink { name, dir, branch } => {
            let home = std::env::var("HOME").unwrap_or_default();
            let short = if !home.is_empty() && dir.starts_with(&home) {
                format!("~{}", &dir[home.len()..])
            } else { dir.clone() };
            let branch_part = if !branch.is_empty() {
                format!("  \x1b[{lb}m[{branch}]\x1b[0m", lb = th.label)
            } else { String::new() };
            lines.push(format!(
                "\x1b[{dm}m▸ repo  \x1b[0m\x1b[1;{lk}m{name}\x1b[0m  \x1b[{dm}m{short}\x1b[0m{branch_part}",
                dm = th.text_dim, lk = th.link,
            ));
        }
        Card::Header { title, cwd: _, branch: _, ts, agent: hdr_agent } => {
            let title_str = title.as_deref().unwrap_or("(untitled session)");
            let (agent_label, agent_col) = if hdr_agent.is_empty() {
                ("claude".to_string(), 75u8)
            } else {
                (hdr_agent.to_lowercase(), agent_color(hdr_agent))
            };
            let agent_part = format!("  \x1b[1;38;5;{agent_col}m{agent_label}\x1b[0m");
            let ts_part = if !ts.is_empty() {
                format!("  \x1b[{dm}m{}\x1b[0m", rel_time(ts), dm = th.text_dim)
            } else { String::new() };
            lines.push(format!("\x1b[{hd}m{title_str}\x1b[0m{agent_part}{ts_part}", hd = th.header));
        }
        Card::System { ts, subtype, content } => {
            lines.push(format!("\x1b[{dm}m── {subtype}  {}\x1b[0m", rel_time(ts), dm = th.text_dim));
            lines.push(String::new());
            for l in wrap(content, w) { lines.push(format!("  \x1b[{dm}m{l}\x1b[0m", dm = th.text_dim)); }
        }
        Card::UserMsg { ts, parts, author } => {
            let label = author.as_deref().unwrap_or("user");
            lines.push(format!(
                "\x1b[1;{fr}m── {label}  \x1b[0m\x1b[{dm}m{}\x1b[0m",
                rel_time(ts), fr = th.fresh, dm = th.text_dim,
            ));
            for part in parts {
                match part {
                    UserPart::Text(text) => {
                        lines.push(String::new());
                        for l in render_md(text, w.saturating_sub(2)) { lines.push(format!("  {l}")); }
                    }
                    UserPart::ToolResult { name, content, is_error, .. } => {
                        let col = if *is_error { th.error } else { th.tool_ok };
                        lines.push(format!("\x1b[{col}m  ◀ {name}\x1b[0m"));
                        let visible: Vec<&str> = content.lines()
                            .filter(|l| !l.trim().is_empty()).take(8).collect();
                        for l in wrap(&visible.join("\n"), w.saturating_sub(4)) {
                            lines.push(format!("\x1b[{dm}m    {l}\x1b[0m", dm = th.text_dim));
                        }
                        let total = content.lines().filter(|l| !l.trim().is_empty()).count();
                        if total > 8 {
                            lines.push(format!("\x1b[{ft}m    … {} more lines\x1b[0m", total - 8, ft = th.text_faint));
                        }
                    }
                }
            }
        }
        Card::AsstMsg { ts, parts } => {
            let (agent_label, agent_col) = if agent.is_empty() {
                ("claude".to_string(), 75u8)
            } else {
                (agent.to_lowercase(), agent_color(agent))
            };
            lines.push(format!(
                "\x1b[1;38;5;{agent_col}m── {agent_label}  \x1b[0m\x1b[{dm}m{}\x1b[0m",
                rel_time(ts), dm = th.text_dim,
            ));
            for part in parts {
                if let AsstPart::Text(text) = part {
                    lines.push(String::new());
                    for l in render_md(text, w.saturating_sub(2)) { lines.push(format!("  {l}")); }
                }
            }
        }
        Card::ToolRound { .. } => {} // handled in build_flat
    }

    lines.push(String::new());
    lines
}

fn render_tool_summary(parts: &[AsstPart]) -> Vec<String> {
    let t = crate::theme::get();
    let count = parts.len();
    let mut seen = std::collections::HashSet::new();
    let unique: Vec<&str> = parts.iter().filter_map(|p| {
        if let AsstPart::ToolCall { name, .. } = p {
            if seen.insert(name.as_str()) { Some(name.as_str()) } else { None }
        } else { None }
    }).collect();
    vec![
        format!("\x1b[{dm}m  ▶ ({count} tool call{}: {})\x1b[0m",
            if count == 1 { "" } else { "s" }, unique.join(", "), dm = t.text_dim),
        String::new(),
    ]
}

fn render_tool_header(parts: &[AsstPart]) -> Vec<String> {
    let t = crate::theme::get();
    let count = parts.len();
    let mut seen = std::collections::HashSet::new();
    let unique: Vec<&str> = parts.iter().filter_map(|p| {
        if let AsstPart::ToolCall { name, .. } = p {
            if seen.insert(name.as_str()) { Some(name.as_str()) } else { None }
        } else { None }
    }).collect();
    vec![format!("\x1b[{dm}m  ▾ ({count} tool call{}: {})\x1b[0m",
        if count == 1 { "" } else { "s" }, unique.join(", "), dm = t.text_dim)]
}

fn render_one_tool_call(part: &AsstPart, w: usize) -> Vec<String> {
    let t = crate::theme::get();
    let mut lines = Vec::new();
    if let AsstPart::ToolCall { name, input, result, .. } = part {
        lines.push(format!("\x1b[{lb}m  ▶ {name}\x1b[0m", lb = t.label));
        if let Some(obj) = input.as_object() {
            let mut is_first = true;
            for (_, v) in obj.iter().take(4) {
                let raw_val = if let Value::String(s) = v { s.clone() } else { v.to_string() };
                let first_line = raw_val.lines().next().unwrap_or("");
                let preview: String = first_line.chars().take(120).collect();
                let suffix = if raw_val.lines().count() > 1 || first_line.chars().count() > 120 { " …" } else { "" };
                let col = if is_first { t.text_primary } else { t.text_secondary };
                lines.push(format!("\x1b[{col}m    {preview}{suffix}\x1b[0m"));
                is_first = false;
            }
            if obj.len() > 4 {
                lines.push(format!("\x1b[{ft}m    … {} more fields\x1b[0m", obj.len() - 4, ft = t.text_faint));
            }
        }
        if let Some((content, is_error)) = result {
            lines.push(format!("\x1b[{ft}m  ────────────────────────────────────────\x1b[0m", ft = t.text_faint));
            let col = if *is_error { t.error } else { t.text_dim };
            let visible: Vec<&str> = content.lines()
                .filter(|l| !l.trim().is_empty()).take(8).collect();
            for l in wrap(&visible.join("\n"), w.saturating_sub(4)) {
                lines.push(format!("\x1b[{col}m    {l}\x1b[0m"));
            }
            let total = content.lines().filter(|l| !l.trim().is_empty()).count();
            if total > 8 {
                lines.push(format!("\x1b[{ft}m    … {} more lines\x1b[0m", total - 8, ft = t.text_faint));
            }
        }
        lines.push(String::new());
    }
    lines
}

// Visible character width, skipping ANSI escape sequences.
fn visible_width(s: &str) -> usize {
    let mut w = 0usize;
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            // consume up to and including the final byte of the CSI sequence
            for nc in chars.by_ref() {
                if nc.is_ascii_alphabetic() { break; }
            }
        } else {
            w += 1;
        }
    }
    w
}

// Apply a selection background to a pre-colored ANSI string.
// Parses SGR sequences properly so that any explicit background color emitted
// by termimad (e.g. `\x1b[48;5;238m` for inline code) is replaced with the
// selection background rather than overriding it.
fn with_bg(s: &str, bg: &str) -> String {
    let bg_seq  = format!("\x1b[{bg}m");
    let mut out = bg_seq.clone();
    let bytes   = s.as_bytes();
    let mut i   = 0;

    while i < bytes.len() {
        if bytes[i] == b'\x1b' && bytes.get(i + 1) == Some(&b'[') {
            // Parse CSI sequence: ESC [ <params> <cmd>
            let esc_start   = i;
            i += 2;
            let params_start = i;
            while i < bytes.len() && !bytes[i].is_ascii_alphabetic() { i += 1; }
            let cmd    = *bytes.get(i).unwrap_or(&b'm');
            let params = &s[params_start..i];
            i += 1;

            if cmd == b'm' {
                out.push_str(&rewrite_sgr(params, &bg_seq));
            } else {
                out.push_str(&s[esc_start..i]);
            }
        } else {
            let ch_len = s[i..].chars().next().map_or(1, |c| c.len_utf8());
            out.push_str(&s[i..i + ch_len]);
            i += ch_len;
        }
    }

    out
}

// Rewrite a single SGR parameter string so that any background colour is
// replaced with the selection background. Foreground / attribute codes are
// kept; a pure reset gets the background re-appended.
fn rewrite_sgr(params: &str, bg_seq: &str) -> String {
    if params.is_empty() || params == "0" {
        return format!("\x1b[0m{bg_seq}");
    }

    let mut non_bg: Vec<&str> = Vec::new();
    let mut found_bg = false;
    let mut segs = params.split(';').peekable();

    while let Some(seg) = segs.next() {
        match seg {
            // Standard background colours 40-47 and bright 100-107
            "40"|"41"|"42"|"43"|"44"|"45"|"46"|"47"
            |"100"|"101"|"102"|"103"|"104"|"105"|"106"|"107" => {
                found_bg = true;
            }
            // 256-colour or true-colour background: 48;5;N or 48;2;R;G;B
            "48" => {
                found_bg = true;
                match segs.next().as_deref() {
                    Some("5") => { segs.next(); }          // skip N
                    Some("2") => { segs.next(); segs.next(); segs.next(); } // skip R;G;B
                    _ => {}
                }
            }
            // \x1b[49m — reset background to default (termimad uses this, not \x1b[0m)
            "49" => { found_bg = true; }
            // Reset within a combined sequence — keep it
            "0" => non_bg.push("0"),
            other => non_bg.push(other),
        }
    }

    if !found_bg {
        return format!("\x1b[{params}m");
    }

    let mut result = String::new();
    if !non_bg.is_empty() {
        result.push_str(&format!("\x1b[{}m", non_bg.join(";")));
    }
    result.push_str(bg_seq);
    result
}

fn wrap(text: &str, width: usize) -> Vec<String> {
    if width < 4 { return text.lines().map(str::to_string).collect(); }
    let mut out = Vec::new();
    for raw_line in text.lines() {
        if raw_line.is_empty() { out.push(String::new()); continue; }
        let mut remaining = raw_line;
        loop {
            if remaining.chars().count() <= width {
                out.push(remaining.to_string());
                break;
            }
            let break_pos = remaining.chars().take(width)
                .collect::<String>()
                .rfind(' ')
                .unwrap_or(width);
            let byte_pos = remaining.char_indices().nth(break_pos)
                .map(|(i, _)| i)
                .unwrap_or(remaining.len());
            out.push(remaining[..byte_pos].to_string());
            remaining = remaining[byte_pos..].trim_start_matches(' ');
        }
    }
    out
}

fn rel_time(iso: &str) -> String {
    let Ok(dt) = DateTime::parse_from_rfc3339(iso) else { return iso.to_string(); };
    let secs = (Utc::now() - dt.with_timezone(&Utc)).num_seconds().max(0);
    if secs < 604_800 {
        match secs {
            s if s < 60     => "just now".into(),
            s if s < 3_600  => format!("{} min{} ago", s/60,     if s/60==1     {""} else {"s"}),
            s if s < 86_400 => format!("{} hr{} ago",  s/3_600,  if s/3_600==1  {""} else {"s"}),
            s               => format!("{} day{} ago", s/86_400, if s/86_400==1 {""} else {"s"}),
        }
    } else {
        dt.with_timezone(&Local).format("%m/%d/%y").to_string()
    }
}

// ── Resume logic ─────────────────────────────────────────────────────────────

fn git_current_branch(cwd: &str) -> Option<String> {
    let out = std::process::Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(cwd)
        .output()
        .ok()?;
    if !out.status.success() { return None; }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() || s == "HEAD" { None } else { Some(s) }
}

fn create_resume_worktree(cwd: &str, branch: &str) -> Option<String> {
    let root_out = std::process::Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(cwd)
        .output()
        .ok()?;
    if !root_out.status.success() { return None; }
    let repo_root = String::from_utf8_lossy(&root_out.stdout).trim().to_string();

    let repo_path = std::path::Path::new(&repo_root);
    let parent = repo_path.parent()?;
    let repo_name = repo_path.file_name()?.to_str()?;
    let wt_path = parent.join(format!("{repo_name}-{branch}"));

    // Branch already exists; add a worktree pointing at it.
    let _ = std::process::Command::new("git")
        .args(["worktree", "add", wt_path.to_str()?, branch])
        .current_dir(&repo_root)
        .output();

    if wt_path.exists() { Some(wt_path.to_string_lossy().to_string()) } else { None }
}

fn resume_via_entire(dir: &str, branch: &str) {
    use std::os::unix::process::CommandExt;

    let launch_dir = if !branch.is_empty() {
        let current = git_current_branch(dir);
        if current.as_deref() != Some(branch) {
            create_resume_worktree(dir, branch).unwrap_or_else(|| dir.to_string())
        } else {
            dir.to_string()
        }
    } else {
        dir.to_string()
    };

    let mut entire = std::process::Command::new("entire");
    entire.arg("resume").current_dir(&launch_dir);
    if !branch.is_empty() { entire.arg(branch); }

    let Ok(out) = entire.output() else { eprintln!("entire resume failed"); return; };

    let cmd_str = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if cmd_str.is_empty() { eprintln!("entire resume returned no command"); return; }

    let mut parts = cmd_str.split_whitespace();
    let Some(prog) = parts.next() else { return; };
    let args: Vec<&str> = parts.collect();
    let err = std::process::Command::new(prog).args(&args).current_dir(&launch_dir).exec();
    eprintln!("exec failed: {err}");
}

/// Find a Claude session by ID. Returns `(cwd, git_branch)` from the JSONL if found,
/// so `claude --resume` can be run from the correct directory and branch is known.
fn find_claude_session_cwd(session_id: &str) -> Option<(String, String)> {
    use std::io::BufRead;
    let home = std::env::var("HOME").ok()?;
    let projects = std::path::PathBuf::from(&home).join(".claude/projects");
    for dir in std::fs::read_dir(&projects).ok()?.flatten() {
        let jsonl = dir.path().join(format!("{session_id}.jsonl"));
        if !jsonl.exists() { continue; }
        let Ok(file) = std::fs::File::open(&jsonl) else { return Some((String::new(), String::new())); };
        let mut cwd = String::new();
        let mut branch = String::new();
        for line in std::io::BufReader::new(file).lines().flatten() {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
            if matches!(v["type"].as_str(), Some("user") | Some("system")) {
                if cwd.is_empty() {
                    if let Some(c) = v["cwd"].as_str() { cwd = c.to_string(); }
                }
                if branch.is_empty() {
                    if let Some(b) = v["gitBranch"].as_str() { branch = b.to_string(); }
                }
                if !cwd.is_empty() && !branch.is_empty() { break; }
            }
        }
        return Some((cwd, branch));
    }
    None
}

fn do_resume(_agent: &str, session_id: &str, session_branch: &str, session_cwd: &str) {
    let current = git_current_branch(session_cwd);
    let same_branch = !session_branch.is_empty()
        && current.as_deref() == Some(session_branch);

    let dir = if same_branch || session_branch.is_empty() {
        session_cwd.to_string()
    } else {
        create_resume_worktree(session_cwd, session_branch)
            .unwrap_or_else(|| session_cwd.to_string())
    };

    resume_session(session_id, &dir);
}

/// Resume a session by ID, falling back to `entire resume` if the Claude JSONL is absent.
/// `fallback_cwd` is used for `entire resume` if the Claude session isn't found.
pub fn resume_session(session_id: &str, fallback_cwd: &str) {
    use std::os::unix::process::CommandExt;
    if let Some((session_cwd, session_branch)) = find_claude_session_cwd(session_id) {
        let launch_dir = if session_cwd.is_empty() || !std::path::Path::new(&session_cwd).exists() {
            fallback_cwd.to_string()
        } else {
            session_cwd
        };
        let err = std::process::Command::new("claude")
            .arg("--resume")
            .arg(session_id)
            .current_dir(&launch_dir)
            .exec();
        eprintln!("exec failed: {err}");
        // exec failed — fall back to entire resume, checking out the session branch first
        resume_via_entire(&launch_dir, &session_branch);
    } else {
        resume_via_entire(fallback_cwd, "");
    }
}

// ── Pager ─────────────────────────────────────────────────────────────────────

fn build_flat(
    cards: &[Card],
    term_w: usize,
    collapsed: &std::collections::HashSet<usize>,
) -> (Vec<(usize, String)>, Vec<Selectable>, Vec<usize>) {
    let w = term_w.saturating_sub(2);
    let mut flat: Vec<(usize, String)> = Vec::new();
    let mut selectables: Vec<Selectable> = Vec::new();
    let mut starts: Vec<usize> = Vec::new();

    // Pull the agent name from the Header card so render_card can use it.
    let agent: &str = cards.iter().find_map(|c| {
        if let Card::Header { agent, .. } = c { Some(agent.as_str()) } else { None }
    }).unwrap_or("");

    for (card_idx, card) in cards.iter().enumerate() {
        if let Card::ToolRound { parts } = card {
            if collapsed.contains(&card_idx) {
                let si = selectables.len();
                starts.push(flat.len());
                selectables.push(Selectable::Card(card_idx));
                for l in render_tool_summary(parts) { flat.push((si, l)); }
            } else {
                // Header row (collapses the round when space is pressed)
                let si = selectables.len();
                starts.push(flat.len());
                selectables.push(Selectable::ToolHeader(card_idx));
                for l in render_tool_header(parts) { flat.push((si, l)); }
                // One selectable per individual tool call
                for (tool_idx, part) in parts.iter().enumerate() {
                    let si = selectables.len();
                    starts.push(flat.len());
                    selectables.push(Selectable::ToolCall(card_idx, tool_idx));
                    for l in render_one_tool_call(part, w) { flat.push((si, l)); }
                }
            }
        } else {
            let si = selectables.len();
            starts.push(flat.len());
            selectables.push(Selectable::Card(card_idx));
            for l in render_card(card, w, agent) { flat.push((si, l)); }
        }
    }

    (flat, selectables, starts)
}

// `Back` returns to whatever called show (the sessions list, the repo TUI, or
// the CLI). `Quit` propagates a full-app exit so q from anywhere quits.
enum PagerOutcome { Back, Quit, Resume, Delete, GoToSessions, GoToRepo(String) }

fn pager(cards: &[Card], start_ts: Option<&str>) -> Result<PagerOutcome> {
    let (term_w, term_h) = terminal::size().unwrap_or((120, 40));
    let mut w = term_w as usize;
    let mut h = (term_h as usize).saturating_sub(1);

    let mut collapsed: std::collections::HashSet<usize> = cards.iter().enumerate()
        .filter_map(|(i, c)| if matches!(c, Card::ToolRound { .. }) { Some(i) } else { None })
        .collect();

    let (mut flat, mut selectables, mut starts) = build_flat(&cards, w, &collapsed);

    let mut stdout = io::stdout();

    let orig_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let mut out = io::stdout();
        let _ = execute!(out, LeaveAlternateScreen, cursor::Show);
        let _ = terminal::disable_raw_mode();
        orig_hook(info);
    }));

    terminal::enable_raw_mode()?;
    execute!(stdout, EnterAlternateScreen, cursor::Hide)?;

    // If a target timestamp was given, jump to the first card whose ts matches.
    // Otherwise land on the first non-navigation card (skip RepoLink and Header).
    let initial_sel = start_ts.and_then(|ts| {
        cards.iter().enumerate().find_map(|(ci, card)| {
            let card_ts = match card {
                Card::UserMsg { ts, .. } | Card::AsstMsg { ts, .. } | Card::System { ts, .. } => ts.as_str(),
                _ => return None,
            };
            if card_ts == ts {
                selectables.iter().position(|s| *s == Selectable::Card(ci))
            } else {
                None
            }
        })
    }).unwrap_or_else(|| selectables.len().saturating_sub(1));

    let mut sel: usize = initial_sel;
    let mut scroll: usize = 0;
    let mut flash:  Option<&str> = None;
    let mut awaiting_delete = false;

    let result: Result<PagerOutcome> = loop {
        let s = starts[sel];
        let e = starts.get(sel + 1).copied().unwrap_or(flat.len());
        if s < scroll          { scroll = s; }
        else if e > scroll + h { scroll = e.saturating_sub(h); }

        if let Err(err) = draw(&mut stdout, &flat, &starts, sel, scroll, h, w, selectables.len(), flash) {
            break Err(anyhow::anyhow!(err));
        }

        match event::read() {
            Err(e) => break Err(e.into()),
            Ok(Event::Key(k)) => {
                let prev_flash = flash.take();
                match (k.code, k.modifiers) {
                    (KeyCode::Char('q'), _) => break Ok(PagerOutcome::Quit),
                    (KeyCode::Char('c'), KeyModifiers::CONTROL) => break Ok(PagerOutcome::Quit),
                    (KeyCode::Esc | KeyCode::Left, _) => break Ok(PagerOutcome::Back),
                    (KeyCode::Char('r'), _) => break Ok(PagerOutcome::Resume),
                    (KeyCode::Char('d'), _) => {
                        awaiting_delete = true;
                        flash = Some("  Delete session? Press y to confirm, any other key to cancel  ");
                        continue;
                    }
                    (KeyCode::Char('y'), _) if awaiting_delete => {
                        break Ok(PagerOutcome::Delete);
                    }

                    (KeyCode::Down | KeyCode::Char('j'), _) => {
                        if sel + 1 < selectables.len() { sel += 1; }
                    }
                    (KeyCode::Up | KeyCode::Char('k'), _) => {
                        if sel > 0 { sel -= 1; }
                    }
                    (KeyCode::Char('g'), _) => { sel = 0; }
                    (KeyCode::Char('G'), _) => { sel = selectables.len().saturating_sub(1); }
                    (KeyCode::Char('u'), _) | (KeyCode::PageUp, _) => {
                        scroll = scroll.saturating_sub(h / 2);
                        sel = flat[scroll].0;
                    }
                    (KeyCode::PageDown, _) => {
                        scroll = (scroll + h / 2).min(flat.len().saturating_sub(h));
                        sel = flat[scroll].0;
                    }

                    (KeyCode::Char('y'), _) | (KeyCode::Char('c'), _) => {
                        let text = match &selectables[sel] {
                            Selectable::Card(ci)         => card_text(&cards[*ci]),
                            Selectable::ToolHeader(ci)   => card_text(&cards[*ci]),
                            Selectable::ToolCall(ci, ti) => {
                                if let Card::ToolRound { parts } = &cards[*ci] {
                                    parts.get(*ti).map_or(String::new(), tool_call_text)
                                } else { String::new() }
                            }
                        };
                        copy_to_clipboard(&text);
                        flash = Some("  ✓ copied to clipboard  ");
                    }

                    // Space/Right/Enter: expand ToolRound, collapse via header, or navigate
                    (KeyCode::Char(' ') | KeyCode::Right | KeyCode::Enter, _) => {
                        let expand_action = match &selectables[sel] {
                            Selectable::Card(ci) if matches!(&cards[*ci], Card::ToolRound { .. }) => {
                                Some((true, *ci))
                            }
                            Selectable::ToolHeader(ci) => Some((false, *ci)),
                            _ => None,
                        };
                        if let Some((expand, card_idx)) = expand_action {
                            if expand { collapsed.remove(&card_idx); } else { collapsed.insert(card_idx); }
                            let (nf, ns, nst) = build_flat(cards, w, &collapsed);
                            flat   = nf;
                            starts = nst;
                            sel = if expand {
                                ns.iter().position(|s| *s == Selectable::ToolHeader(card_idx))
                            } else {
                                ns.iter().position(|s| *s == Selectable::Card(card_idx))
                            }.unwrap_or_else(|| sel.min(ns.len().saturating_sub(1)));
                            selectables = ns;
                        } else if let Selectable::Card(ci) = &selectables[sel] {
                            match &cards[*ci] {
                                Card::RepoLink { dir, .. } => {
                                    break Ok(PagerOutcome::GoToRepo(dir.clone()));
                                }
                                Card::Header { .. } => {
                                    break Ok(PagerOutcome::GoToSessions);
                                }
                                _ => { flash = prev_flash; }
                            }
                        } else {
                            flash = prev_flash;
                        }
                    }

                    _ => { awaiting_delete = false; flash = prev_flash; }
                }
            }
            Ok(Event::Resize(new_w, new_h)) => {
                w = new_w as usize;
                h = (new_h as usize).saturating_sub(1);
                let (nf, ns, nst) = build_flat(&cards, w, &collapsed);
                flat = nf; selectables = ns; starts = nst;
                execute!(stdout, terminal::Clear(ClearType::All)).ok();
            }
            Ok(_) => {}
        }
    };

    execute!(stdout, LeaveAlternateScreen, cursor::Show)?;
    terminal::disable_raw_mode()?;
    result
}

fn draw(
    stdout: &mut impl Write,
    flat:   &[(usize, String)],
    starts: &[usize],
    sel:    usize,
    scroll: usize,
    h:      usize,
    w:      usize,
    total:  usize,
    flash:  Option<&str>,
) -> io::Result<()> {
    use crossterm::queue;
    let sel_bg = crate::theme::get().sel_bg;

    let end = (scroll + h).min(flat.len());

    // Build the entire frame into one buffer; flush once to eliminate flicker.
    // Use explicit cursor::MoveTo per row so embedded newlines in content can't
    // shift subsequent rows into the wrong position.
    let mut buf: Vec<u8> = Vec::with_capacity((w + 40) * (h + 2));

    for row in 0..h {
        queue!(buf, cursor::MoveTo(0, row as u16), terminal::Clear(ClearType::UntilNewLine))?;

        let flat_idx = scroll + row;
        if flat_idx < end {
            let (card_idx, line) = &flat[flat_idx];
            if *card_idx == sel {
                let line_bg = with_bg(line, sel_bg);
                let vis = visible_width(line);
                let pad = w.saturating_sub(vis);
                write!(buf, "\x1b[{sel_bg}m{line_bg}{}\x1b[0m", " ".repeat(pad))?;
            } else {
                buf.extend_from_slice(line.as_bytes());
            }
        }
    }

    // Status bar
    let sel_end = starts.get(sel + 1).copied().unwrap_or(flat.len());
    let base = format!(
        "  {}/{} msgs  lines {}-{}  j/k ↑↓ navigate  u/PgDn page  g/G ends  y/c copy  r resume  d delete  q quit  ",
        sel + 1, total, starts[sel] + 1, sel_end,
    );
    let bar = if let Some(msg) = flash {
        let skip = msg.chars().count();
        let rest: String = base.chars().skip(skip).collect();
        format!("{msg}{rest}")
    } else {
        base
    };
    let bar_display: String = bar.chars().take(w).collect();
    let padded = format!("{bar_display:width$}", width = w);
    queue!(buf, cursor::MoveTo(0, h as u16))?;
    write!(buf, "\x1b[7m{padded}\x1b[0m")?;

    stdout.write_all(&buf)?;
    stdout.flush()
}
