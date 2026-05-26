use anyhow::Result;
use chrono::{DateTime, Local, Utc};
use crossterm::{
    cursor,
    event::{self, Event, KeyCode},
    execute,
    terminal::{self, ClearType, EnterAlternateScreen, LeaveAlternateScreen},
};
use std::env;
use std::io::{self, IsTerminal, Write};

use crate::{db, entity::repository::Repository};

// ── Shared structs ────────────────────────────────────────────────────────────

use super::session_list::{self, DisplaySession as RepoSession, Scope};

struct RepoWorktree {
    path: String,
    branch: String, // bare branch name, or "(detached)"
    head: String,   // short commit hash
    is_main: bool,
}

struct NewSessionConfig {
    agent_name: String,
    agent_cli: String,
    branch: Option<String>, // None = no new worktree
    session_name: String,
    prompt: String,
    repo_dir: String,
}

// (display_name, cli_command, terminal_256_color)
const AGENTS: &[(&str, &str, u8)] = &[
    ("Claude Code", "claude", 214),
    ("Gemini CLI",  "gemini", 75),
    ("Aider",       "aider",  42),
];

// ── Entry point ───────────────────────────────────────────────────────────────

pub fn run(json: bool) -> Result<()> {
    let conn = db::connect()?;
    let repos = fetch_repos(&conn)?;

    if json {
        let arr: Vec<serde_json::Value> = repos.iter().map(|r| {
            let worktrees: Vec<serde_json::Value> = fetch_worktrees(&r.directory).into_iter().map(|wt| serde_json::json!({
                "path": wt.path,
                "branch": wt.branch,
                "head": wt.head,
                "is_main": wt.is_main,
            })).collect();
            let sessions: Vec<serde_json::Value> = session_list::fetch(Scope::Repo(r), true)
                .into_iter().map(|s| serde_json::json!({
                "session_id": s.session_id,
                "session_name": s.session_name,
                "branch": s.branch,
                "author": s.author,
                "agent": s.agent_name,
                "updated_at": s.updated_at.to_rfc3339(),
                "backed_up": s.backed_up,
            })).collect();
            serde_json::json!({
                "name": r.name,
                "directory": r.directory,
                "remote": r.remote,
                "worktrees": worktrees,
                "sessions": sessions,
            })
        }).collect();
        println!("{}", serde_json::to_string_pretty(&serde_json::json!({ "repos": arr }))?);
        return Ok(());
    }

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

    let outcome = tui_loop(&mut stdout, &repos, cd_file.is_some(), None);

    execute!(stdout, LeaveAlternateScreen, cursor::Show)?;
    terminal::disable_raw_mode()?;

    match outcome? {
        Some(TuiOutcome::CdTo(path)) => {
            if let Some(file) = cd_file {
                std::fs::write(&file, &path)?;
            }
        }
        Some(TuiOutcome::ResumeSession { id, cwd }) => {
            super::show::resume_session(&id, &cwd);
        }
        Some(TuiOutcome::LaunchAgent { cli, cwd, session_name, prompt }) => {
            use std::os::unix::process::CommandExt;
            let mut cmd = std::process::Command::new(&cli);
            if !cwd.is_empty() { cmd.current_dir(&cwd); }
            if !session_name.is_empty() { cmd.args(["-n", &session_name]); }
            if !prompt.is_empty() { cmd.arg(&prompt); }
            let err = cmd.exec();
            eprintln!("Failed to launch {cli}: {err}");
        }
        None => {}
    }

    Ok(())
}

enum TuiOutcome {
    CdTo(String),
    ResumeSession { id: String, cwd: String },
    LaunchAgent { cli: String, cwd: String, session_name: String, prompt: String },
}

enum Screen {
    Repos { sel: usize },
    Sessions { repo_idx: usize, sel: usize, sessions: Vec<RepoSession>, worktrees: Vec<RepoWorktree> },
}

