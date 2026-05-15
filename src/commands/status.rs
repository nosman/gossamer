use anyhow::Result;
use chrono::{DateTime, Local, Utc};
use crossterm::{
    cursor,
    event::{self, Event, KeyCode},
    execute,
    terminal::{self, ClearType, EnterAlternateScreen, LeaveAlternateScreen},
};
use std::env;
use std::io::{self, BufRead, IsTerminal, Write};
use std::path::PathBuf;

use crate::{db, entity::repository::Repository};

// ── Shared structs ────────────────────────────────────────────────────────────

struct RepoSession {
    session_id: String,
    session_name: String,
    updated_at: DateTime<Utc>,
}

// ── Entry point ───────────────────────────────────────────────────────────────

pub fn run() -> Result<()> {
    let conn = db::connect()?;
    let repos = fetch_repos(&conn)?;

    if repos.is_empty() {
        println!("No repositories tracked. Run `gossamer init` in a git repo to get started.");
        return Ok(());
    }

    // The shell wrapper sets GOSSAMER_CDPATH to a temp file path.
    // We write the selected directory there instead of stdout, avoiding all
    // the stdout-capture / /dev/tty complexity.
    let cd_file = std::env::var("GOSSAMER_CDPATH").ok();

    if !io::stdout().is_terminal() && cd_file.is_none() {
        // Plain list when truly non-interactive (piped, no wrapper)
        let cwd = env::current_dir().ok().map(|p| p.to_string_lossy().to_string());
        let current_dir = cwd.as_deref().and_then(|cwd| {
            repos.iter().find(|r| cwd.starts_with(r.directory.as_str())).map(|r| r.directory.as_str())
        });
        for repo in &repos {
            let is_cur = current_dir == Some(repo.directory.as_str());
            let dot = if is_cur { "*" } else { " " };
            println!("{dot} {}  {}  {}", repo.name, repo.directory, repo.remote);
        }
        return Ok(());
    }

    // Register panic hook to restore terminal
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

    let outcome = tui_loop(&mut stdout, &repos, cd_file.is_some());

    execute!(stdout, LeaveAlternateScreen, cursor::Show)?;
    terminal::disable_raw_mode()?;

    match outcome? {
        Some(TuiOutcome::CdTo(path)) => {
            if let Some(file) = cd_file {
                std::fs::write(&file, &path)?;
            }
        }
        Some(TuiOutcome::ResumeSession(session_id)) => {
            std::process::Command::new("claude")
                .arg("--resume")
                .arg(&session_id)
                .status()
                .ok();
        }
        None => {}
    }

    Ok(())
}

enum TuiOutcome {
    CdTo(String),
    ResumeSession(String),
}

enum Screen {
    Repos { sel: usize },
    Sessions { repo_idx: usize, sel: usize, sessions: Vec<RepoSession> },
}

fn tui_loop(stdout: &mut impl Write, repos: &[Repository], has_cd: bool) -> Result<Option<TuiOutcome>> {
    let cwd = env::current_dir().ok().map(|p| p.to_string_lossy().to_string());
    let current_repo_dir = cwd.as_deref().and_then(|cwd| {
        repos.iter().find(|r| cwd.starts_with(r.directory.as_str())).map(|r| r.directory.as_str())
    });

    let start_sel = cwd.as_deref()
        .and_then(|cwd| repos.iter().position(|r| cwd.starts_with(r.directory.as_str())))
        .unwrap_or(0);

    let mut screen = Screen::Repos { sel: start_sel };

    loop {
        let (w, h) = terminal::size().unwrap_or((120, 40));
        let w = w as usize;
        let h = h as usize;

        match &screen {
            Screen::Repos { sel } => draw_repos(stdout, repos, *sel, current_repo_dir, w, h, has_cd)?,
            Screen::Sessions { repo_idx, sel, sessions } => {
                draw_sessions(stdout, repos, *repo_idx, sessions, *sel, w, h)?
            }
        }

        match event::read()? {
            Event::Key(k) => match &mut screen {
                Screen::Repos { sel } => match k.code {
                    KeyCode::Char('q') | KeyCode::Esc => break,
                    KeyCode::Up   | KeyCode::Char('k') => { if *sel > 0 { *sel -= 1; } }
                    KeyCode::Down | KeyCode::Char('j') => { if *sel + 1 < repos.len() { *sel += 1; } }
                    KeyCode::Char('g') => { *sel = 0; }
                    KeyCode::Char('G') => { *sel = repos.len().saturating_sub(1); }
                    KeyCode::Char(' ') => {
                        let idx = *sel;
                        let sessions = load_sessions(&repos[idx].directory);
                        screen = Screen::Sessions { repo_idx: idx, sel: 0, sessions };
                    }
                    KeyCode::Char('c') if has_cd => {
                        let path = repos[*sel].directory.clone();
                        return Ok(Some(TuiOutcome::CdTo(path)));
                    }
                    _ => {}
                },
                Screen::Sessions { sel, sessions, .. } => match k.code {
                    KeyCode::Char('q') => break,
                    KeyCode::Esc | KeyCode::Char('h') | KeyCode::Left => {
                        let prev_sel = match &screen { Screen::Sessions { repo_idx, .. } => *repo_idx, _ => 0 };
                        screen = Screen::Repos { sel: prev_sel };
                    }
                    KeyCode::Up   | KeyCode::Char('k') => { if *sel > 0 { *sel -= 1; } }
                    KeyCode::Down | KeyCode::Char('j') => { if *sel + 1 < sessions.len() { *sel += 1; } }
                    KeyCode::Char('g') => { *sel = 0; }
                    KeyCode::Char('G') => { *sel = sessions.len().saturating_sub(1); }
                    KeyCode::Char(' ') => {
                        if !sessions.is_empty() {
                            let session_id = sessions[*sel].session_id.clone();
                            execute!(stdout, LeaveAlternateScreen, cursor::Show).ok();
                            terminal::disable_raw_mode().ok();
                            let _ = super::show::run(&session_id);
                            terminal::enable_raw_mode().ok();
                            execute!(stdout, EnterAlternateScreen, cursor::Hide).ok();
                            execute!(stdout, terminal::Clear(ClearType::All)).ok();
                        }
                    }
                    KeyCode::Char('r') => {
                        if !sessions.is_empty() {
                            let session_id = sessions[*sel].session_id.clone();
                            return Ok(Some(TuiOutcome::ResumeSession(session_id)));
                        }
                    }
                    _ => {}
                },
            },
            Event::Resize(_, _) => {
                execute!(stdout, terminal::Clear(ClearType::All)).ok();
            }
            _ => {}
        }
    }

    Ok(None)
}

