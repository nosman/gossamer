use anyhow::Result;
use chrono::{DateTime, Local, Utc};
use crossterm::{
    cursor,
    event::{self, Event, KeyCode},
    execute,
    terminal::{self, ClearType, EnterAlternateScreen, LeaveAlternateScreen},
};
use std::env;
use std::io::{self, Write};

use crate::{db, commands::status::fetch_repos};
use crate::commands::session_list::{self, DisplaySession, Scope};

enum Action {
    Show(String),
    Resume(String, String), // (id, cwd)
}

pub fn run(all: bool, json: bool) -> Result<()> {
    let conn = db::connect()?;

    let repos = fetch_repos(&conn)?;
    let cwd_env = env::current_dir().ok().map(|p| p.to_string_lossy().to_string());
    let current_repo_id: Option<i64> = cwd_env.as_deref()
        .and_then(|cwd| repos.iter().find(|r| cwd.starts_with(r.directory.as_str())))
        .map(|r| r.id as i64);

    let mut sessions = session_list::fetch(Scope::All, all);

    // Pin sessions belonging to the current repo to the top while preserving
    // recency-DESC within each group. session_id → repo_id lookup happens here
    // (one query) so we don't run it per row.
    if let Some(current) = current_repo_id {
        let repo_id_for: std::collections::HashMap<String, i64> = {
            let mut map = std::collections::HashMap::new();
            if let Ok(mut stmt) = conn.prepare(
                "SELECT session_id, repo_id FROM sessions WHERE repo_id IS NOT NULL"
            ) {
                if let Ok(rows) = stmt.query_map([], |row| {
                    Ok::<(String, i64), rusqlite::Error>((row.get(0)?, row.get(1)?))
                }) {
                    for r in rows.flatten() { map.insert(r.0, r.1); }
                }
            }
            map
        };
        sessions.sort_by(|a, b| {
            let a_local = repo_id_for.get(&a.session_id) == Some(&current);
            let b_local = repo_id_for.get(&b.session_id) == Some(&current);
            b_local.cmp(&a_local).then(b.updated_at.cmp(&a.updated_at))
        });
    }

    if json {
        let arr: Vec<serde_json::Value> = sessions.iter().map(|s| serde_json::json!({
            "session_id": s.session_id,
            "session_name": s.session_name,
            "cwd": s.cwd,
            "branch": s.branch,
            "author": s.author,
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
    let t = crate::theme::get();
    let sel_bg = t.sel_bg;

    let content_h = h.saturating_sub(1);
    let scroll = if sel >= content_h { sel + 1 - content_h } else { 0 };

    // Pre-compute column widths
    let name_w = sessions.iter().map(|s| s.session_name.trim().chars().count()).max().unwrap_or(0).min(40);
    let cwd_w  = sessions.iter().map(|s| short_cwd(&s.cwd).chars().count()).max().unwrap_or(0);
    let branch_w = sessions.iter().map(|s| s.branch.chars().count()).max().unwrap_or(0);
    let author_w = sessions.iter().map(|s| s.author.chars().count()).max().unwrap_or(0);
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
            a if a < 900   => t.fresh,
            a if a < 3_600 => t.moderate,
            _              => t.text_dim,
        };
        let (name_col, meta_col, dot_char) = if s.backed_up {
            (t.backed_name, t.backed_meta, "*")
        } else {
            (t.unbacked_name, t.unbacked_meta, "·")
        };
        let branch_col = if s.backed_up { t.link } else { t.stale };

        let clean = session_list::sanitize_one_line(&s.session_name);
        let name: String = clean.chars().take(name_w).collect();
        let name_padded = format!("{:<name_w$}", name);

        let cwd_short = short_cwd(&s.cwd);
        let cwd_padded = format!("{:<cwd_w$}", cwd_short);

        let mut line = format!(
            "\x1b[{dot_col}m{dot_char}\x1b[0m \x1b[{name_col}m{name_padded}\x1b[0m  \x1b[{dm}m{cwd_padded}\x1b[0m",
            dm = t.text_dim,
        );

        if branch_w > 0 {
            let b: String = s.branch.chars().take(branch_w).collect();
            let pad = " ".repeat(branch_w - b.chars().count());
            line.push_str(&format!("  \x1b[{branch_col}m{b}{pad}\x1b[0m"));
        }

        if author_w > 0 {
            let a: String = s.author.chars().take(author_w).collect();
            let pad = " ".repeat(author_w - a.chars().count());
            line.push_str(&format!("  \x1b[{dm}m{a}{pad}\x1b[0m", dm = t.text_dim));
        }

        if agent_w > 0 {
            let col = if s.backed_up { agent_color(&s.agent_name) } else { t.stale_agent };
            let a: String = s.agent_name.chars().take(agent_w).collect();
            let pad = " ".repeat(agent_w - a.chars().count());
            line.push_str(&format!("  \x1b[38;5;{col}m{a}{pad}\x1b[0m"));
        }

        line.push_str(&format!("  \x1b[{meta_col}m{id_short}  {ts}\x1b[0m"));

        if is_sel {
            let colored = with_bg(&line, sel_bg);
            let vis = visible_width(&line);
            let pad = w.saturating_sub(vis);
            write!(stdout, "\x1b[{sel_bg}m{colored}{}\x1b[0m", " ".repeat(pad))?;
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