fn tui_loop(stdout: &mut impl Write, repos: &[Repository], has_cd: bool, start_repo: Option<usize>) -> Result<Option<TuiOutcome>> {
    let cwd = env::current_dir().ok().map(|p| p.to_string_lossy().to_string());
    let current_repo_dir = cwd.as_deref().and_then(|cwd| {
        repos.iter().find(|r| cwd.starts_with(r.directory.as_str())).map(|r| r.directory.as_str())
    });

    let start_sel = cwd.as_deref()
        .and_then(|cwd| repos.iter().position(|r| cwd.starts_with(r.directory.as_str())))
        .unwrap_or(0);

    let initial = if let Some(idx) = start_repo.filter(|&i| i < repos.len()) {
        let sessions = session_list::fetch(Scope::Repo(&repos[idx]), true);
        let worktrees = fetch_worktrees(&repos[idx].directory);
        Screen::Sessions { repo_idx: idx, sel: 0, sessions, worktrees }
    } else {
        Screen::Repos { sel: start_sel }
    };

    // Navigation stack — back pops; when empty the TUI exits.
    let mut stack: Vec<Screen> = vec![initial];

    // Commands produced inside match arms, executed after the borrow ends.
    enum Cmd {
        None,
        Break,
        Back,
        PushSessions(usize),
        Cd(String),
        ShowSession(String),
        ResumeSession(String, String), // (session_id, repo_dir)
        Search(String),
        NewWorktree(String), // branch name
        NewSession(NewSessionConfig),
        Tidy,
        Redraw,
    }

    loop {
        let (w, h) = terminal::size().unwrap_or((120, 40));
        let w = w as usize;
        let h = h as usize;

        match stack.last().unwrap() {
            Screen::Repos { sel } => draw_repos(stdout, repos, *sel, current_repo_dir, w, h, has_cd)?,
            Screen::Sessions { repo_idx, sel, sessions, worktrees } => {
                draw_sessions(stdout, repos, *repo_idx, sessions, worktrees, *sel, w, h)?
            }
        }

        let cmd = match event::read()? {
            Event::Key(k) => match stack.last_mut().unwrap() {
                Screen::Repos { sel } => match k.code {
                    KeyCode::Char('q') | KeyCode::Esc => Cmd::Break,
                    KeyCode::Char('c') if k.modifiers.contains(crossterm::event::KeyModifiers::CONTROL) => {
                        execute!(stdout, LeaveAlternateScreen, cursor::Show).ok();
                        terminal::disable_raw_mode().ok();
                        std::process::exit(0);
                    }
                    KeyCode::Up   | KeyCode::Char('k') => { if *sel > 0 { *sel -= 1; } Cmd::None }
                    KeyCode::Down | KeyCode::Char('j') => { if *sel + 1 < repos.len() { *sel += 1; } Cmd::None }
                    KeyCode::Char('g') => { *sel = 0; Cmd::None }
                    KeyCode::Char('G') => { *sel = repos.len().saturating_sub(1); Cmd::None }
                    KeyCode::Char(' ') | KeyCode::Right => Cmd::PushSessions(*sel),
                    KeyCode::Char('c') if has_cd => Cmd::Cd(repos[*sel].directory.clone()),
                    KeyCode::Char('s') => {
                        let repo_dir = repos[*sel].directory.clone();
                        match new_session_wizard(stdout, &repo_dir, w, h) {
                            Some(cfg) => Cmd::NewSession(cfg),
                            None => Cmd::Redraw,
                        }
                    }
                    KeyCode::Char('/') => match collect_search_query(stdout, w, h) {
                        Some(q) if !q.trim().is_empty() => Cmd::Search(q),
                        _ => Cmd::Redraw,
                    },
                    _ => Cmd::None,
                },
                Screen::Sessions { sel, sessions, repo_idx, .. } => match k.code {
                    KeyCode::Char('q') => Cmd::Break,
                    KeyCode::Char('c') if k.modifiers.contains(crossterm::event::KeyModifiers::CONTROL) => {
                        execute!(stdout, LeaveAlternateScreen, cursor::Show).ok();
                        terminal::disable_raw_mode().ok();
                        std::process::exit(0);
                    }
                    KeyCode::Esc | KeyCode::Char('h') | KeyCode::Left => Cmd::Back,
                    KeyCode::Up   | KeyCode::Char('k') => { if *sel > 0 { *sel -= 1; } Cmd::None }
                    KeyCode::Down | KeyCode::Char('j') => { if *sel + 1 < sessions.len() { *sel += 1; } Cmd::None }
                    KeyCode::Char('g') => { *sel = 0; Cmd::None }
                    KeyCode::Char('G') => { *sel = sessions.len().saturating_sub(1); Cmd::None }
                    KeyCode::Char(' ') | KeyCode::Right => {
                        if sessions.is_empty() { Cmd::None }
                        else { Cmd::ShowSession(sessions[*sel].session_id.clone()) }
                    }
                    KeyCode::Char('r') => {
                        if sessions.is_empty() { Cmd::None }
                        else { Cmd::ResumeSession(sessions[*sel].session_id.clone(), repos[*repo_idx].directory.clone()) }
                    }
                    KeyCode::Char('/') => match collect_search_query(stdout, w, h) {
                        Some(q) if !q.trim().is_empty() => Cmd::Search(q),
                        _ => Cmd::Redraw,
                    },
                    KeyCode::Char('n') => match collect_text_input(stdout, "  new worktree branch: ", w, h) {
                        Some(b) if !b.trim().is_empty() => Cmd::NewWorktree(b.trim().to_string()),
                        _ => Cmd::Redraw,
                    },
                    KeyCode::Char('s') => {
                        let repo_dir = repos[*repo_idx].directory.clone();
                        match new_session_wizard(stdout, &repo_dir, w, h) {
                            Some(cfg) => Cmd::NewSession(cfg),
                            None => Cmd::Redraw,
                        }
                    }
                    KeyCode::Char('t') => Cmd::Tidy,
                    _ => Cmd::None,
                },
            },
            Event::Resize(_, _) => Cmd::Redraw,
            _ => Cmd::None,
        };

        match cmd {
            Cmd::None => {}
            Cmd::Break => break,
            Cmd::Back => {
                stack.pop();
                if stack.is_empty() { break; }
            }
            Cmd::PushSessions(idx) => {
                let sessions = session_list::fetch(Scope::Repo(&repos[idx]), true);
                let worktrees = fetch_worktrees(&repos[idx].directory);
                stack.push(Screen::Sessions { repo_idx: idx, sel: 0, sessions, worktrees });
            }
            Cmd::Cd(path) => return Ok(Some(TuiOutcome::CdTo(path))),
            Cmd::ResumeSession(id, cwd) => return Ok(Some(TuiOutcome::ResumeSession { id, cwd })),
            Cmd::ShowSession(id) => {
                execute!(stdout, LeaveAlternateScreen, cursor::Show).ok();
                terminal::disable_raw_mode().ok();
                let _ = super::show::run(&id);
                terminal::enable_raw_mode().ok();
                execute!(stdout, EnterAlternateScreen, cursor::Hide).ok();
                execute!(stdout, terminal::Clear(ClearType::All)).ok();
            }
            Cmd::Search(query) => {
                execute!(stdout, LeaveAlternateScreen, cursor::Show).ok();
                terminal::disable_raw_mode().ok();
                let _ = super::search::run(&query, 10, false);
                terminal::enable_raw_mode().ok();
                execute!(stdout, EnterAlternateScreen, cursor::Hide).ok();
                execute!(stdout, terminal::Clear(ClearType::All)).ok();
            }
            Cmd::NewWorktree(branch) => {
                if let Some(Screen::Sessions { repo_idx, worktrees, .. }) = stack.last_mut() {
                    let repo_dir = &repos[*repo_idx].directory;
                    let notification = create_worktree(repo_dir, &branch);
                    // Refresh the worktree list whether or not it succeeded.
                    *worktrees = fetch_worktrees(repo_dir);
                    // Show the result in the status bar until the next keypress.
                    let (tw, th) = terminal::size().unwrap_or((120, 40));
                    let msg: String = notification.chars().take(tw as usize).collect();
                    let padded = format!("{:<width$}", msg, width = tw as usize);
                    execute!(stdout, cursor::MoveTo(0, th - 1)).ok();
                    write!(stdout, "\x1b[7m{padded}\x1b[0m").ok();
                    stdout.flush().ok();
                }
            }
            Cmd::NewSession(cfg) => {
                // Create worktree if requested, then launch the agent.
                let launch_dir = if let Some(ref branch) = cfg.branch {
                    let _ = create_worktree(&cfg.repo_dir, branch);
                    if let Some(Screen::Sessions { repo_idx, worktrees, .. }) = stack.last_mut() {
                        *worktrees = fetch_worktrees(&repos[*repo_idx].directory);
                    }
                    let repo_path = std::path::Path::new(&cfg.repo_dir);
                    let parent = repo_path.parent().unwrap_or(repo_path);
                    let repo_name = repo_path.file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_else(|| "repo".to_string());
                    parent.join(format!("{repo_name}-{}", branch)).to_string_lossy().to_string()
                } else {
                    cfg.repo_dir.clone()
                };

                // Copy prompt to clipboard as a convenience.
                let prompt = cfg.prompt.trim().to_string();
                if !prompt.is_empty() {
                    if let Ok(mut child) = std::process::Command::new("pbcopy")
                        .stdin(std::process::Stdio::piped())
                        .spawn()
                    {
                        if let Some(stdin) = child.stdin.as_mut() {
                            let _ = stdin.write_all(prompt.as_bytes());
                        }
                        let _ = child.wait();
                    }
                }

                let session_name = cfg.session_name.trim().to_string();
                return Ok(Some(TuiOutcome::LaunchAgent {
                    cli: cfg.agent_cli,
                    cwd: launch_dir,
                    session_name,
                    prompt,
                }));
            }
            Cmd::Tidy => {
                let repo_idx_opt = if let Some(Screen::Sessions { repo_idx, .. }) = stack.last() {
                    Some(*repo_idx)
                } else {
                    None
                };
                if let Some(repo_idx) = repo_idx_opt {
                    let repo = &repos[repo_idx];
                    let (tw, th) = terminal::size().unwrap_or((120, 40));
                    let changed = super::tidy::tui_tidy(
                        stdout,
                        std::slice::from_ref(repo),
                        7,
                        false,
                        tw as usize,
                        th as usize,
                    );
                    if changed {
                        if let Some(Screen::Sessions { worktrees, .. }) = stack.last_mut() {
                            *worktrees = fetch_worktrees(&repos[repo_idx].directory);
                        }
                    }
                    execute!(stdout, terminal::Clear(ClearType::All)).ok();
                }
            }
            Cmd::Redraw => { execute!(stdout, terminal::Clear(ClearType::All)).ok(); }
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
    let t = crate::theme::get();
    let sel_bg = t.sel_bg;

    execute!(stdout, cursor::MoveTo(0, 0))?;

    let content_h = h.saturating_sub(1);
    let mut row = 0usize;

    let name_w = repos.iter().map(|r| r.name.chars().count()).max().unwrap_or(0);
    let dir_w  = repos.iter().map(|r| r.directory.chars().count()).max().unwrap_or(0);

    for (i, repo) in repos.iter().enumerate() {
        if row >= content_h { break }

        let is_sel = i == sel;
        let is_cur = current_repo_dir == Some(repo.directory.as_str());
        let dot_col = if is_cur { t.fresh } else { t.text_dim };

        let name_padded = format!("{:<name_w$}", repo.name);
        let dir_padded  = format!("{:<dir_w$}",  repo.directory);
        let line = format!(
            "\x1b[{dot_col}m*\x1b[0m \x1b[{pm}m{name_padded}\x1b[0m  \x1b[{dm}m{dir_padded}  {}\x1b[0m",
            repo.remote, pm = t.text_primary, dm = t.text_dim,
        );

        print_row(stdout, &line, is_sel, sel_bg, w, row as u16)?;
        row += 1;
    }

    // Clear remaining rows
    while row < content_h {
        execute!(stdout, cursor::MoveTo(0, row as u16), terminal::Clear(ClearType::UntilNewLine))?;
        row += 1;
    }

    // Status bar
    let cd_hint = if has_cd { "   c: cd" } else { "" };
    let bar = format!(
        "  {} repos   ↑↓/jk navigate   space: sessions   s: new session   /: search{}   q: quit  ",
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
    worktrees: &[RepoWorktree],
    sel: usize,
    w: usize,
    h: usize,
) -> io::Result<()> {
    let t = crate::theme::get();
    let sel_bg = t.sel_bg;

    execute!(stdout, cursor::MoveTo(0, 0))?;
    write!(stdout, "\x1b[{hd}m{}\x1b[0m", repos[repo_idx].name, hd = t.header)?;
    execute!(stdout, terminal::Clear(ClearType::UntilNewLine))?;

    let content_h = h.saturating_sub(2); // header + status bar
    let mut row = 1usize;

    // ── Worktrees ────────────────────────────────────────────────────────────
    if !worktrees.is_empty() {
        for wt in worktrees.iter().take(content_h.saturating_sub(row + 1)) {
            if row >= content_h { break; }

            let (branch_col, branch_label) = if wt.branch == "(detached)" {
                (t.error, format!("detached:{}", &wt.head))
            } else if wt.is_main {
                (t.accent, wt.branch.clone())
            } else {
                (t.link, wt.branch.clone())
            };

            let path_short = short_path_s(&wt.path);
            let line = format!(
                "\x1b[{dm}m  @ \x1b[{branch_col}m{branch_label}\x1b[0m  \x1b[{dm}m{path_short}\x1b[0m",
                dm = t.text_dim,
            );
            execute!(stdout, cursor::MoveTo(0, row as u16))?;
            write!(stdout, "{line}")?;
            execute!(stdout, terminal::Clear(ClearType::UntilNewLine))?;
            row += 1;
        }

        // Blank separator between worktrees and sessions
        if row < content_h {
            execute!(stdout, cursor::MoveTo(0, row as u16), terminal::Clear(ClearType::UntilNewLine))?;
            row += 1;
        }
    }

    // ── Sessions ─────────────────────────────────────────────────────────────
    let sessions_start = row;
    let sessions_h = content_h.saturating_sub(sessions_start);
    let scroll = if sel >= sessions_h { sel + 1 - sessions_h } else { 0 };

    if sessions.is_empty() {
        if row < content_h {
            execute!(stdout, cursor::MoveTo(0, row as u16))?;
            write!(stdout, "\x1b[{dm}m  no sessions found\x1b[0m", dm = t.text_dim)?;
            execute!(stdout, terminal::Clear(ClearType::UntilNewLine))?;
            row += 1;
        }
    } else {
        // Pre-compute column widths for table alignment
        let name_w   = sessions.iter().map(|s| s.session_name.trim().chars().count()).max().unwrap_or(0).min(40);
        let branch_w = sessions.iter().map(|s| s.branch.chars().count()).max().unwrap_or(0);
        let author_w = sessions.iter().map(|s| s.author.chars().count()).max().unwrap_or(0);
        let agent_w  = sessions.iter().map(|s| s.agent_name.chars().count()).max().unwrap_or(0);

        for (i, s) in sessions.iter().enumerate().skip(scroll) {
            if row >= content_h { break; }

            let id_short: String = s.session_id.chars().take(8).collect();
            let ts = relative_time(s.updated_at);
            let clean = session_list::sanitize_one_line(&s.session_name);
            let name: String = clean.chars().take(name_w).collect();
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

            let name_padded = format!("{:<name_w$}", name);
            let mut line = format!("\x1b[{dot_col}m{dot_char}\x1b[0m \x1b[{name_col}m{name_padded}\x1b[0m");

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

            print_row(stdout, &line, i == sel, sel_bg, w, row as u16)?;
            row += 1;
        }
    }

    while row < content_h {
        execute!(stdout, cursor::MoveTo(0, row as u16), terminal::Clear(ClearType::UntilNewLine))?;
        row += 1;
    }

    let bar = format!(
        "  {} sessions   ↑↓/jk navigate   space: view   r: resume   s: new session   n: new worktree   t: tidy   /: search   ←/h: back   q: quit  ",
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

// ── Worktree loading ──────────────────────────────────────────────────────────

fn fetch_worktrees(repo_dir: &str) -> Vec<RepoWorktree> {
    let out = std::process::Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(repo_dir)
        .output();

    let Ok(out) = out else { return vec![]; };
    if !out.status.success() { return vec![]; }
    let text = String::from_utf8_lossy(&out.stdout);

    let mut result = Vec::new();
    let mut first = true;

    // Each worktree block is separated by a blank line.
    for block in text.split("\n\n") {
        let mut path = String::new();
        let mut head = String::new();
        let mut branch = String::new();
        let mut detached = false;

        for line in block.lines() {
            if let Some(v) = line.strip_prefix("worktree ") {
                path = v.to_string();
            } else if let Some(v) = line.strip_prefix("HEAD ") {
                head = v.chars().take(8).collect();
            } else if let Some(v) = line.strip_prefix("branch refs/heads/") {
                branch = v.to_string();
            } else if line == "detached" {
                detached = true;
            }
        }

        if path.is_empty() { continue; }
        if detached { branch = "(detached)".to_string(); }
        if branch.is_empty() { continue; } // bare worktree — skip

        result.push(RepoWorktree { path, branch, head, is_main: first });
        first = false;
    }

    result
}

// ── Session loading ───────────────────────────────────────────────────────────

// ── Text input prompt ─────────────────────────────────────────────────────────

/// Generic single-line input shown in the status bar. Returns None on Esc.
fn collect_text_input(stdout: &mut impl Write, prefix: &str, w: usize, h: usize) -> Option<String> {
    let mut value = String::new();
    execute!(stdout, cursor::Show).ok();
    draw_input_bar(stdout, prefix, &value, w, h).ok();

    loop {
        match event::read().ok()? {
            Event::Key(k) => match k.code {
                KeyCode::Esc => {
                    execute!(stdout, cursor::Hide).ok();
                    return None;
                }
                KeyCode::Enter => {
                    execute!(stdout, cursor::Hide).ok();
                    return Some(value);
                }
                KeyCode::Backspace => {
                    value.pop();
                    draw_input_bar(stdout, prefix, &value, w, h).ok();
                }
                KeyCode::Char(c) => {
                    value.push(c);
                    draw_input_bar(stdout, prefix, &value, w, h).ok();
                }
                _ => {}
            },
            _ => {}
        }
    }
}

fn draw_input_bar(stdout: &mut impl Write, prefix: &str, value: &str, w: usize, h: usize) -> io::Result<()> {
    let prefix_len = prefix.chars().count();
    let text: String = value.chars().take(w.saturating_sub(prefix_len + 2)).collect();
    let content = format!("{prefix}{text}");
    let padded = format!("{:<width$}", content, width = w);
    execute!(stdout, cursor::MoveTo(0, (h - 1) as u16))?;
    write!(stdout, "\x1b[7m{padded}\x1b[0m")?;
    let col = (prefix_len + text.chars().count()).min(w.saturating_sub(1)) as u16;
    execute!(stdout, cursor::MoveTo(col, (h - 1) as u16))?;
    stdout.flush()
}

fn collect_search_query(stdout: &mut impl Write, w: usize, h: usize) -> Option<String> {
    collect_text_input(stdout, "  / ", w, h)
}

// ── New session wizard ────────────────────────────────────────────────────────

/// A 4-step panel drawn over the bottom of the screen. Each completed step
/// stays visible with its confirmed value while the user fills the next one.
fn new_session_wizard(stdout: &mut impl Write, repo_dir: &str, w: usize, h: usize) -> Option<NewSessionConfig> {
    const LABEL_W: usize = 24;
    // Panel rows: title, blank, agent, branch, name, prompt, blank  (7 rows + 1 status bar)
    const PANEL_H: usize = 7;

    let t = crate::theme::get();
    let panel_top = h.saturating_sub(PANEL_H + 1);

    let mut step = 0usize;           // 0=agent 1=branch 2=name 3=prompt
    let mut agent_sel = 0usize;
    let mut confirmed_agent = 0usize;
    let mut inputs = [String::new(), String::new(), String::new()]; // branch, name, prompt

    execute!(stdout, cursor::Show).ok();

    loop {
        // ── Draw panel ────────────────────────────────────────────────────────
        // Title row
        execute!(stdout, cursor::MoveTo(0, panel_top as u16)).ok();
        write!(stdout, "\x1b[{hd}m  New Session\x1b[0m", hd = t.header).ok();
        execute!(stdout, terminal::Clear(ClearType::UntilNewLine)).ok();

        // Blank separator
        execute!(stdout, cursor::MoveTo(0, (panel_top + 1) as u16)).ok();
        execute!(stdout, terminal::Clear(ClearType::UntilNewLine)).ok();

        let step_rows  = [panel_top + 2, panel_top + 3, panel_top + 4, panel_top + 5];
        let step_labels = ["  Agent", "  Worktree branch", "  Session name", "  Prompt"];

        for (i, (&row, &label)) in step_rows.iter().zip(step_labels.iter()).enumerate() {
            execute!(stdout, cursor::MoveTo(0, row as u16)).ok();
            let lpart = format!("{label:<LABEL_W$}");

            if i < step {
                // Completed — dim label, value in colour
                let val = if i == 0 {
                    let (name, _, col) = AGENTS[confirmed_agent];
                    format!("\x1b[38;5;{col}m{name}\x1b[0m")
                } else {
                    let v = inputs[i - 1].trim();
                    if v.is_empty() { format!("\x1b[{ft}m(skip)\x1b[0m", ft = t.text_faint) }
                    else            { format!("\x1b[{pm}m{v}\x1b[0m", pm = t.text_primary) }
                };
                write!(stdout, "\x1b[{dm}m{lpart}\x1b[0m{val}", dm = t.text_dim).ok();
            } else if i == step {
                // Active step
                write!(stdout, "\x1b[{pm}m{lpart}\x1b[0m", pm = t.text_primary).ok();
                if i == 0 {
                    // Inline agent picker
                    for (ai, (name, _, col)) in AGENTS.iter().enumerate() {
                        if ai > 0 { write!(stdout, "\x1b[{ft}m │ \x1b[0m", ft = t.text_faint).ok(); }
                        if ai == agent_sel {
                            write!(stdout, "\x1b[{sb};38;5;{col}m {name} \x1b[0m", sb = t.sel_bg).ok();
                        } else {
                            write!(stdout, "\x1b[{dm}m {name}\x1b[0m", dm = t.text_dim).ok();
                        }
                    }
                } else {
                    // Text input — print typed chars, terminal cursor sits here
                    write!(stdout, "\x1b[{pm}m{}\x1b[0m", inputs[i - 1], pm = t.text_primary).ok();
                }
            } else {
                // Future step — very dim label only
                write!(stdout, "\x1b[{ft}m{lpart}\x1b[0m", ft = t.text_faint).ok();
            }
            execute!(stdout, terminal::Clear(ClearType::UntilNewLine)).ok();
        }

        // Trailing blank row
        let blank2 = panel_top + 6;
        if blank2 < h.saturating_sub(1) {
            execute!(stdout, cursor::MoveTo(0, blank2 as u16)).ok();
            execute!(stdout, terminal::Clear(ClearType::UntilNewLine)).ok();
        }

        // Status bar hint
        let bar = if step == 0 {
            "  ↑↓/jk: select agent   enter: confirm   esc: cancel  "
        } else {
            "  type to enter   enter: next   esc: cancel  "
        };
        draw_status(stdout, bar, w, h).ok();

        // Position terminal cursor for text input steps
        if step > 0 {
            let row = step_rows[step];
            let col = (LABEL_W + inputs[step - 1].len()).min(w.saturating_sub(1));
            execute!(stdout, cursor::MoveTo(col as u16, row as u16)).ok();
        }
        stdout.flush().ok();

        // ── Handle input ──────────────────────────────────────────────────────
        match event::read().ok()? {
            Event::Key(k) => match k.code {
                KeyCode::Esc => {
                    execute!(stdout, cursor::Hide).ok();
                    return None;
                }
                KeyCode::Up   | KeyCode::Char('k') if step == 0 => {
                    if agent_sel > 0 { agent_sel -= 1; }
                }
                KeyCode::Down | KeyCode::Char('j') if step == 0 => {
                    if agent_sel + 1 < AGENTS.len() { agent_sel += 1; }
                }
                KeyCode::Backspace if step > 0 => {
                    inputs[step - 1].pop();
                }
                KeyCode::Char(c) if step > 0 && !k.modifiers.contains(crossterm::event::KeyModifiers::CONTROL) => {
                    inputs[step - 1].push(c);
                }
                KeyCode::Enter => match step {
                    0 => { confirmed_agent = agent_sel; step = 1; }
                    1 | 2 => { step += 1; }
                    _ => {
                        execute!(stdout, cursor::Hide).ok();
                        let (agent_name, agent_cli, _) = AGENTS[confirmed_agent];
                        let branch_raw = inputs[0].trim().to_string();
                        return Some(NewSessionConfig {
                            agent_name: agent_name.to_string(),
                            agent_cli: agent_cli.to_string(),
                            branch: if branch_raw.is_empty() { None } else { Some(branch_raw) },
                            session_name: inputs[1].trim().to_string(),
                            prompt: inputs[2].trim().to_string(),
                            repo_dir: repo_dir.to_string(),
                        });
                    }
                },
                _ => {}
            },
            _ => {}
        }
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn create_worktree(repo_dir: &str, branch: &str) -> String {
    let repo_path = std::path::Path::new(repo_dir);
    let parent = match repo_path.parent() {
        Some(p) => p,
        None => return "Error: cannot determine repo parent directory".to_string(),
    };
    let repo_name = repo_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "repo".to_string());
    let wt_path = parent.join(format!("{repo_name}-{branch}"));

    // Try -b (new branch) first; fall back to checking out an existing branch.
    let out = std::process::Command::new("git")
        .args(["worktree", "add", "-b", branch, wt_path.to_str().unwrap_or("")])
        .current_dir(repo_dir)
        .output();

    match out {
        Err(e) => format!("Error: {e}"),
        Ok(o) if o.status.success() => {
            format!("Created worktree: {}", short_path_s(wt_path.to_str().unwrap_or("")))
        }
        Ok(o) => {
            let msg = String::from_utf8_lossy(&o.stderr);
            let first = msg.lines().find(|l| !l.trim().is_empty()).unwrap_or("unknown error");
            format!("Error: {first}")
        }
    }
}

use super::agent_color;

fn short_path_s(path: &str) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    if !home.is_empty() && path.starts_with(&home) {
        format!("~{}", &path[home.len()..])
    } else {
        path.to_string()
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

pub fn run_for_dir(repo_dir: &str) -> Result<()> {
    let conn = db::connect()?;
    let repos = fetch_repos(&conn)?;
    let start = repos.iter().position(|r| r.directory == repo_dir);

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

    let outcome = tui_loop(&mut stdout, &repos, false, start);

    execute!(stdout, LeaveAlternateScreen, cursor::Show)?;
    terminal::disable_raw_mode()?;

    match outcome? {
        Some(TuiOutcome::ResumeSession { id, cwd }) => {
            super::show::resume_session(&id, &cwd);
        }
        Some(TuiOutcome::LaunchAgent { cli, cwd, session_name, prompt }) => {
            use std::os::unix::process::CommandExt;
            let mut cmd = std::process::Command::new(&cli);
            if !cwd.is_empty() { cmd.current_dir(&cwd); }
            if !session_name.is_empty() { cmd.args(["-n", &session_name]); }
            if !prompt.is_empty() { cmd.arg(&prompt); }
            let err = cmd.exec();
            eprintln!("Failed to launch {cli}: {err}");
        }
        _ => {}
    }

    Ok(())
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
