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

// ── Data model ────────────────────────────────────────────────────────────────

enum Card {
    RepoLink  { name: String, dir: String, branch: String },
    Header    { title: Option<String>, cwd: String, branch: String, ts: String, agent: String },
    UserMsg   { ts: String, parts: Vec<UserPart> },
    AsstMsg   { ts: String, parts: Vec<AsstPart> },
    ToolRound { parts: Vec<AsstPart> },
    System    { ts: String, subtype: String, content: String },
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

pub fn run(session_id: &str) -> Result<()> {
    run_at(session_id, None)
}

pub fn run_at(session_id: &str, start_ts: Option<&str>) -> Result<()> {
    let path = find_session(session_id)
        .with_context(|| format!("no session file found for '{session_id}'"))?;

    let raw = std::fs::read_to_string(&path)
        .with_context(|| format!("cannot read {}", path.display()))?;

    // Look up agent name and repo info from the gossamer DB using the session UUID.
    let uuid = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let agent = if let Ok(conn) = crate::db::connect() {
        conn.query_row(
            "SELECT agent_name FROM sessions WHERE session_id = ?1",
            [uuid],
            |row| row.get::<_, String>(0),
        ).unwrap_or_default()
    } else { String::new() };

    let mut cards = parse(&raw, &agent);
    if cards.is_empty() {
        println!("No messages found.");
        return Ok(());
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

    loop {
        match pager(&cards, start_ts)? {
            PagerOutcome::Resume => {
                do_resume(&agent, session_id, &session_branch, &session_cwd);
                break;
            }
            PagerOutcome::Delete => { super::clean::run(session_id)?; break; }
            PagerOutcome::Quit   => break,
            PagerOutcome::GoToSessions => {
                super::sessions::run(false)?;
                break;
            }
            PagerOutcome::GoToRepo(dir) => {
                super::status::run_for_dir(&dir)?;
            }
        }
    }

    Ok(())
}

fn find_session(id: &str) -> Option<PathBuf> {
    let p = PathBuf::from(id);
    if p.exists() { return Some(p); }
    let home = std::env::var("HOME").ok()?;
    let projects = PathBuf::from(&home).join(".claude/projects");
    for entry in std::fs::read_dir(&projects).ok()? {
        let dir = entry.ok()?.path();
        let candidate = dir.join(format!("{id}.jsonl"));
        if candidate.exists() { return Some(candidate); }
    }
    None
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
                if !parts.is_empty() { cards.push(Card::UserMsg { ts, parts }); }
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

// ── Rendering ─────────────────────────────────────────────────────────────────

fn agent_color(name: &str) -> u8 {
    if      name.contains("Claude")   { 214 }
    else if name.contains("Copilot")  { 99  }
    else if name.contains("Cursor")   { 33  }
    else if name.contains("Gemini")   { 75  }
    else if name.contains("Aider")    { 42  }
    else if name.contains("ChatGPT")  { 35  }
    else if name.contains("Windsurf") { 44  }
    else if name.contains("Amazon Q") { 208 }
    else                              { 245 }
}

fn render_card(card: &Card, width: usize, agent: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let w = width.saturating_sub(2);

    match card {
        Card::RepoLink { name, dir, branch } => {
            let home = std::env::var("HOME").unwrap_or_default();
            let short = if !home.is_empty() && dir.starts_with(&home) {
                format!("~{}", &dir[home.len()..])
            } else { dir.clone() };
            let branch_part = if !branch.is_empty() {
                format!("  \x1b[38;5;220m[{branch}]\x1b[0m")
            } else { String::new() };
            lines.push(format!("\x1b[38;5;240m▸ repo  \x1b[0m\x1b[1;38;5;75m{name}\x1b[0m  \x1b[38;5;240m{short}\x1b[0m{branch_part}"));
        }
        Card::Header { title, cwd: _, branch: _, ts, agent: hdr_agent } => {
            let t = title.as_deref().unwrap_or("(untitled session)");
            let (agent_label, agent_col) = if hdr_agent.is_empty() {
                ("claude".to_string(), 75u8)
            } else {
                (hdr_agent.to_lowercase(), agent_color(hdr_agent))
            };
            let agent_part = format!("  \x1b[1;38;5;{agent_col}m{agent_label}\x1b[0m");
            let ts_part = if !ts.is_empty() {
                format!("  \x1b[38;5;240m{}\x1b[0m", rel_time(ts))
            } else { String::new() };
            lines.push(format!("\x1b[1;38;5;229m{t}\x1b[0m{agent_part}{ts_part}"));
        }
        Card::System { ts, subtype, content } => {
            lines.push(format!("\x1b[38;5;240m── {subtype}  {}\x1b[0m", rel_time(ts)));
            lines.push(String::new());
            for l in wrap(content, w) { lines.push(format!("  \x1b[38;5;240m{l}\x1b[0m")); }
        }
        Card::UserMsg { ts, parts } => {
            lines.push(format!("\x1b[1;38;5;82m── user  \x1b[0m\x1b[38;5;240m{}\x1b[0m", rel_time(ts)));
            for part in parts {
                match part {
                    UserPart::Text(text) => {
                        lines.push(String::new());
                        for l in wrap(text, w) { lines.push(format!("  \x1b[38;5;255m{l}\x1b[0m")); }
                    }
                    UserPart::ToolResult { name, content, is_error, .. } => {
                        let col = if *is_error { "38;5;196" } else { "38;5;177" };
                        lines.push(format!("\x1b[{col}m  ◀ {name}\x1b[0m"));
                        let visible: Vec<&str> = content.lines()
                            .filter(|l| !l.trim().is_empty()).take(8).collect();
                        for l in wrap(&visible.join("\n"), w.saturating_sub(4)) {
                            lines.push(format!("\x1b[38;5;240m    {l}\x1b[0m"));
                        }
                        let total = content.lines().filter(|l| !l.trim().is_empty()).count();
                        if total > 8 {
                            lines.push(format!("\x1b[38;5;238m    … {} more lines\x1b[0m", total - 8));
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
            lines.push(format!("\x1b[1;38;5;{agent_col}m── {agent_label}  \x1b[0m\x1b[38;5;240m{}\x1b[0m", rel_time(ts)));
            for part in parts {
                if let AsstPart::Text(text) = part {
                    lines.push(String::new());
                    for l in wrap(text, w) { lines.push(format!("  \x1b[38;5;252m{l}\x1b[0m")); }
                }
            }
        }
        Card::ToolRound { .. } => {} // handled in build_flat
    }

    lines.push(String::new());
    lines
}

fn render_tool_summary(parts: &[AsstPart]) -> Vec<String> {
    let count = parts.len();
    let mut seen = std::collections::HashSet::new();
    let unique: Vec<&str> = parts.iter().filter_map(|p| {
        if let AsstPart::ToolCall { name, .. } = p {
            if seen.insert(name.as_str()) { Some(name.as_str()) } else { None }
        } else { None }
    }).collect();
    vec![
        format!("\x1b[38;5;240m  ▶ ({count} tool call{}: {})\x1b[0m",
            if count == 1 { "" } else { "s" }, unique.join(", ")),
        String::new(),
    ]
}

fn render_tool_header(parts: &[AsstPart]) -> Vec<String> {
    let count = parts.len();
    let mut seen = std::collections::HashSet::new();
    let unique: Vec<&str> = parts.iter().filter_map(|p| {
        if let AsstPart::ToolCall { name, .. } = p {
            if seen.insert(name.as_str()) { Some(name.as_str()) } else { None }
        } else { None }
    }).collect();
    vec![format!("\x1b[38;5;240m  ▾ ({count} tool call{}: {})\x1b[0m",
        if count == 1 { "" } else { "s" }, unique.join(", "))]
}

fn render_one_tool_call(part: &AsstPart, w: usize) -> Vec<String> {
    let mut lines = Vec::new();
    if let AsstPart::ToolCall { name, input, result, .. } = part {
        lines.push(format!("\x1b[38;5;220m  ▶ {name}\x1b[0m"));
        if let Some(obj) = input.as_object() {
            let mut is_first = true;
            for (_, v) in obj.iter().take(4) {
                let raw_val = if let Value::String(s) = v { s.clone() } else { v.to_string() };
                let first_line = raw_val.lines().next().unwrap_or("");
                let preview: String = first_line.chars().take(120).collect();
                let suffix = if raw_val.lines().count() > 1 || first_line.chars().count() > 120 { " …" } else { "" };
                let col = if is_first { "38;5;255" } else { "38;5;245" };
                lines.push(format!("\x1b[{col}m    {preview}{suffix}\x1b[0m"));
                is_first = false;
            }
            if obj.len() > 4 {
                lines.push(format!("\x1b[38;5;238m    … {} more fields\x1b[0m", obj.len() - 4));
            }
        }
        if let Some((content, is_error)) = result {
            lines.push(format!("\x1b[38;5;238m  ────────────────────────────────────────\x1b[0m"));
            let col = if *is_error { "38;5;196" } else { "38;5;240" };
            let visible: Vec<&str> = content.lines()
                .filter(|l| !l.trim().is_empty()).take(8).collect();
            for l in wrap(&visible.join("\n"), w.saturating_sub(4)) {
                lines.push(format!("\x1b[{col}m    {l}\x1b[0m"));
            }
            let total = content.lines().filter(|l| !l.trim().is_empty()).count();
            if total > 8 {
                lines.push(format!("\x1b[38;5;238m    … {} more lines\x1b[0m", total - 8));
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

// Apply a background color code to a pre-colored ANSI string by re-inserting
// the background after every reset sequence.
fn with_bg(s: &str, bg: &str) -> String {
    let reinsert = format!("\x1b[0m\x1b[{bg}m");
    let body = s.replace("\x1b[0m", &reinsert);
    format!("\x1b[{bg}m{body}")
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

    let Ok(out) = std::process::Command::new("entire")
        .arg("resume")
        .current_dir(&launch_dir)
        .output() else { eprintln!("entire resume failed"); return; };

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

enum PagerOutcome { Quit, Resume, Delete, GoToSessions, GoToRepo(String) }

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
    }).unwrap_or_else(|| {
        selectables.iter().position(|s| {
            if let Selectable::Card(ci) = s {
                !matches!(&cards[*ci], Card::RepoLink { .. } | Card::Header { .. })
            } else { false }
        }).unwrap_or(0)
    });

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
                    (KeyCode::Char('q') | KeyCode::Esc | KeyCode::Left, _) => break Ok(PagerOutcome::Quit),
                    (KeyCode::Char('c'), KeyModifiers::CONTROL) => break Ok(PagerOutcome::Quit),
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
                    (KeyCode::Char('d'), _) => { scroll = (scroll + h / 2).min(flat.len().saturating_sub(1)); }
                    (KeyCode::Char('u'), _) => { scroll = scroll.saturating_sub(h / 2); }

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
    stdout:  &mut impl Write,
    flat:    &[(usize, String)],
    starts:  &[usize],
    sel:     usize,
    scroll:  usize,
    h:       usize,
    w:       usize,
    total:   usize,
    flash:   Option<&str>,
) -> io::Result<()> {
    const SEL_BG: &str = "48;5;236";

    let end = (scroll + h).min(flat.len());

    for row in 0..h {
        // Clear the whole row first so tabs and short lines never leave stale chars.
        execute!(stdout, cursor::MoveTo(0, row as u16), terminal::Clear(ClearType::UntilNewLine))?;

        if scroll + row < end {
            let (card_idx, line) = &flat[scroll + row];
            let is_sel = *card_idx == sel;

            if is_sel {
                let line_bg = with_bg(line, SEL_BG);
                let vis = visible_width(line);
                let pad = w.saturating_sub(vis);
                write!(stdout, "\x1b[{SEL_BG}m{line_bg}{}\x1b[0m", " ".repeat(pad))?;
            } else {
                write!(stdout, "{line}")?;
            }
        }
    }

    // Status bar
    let sel_end = starts.get(sel + 1).copied().unwrap_or(flat.len());
    let base = format!(
        "  {}/{} msgs  lines {}-{}  ↑↓/jk  space/enter navigate  d/u page  g/G ends  y/c copy  r resume  d delete  q quit  ",
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
    let padded = format!("{:width$}", bar_display, width = w);
    execute!(stdout, cursor::MoveTo(0, h as u16))?;
    write!(stdout, "\x1b[7m{padded}\x1b[0m")?;

    stdout.flush()
}
