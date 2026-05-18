use anyhow::Result;
use chrono::{DateTime, Local, Utc};
use std::collections::HashSet;
use std::env;
use std::io::BufRead;
use std::path::PathBuf;

use crate::{db, entity::session::Session, commands::status::fetch_repos};

struct DisplaySession {
    session_id: String,
    session_name: String,
    cwd: String,
    updated_at: DateTime<Utc>,
    agent_name: String,
}

pub fn run(all: bool) -> Result<()> {
    let conn = db::connect()?;

    let repos = fetch_repos(&conn)?;
    let cwd_env = env::current_dir().ok().map(|p| p.to_string_lossy().to_string());
    let current_repo_dir: Option<String> = cwd_env.as_deref().and_then(|cwd| {
        repos.iter()
            .find(|r| cwd.starts_with(r.directory.as_str()))
            .map(|r| r.directory.clone())
    });

    let mut stmt = conn.prepare(
        "SELECT session_id, agent_name, user, created_at, updated_at, cwd, session_name, tokens_used
         FROM sessions ORDER BY updated_at DESC"
    )?;

    let db_sessions: Vec<Session> = stmt.query_map([], |row| {
        let created_str: String = row.get(3)?;
        let updated_str: String = row.get(4)?;
        Ok(Session {
            session_id: row.get(0)?,
            agent_name: row.get(1)?,
            user: row.get(2)?,
            created_at: DateTime::parse_from_rfc3339(&created_str)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now()),
            updated_at: DateTime::parse_from_rfc3339(&updated_str)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now()),
            cwd: row.get(5)?,
            session_name: row.get(6)?,
            tokens_used: row.get(7)?,
        })
    })?
    .collect::<Result<Vec<_>, _>>()?;

    let known_ids: HashSet<String> = db_sessions.iter().map(|s| s.session_id.clone()).collect();
    let cutoff = Utc::now() - chrono::Duration::days(3);

    let mut sessions: Vec<DisplaySession> = db_sessions.into_iter()
        .filter(|s| all || s.updated_at >= cutoff)
        .map(|s| DisplaySession {
            session_id: s.session_id,
            session_name: s.session_name,
            cwd: s.cwd,
            updated_at: s.updated_at,
            agent_name: s.agent_name,
        })
        .collect();

    sessions.extend(scan_claude_projects(&known_ids, all, cutoff));

    // Local-repo sessions first, then by recency
    sessions.sort_by(|a, b| {
        let a_local = current_repo_dir.as_deref().map_or(false, |d| a.cwd.starts_with(d));
        let b_local = current_repo_dir.as_deref().map_or(false, |d| b.cwd.starts_with(d));
        b_local.cmp(&a_local).then(b.updated_at.cmp(&a.updated_at))
    });

    if sessions.is_empty() {
        println!("No sessions found.");
        return Ok(());
    }

    let term_w = crossterm::terminal::size().map(|(w, _)| w as usize).unwrap_or(120);
    let now = Utc::now();

    for s in &sessions {
        let age = (now - s.updated_at).num_seconds();
        let is_local = current_repo_dir.as_deref().map_or(false, |d| s.cwd.starts_with(d));

        let dot = match age {
            a if a < 900    => "\x1b[38;5;82m*\x1b[0m",
            a if a < 3_600  => "\x1b[38;5;214m*\x1b[0m",
            _               => "\x1b[38;5;240m*\x1b[0m",
        };

        let id_short: String = s.session_id.chars().take(8).collect();
        let ts = relative_time(s.updated_at);
        let cwd_short = short_cwd(&s.cwd);
        let agent_col = agent_color(&s.agent_name);
        let meta = format!(
            "\x1b[38;5;240m{id_short}  \x1b[38;5;{agent_col}m{agent}\x1b[38;5;240m  {cwd_short}  {ts}\x1b[0m",
            agent = s.agent_name,
        );

        let name_col = if is_local { "38;5;255" } else { "38;5;245" };
        let name = s.session_name.trim();

        if name.is_empty() {
            println!("{dot}  {meta}");
        } else {
            let name_trunc = truncate(name, term_w.saturating_sub(4));
            println!("{dot} \x1b[{name_col}m{name_trunc}\x1b[0m");
            println!("   {meta}");
        }
    }

    Ok(())
}

