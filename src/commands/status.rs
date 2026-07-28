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

pub(super) struct NewSessionConfig {
    pub branch: Option<String>, // None = no new worktree
    pub session_name: String,
    pub prompt: String,
    pub repo_dir: String,
}

// ── Entry point ───────────────────────────────────────────────────────────────

/// Returns `Ok(true)` if the user pressed `q` (full app quit) somewhere in
/// this TUI or a nested viewer. `Ok(false)` for a normal back-out, JSON mode,
/// or the `gr` `cd` outcome.
pub fn run(json: bool) -> Result<bool> {
    let conn = db::connect()?;
    let mut repos = fetch_repos(&conn)?;

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
        return Ok(false);
    }

    if repos.is_empty() {
        println!("No repositories tracked. Run `entire gossamer discover --dry-run` to find repos you may want to track, or `entire gossamer init` in a git repo to add one individually.");
        return Ok(false);
    }

    // The shell wrapper sets GOSSAMER_CDPATH to a temp file path.
    // We write the selected directory there instead of stdout, avoiding all
    // the stdout-capture / /dev/tty complexity.
    let cd_file = std::env::var("GOSSAMER_CDPATH").ok();

    if !io::stdout().is_terminal() && cd_file.is_none() {
        // Plain list when truly non-interactive (piped, no wrapper)
        let cur_idx = find_repo_for_cwd(&repos);
        for (i, repo) in repos.iter().enumerate() {
            let dot = if cur_idx == Some(i) { "*" } else { " " };
            println!("{dot} {}  {}  {}", repo.name, repo.directory, repo.remote);
        }
        return Ok(false);
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

    let start_repo = find_repo_for_cwd(&repos);

    let outcome = tui_loop(&mut stdout, &mut repos, cd_file.is_some(), start_repo);

    execute!(stdout, LeaveAlternateScreen, cursor::Show)?;
    terminal::disable_raw_mode()?;

    let outcome = outcome?;
    let quit_app = matches!(outcome, Some(TuiOutcome::Quit));
    match outcome {
        Some(TuiOutcome::Quit) => {}
        Some(TuiOutcome::CdTo(path)) => {
            if let Some(file) = cd_file {
                std::fs::write(&file, &path)?;
            }
        }
        Some(TuiOutcome::ResumeSession { id, cwd }) => {
            super::show::resume_session(&id, &cwd);
        }
        Some(TuiOutcome::LaunchNewSession(cfg)) => { launch_new_session(cfg); }
        None => {}
    }

    Ok(quit_app)
}

enum TuiOutcome {
    /// User pressed q somewhere in the TUI (or a nested viewer). Parent
    /// callers should propagate as a full-app exit.
    Quit,
    CdTo(String),
    ResumeSession { id: String, cwd: String },
    LaunchNewSession(NewSessionConfig),
}

enum Screen {
    Repos { sel: usize },
    Sessions { repo_idx: usize, sel: usize, sessions: Vec<RepoSession>, worktrees: Vec<RepoWorktree> },
}

