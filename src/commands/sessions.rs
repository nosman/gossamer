use anyhow::Result;
use chrono::{DateTime, Local, Utc};
use crossterm::{
    cursor,
    event::{self, Event, KeyCode},
    execute,
    terminal::{self, ClearType, EnterAlternateScreen, LeaveAlternateScreen},
};
use std::collections::HashSet;
use std::env;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;

use crate::{db, entity::session::Session, commands::status::fetch_repos};

struct DisplaySession {
    session_id: String,
    session_name: String,
    cwd: String,
    branch: String,
    updated_at: DateTime<Utc>,
    agent_name: String,
    backed_up: bool,
}

enum Action {
    Show(String),
    Resume(String, String), // (id, cwd)
}

pub fn run(all: bool, json: bool) -> Result<()> {
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
            branch: String::new(),
            updated_at: s.updated_at,
            agent_name: s.agent_name,
            backed_up: true,
        })
        .collect();

    sessions.extend(scan_claude_projects(&known_ids, all, cutoff));

    // Local-repo sessions first, then by recency
    sessions.sort_by(|a, b| {
        let a_local = current_repo_dir.as_deref().map_or(false, |d| a.cwd.starts_with(d));
        let b_local = current_repo_dir.as_deref().map_or(false, |d| b.cwd.starts_with(d));
        b_local.cmp(&a_local).then(b.updated_at.cmp(&a.updated_at))
    });

    if json {
        let arr: Vec<serde_json::Value> = sessions.iter().map(|s| serde_json::json!({
            "session_id": s.session_id,
            "session_name": s.session_name,
            "cwd": s.cwd,
            "branch": s.branch,
            "agent": s.agent_name,
            "updated_at": s.updated_at.to_rfc3339(),
            "backed_up": s.backed_up,
        })).collect();
        println!("{}", serde_json::to_string_pretty(&serde_json::json!({ "sessions": arr }))?);
        return Ok(());
    }

    if sessions.is_empty() {
        println!("No sessions found.");
        return Ok(());
    }

    let orig_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let mut out = io::stdout();
        let _ = execute!(out, LeaveAlternateScreen, cursor::Show);
        let _ = terminal::disable_raw_mode();
        orig_hook(info);
    }));

    let mut stdout = io::stdout();
    terminal::enable_raw_mode()?;
    execute!(stdout, EnterAlternateScreen, cursor::Hide)?;

    let action = tui_loop(&mut stdout, &sessions);

    execute!(stdout, LeaveAlternateScreen, cursor::Show)?;
    terminal::disable_raw_mode()?;

    match action {
        Some(Action::Show(id)) => { super::show::run(&id)?; }
        Some(Action::Resume(id, cwd)) => { super::show::resume_session(&id, &cwd); }
        None => {}
    }

    Ok(())
}

fn tui_loop(stdout: &mut impl Write, sessions: &[DisplaySession]) -> Option<Action> {
    let mut sel = 0usize;

    loop {
        let (w, h) = terminal::size().unwrap_or((120, 40));
        let w = w as usize;
        let h = h as usize;

        draw(stdout, sessions, sel, w, h).ok();

        match event::read().ok()? {
            Event::Key(k) => match k.code {
                KeyCode::Char('q') | KeyCode::Esc => break,
                KeyCode::Char('c') if k.modifiers.contains(crossterm::event::KeyModifiers::CONTROL) => {
                    execute!(stdout, LeaveAlternateScreen, cursor::Show).ok();
                    terminal::disable_raw_mode().ok();
                    std::process::exit(0);
                }
                KeyCode::Up   | KeyCode::Char('k') => { if sel > 0 { sel -= 1; } }
                KeyCode::Down | KeyCode::Char('j') => { if sel + 1 < sessions.len() { sel += 1; } }
                KeyCode::Char('g') => { sel = 0; }
                KeyCode::Char('G') => { sel = sessions.len().saturating_sub(1); }
                KeyCode::Char(' ') | KeyCode::Right | KeyCode::Enter => {
                    return Some(Action::Show(sessions[sel].session_id.clone()));
                }
                KeyCode::Char('r') => {
                    let s = &sessions[sel];
                    return Some(Action::Resume(s.session_id.clone(), s.cwd.clone()));
                }
                _ => {}
            },
            Event::Resize(_, _) => {
                execute!(stdout, terminal::Clear(ClearType::All)).ok();
            }
            _ => {}
        }
    }

    None
}

