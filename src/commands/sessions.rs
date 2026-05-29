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
use std::io::{self, Write};

use crate::{db, commands::status::{self, fetch_repos, NewSessionConfig}};
use crate::commands::session_list::{self, DisplaySession, Scope};
use crate::entity::repository::Repository;

// Outcomes that need to happen after the TUI exits.
// - `Quit` propagates a full-app exit (q pressed anywhere in this loop or a
//   nested viewer like show/search).
// - `Resume`/`LaunchNewSession` `exec` into another process.
// `Show` doesn't go here because it runs inline within the loop, so hitting
// back in the transcript viewer drops us back to this list.
enum Action {
    Quit,
    Resume(String, String), // (id, cwd)
    LaunchNewSession(NewSessionConfig),
}

/// Returns `Ok(true)` if the user pressed `q` (full app quit) anywhere within
/// the sessions TUI or a nested viewer (show/search). `Ok(false)` for a
/// normal back-out, JSON mode, or empty list.
pub fn run(all: bool, json: bool) -> Result<bool> {
    let conn = db::connect()?;

    let repos = fetch_repos(&conn)?;
    let cwd_env = env::current_dir().ok().map(|p| p.to_string_lossy().to_string());
    let current_repo_id: Option<i64> = cwd_env.as_deref()
        .and_then(|cwd| repos.iter().find(|r| cwd.starts_with(r.directory.as_str())))
        .map(|r| r.id as i64);

    let mut sessions = session_list::fetch(Scope::All, all);

    // Pin sessions belonging to the current repo to the top while preserving
    // recency-DESC within each group, and remember which sessions are local so
    // the renderer can flag them with a star. session_id → repo_id lookup
    // happens here (one query) so we don't run it per row.
    let mut local_sessions: HashSet<String> = HashSet::new();
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
        // Local set: sessions whose repo_id matches the current repo, plus any
        // session whose cwd is within the repo's directory (catches untracked
        // JSONL-only sessions augmented by session_list::fetch).
        let current_dir = repos.iter().find(|r| r.id as i64 == current)
            .map(|r| r.directory.clone()).unwrap_or_default();
        for s in &sessions {
            let by_id = repo_id_for.get(&s.session_id) == Some(&current);
            let by_cwd = !current_dir.is_empty() && s.cwd.starts_with(current_dir.as_str());
            if by_id || by_cwd { local_sessions.insert(s.session_id.clone()); }
        }
        sessions.sort_by(|a, b| {
            let a_local = local_sessions.contains(&a.session_id);
            let b_local = local_sessions.contains(&b.session_id);
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
        return Ok(false);
    }

    if sessions.is_empty() {
        println!("No sessions found.");
        return Ok(false);
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

    let action = tui_loop(&mut stdout, &sessions, &local_sessions, &repos);

    execute!(stdout, LeaveAlternateScreen, cursor::Show)?;
    terminal::disable_raw_mode()?;

    let quit_app = matches!(action, Some(Action::Quit));
    match action {
        Some(Action::Quit) => {}
        Some(Action::Resume(id, cwd)) => { super::show::resume_session(&id, &cwd); }
        Some(Action::LaunchNewSession(cfg)) => { status::launch_new_session(cfg); }
        None => {}
    }

    Ok(quit_app)
}

/// Find the tracked repo that contains a session's cwd, falling back to the
/// caller-supplied default (e.g. the current working dir's repo) when the
/// session is from outside any tracked repo. Returns `None` only if no repo
/// could be determined at all — callers should bail in that case.
fn repo_for_session<'a>(s: &DisplaySession, repos: &'a [Repository], fallback: Option<&'a Repository>) -> Option<&'a Repository> {
    repos.iter().find(|r| s.cwd.starts_with(r.directory.as_str())).or(fallback)
}

// Screens on the navigation stack. Only one variant today, but the stack
// shape mirrors status.rs::Screen so future drill-down screens can slot in
// the same way (push to enter, pop to back out).
enum Screen {
    Sessions { sel: usize },
}

// Commands produced inside the key-handling match arms and executed after the
// borrow on `stack` ends. Mirrors the Cmd enum in status.rs.
enum Cmd {
    None,
    Break,
    Back,
    Show(String),
    Resume(String, String),                  // (session_id, cwd)
    Search(String),
    NewWorktree(String, String),             // (repo_dir, branch)
    NewSession(NewSessionConfig),
    Tidy(String),                            // repo_dir
    Redraw,
}

fn tui_loop(
    stdout: &mut impl Write,
    sessions: &[DisplaySession],
    local_sessions: &HashSet<String>,
    repos: &[Repository],
) -> Option<Action> {
    // Fallback for `n`/`s`/`t` when the selected session's cwd doesn't match
    // any tracked repo (e.g. JSONL-only sessions from before init): prefer the
    // repo for the current working directory.
    let cwd_now = env::current_dir().ok().map(|p| p.to_string_lossy().to_string());
    let cwd_repo: Option<&Repository> = cwd_now.as_deref()
        .and_then(|cwd| repos.iter().find(|r| cwd.starts_with(r.directory.as_str())));

    let mut stack: Vec<Screen> = vec![Screen::Sessions { sel: 0 }];

    loop {
        let (w, h) = terminal::size().unwrap_or((120, 40));
        let w = w as usize;
        let h = h as usize;

        match stack.last().unwrap() {
            Screen::Sessions { sel } => { draw(stdout, sessions, local_sessions, *sel, w, h).ok(); }
        }

        let cmd = match event::read().ok()? {
            Event::Key(k) => match stack.last_mut().unwrap() {
                Screen::Sessions { sel } => match k.code {
                    KeyCode::Char('q') => Cmd::Break,
                    KeyCode::Esc => Cmd::Back,
                    KeyCode::Char('c') if k.modifiers.contains(crossterm::event::KeyModifiers::CONTROL) => {
                        execute!(stdout, LeaveAlternateScreen, cursor::Show).ok();
                        terminal::disable_raw_mode().ok();
                        std::process::exit(0);
                    }
                    KeyCode::Up   | KeyCode::Char('k') => { if *sel > 0 { *sel -= 1; } Cmd::None }
                    KeyCode::Down | KeyCode::Char('j') => { if *sel + 1 < sessions.len() { *sel += 1; } Cmd::None }
                    KeyCode::Char('g') => { *sel = 0; Cmd::None }
                    KeyCode::Char('G') => { *sel = sessions.len().saturating_sub(1); Cmd::None }
                    KeyCode::Char(' ') | KeyCode::Right | KeyCode::Enter => {
                        if sessions.is_empty() { Cmd::None }
                        else { Cmd::Show(sessions[*sel].session_id.clone()) }
                    }
                    KeyCode::Char('r') => {
                        if sessions.is_empty() { Cmd::None }
                        else {
                            let s = &sessions[*sel];
                            Cmd::Resume(s.session_id.clone(), s.cwd.clone())
                        }
                    }
                    KeyCode::Char('/') => match status::collect_search_query(stdout, w, h) {
                        Some(q) if !q.trim().is_empty() => Cmd::Search(q),
                        _ => Cmd::Redraw,
                    },
                    KeyCode::Char('n') => {
                        let repo = sessions.get(*sel)
                            .and_then(|s| repo_for_session(s, repos, cwd_repo));
                        if let Some(repo) = repo {
                            match status::collect_text_input(stdout, "  new worktree branch: ", w, h) {
                                Some(b) if !b.trim().is_empty() => {
                                    Cmd::NewWorktree(repo.directory.clone(), b.trim().to_string())
                                }
                                _ => Cmd::Redraw,
                            }
                        } else { Cmd::Redraw }
                    }
                    KeyCode::Char('s') => {
                        let repo = sessions.get(*sel)
                            .and_then(|s| repo_for_session(s, repos, cwd_repo))
                            .or(cwd_repo);
                        if let Some(repo) = repo {
                            match status::new_session_wizard(stdout, &repo.directory, w, h) {
                                Some(cfg) => Cmd::NewSession(cfg),
                                None => Cmd::Redraw,
                            }
                        } else { Cmd::Redraw }
                    }
                    KeyCode::Char('t') => {
                        let repo = sessions.get(*sel)
                            .and_then(|s| repo_for_session(s, repos, cwd_repo))
                            .or(cwd_repo);
                        match repo {
                            Some(r) => Cmd::Tidy(r.directory.clone()),
                            None => Cmd::None,
                        }
                    }
                    _ => Cmd::None,
                }
            },
            Event::Resize(_, _) => Cmd::Redraw,
            _ => Cmd::None,
        };

        match cmd {
            Cmd::None => {}
            Cmd::Break => return Some(Action::Quit),
            Cmd::Back => {
                stack.pop();
                if stack.is_empty() { break; }
            }
            Cmd::Show(id) => {
                // Transcript viewer is its own self-contained TUI: step out of
                // the alternate screen, run it, then come back and redraw.
                // If the user pressed `q` in the viewer, propagate the full-app
                // exit instead of resuming this loop.
                execute!(stdout, LeaveAlternateScreen, cursor::Show).ok();
                terminal::disable_raw_mode().ok();
                let quit_app = super::show::run(&id).unwrap_or(false);
                terminal::enable_raw_mode().ok();
                if quit_app { return Some(Action::Quit); }
                execute!(stdout, EnterAlternateScreen, cursor::Hide).ok();
                execute!(stdout, terminal::Clear(ClearType::All)).ok();
            }
            Cmd::Resume(id, cwd) => return Some(Action::Resume(id, cwd)),
            Cmd::Search(query) => {
                execute!(stdout, LeaveAlternateScreen, cursor::Show).ok();
                terminal::disable_raw_mode().ok();
                let quit_app = super::search::run(&query, 10, false).unwrap_or(false);
                terminal::enable_raw_mode().ok();
                if quit_app { return Some(Action::Quit); }
                execute!(stdout, EnterAlternateScreen, cursor::Hide).ok();
                execute!(stdout, terminal::Clear(ClearType::All)).ok();
            }
            Cmd::NewWorktree(repo_dir, branch) => {
                let msg = status::create_worktree(&repo_dir, &branch);
                let display: String = msg.chars().take(w).collect();
                let padded = format!("{:<width$}", display, width = w);
                execute!(stdout, cursor::MoveTo(0, (h - 1) as u16)).ok();
                write!(stdout, "\x1b[7m{padded}\x1b[0m").ok();
                stdout.flush().ok();
            }
            Cmd::NewSession(cfg) => return Some(Action::LaunchNewSession(cfg)),
            Cmd::Tidy(repo_dir) => {
                if let Some(r) = repos.iter().find(|r| r.directory == repo_dir) {
                    super::tidy::tui_tidy(stdout, std::slice::from_ref(r), 7, false, w, h);
                    execute!(stdout, terminal::Clear(ClearType::All)).ok();
                }
            }
            Cmd::Redraw => { execute!(stdout, terminal::Clear(ClearType::All)).ok(); }
        }
    }

    None
}

fn draw(
    stdout: &mut impl Write,
    sessions: &[DisplaySession],
    local_sessions: &HashSet<String>,
    sel: usize,
    w: usize,
    h: usize,
) -> io::Result<()> {
    let t = crate::theme::get();
    let sel_bg = t.sel_bg;
    // Reserve the leading cell only if at least one row will use the star.
    // Otherwise we'd lose two columns of width for no visible benefit (e.g.
    // when not invoked from inside a tracked repo).
    let any_local = sessions.iter().any(|s| local_sessions.contains(&s.session_id));

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
        let (meta_col, dot_char) = if s.backed_up {
            (t.backed_meta, "*")
        } else {
            (t.unbacked_meta, "·")
        };
        // Name color is driven by whether the user explicitly named the
        // session (`/rename` or custom-title), not by whether it's been
        // checkpointed. Explicit names always pop; derived first-prompt
        // fallbacks render dim regardless of backed_up.
        let name_col = if s.name_is_explicit {
            t.backed_name
        } else if s.backed_up {
            t.text_secondary
        } else {
            t.unbacked_name
        };
        let branch_col = if s.backed_up { t.link } else { t.stale };

        let clean = session_list::sanitize_one_line(&s.session_name);
        let name: String = clean.chars().take(name_w).collect();
        let name_padded = format!("{:<name_w$}", name);

        let cwd_short = short_cwd(&s.cwd);
        let cwd_padded = format!("{:<cwd_w$}", cwd_short);

        let star_prefix = if any_local {
            if local_sessions.contains(&s.session_id) {
                format!("\x1b[{fc}m★\x1b[0m ", fc = t.fresh)
            } else {
                "  ".to_string()
            }
        } else {
            String::new()
        };

        let mut line = format!(
            "{star_prefix}\x1b[{dot_col}m{dot_char}\x1b[0m \x1b[{name_col}m{name_padded}\x1b[0m  \x1b[{dm}m{cwd_padded}\x1b[0m",
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
        "  {} sessions   ↑↓/jk navigate   space: view   r: resume   s: new session   n: new worktree   t: tidy   /: search   q: quit  ",
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
