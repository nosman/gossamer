use anyhow::Result;
use std::collections::HashSet;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;

use crate::db;

pub struct CandidateRepo {
    pub name:      String,
    pub directory: String,
    pub remote:    String,
}

// ── Scanning ──────────────────────────────────────────────────────────────────

/// Walk ~/.claude/projects JSONL files, extract every unique `cwd`, resolve
/// each to a git repo root with a GitHub remote, and return the ones not
/// already in `known_dirs`.
pub fn scan_candidates(known_dirs: &HashSet<String>) -> Vec<CandidateRepo> {
    let home = std::env::var("HOME").unwrap_or_default();
    let projects = PathBuf::from(&home).join(".claude/projects");

    let mut unique_cwds: HashSet<String> = HashSet::new();
    if let Ok(dirs) = std::fs::read_dir(&projects) {
        for dir in dirs.flatten() {
            if let Ok(files) = std::fs::read_dir(dir.path()) {
                for file in files.flatten() {
                    let path = file.path();
                    if path.extension().and_then(|e| e.to_str()) != Some("jsonl") { continue; }
                    if let Some(cwd) = extract_cwd(&path) { unique_cwds.insert(cwd); }
                }
            }
        }
    }

    let mut seen_roots: HashSet<String> = HashSet::new();
    let mut seen_remotes: HashSet<String> = HashSet::new();
    let mut candidates: Vec<CandidateRepo> = Vec::new();

    // Also seed seen_remotes with remotes already in the DB so worktrees of
    // registered repos don't appear as candidates.
    for dir in known_dirs {
        let Ok(out) = Command::new("git")
            .args(["remote", "get-url", "origin"])
            .current_dir(dir)
            .output()
        else { continue };
        if out.status.success() {
            let remote = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !remote.is_empty() { seen_remotes.insert(remote); }
        }
    }

    for cwd in unique_cwds {
        if !std::path::Path::new(&cwd).is_dir() { continue; }

        let Ok(out) = Command::new("git")
            .args(["rev-parse", "--show-toplevel"])
            .current_dir(&cwd)
            .output()
        else { continue };
        if !out.status.success() { continue; }

        let toplevel = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if toplevel.is_empty() { continue; }

        // If `cwd` is inside a linked worktree, `--show-toplevel` gives the
        // worktree's own directory rather than the original repo. Resolve
        // back to the main worktree so we suggest tracking that instead.
        let root = resolve_main_root(&cwd).unwrap_or(toplevel);
        if seen_roots.contains(&root) { continue; }
        seen_roots.insert(root.clone());
        if known_dirs.contains(&root) { continue; }

        let Ok(out) = Command::new("git")
            .args(["remote", "get-url", "origin"])
            .current_dir(&root)
            .output()
        else { continue };
        if !out.status.success() { continue; }

        let remote = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !remote.contains("github.com") { continue; }
        if seen_remotes.contains(&remote) { continue; }
        seen_remotes.insert(remote.clone());

        let name = repo_name_from_remote(&remote);
        candidates.push(CandidateRepo { name, directory: root, remote });
    }

    candidates.sort_by(|a, b| a.name.cmp(&b.name));
    candidates
}

/// Resolve `dir` to the main worktree's root directory, even when `dir` is
/// itself a linked worktree. `--git-common-dir` always points at the shared
/// `.git` directory in the main worktree, regardless of which worktree it's
/// run from, so its parent is the original repo root.
fn resolve_main_root(dir: &str) -> Option<String> {
    let out = Command::new("git")
        .args(["rev-parse", "--git-common-dir"])
        .current_dir(dir)
        .output()
        .ok()?;
    if !out.status.success() { return None; }

    let common = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if common.is_empty() { return None; }
    let common_path = if std::path::Path::new(&common).is_absolute() {
        PathBuf::from(&common)
    } else {
        PathBuf::from(dir).join(&common)
    };

    let root = common_path.parent()?;
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    Some(root.to_string_lossy().to_string())
}