fn draw(stdout: &mut impl Write, sessions: &[DisplaySession], sel: usize, w: usize, h: usize) -> io::Result<()> {
    const SEL_BG: &str = "48;5;236";

    let content_h = h.saturating_sub(1);
    let scroll = if sel >= content_h { sel + 1 - content_h } else { 0 };

    // Pre-compute column widths
    let name_w = sessions.iter().map(|s| s.session_name.trim().chars().count()).max().unwrap_or(0).min(40);
    let cwd_w  = sessions.iter().map(|s| short_cwd(&s.cwd).chars().count()).max().unwrap_or(0);
    let branch_w = sessions.iter().map(|s| s.branch.chars().count()).max().unwrap_or(0);
    let agent_w  = sessions.iter().map(|s| s.agent_name.chars().count()).max().unwrap_or(0);

    execute!(stdout, cursor::MoveTo(0, 0))?;

    for row in 0..content_h {
        execute!(stdout, cursor::MoveTo(0, row as u16))?;
        let idx = scroll + row;
        if idx >= sessions.len() {
            execute!(stdout, terminal::Clear(ClearType::UntilNewLine))?;
            continue;
        }

        let s = &sessions[idx];
        let is_sel = idx == sel;

        let id_short: String = s.session_id.chars().take(8).collect();
        let ts = relative_time(s.updated_at);
        let age = (Utc::now() - s.updated_at).num_seconds().max(0);
        let dot_col = match age {
            a if a < 900   => "38;5;82",
            a if a < 3_600 => "38;5;214",
            _              => "38;5;240",
        };
        let (name_col, meta_col, dot_char) = if s.backed_up {
            ("1;38;5;255", "38;5;240", "*")
        } else {
            ("38;5;242", "38;5;238", "·")
        };
        let branch_col = if s.backed_up { "38;5;75" } else { "38;5;239" };

        let name: String = s.session_name.trim().chars().take(name_w).collect();
        let name_padded = format!("{:<name_w$}", name);

        let cwd_short = short_cwd(&s.cwd);
        let cwd_padded = format!("{:<cwd_w$}", cwd_short);

        let mut line = format!(
            "\x1b[{dot_col}m{dot_char}\x1b[0m \x1b[{name_col}m{name_padded}\x1b[0m  \x1b[38;5;240m{cwd_padded}\x1b[0m"
        );

        if branch_w > 0 {
            let b: String = s.branch.chars().take(branch_w).collect();
            let pad = " ".repeat(branch_w - b.chars().count());
            line.push_str(&format!("  \x1b[{branch_col}m{b}{pad}\x1b[0m"));
        }

        if agent_w > 0 {
            let col = if s.backed_up { agent_color(&s.agent_name) } else { 239 };
            let a: String = s.agent_name.chars().take(agent_w).collect();
            let pad = " ".repeat(agent_w - a.chars().count());
            line.push_str(&format!("  \x1b[38;5;{col}m{a}{pad}\x1b[0m"));
        }

        line.push_str(&format!("  \x1b[{meta_col}m{id_short}  {ts}\x1b[0m"));

        if is_sel {
            let colored = with_bg(&line, SEL_BG);
            let vis = visible_width(&line);
            let pad = w.saturating_sub(vis);
            write!(stdout, "\x1b[{SEL_BG}m{colored}{}\x1b[0m", " ".repeat(pad))?;
        } else {
            write!(stdout, "{line}")?;
            execute!(stdout, terminal::Clear(ClearType::UntilNewLine))?;
        }
    }

    let bar = format!(
        "  {} sessions   ↑↓/jk navigate   space/enter: view   r: resume   q: quit  ",
        sessions.len()
    );
    let display: String = bar.chars().take(w).collect();
    let padded = format!("{:<width$}", display, width = w);
    execute!(stdout, cursor::MoveTo(0, (h - 1) as u16))?;
    write!(stdout, "\x1b[7m{padded}\x1b[0m")?;

    stdout.flush()
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
            let mut branch = String::new();
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
                if let Some(b) = v["gitBranch"].as_str() {
                    if !b.is_empty() { branch = b.to_string(); }
                }
            }

            let display_name = if !session_name.is_empty() { session_name } else { last_prompt };

            if known_ids.contains(&session_id) {
                if let Some(existing) = sessions.iter_mut().find(|s| s.session_id == session_id) {
                    if !display_name.is_empty() { existing.session_name = display_name; }
                    if file_mtime > existing.updated_at { existing.updated_at = file_mtime; }
                    if !branch.is_empty() { existing.branch = branch; }
                }
                continue;
            }

            sessions.push(DisplaySession {
                session_id,
                session_name: display_name,
                cwd,
                branch,
                updated_at: file_mtime,
                agent_name: "Claude Code".to_string(),
                backed_up: false,
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

use super::agent_color;

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

fn short_cwd(cwd: &str) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let path = if !home.is_empty() && cwd.starts_with(&home) {
        format!("~{}", &cwd[home.len()..])
    } else {
        cwd.to_string()
    };
    let parts: Vec<&str> = path.trim_end_matches('/').split('/').filter(|s| !s.is_empty()).collect();
    match parts.len() {
        0 => "/".to_string(),
        1 => format!("/{}", parts[0]),
        2 => format!("{}/{}", parts[0], parts[1]),
        _ => format!("…/{}/{}", parts[parts.len() - 2], parts[parts.len() - 1]),
    }
}

fn with_bg(s: &str, bg: &str) -> String {
    let reinsert = format!("\x1b[0m\x1b[{bg}m");
    let body = s.replace("\x1b[0m", &reinsert);
    format!("\x1b[{bg}m{body}")
}

fn visible_width(s: &str) -> usize {
    let mut w = 0usize;
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            for nc in chars.by_ref() { if nc.is_ascii_alphabetic() { break; } }
        } else {
            w += 1;
        }
    }
    w
}