fn tui_loop(stdout: &mut impl Write, repos: &mut Vec<Repository>, has_cd: bool, start_repo: Option<usize>) -> Result<Option<TuiOutcome>> {
    let current_repo_idx = find_repo_for_cwd(repos);
    let current_repo_dir: Option<String> = current_repo_idx
        .and_then(|i| repos.get(i))
        .map(|r| r.directory.clone());

    let start_sel = current_repo_idx.unwrap_or(0);

    // Navigation stack — back pops; when empty the TUI exits.
    // When starting inside a tracked repo, seed the stack with the repos list
    // underneath so pressing Back always returns to it rather than exiting.
    let mut stack: Vec<Screen> = if let Some(idx) = start_repo.filter(|&i| i < repos.len()) {
        let sessions = session_list::fetch(Scope::Repo(&repos[idx]), true);
        let worktrees = fetch_worktrees(&repos[idx].directory);
        vec![
            Screen::Repos { sel: idx },
            Screen::Sessions { repo_idx: idx, sel: 0, sessions, worktrees },
        ]
    } else {
        vec![Screen::Repos { sel: start_sel }]
    };

    let mut awaiting_delete = false;
    let mut flash: Option<&'static str> = None;

    // Commands produced inside match arms, executed after the borrow ends.
    enum Cmd {
        None,
        Break,
        Back,
        PushSessions(usize),
        Cd(String),
        ShowSession(String),
        ResumeSession(String, String), // (session_id, repo_dir)
        DeleteSession(String),         // session_id
        Discover,
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
            Screen::Repos { sel } => draw_repos(stdout, repos, *sel, current_repo_dir.as_deref(), w, h, has_cd)?,
            Screen::Sessions { repo_idx, sel, sessions, worktrees } => {
                draw_sessions(stdout, repos, *repo_idx, sessions, worktrees, *sel, w, h, flash)?
            }
        }

        let cmd = match event::read()? {
            Event::Key(k) => match stack.last_mut().unwrap() {
                Screen::Repos { sel } => match k.code {
                    KeyCode::Char('q') => Cmd::Break,
                    KeyCode::Esc => Cmd::Back,
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
                    KeyCode::Char('/') => match super::collect_search_query(stdout, w, h) {
                        Some(q) if !q.trim().is_empty() => Cmd::Search(q),
                        _ => Cmd::Redraw,
                    },
                    KeyCode::Char('d') => Cmd::Discover,
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
                    KeyCode::Char('d') if !sessions.is_empty() => {
                        awaiting_delete = true;
                        flash = Some("  Delete session? Press y to confirm, any other key to cancel  ");
                        Cmd::None
                    }
                    KeyCode::Char('y') if awaiting_delete => {
                        awaiting_delete = false;
                        flash = None;
                        Cmd::DeleteSession(sessions[*sel].session_id.clone())
                    }
                    KeyCode::Char('/') => match super::collect_search_query(stdout, w, h) {
                        Some(q) if !q.trim().is_empty() => Cmd::Search(q),
                        _ => Cmd::Redraw,
                    },
                    KeyCode::Char('n') => match super::collect_text_input(stdout, "  new worktree branch: ", w, h) {
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
                    _ => { awaiting_delete = false; flash = None; Cmd::None }
                },
            },
            Event::Resize(_, _) => Cmd::Redraw,
            _ => Cmd::None,
        };

        match cmd {
            Cmd::None => {}
            Cmd::Break => return Ok(Some(TuiOutcome::Quit)),
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
            Cmd::DeleteSession(id) => {
                super::clean::remove_session(&id).ok();
                if let Some(Screen::Sessions { sel, sessions, .. }) = stack.last_mut() {
                    sessions.retain(|s| s.session_id != id);
                    if *sel >= sessions.len() && !sessions.is_empty() { *sel = sessions.len() - 1; }
                }
                execute!(stdout, terminal::Clear(ClearType::All)).ok();
            }
            Cmd::ShowSession(id) => {
                execute!(stdout, LeaveAlternateScreen, cursor::Show).ok();
                terminal::disable_raw_mode().ok();
                let result = super::show::run(&id);
                terminal::enable_raw_mode().ok();
                execute!(stdout, EnterAlternateScreen, cursor::Hide).ok();
                execute!(stdout, terminal::Clear(ClearType::All)).ok();
                match result {
                    Ok(true) => return Ok(Some(TuiOutcome::Quit)),
                    Err(_) => { flash = Some("  Transcript not found — run `entire gossamer ingest` to backfill  "); }
                    Ok(false) => {}
                }
            }
            Cmd::Search(query) => {
                execute!(stdout, LeaveAlternateScreen, cursor::Show).ok();
                terminal::disable_raw_mode().ok();
                let quit_app = super::search::run(&query, 10, false).unwrap_or(false);
                terminal::enable_raw_mode().ok();
                if quit_app { return Ok(Some(TuiOutcome::Quit)); }
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
                return Ok(Some(TuiOutcome::LaunchNewSession(cfg)));
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
            Cmd::Discover => {
                let (tw, th) = terminal::size().unwrap_or((120, 40));
                let scanning = format!("{:<width$}", "  Scanning for new repos…", width = tw as usize);
                execute!(stdout, cursor::MoveTo(0, th - 1)).ok();
                write!(stdout, "\x1b[7m{scanning}\x1b[0m").ok();
                stdout.flush().ok();

                let known: std::collections::HashSet<String> = repos.iter().map(|r| r.directory.clone()).collect();
                let candidates = super::discover::scan_candidates(&known);

                if candidates.is_empty() {
                    let msg = format!("{:<width$}", "  No new GitHub repos found in Claude session history — press any key  ", width = tw as usize);
                    execute!(stdout, cursor::MoveTo(0, th - 1)).ok();
                    write!(stdout, "\x1b[7m{msg}\x1b[0m").ok();
                    stdout.flush().ok();
                    event::read().ok();
                } else if let Some(selected) = super::discover::tui_discover(stdout, candidates, tw as usize, th as usize) {
                    if !selected.is_empty() {
                        if let Ok(conn) = crate::db::connect() {
                            super::discover::register_and_backfill(&conn, &selected).ok();
                            if let Ok(new_repos) = fetch_repos(&conn) {
                                *repos = new_repos;
                            }
                        }
                    }
                }
                execute!(stdout, terminal::Clear(ClearType::All)).ok();
            }
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
    use crossterm::queue;
    let t = crate::theme::get();
    let content_h = h.saturating_sub(1);
    let mut buf: Vec<u8> = Vec::with_capacity((w + 40) * (h + 2));
    let mut row = 0usize;

    let name_w = repos.iter().map(|r| r.name.chars().count()).max().unwrap_or(0);
    let dir_w  = repos.iter().map(|r| r.directory.chars().count()).max().unwrap_or(0);

    for (i, repo) in repos.iter().enumerate() {
        if row >= content_h { break }

        let is_sel = i == sel;
        let is_cur = current_repo_dir == Some(repo.directory.as_str());
        let star = if is_cur {
            format!("\x1b[{}m★\x1b[0m", t.fresh)
        } else {
            " ".to_string()
        };

        let name_padded = format!("{:<name_w$}", repo.name);
        let dir_padded  = format!("{:<dir_w$}",  repo.directory);
        let line = format!(
            "{star} \x1b[{pm}m{name_padded}\x1b[0m  \x1b[{dm}m{dir_padded}  {}\x1b[0m",
            repo.remote, pm = t.text_primary, dm = t.text_dim,
        );

        super::render_row(&mut buf, &line, is_sel, row, w)?;
        row += 1;
    }

    while row < content_h {
        queue!(buf, cursor::MoveTo(0, row as u16), terminal::Clear(ClearType::UntilNewLine))?;
        row += 1;
    }

    let cd_hint = if has_cd { "   c: cd" } else { "" };
    let bar = format!(
        "  {} repos   ↑↓/jk navigate   space: sessions   s: launch   d: discover   / search{}   q: quit  ",
        repos.len(), cd_hint
    );
    super::draw_statusbar(&mut buf, &bar, w, h)?;

    stdout.write_all(&buf)?;
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
    flash: Option<&str>,
) -> io::Result<()> {
    use crossterm::queue;
    let t = crate::theme::get();
    let content_h = h.saturating_sub(2); // header + status bar
    let mut buf: Vec<u8> = Vec::with_capacity((w + 40) * (h + 2));

    // Header row
    queue!(buf, cursor::MoveTo(0, 0), terminal::Clear(ClearType::UntilNewLine))?;
    write!(buf, "\x1b[{hd}m{}\x1b[0m", repos[repo_idx].name, hd = t.header)?;
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

            let path_short = super::short_path(&wt.path);
            let line = format!(
                "\x1b[{dm}m  @ \x1b[{branch_col}m{branch_label}\x1b[0m  \x1b[{dm}m{path_short}\x1b[0m",
                dm = t.text_dim,
            );
            queue!(buf, cursor::MoveTo(0, row as u16), terminal::Clear(ClearType::UntilNewLine))?;
            write!(buf, "{line}")?;
            row += 1;
        }

        if row < content_h {
            queue!(buf, cursor::MoveTo(0, row as u16), terminal::Clear(ClearType::UntilNewLine))?;
            row += 1;
        }
    }

    // ── Sessions ─────────────────────────────────────────────────────────────
    let sessions_start = row;
    let sessions_h = content_h.saturating_sub(sessions_start);
    // One row of sessions_h is consumed by the "session / branch / ..." header
    // drawn below, so only sessions_h - 1 rows are actually available for
    // entries. Without this, the scroll math thinks one more row is visible
    // than actually is, so the entry at the bottom edge computes as in view
    // but gets drawn past content_h and is dropped by the `row >= content_h`
    // break below — the highlighted row can end up off-screen.
    let entries_h = sessions_h.saturating_sub(1);
    let scroll = if sel >= entries_h { sel + 1 - entries_h } else { 0 };

    if sessions.is_empty() {
        if row < content_h {
            queue!(buf, cursor::MoveTo(0, row as u16), terminal::Clear(ClearType::UntilNewLine))?;
            write!(buf, "\x1b[{dm}m  no sessions found\x1b[0m", dm = t.text_dim)?;
            row += 1;
        }
    } else {
        let name_w   = sessions.iter().map(|s| s.session_name.trim().chars().count()).max().unwrap_or(0).min(40);
        let branch_w = sessions.iter().map(|s| s.branch.chars().count()).max().unwrap_or(0);
        let author_w = sessions.iter().map(|s| s.author.chars().count()).max().unwrap_or(0);
        let tokens_w = {
            let w = sessions.iter().map(|s| session_list::fmt_tokens(s.tokens_used).chars().count()).max().unwrap_or(0);
            if w > 0 { w.max(6) } else { 0 }
        };

        if row < content_h {
            let dm = t.text_dim;
            let mut hdr = format!("  {:<name_w$}", "session");
            if branch_w > 0 { hdr.push_str(&format!("  {:<branch_w$}", "branch")); }
            if author_w > 0 { hdr.push_str(&format!("  {:<author_w$}", "author")); }
            if tokens_w > 0 { hdr.push_str(&format!("  {:>tokens_w$}", "tokens")); }
            hdr.push_str("  id        updated");
            let display: String = hdr.chars().take(w).collect();
            queue!(buf, cursor::MoveTo(0, row as u16), terminal::Clear(ClearType::UntilNewLine))?;
            write!(buf, "\x1b[{dm}m{display}\x1b[0m")?;
            row += 1;
        }

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

            let (meta_col, dot_char) = if s.backed_up {
                (t.backed_meta, "★")
            } else {
                (t.unbacked_meta, "·")
            };
            let name_col = if s.name_is_explicit {
                t.backed_name
            } else if s.backed_up {
                t.text_secondary
            } else {
                t.unbacked_name
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

            if tokens_w > 0 {
                let tok = session_list::fmt_tokens(s.tokens_used);
                let pad = " ".repeat(tokens_w - tok.chars().count());
                let tk = session_list::token_color(s.tokens_used);
                line.push_str(&format!("  \x1b[{dm}m{pad}\x1b[{tk}m{tok}\x1b[0m", dm = t.text_dim));
            }

            line.push_str(&format!("  \x1b[{meta_col}m{id_short}  {ts}\x1b[0m"));

            super::render_row(&mut buf, &line, i == sel, row, w)?;
            row += 1;
        }
    }

    while row < content_h {
        queue!(buf, cursor::MoveTo(0, row as u16), terminal::Clear(ClearType::UntilNewLine))?;
        row += 1;
    }

    let base = format!(
        "  {} sessions   ↑↓/jk navigate   space: view   r: resume   d: delete   s: launch   n: new worktree   t: tidy   / search   ←/h: back   q: quit  ",
        sessions.len()
    );
    let bar = if let Some(msg) = flash {
        let skip = msg.chars().count();
        let rest: String = base.chars().skip(skip).collect();
        format!("{msg}{rest}")
    } else { base };
    super::draw_statusbar(&mut buf, &bar, w, h)?;

    stdout.write_all(&buf)?;
    stdout.flush()
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

// ── New session wizard ────────────────────────────────────────────────────────

/// A 3-step panel drawn over the bottom of the screen. Each completed step
/// stays visible with its confirmed value while the user fills the next one.
/// The prompt field (step 2) wraps across PROMPT_ROWS lines.
pub(super) fn new_session_wizard(stdout: &mut impl Write, repo_dir: &str, w: usize, h: usize) -> Option<NewSessionConfig> {
    const LABEL_W: usize = 24;
    const PROMPT_ROWS: usize = 3;
    // Panel: title + blank + branch + name + PROMPT_ROWS + blank
    const PANEL_H: usize = 4 + PROMPT_ROWS + 1;

    let t = crate::theme::get();
    let panel_top = h.saturating_sub(PANEL_H + 1);
    let input_w = w.saturating_sub(LABEL_W).max(1);

    let mut step = 0usize; // 0=branch 1=name 2=prompt
    let mut inputs = [String::new(), String::new(), String::new()];

    execute!(stdout, cursor::Show).ok();

    loop {
        // ── Draw panel ────────────────────────────────────────────────────────
        execute!(stdout, cursor::MoveTo(0, panel_top as u16)).ok();
        write!(stdout, "\x1b[{hd}m  Launch\x1b[0m", hd = t.header).ok();
        execute!(stdout, terminal::Clear(ClearType::UntilNewLine)).ok();

        execute!(stdout, cursor::MoveTo(0, (panel_top + 1) as u16)).ok();
        execute!(stdout, terminal::Clear(ClearType::UntilNewLine)).ok();

        let step_rows   = [panel_top + 2, panel_top + 3, panel_top + 4];
        let step_labels = ["  Worktree branch", "  Session name", "  Prompt"];

        for (i, (&row, &label)) in step_rows.iter().zip(step_labels.iter()).enumerate() {
            let lpart = format!("{label:<LABEL_W$}");

            if i == 2 {
                // Multi-row prompt area: show the tail end that fits in PROMPT_ROWS lines.
                let max_visible = PROMPT_ROWS * input_w;
                let chars: Vec<char> = inputs[i].chars().collect();
                let display_start = chars.len().saturating_sub(max_visible);
                let display_chars: Vec<char> = chars[display_start..].to_vec();

                for pr in 0..PROMPT_ROWS {
                    execute!(stdout, cursor::MoveTo(0, (row + pr) as u16)).ok();
                    let chunk: String = display_chars.iter().skip(pr * input_w).take(input_w).collect();
                    let indent = if pr == 0 { lpart.clone() } else { " ".repeat(LABEL_W) };

                    if i < step {
                        if pr == 0 && inputs[i].is_empty() {
                            write!(stdout, "\x1b[{dm}m{indent}\x1b[{ft}m(skip)\x1b[0m",
                                dm = t.text_dim, ft = t.text_faint).ok();
                        } else {
                            write!(stdout, "\x1b[{dm}m{indent}\x1b[{pm}m{chunk}\x1b[0m",
                                dm = t.text_dim, pm = t.text_primary).ok();
                        }
                    } else if i == step {
                        write!(stdout, "\x1b[{pm}m{indent}{chunk}\x1b[0m", pm = t.text_primary).ok();
                    } else if pr == 0 {
                        write!(stdout, "\x1b[{ft}m{indent}\x1b[0m", ft = t.text_faint).ok();
                    }
                    execute!(stdout, terminal::Clear(ClearType::UntilNewLine)).ok();
                }
                continue;
            }

            execute!(stdout, cursor::MoveTo(0, row as u16)).ok();
            if i < step {
                let v = inputs[i].trim();
                let val = if v.is_empty() {
                    format!("\x1b[{ft}m(skip)\x1b[0m", ft = t.text_faint)
                } else {
                    format!("\x1b[{pm}m{v}\x1b[0m", pm = t.text_primary)
                };
                write!(stdout, "\x1b[{dm}m{lpart}\x1b[0m{val}", dm = t.text_dim).ok();
            } else if i == step {
                write!(stdout, "\x1b[{pm}m{lpart}\x1b[0m", pm = t.text_primary).ok();
                write!(stdout, "\x1b[{pm}m{}\x1b[0m", inputs[i], pm = t.text_primary).ok();
            } else {
                write!(stdout, "\x1b[{ft}m{lpart}\x1b[0m", ft = t.text_faint).ok();
            }
            execute!(stdout, terminal::Clear(ClearType::UntilNewLine)).ok();
        }

        let blank2 = panel_top + 4 + PROMPT_ROWS;
        if blank2 < h.saturating_sub(1) {
            execute!(stdout, cursor::MoveTo(0, blank2 as u16)).ok();
            execute!(stdout, terminal::Clear(ClearType::UntilNewLine)).ok();
        }

        super::draw_statusbar(stdout, "  type to enter   enter: next   esc: cancel  ", w, h).ok();

        // ── Position cursor ───────────────────────────────────────────────────
        if step == 2 {
            let max_visible = PROMPT_ROWS * input_w;
            let display_len = inputs[step].chars().count().min(max_visible);
            let (row_off, col) = if display_len / input_w >= PROMPT_ROWS {
                (PROMPT_ROWS - 1, LABEL_W + input_w)
            } else {
                (display_len / input_w, LABEL_W + display_len % input_w)
            };
            execute!(stdout, cursor::MoveTo(
                col.min(w.saturating_sub(1)) as u16,
                (step_rows[2] + row_off) as u16,
            )).ok();
        } else {
            let col = (LABEL_W + inputs[step].len()).min(w.saturating_sub(1));
            execute!(stdout, cursor::MoveTo(col as u16, step_rows[step] as u16)).ok();
        }
        stdout.flush().ok();

        // ── Handle input ──────────────────────────────────────────────────────
        match event::read().ok()? {
            Event::Key(k) => match k.code {
                KeyCode::Esc => {
                    execute!(stdout, cursor::Hide).ok();
                    return None;
                }
                KeyCode::Backspace => { inputs[step].pop(); }
                KeyCode::Char(c) if !k.modifiers.contains(crossterm::event::KeyModifiers::CONTROL) => {
                    inputs[step].push(c);
                }
                KeyCode::Enter => match step {
                    0 | 1 => { step += 1; }
                    _ => {
                        execute!(stdout, cursor::Hide).ok();
                        let branch_raw = inputs[0].trim().to_string();
                        return Some(NewSessionConfig {
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

/// Create the worktree (if `cfg.branch` is set), copy the prompt to the
/// clipboard, then `exec` claude. Only returns if `exec` failed.
pub(super) fn launch_new_session(cfg: NewSessionConfig) {
    use std::os::unix::process::CommandExt;

    let launch_dir = if let Some(ref branch) = cfg.branch {
        let _ = create_worktree(&cfg.repo_dir, branch);
        let repo_path = std::path::Path::new(&cfg.repo_dir);
        let parent = repo_path.parent().unwrap_or(repo_path);
        let repo_name = repo_path.file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "repo".to_string());
        parent.join(format!("{repo_name}-{}", branch)).to_string_lossy().to_string()
    } else {
        cfg.repo_dir.clone()
    };

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
    let mut cmd = std::process::Command::new("claude");
    if !launch_dir.is_empty() { cmd.current_dir(&launch_dir); }
    if !session_name.is_empty() { cmd.args(["-n", &session_name]); }
    if !prompt.is_empty() { cmd.arg(&prompt); }
    let err = cmd.exec();
    eprintln!("Failed to launch claude: {err}");
}

pub(super) fn create_worktree(repo_dir: &str, branch: &str) -> String {
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
            format!("Created worktree: {}", super::short_path(wt_path.to_str().unwrap_or("")))
        }
        Ok(o) => {
            let msg = String::from_utf8_lossy(&o.stderr);
            let first = msg.lines().find(|l| !l.trim().is_empty()).unwrap_or("unknown error");
            format!("Error: {first}")
        }
    }
}


// Find which tracked repo the current directory belongs to — handles both the
// main worktree (starts_with match) and linked worktrees (git-common-dir match).
fn find_repo_for_cwd(repos: &[Repository]) -> Option<usize> {
    let cwd = env::current_dir().ok()?;
    let cwd_str = cwd.to_string_lossy();

    // Main worktree: cwd is inside the repo root
    if let Some(idx) = repos.iter().position(|r| cwd_str.starts_with(r.directory.as_str())) {
        return Some(idx);
    }

    // Linked worktree: git-common-dir points to the main repo's .git
    let out = std::process::Command::new("git")
        .args(["rev-parse", "--git-common-dir"])
        .current_dir(&cwd)
        .output()
        .ok()?;
    if !out.status.success() { return None; }

    let common = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let common_path = if std::path::Path::new(&common).is_absolute() {
        std::path::PathBuf::from(&common)
    } else {
        cwd.join(&common)
    };

    // common_path is the .git dir; its parent is the repo root
    let repo_root = common_path.parent()?.to_string_lossy().to_string();
    repos.iter().position(|r| r.directory == repo_root)
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

pub fn run_for_dir(repo_dir: &str) -> Result<bool> {
    let conn = db::connect()?;
    let mut repos = fetch_repos(&conn)?;
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

    let outcome = tui_loop(&mut stdout, &mut repos, false, start);

    execute!(stdout, LeaveAlternateScreen, cursor::Show)?;
    terminal::disable_raw_mode()?;

    let outcome = outcome?;
    let quit_app = matches!(outcome, Some(TuiOutcome::Quit));
    match outcome {
        Some(TuiOutcome::ResumeSession { id, cwd }) => {
            super::show::resume_session(&id, &cwd);
        }
        Some(TuiOutcome::LaunchNewSession(cfg)) => { launch_new_session(cfg); }
        _ => {}
    }

    Ok(quit_app)
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