fn extract_cwd(path: &std::path::Path) -> Option<String> {
    use std::io::BufRead;
    let file = std::fs::File::open(path).ok()?;
    for line in std::io::BufReader::new(file).lines().take(20).flatten() {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
            if let Some(cwd) = v["cwd"].as_str() {
                if !cwd.is_empty() { return Some(cwd.to_string()); }
            }
        }
    }
    None
}

fn repo_name_from_remote(remote: &str) -> String {
    remote.rsplit('/').next().unwrap_or(remote)
        .trim_end_matches(".git")
        .to_string()
}

// ── Registration ──────────────────────────────────────────────────────────────

/// Insert candidates into the `repositories` table (idempotent) and backfill
/// local JSONL sessions whose cwd now resolves to one of the new repos.
/// Returns (repos_added, sessions_backfilled).
pub fn register_and_backfill(conn: &rusqlite::Connection, candidates: &[CandidateRepo]) -> Result<(usize, usize)> {
    let mut added = 0usize;
    for c in candidates {
        let rows = conn.execute(
            "INSERT OR IGNORE INTO repositories (directory, remote, name) VALUES (?1, ?2, ?3)",
            rusqlite::params![c.directory, c.remote, c.name],
        )?;
        added += rows;
    }

    let repos: Vec<(i64, String, String)> = {
        let mut stmt = conn.prepare("SELECT id, directory, remote FROM repositories")?;
        stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<Result<_, _>>()?
    };

    let resolver = crate::commands::index::RepoResolver::new(conn)?;
    let sessions = crate::commands::index::backfill_local_jsonls(conn, &repos, &resolver)?;
    Ok((added, sessions))
}

// ── CLI entry point ───────────────────────────────────────────────────────────

pub fn run(dry_run: bool, json: bool) -> Result<()> {
    let conn = db::connect()?;

    let known: HashSet<String> = {
        let mut stmt = conn.prepare("SELECT directory FROM repositories")?;
        stmt.query_map([], |row| row.get(0))?
            .collect::<Result<_, _>>()?
    };

    if !json { eprint!("Scanning…"); }
    let candidates = scan_candidates(&known);
    if !json { eprintln!(" done."); }

    if candidates.is_empty() {
        if json { println!("{}", serde_json::json!({"registered": [], "sessions_backfilled": 0})); }
        else     { println!("No new GitHub repositories found in your Claude session history."); }
        return Ok(());
    }

    if json {
        let arr: Vec<serde_json::Value> = candidates.iter().map(|c| serde_json::json!({
            "name": c.name, "directory": c.directory, "remote": c.remote,
        })).collect();
        if dry_run {
            println!("{}", serde_json::to_string_pretty(&serde_json::json!({"dry_run": true, "would_register": arr}))?);
        } else {
            let (added, sessions) = register_and_backfill(&conn, &candidates)?;
            println!("{}", serde_json::to_string_pretty(&serde_json::json!({
                "registered": arr, "repos_added": added, "sessions_backfilled": sessions,
            }))?);
        }
        return Ok(());
    }

    let t = crate::theme::get();
    println!("Found {} new GitHub repo{}:", candidates.len(), if candidates.len() == 1 { "" } else { "s" });
    for c in &candidates {
        let short = super::short_path(&c.directory);
        println!("  \x1b[1m{}\x1b[0m  \x1b[{dm}m{short}\x1b[0m", c.name, dm = t.text_dim);
    }

    if dry_run {
        println!("(dry run — nothing registered)");
        return Ok(());
    }

    let (added, sessions) = register_and_backfill(&conn, &candidates)?;
    println!("Registered {} repo(s), backfilled {} session(s).", added, sessions);
    Ok(())
}

// ── TUI overlay ───────────────────────────────────────────────────────────────

