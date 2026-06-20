use anyhow::Result;
use chrono::{DateTime, Duration, Utc};
use crossterm::{
    cursor,
    event::{self, Event, KeyCode},
    execute,
    terminal::{self, ClearType},
};
use std::io::Write;
use std::path::PathBuf;

use crate::{db, entity::repository::Repository};

pub struct StaleWorktree {
    pub repo_dir: String,
    pub path: String,
    pub branch: String,
}

// ── Core logic ────────────────────────────────────────────────────────────────

fn worktree_paths(repo_dir: &str) -> Vec<(String, String, bool)> {
    let out = std::process::Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(repo_dir)
        .output();

    let Ok(out) = out else { return vec![]; };
    if !out.status.success() { return vec![]; }
    let text = String::from_utf8_lossy(&out.stdout);

    let mut result = Vec::new();
    let mut first = true;

    for block in text.split("\n\n") {
        let mut path = String::new();
        let mut branch = String::new();
        let mut detached = false;

        for line in block.lines() {
            if let Some(v) = line.strip_prefix("worktree ") { path = v.to_string(); }
            else if let Some(v) = line.strip_prefix("branch refs/heads/") { branch = v.to_string(); }
            else if line == "detached" { detached = true; }
        }

        if path.is_empty() { continue; }
        if detached { branch = "(detached)".to_string(); }
        if branch.is_empty() { continue; }

        let is_main = first;
        result.push((path, branch, is_main));
        first = false;
    }

    result
}

fn is_worktree_active(wt_path: &str, threshold: DateTime<Utc>) -> bool {
    // Check gossamer DB for sessions whose cwd is inside this worktree
    if let Ok(conn) = db::connect() {
        let pattern = format!("{wt_path}%");
        let threshold_str = threshold.to_rfc3339();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sessions WHERE cwd LIKE ?1 AND updated_at >= ?2",
            rusqlite::params![pattern, threshold_str],
            |row| row.get(0),
        ).unwrap_or(0);
        if count > 0 { return true; }
    }

    // Check Claude JSONL files for recently-modified sessions whose cwd matches
    let Ok(home) = std::env::var("HOME") else { return false };
    let projects = PathBuf::from(&home).join(".claude/projects");
    let Ok(dirs) = std::fs::read_dir(&projects) else { return false };

    for dir_entry in dirs.flatten() {
        let dir = dir_entry.path();
        if !dir.is_dir() { continue; }
        let Ok(files) = std::fs::read_dir(&dir) else { continue };
        for f in files.flatten() {
            let path = f.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") { continue; }

            let mtime: DateTime<Utc> = f.metadata().ok()
                .and_then(|m| m.modified().ok())
                .map(DateTime::from)
                .unwrap_or_else(Utc::now);
            if mtime < threshold { continue; }

            let Ok(content) = std::fs::read_to_string(&path) else { continue };
            for line in content.lines() {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
                if v["cwd"].as_str().is_some_and(|c| c.starts_with(wt_path)) {
                    return true;
                }
            }
        }
    }

    false
}

pub fn find_stale(repos: &[Repository], age_days: i64) -> Vec<StaleWorktree> {
    let threshold = Utc::now() - Duration::days(age_days);
    let mut stale = Vec::new();

    for repo in repos {
        for (path, branch, is_main) in worktree_paths(&repo.directory) {
            if is_main { continue; }
            if !is_worktree_active(&path, threshold) {
                stale.push(StaleWorktree {
                    repo_dir: repo.directory.clone(),
                    path,
                    branch,
                });
            }
        }
    }

    stale
}

fn remove_worktree(repo_dir: &str, wt_path: &str, force: bool) -> Result<()> {
    let mut args = vec!["worktree", "remove", wt_path];
    if force { args.push("--force"); }
    let out = std::process::Command::new("git")
        .args(&args)
        .current_dir(repo_dir)
        .output()?;
    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr);
        anyhow::bail!("{}", msg.trim());
    }
    Ok(())
}

fn short_path(path: &str) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    if !home.is_empty() && path.starts_with(&home) {
        format!("~{}", &path[home.len()..])
    } else {
        path.to_string()
    }
}

// ── Session cleanup ───────────────────────────────────────────────────────────