// ── Renderers ─────────────────────────────────────────────────────────────────

fn draw_repos(
    stdout: &mut impl Write,
    repos: &[Repository],
    sel: usize,
    current_repo_dir: Option<&str>,
    w: usize,
    h: usize,
    has_cd: bool,
) -> io::Result<()> {
    const SEL_BG: &str = "48;5;236";

    execute!(stdout, cursor::MoveTo(0, 0))?;

    let content_h = h.saturating_sub(1);
    let mut row = 0usize;

    for (i, repo) in repos.iter().enumerate() {
        if row + 1 >= content_h { break } // need at least 2 rows per entry

        let is_sel = i == sel;
        let is_cur = current_repo_dir == Some(repo.directory.as_str());
        let dot_col = if is_cur { "38;5;82" } else { "38;5;240" };
        let name_col = if is_cur { "38;5;255" } else { "38;5;245" };

        let line1 = format!(
            "\x1b[{dot_col}m*\x1b[0m \x1b[{name_col}m{}\x1b[0m",
            repo.name
        );
        let line2 = format!(
            "   \x1b[38;5;240m{}  {}\x1b[0m",
            repo.directory, repo.remote
        );

        print_row(stdout, &line1, is_sel, SEL_BG, w, row as u16)?;
        row += 1;
        print_row(stdout, &line2, is_sel, SEL_BG, w, row as u16)?;
        row += 1;
    }

    // Clear remaining rows
    while row < content_h {
        execute!(stdout, cursor::MoveTo(0, row as u16), terminal::Clear(ClearType::UntilNewLine))?;
        row += 1;
    }

    // Status bar
    let cd_hint = if has_cd { "   c: cd to repo" } else { "" };
    let bar = format!(
        "  {} repos   ↑↓/jk navigate   space: sessions{}   q: quit  ",
        repos.len(), cd_hint
    );
    draw_status(stdout, &bar, w, h)?;

    stdout.flush()
}

fn draw_sessions(
    stdout: &mut impl Write,
    repos: &[Repository],
    repo_idx: usize,
    sessions: &[RepoSession],
    sel: usize,
    w: usize,
    h: usize,
) -> io::Result<()> {
    const SEL_BG: &str = "48;5;236";

    execute!(stdout, cursor::MoveTo(0, 0))?;

    // Header
    let header = format!(
        "\x1b[1;38;5;229m{}\x1b[0m",
        repos[repo_idx].name
    );
    execute!(stdout, cursor::MoveTo(0, 0))?;
    write!(stdout, "{}", header)?;
    execute!(stdout, terminal::Clear(ClearType::UntilNewLine))?;

    let content_h = h.saturating_sub(2); // header + status bar
    let mut row = 1usize;

    if sessions.is_empty() {
        execute!(stdout, cursor::MoveTo(0, row as u16))?;
        write!(stdout, "\x1b[38;5;240m  no sessions found\x1b[0m")?;
        execute!(stdout, terminal::Clear(ClearType::UntilNewLine))?;
        row += 1;
    }

    for (i, s) in sessions.iter().enumerate() {
        if row >= content_h { break }

        let is_sel = i == sel;
        let id_short: String = s.session_id.chars().take(8).collect();
        let ts = relative_time(s.updated_at);
        let name = s.session_name.trim();

        let line = if name.is_empty() {
            format!("\x1b[38;5;240m*  {id_short}  {ts}\x1b[0m")
        } else {
            format!("\x1b[38;5;245m*\x1b[0m \x1b[38;5;255m{name}\x1b[38;5;240m  {id_short}  {ts}\x1b[0m")
        };

        print_row(stdout, &line, is_sel, SEL_BG, w, row as u16)?;
        row += 1;
    }

    while row < content_h {
        execute!(stdout, cursor::MoveTo(0, row as u16), terminal::Clear(ClearType::UntilNewLine))?;
        row += 1;
    }

    let bar = format!(
        "  {} sessions   ↑↓/jk navigate   space: view   r: resume   ←/h: back   q: quit  ",
        sessions.len()
    );
    draw_status(stdout, &bar, w, h)?;

    stdout.flush()
}