/// Interactive multi-select overlay. All candidates start checked. Returns
/// the selected subset, or `None` if the user cancelled.
pub(super) fn tui_discover(
    stdout: &mut impl Write,
    candidates: Vec<CandidateRepo>,
    w: usize,
    h: usize,
) -> Option<Vec<CandidateRepo>> {
    use crossterm::{cursor, event::{self, Event, KeyCode}, queue, terminal::{self, ClearType}};

    let mut selected: Vec<bool> = vec![true; candidates.len()];
    let mut sel = 0usize;
    let content_h = h.saturating_sub(2); // reserve title row + status bar

    let t = crate::theme::get();

    loop {
        let mut buf: Vec<u8> = Vec::with_capacity((w + 40) * (h + 2));

        // Title row
        queue!(buf, cursor::MoveTo(0, 0), terminal::Clear(ClearType::UntilNewLine)).ok();
        let n_sel: usize = selected.iter().filter(|&&s| s).count();
        write!(buf, "\x1b[{hd}m  Discovered repos\x1b[0m  \x1b[{dm}m{} found, {} selected\x1b[0m",
            candidates.len(), n_sel, hd = t.header, dm = t.text_dim).ok();

        // Candidate rows
        let scroll = if sel + 1 > content_h { sel + 1 - content_h } else { 0 };
        for (row, i) in (scroll..candidates.len()).take(content_h).enumerate() {
            let screen_row = (row + 1) as u16;
            queue!(buf, cursor::MoveTo(0, screen_row), terminal::Clear(ClearType::UntilNewLine)).ok();

            let c = &candidates[i];
            let check_col  = if selected[i] { t.fresh } else { t.text_faint };
            let check_char = if selected[i] { "x" } else { " " };
            let short = super::short_path(&c.directory);
            let remote_short: String = c.remote.chars().take(50).collect();

            let line = format!(
                "  \x1b[{check_col}m[{check_char}]\x1b[0m  \x1b[{pm}m{:<20}\x1b[0m  \x1b[{dm}m{:<35}  {remote_short}\x1b[0m",
                c.name, short, pm = t.text_primary, dm = t.text_dim,
            );

            if i == sel {
                let bg = t.sel_bg;
                let colored = super::with_bg(&line, bg);
                let vis = super::visible_width(&line);
                let pad = w.saturating_sub(vis);
                write!(buf, "\x1b[{bg}m{colored}{}\x1b[0m", " ".repeat(pad)).ok();
            } else {
                write!(buf, "{line}").ok();
            }
        }

        // Clear empty rows
        for row in (candidates.len() + 1)..=content_h {
            queue!(buf, cursor::MoveTo(0, row as u16), terminal::Clear(ClearType::UntilNewLine)).ok();
        }

        super::draw_statusbar(
            &mut buf,
            "  ↑↓/jk navigate   space: toggle   a: toggle all   enter: register selected   esc: cancel  ",
            w, h,
        ).ok();

        stdout.write_all(&buf).ok();
        stdout.flush().ok();

        match event::read().ok()? {
            Event::Key(k) => match k.code {
                KeyCode::Esc => return None,
                KeyCode::Enter => {
                    let result = candidates.into_iter()
                        .zip(selected)
                        .filter_map(|(c, s)| if s { Some(c) } else { None })
                        .collect();
                    return Some(result);
                }
                KeyCode::Up   | KeyCode::Char('k') => { if sel > 0 { sel -= 1; } }
                KeyCode::Down | KeyCode::Char('j') => { if sel + 1 < candidates.len() { sel += 1; } }
                KeyCode::Char(' ') => { selected[sel] = !selected[sel]; }
                KeyCode::Char('a') => {
                    let all = selected.iter().all(|&s| s);
                    selected.iter_mut().for_each(|s| *s = !all);
                }
                _ => {}
            },
            Event::Resize(nw, nh) => {
                let (w2, h2) = (nw as usize, nh as usize);
                // reborrow will use updated w/h on next iteration — but they're
                // captured by value, so just continue (slight sizing glitch ok here)
                let _ = (w2, h2);
            }
            _ => {}
        }
    }
}