/// Delete all sessions (DB rows, event log, search index) whose cwd was inside `wt_path`.
/// Returns the session IDs that were removed.
fn clean_sessions_for_worktree(wt_path: &str) -> Vec<String> {
    let Ok(conn) = db::connect() else { return vec![]; };
    let pattern = format!("{wt_path}%");

    let mut stmt = match conn.prepare("SELECT session_id FROM sessions WHERE cwd LIKE ?1") {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    let ids: Vec<String> = stmt
        .query_map([&pattern], |row| row.get(0))
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default();

    let mut removed = Vec::new();
    for id in &ids {
        let _ = std::process::Command::new("entire").args(["clean", "--session", id, "--force"]).status();
        let _ = conn.execute("DELETE FROM event_log WHERE session_id = ?1", rusqlite::params![id]);
        if conn.execute("DELETE FROM sessions WHERE session_id = ?1", rusqlite::params![id]).is_ok() {
            removed.push(id.clone());
        }
        if let Ok(mut wc_db) = crate::ingest::open_search_db() {
            use witchcraft::types::{
                SqlConditionInternal, SqlOperator, SqlStatementInternal, SqlStatementType, SqlValue,
            };
            let filter = SqlStatementInternal {
                statement_type: SqlStatementType::Condition,
                condition: Some(SqlConditionInternal {
                    key: "$.session_id".to_string(),
                    operator: SqlOperator::Equals,
                    value: Some(SqlValue::String(id.clone())),
                }),
                logic: None,
                statements: None,
            };
            let _ = wc_db.delete_with_filter(&filter);
        }
    }
    removed
}

// ── CLI entry point ───────────────────────────────────────────────────────────

pub fn run(age_days: i64, dry_run: bool, force: bool, clean_sessions: bool, json: bool) -> Result<()> {
    let conn = db::connect()?;
    let repos = super::status::fetch_repos(&conn)?;
    let stale = find_stale(&repos, age_days);

    if stale.is_empty() {
        if json {
            println!("{}", serde_json::json!({"removed": [], "dry_run": dry_run}));
        } else {
            println!("No stale worktrees found (threshold: {} days).", age_days);
        }
        return Ok(());
    }

    if dry_run {
        if !json {
            println!("Stale worktrees (would be removed):");
            for wt in &stale {
                println!("  {} [{}]", short_path(&wt.path), wt.branch);
            }
        } else {
            let paths: Vec<_> = stale.iter().map(|w| serde_json::json!({
                "path": short_path(&w.path), "branch": w.branch,
            })).collect();
            println!("{}", serde_json::json!({"would_remove": paths, "dry_run": true}));
        }
        return Ok(());
    }

    if !json {
        println!("Removing stale worktrees:");
    }

    let mut removed = Vec::new();
    let mut errors: Vec<(String, String)> = Vec::new();

    for wt in &stale {
        match remove_worktree(&wt.repo_dir, &wt.path, force) {
            Ok(()) => {
                if !json { println!("  removed worktree: {}", short_path(&wt.path)); }
                if clean_sessions {
                    let ids = clean_sessions_for_worktree(&wt.path);
                    if !json && !ids.is_empty() {
                        println!("  removed {} session{}", ids.len(), if ids.len() == 1 { "" } else { "s" });
                    }
                }
                removed.push(wt.path.clone());
            }
            Err(e) => {
                if !json { eprintln!("  error: {} — {e}", short_path(&wt.path)); }
                errors.push((wt.path.clone(), e.to_string()));
            }
        }
    }

    if json {
        println!("{}", serde_json::to_string_pretty(&serde_json::json!({
            "removed": removed.iter().map(|p| serde_json::json!({
                "path": short_path(p),
            })).collect::<Vec<_>>(),
            "errors": errors.iter().map(|(p, e)| serde_json::json!({
                "path": short_path(p), "error": e,
            })).collect::<Vec<_>>(),
            "dry_run": false,
        }))?);
    }

    Ok(())
}

// ── TUI entry point ───────────────────────────────────────────────────────────

/// Shows stale worktrees for `repos` and asks for confirmation before removing.
/// Returns true if any worktrees were removed (caller should refresh the worktree list).
pub fn tui_tidy(
    stdout: &mut impl Write,
    repos: &[Repository],
    age_days: i64,
    clean_sessions: bool,
    w: usize,
    h: usize,
) -> bool {
    let stale = find_stale(repos, age_days);
    let mut clean_sessions = clean_sessions;

    if stale.is_empty() {
        let msg = format!("{:<width$}", "  No stale worktrees to remove.", width = w);
        execute!(stdout, cursor::MoveTo(0, (h - 1) as u16)).ok();
        write!(stdout, "\x1b[7m{msg}\x1b[0m").ok();
        stdout.flush().ok();
        let _ = event::read();
        return false;
    }

    let max_items = h.saturating_sub(5);
    let list_h = stale.len().min(max_items).max(1);
    let panel_h = list_h + 2; // title + list rows
    let panel_top = h.saturating_sub(panel_h + 1);

    let t = crate::theme::get();
    loop {
        // Title
        execute!(stdout, cursor::MoveTo(0, panel_top as u16)).ok();
        write!(stdout, "\x1b[{tw}m  Tidy — stale worktrees\x1b[0m", tw = t.tidy_warn).ok();
        execute!(stdout, terminal::Clear(ClearType::UntilNewLine)).ok();

        // List
        for (i, wt) in stale.iter().take(list_h).enumerate() {
            execute!(stdout, cursor::MoveTo(0, (panel_top + 1 + i) as u16)).ok();
            write!(
                stdout,
                "  \x1b[{dm}m[{}]\x1b[0m \x1b[{pm}m{}\x1b[0m",
                wt.branch, short_path(&wt.path), dm = t.text_dim, pm = t.text_primary,
            ).ok();
            execute!(stdout, terminal::Clear(ClearType::UntilNewLine)).ok();
        }
        if stale.len() > list_h {
            let overflow_row = panel_top + 1 + list_h;
            if overflow_row < h.saturating_sub(1) {
                execute!(stdout, cursor::MoveTo(0, overflow_row as u16)).ok();
                write!(stdout, "  \x1b[{dm}m... and {} more\x1b[0m", stale.len() - list_h, dm = t.text_dim).ok();
                execute!(stdout, terminal::Clear(ClearType::UntilNewLine)).ok();
            }
        }

        // Status bar
        let count = stale.len();
        let sess_state = if clean_sessions { "[on]" } else { "[off]" };
        let hint = format!(
            "  y: remove {count} worktree{}   s: +sessions {sess_state}   esc/n: cancel  ",
            if count == 1 { "" } else { "s" },
        );
        let bar = format!("{:<width$}", hint, width = w);
        execute!(stdout, cursor::MoveTo(0, (h - 1) as u16)).ok();
        write!(stdout, "\x1b[7m{bar}\x1b[0m").ok();
        stdout.flush().ok();

        match event::read().ok() {
            Some(Event::Key(k)) => match k.code {
                KeyCode::Char('y') | KeyCode::Char('Y') => {
                    let mut n_wt = 0usize;
                    let mut n_sess = 0usize;
                    for wt in &stale {
                        if remove_worktree(&wt.repo_dir, &wt.path, false).is_ok() {
                            n_wt += 1;
                            if clean_sessions {
                                n_sess += clean_sessions_for_worktree(&wt.path).len();
                            }
                        }
                    }
                    let mut summary = format!(
                        "  Removed {n_wt} worktree{}",
                        if n_wt == 1 { "" } else { "s" },
                    );
                    if clean_sessions {
                        summary.push_str(&format!(
                            " and {n_sess} session{}",
                            if n_sess == 1 { "" } else { "s" },
                        ));
                    }
                    summary.push('.');
                    let done = format!("{:<width$}", summary, width = w);
                    execute!(stdout, cursor::MoveTo(0, (h - 1) as u16)).ok();
                    write!(stdout, "\x1b[7m{done}\x1b[0m").ok();
                    stdout.flush().ok();
                    let _ = event::read();
                    return n_wt > 0;
                }
                KeyCode::Char('s') | KeyCode::Char('S') => { clean_sessions = !clean_sessions; }
                KeyCode::Char('n') | KeyCode::Esc | KeyCode::Char('q') => return false,
                _ => {}
            },
            _ => {}
        }
    }
}