fn scan_claude_projects(known_ids: &HashSet<String>, all: bool, cutoff: DateTime<Utc>) -> Vec<DisplaySession> {
    let home = match std::env::var("HOME") {
        Ok(h) => h,
        Err(_) => return vec![],
    };
    let projects_dir = PathBuf::from(&home).join(".claude/projects");
    let Ok(projects) = std::fs::read_dir(&projects_dir) else { return vec![] };

    let mut sessions: Vec<DisplaySession> = Vec::new();

    for project_entry in projects.flatten() {
        let project_dir = project_entry.path();
        if !project_dir.is_dir() { continue }

        let Ok(files) = std::fs::read_dir(&project_dir) else { continue };

        for file_entry in files.flatten() {
            let path = file_entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") { continue }

            let session_id = match path.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };

            let file_mtime = file_entry.metadata().ok()
                .and_then(|m| m.modified().ok())
                .map(DateTime::<Utc>::from)
                .unwrap_or_else(Utc::now);

            if !all && file_mtime < cutoff { continue }

            let Ok(file) = std::fs::File::open(&path) else { continue };
            let reader = std::io::BufReader::new(file);
            let mut session_name = String::new();
            let mut cwd = String::new();
            let mut last_prompt = String::new();

            for line in reader.lines().flatten() {
                if line.trim().is_empty() { continue }
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
                match v["type"].as_str() {
                    Some("custom-title") => {
                        if let Some(t) = v["customTitle"].as_str() { session_name = t.to_string(); }
                    }
                    Some("user") | Some("system") => {
                        if cwd.is_empty() {
                            if let Some(c) = v["cwd"].as_str() { cwd = c.to_string(); }
                        }
                    }
                    _ => {}
                }
                if v["type"].as_str() == Some("user") {
                    if let Some(t) = user_text(&v["message"]["content"]) {
                        last_prompt = t;
                    }
                }
            }

            let display_name = if !session_name.is_empty() { session_name } else { last_prompt };

            if known_ids.contains(&session_id) {
                // Refresh the existing DB entry's name and timestamp
                if let Some(existing) = sessions.iter_mut().find(|s| s.session_id == session_id) {
                    if !display_name.is_empty() { existing.session_name = display_name; }
                    if file_mtime > existing.updated_at { existing.updated_at = file_mtime; }
                }
                continue;
            }

            sessions.push(DisplaySession {
                session_id,
                session_name: display_name,
                cwd,
                updated_at: file_mtime,
                agent_name: "Claude Code".to_string(),
            });
        }
    }

    sessions
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

fn relative_time(dt: DateTime<Utc>) -> String {
    let secs = (Utc::now() - dt).num_seconds().max(0);
    if secs < 604_800 {
        match secs {
            s if s < 60     => "just now".to_string(),
            s if s < 3_600  => format!("{} min{} ago", s/60,     if s/60==1     {""} else {"s"}),
            s if s < 86_400 => format!("{} hr{} ago",  s/3_600,  if s/3_600==1  {""} else {"s"}),
            s               => format!("{} day{} ago", s/86_400, if s/86_400==1 {""} else {"s"}),
        }
    } else {
        dt.with_timezone(&Local).format("%m/%d/%y").to_string()
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max.saturating_sub(1)).collect::<String>())
    }
}

fn short_cwd(cwd: &str) -> String {
    let parts: Vec<&str> = cwd.trim_end_matches('/').split('/').filter(|s| !s.is_empty()).collect();
    match parts.len() {
        0 => "/".to_string(),
        1 => format!("/{}", parts[0]),
        _ => format!("…/{}/{}", parts[parts.len() - 2], parts[parts.len() - 1]),
    }
}