fn print_row(stdout: &mut impl Write, line: &str, selected: bool, bg: &str, w: usize, row: u16) -> io::Result<()> {
    execute!(stdout, cursor::MoveTo(0, row))?;
    if selected {
        let colored = with_bg(line, bg);
        let vis = visible_width(line);
        let pad = w.saturating_sub(vis);
        write!(stdout, "\x1b[{bg}m{colored}{}\x1b[0m", " ".repeat(pad))?;
    } else {
        write!(stdout, "{line}")?;
        execute!(stdout, terminal::Clear(ClearType::UntilNewLine))?;
    }
    Ok(())
}

fn draw_status(stdout: &mut impl Write, bar: &str, w: usize, h: usize) -> io::Result<()> {
    let display: String = bar.chars().take(w).collect();
    let padded = format!("{:<width$}", display, width = w);
    execute!(stdout, cursor::MoveTo(0, (h - 1) as u16))?;
    write!(stdout, "\x1b[7m{padded}\x1b[0m")
}

// ── Session loading ───────────────────────────────────────────────────────────

fn load_sessions(cwd_prefix: &str) -> Vec<RepoSession> {
    let mut sessions: Vec<RepoSession> = Vec::new();

    // From DB
    if let Ok(conn) = db::connect() {
        if let Ok(mut stmt) = conn.prepare(
            "SELECT session_id, session_name, updated_at FROM sessions WHERE cwd LIKE ?1 ORDER BY updated_at DESC"
        ) {
            let prefix_pattern = format!("{cwd_prefix}%");
            let _ = stmt.query_map([&prefix_pattern], |row| {
                let ts_str: String = row.get(2)?;
                let updated_at = DateTime::parse_from_rfc3339(&ts_str)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now());
                Ok(RepoSession {
                    session_id: row.get(0)?,
                    session_name: row.get(1)?,
                    updated_at,
                })
            }).map(|rows| {
                for r in rows.flatten() { sessions.push(r); }
            });
        }
    }

    let known: std::collections::HashSet<String> = sessions.iter().map(|s| s.session_id.clone()).collect();

    // From ~/.claude/projects/
    if let Ok(home) = std::env::var("HOME") {
        let projects = PathBuf::from(&home).join(".claude/projects");
        if let Ok(dirs) = std::fs::read_dir(&projects) {
            for dir_entry in dirs.flatten() {
                let dir = dir_entry.path();
                if !dir.is_dir() { continue }
                if let Ok(files) = std::fs::read_dir(&dir) {
                    for f in files.flatten() {
                        let path = f.path();
                        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") { continue }
                        let session_id = match path.file_stem().and_then(|s| s.to_str()) {
                            Some(s) => s.to_string(),
                            None => continue,
                        };
                        if known.contains(&session_id) { continue }

                        let updated_at = f.metadata().ok()
                            .and_then(|m| m.modified().ok())
                            .map(DateTime::<Utc>::from)
                            .unwrap_or_else(Utc::now);

                        // Read first 100 lines for cwd + name
                        let Ok(file) = std::fs::File::open(&path) else { continue };
                        let reader = std::io::BufReader::new(file);
                        let mut session_name = String::new();
                        let mut cwd_found = String::new();

                        for line in reader.lines().take(100).flatten() {
                            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
                            match v["type"].as_str() {
                                Some("custom-title") => {
                                    if let Some(t) = v["customTitle"].as_str() { session_name = t.to_string(); }
                                }
                                Some("user") | Some("system") => {
                                    if cwd_found.is_empty() {
                                        if let Some(c) = v["cwd"].as_str() { cwd_found = c.to_string(); }
                                    }
                                }
                                _ => {}
                            }
                            if !session_name.is_empty() && !cwd_found.is_empty() { break }
                        }

                        if !cwd_found.starts_with(cwd_prefix) { continue }

                        sessions.push(RepoSession { session_id, session_name, updated_at });
                    }
                }
            }
        }
    }

    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    sessions
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

pub fn fetch_repos(conn: &rusqlite::Connection) -> Result<Vec<Repository>> {
    let mut stmt = conn.prepare("SELECT id, directory, remote, name FROM repositories ORDER BY name")?;
    let repos = stmt.query_map([], |row| {
        Ok(Repository {
            id: row.get(0)?,
            directory: row.get(1)?,
            remote: row.get(2)?,
            name: row.get(3)?,
        })
    })?
    .collect::<Result<Vec<_>, _>>()?;
    Ok(repos)
}
