use anyhow::{Context, Result};
use crossterm::{
    cursor,
    event::{self, Event, KeyCode},
    execute,
    terminal::{self, ClearType, EnterAlternateScreen, LeaveAlternateScreen},
};
use std::io::{self, IsTerminal, Write};

// ── Hit types ─────────────────────────────────────────────────────────────────

enum HitKind {
    Log,
    Session,
    Repo,
}

impl HitKind {
    fn badge(&self) -> &'static str {
        match self {
            HitKind::Log     => "[log]",
            HitKind::Session => "[ses]",
            HitKind::Repo    => "[rep]",
        }
    }
    fn color(&self) -> &'static str {
        match self {
            HitKind::Log     => "38;5;75",
            HitKind::Session => "38;5;177",
            HitKind::Repo    => "38;5;220",
        }
    }
    fn label(&self) -> &'static str {
        match self {
            HitKind::Log     => "log",
            HitKind::Session => "ses",
            HitKind::Repo    => "rep",
        }
    }
}

struct SearchHit {
    kind: HitKind,
    title: String,
    repo_name: String,  // last path component of the cwd/dir
    excerpt: String,    // one-line text snippet (log hits only)
    dir: String,        // short path — shown dim at the end
    session_id: Option<String>,
    repo_dir: Option<String>,
    start_ts: Option<String>,
}

// ── Entry point ───────────────────────────────────────────────────────────────

pub fn run(query: &str, top_k: usize) -> Result<()> {
    let assets = crate::config::resolve_warp_assets()
        .ok_or_else(|| anyhow::anyhow!(
            "Witchcraft assets not configured.\nRun: gossamer config <path-to-witchcraft-assets>"
        ))?;

    let db_path = dirs::home_dir()
        .ok_or_else(|| anyhow::anyhow!("cannot determine home directory"))?
        .join(".gossamer/search.db");

    let db = witchcraft::DB::new_reader(db_path).map_err(|e| anyhow::anyhow!("failed to open search DB: {e}"))?;
    let device = witchcraft::make_device();
    let embedder = witchcraft::Embedder::new(&device, &assets).context("failed to load embedder")?;
    let mut cache = witchcraft::EmbeddingsCache::new(1);

    // Per-type thresholds. Fetch at the global minimum so witchcraft doesn't
    // filter anything we'd keep, then post-filter per source type.
    const FLOOR:         f32 = 0.20;
    const LOG_THRESHOLD: f32 = 0.40;
    const SES_THRESHOLD: f32 = 0.25;
    const REP_THRESHOLD: f32 = 0.25;

    let t0 = std::time::Instant::now();
    // Over-fetch so there are enough candidates after per-type filtering.
    let raw = witchcraft::search(&db, &embedder, &mut cache, query, FLOOR, top_k * 4, true, None)?;
    let ms = t0.elapsed().as_millis();

    let mut hits: Vec<SearchHit> = raw
        .iter()
        .filter_map(|(score, meta, bodies, sub_idx, _date)| {
            let hit = parse_hit(meta, bodies, *sub_idx as u32);
            let threshold = match hit.kind {
                HitKind::Log     => LOG_THRESHOLD,
                HitKind::Session => SES_THRESHOLD,
                HitKind::Repo    => REP_THRESHOLD,
            };
            if *score >= threshold { Some(hit) } else { None }
        })
        .take(top_k)
        .collect();

    // Direct name-match search: finds sessions/repos whose names contain all
    // query words even when hyphens/underscores differ from the query.
    for hit in search_sessions_by_name(query) {
        let already = hits.iter().any(|h| {
            matches!(h.kind, HitKind::Session) && h.session_id == hit.session_id
        });
        if !already {
            hits.insert(0, hit);
        }
    }
    for hit in search_repos_by_name(query) {
        let already = hits.iter().any(|h| {
            matches!(h.kind, HitKind::Repo) && h.repo_dir == hit.repo_dir
        });
        if !already {
            hits.insert(0, hit);
        }
    }
    hits.truncate(top_k);

    if !io::stdout().is_terminal() {
        for h in &hits {
            println!("[{}]  {}", h.kind.label(), h.title);
        }
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

    let result = tui_loop(&mut stdout, &hits, query, ms);

    execute!(stdout, LeaveAlternateScreen, cursor::Show)?;
    terminal::disable_raw_mode()?;

    result
}

// ── Hit parsing ───────────────────────────────────────────────────────────────

fn parse_hit(metadata_json: &str, bodies: &[String], sub_idx: u32) -> SearchHit {
    let sub_idx = sub_idx as usize;
    let meta: serde_json::Value = serde_json::from_str(metadata_json).unwrap_or_default();
    let source = meta["source"].as_str().unwrap_or("claude");

    match source {
        "session" => {
            let name = meta["session_name"].as_str().unwrap_or("").to_string();
            let cwd  = meta["cwd"].as_str().unwrap_or("").to_string();
            SearchHit {
                kind: HitKind::Session,
                title: name,
                repo_name: last_component(&cwd),
                excerpt: String::new(),
                dir: short_path(&cwd),
                session_id: meta["session_id"].as_str().map(str::to_string),
                repo_dir: None,
                start_ts: None,
            }
        }
        "repo" => {
            let name = meta["repo_name"].as_str().unwrap_or("").to_string();
            let dir  = meta["repo_dir"].as_str().unwrap_or("").to_string();
            SearchHit {
                kind: HitKind::Repo,
                title: name,
                repo_name: String::new(), // same as title, skip
                excerpt: String::new(),
                dir: short_path(&dir),
                session_id: None,
                repo_dir: Some(dir),
                start_ts: None,
            }
        }
        _ => {
            // "claude" — session log turn
            let name    = meta["session_name"].as_str().unwrap_or("").to_string();
            let project = meta["project"].as_str().unwrap_or("").to_string();
            let idx = sub_idx.min(bodies.len().saturating_sub(1));
            let excerpt: String = bodies
                .get(idx)
                .and_then(|b| b.lines().find(|l| !l.trim().is_empty()))
                .map(|l| l.chars().take(80).collect())
                .unwrap_or_default();
            // Prefer the stored path (most reliable); fall back to session UUID lookup.
            let open_id = meta["path"].as_str()
                .filter(|p| !p.is_empty())
                .map(str::to_string)
                .or_else(|| meta["session_id"].as_str().map(str::to_string));
            // sub_idx 0 = header chunk; 1+ maps to turns[sub_idx - 1].
            let start_ts = if sub_idx > 0 {
                meta["turns"][sub_idx - 1]["timestamp"].as_str()
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
            } else {
                None
            };
            SearchHit {
                kind: HitKind::Log,
                title: name,
                repo_name: last_component(&project),
                excerpt,
                dir: short_path(&project),
                session_id: open_id,
                repo_dir: None,
                start_ts,
            }
        }
    }
}

// ── TUI ───────────────────────────────────────────────────────────────────────

fn tui_loop(stdout: &mut impl Write, hits: &[SearchHit], query: &str, ms: u128) -> Result<()> {
    let mut sel = 0usize;

    loop {
        let (w, h) = terminal::size().unwrap_or((120, 40));
        draw(stdout, hits, query, ms, sel, w as usize, h as usize)?;

        match event::read()? {
            Event::Key(k) => match k.code {
                KeyCode::Char('q') | KeyCode::Esc => break,
                KeyCode::Up   | KeyCode::Char('k') => { if sel > 0 { sel -= 1; } }
                KeyCode::Down | KeyCode::Char('j') => { if sel + 1 < hits.len() { sel += 1; } }
                KeyCode::Char('g') => { sel = 0; }
                KeyCode::Char('G') => { sel = hits.len().saturating_sub(1); }
                KeyCode::Char(' ') | KeyCode::Right | KeyCode::Enter => {
                    if let Some(hit) = hits.get(sel) {
                        // Temporarily leave the TUI, open the view, then come back.
                        execute!(stdout, LeaveAlternateScreen, cursor::Show).ok();
                        terminal::disable_raw_mode().ok();

                        match hit.kind {
                            HitKind::Log => {
                                if let Some(id) = &hit.session_id {
                                    let _ = super::show::run_at(id, hit.start_ts.as_deref());
                                }
                            }
                            HitKind::Session => {
                                if let Some(id) = &hit.session_id {
                                    let _ = super::show::run(id);
                                }
                            }
                            HitKind::Repo => {
                                if let Some(dir) = &hit.repo_dir {
                                    let _ = super::status::run_for_dir(dir);
                                }
                            }
                        }

                        terminal::enable_raw_mode().ok();
                        execute!(stdout, EnterAlternateScreen, cursor::Hide).ok();
                        execute!(stdout, terminal::Clear(ClearType::All)).ok();
                    }
                }
                _ => {}
            },
            Event::Resize(_, _) => {
                execute!(stdout, terminal::Clear(ClearType::All)).ok();
            }
            _ => {}
        }
    }

    Ok(())
}

// ── Rendering ─────────────────────────────────────────────────────────────────

fn draw(
    stdout: &mut impl Write,
    hits: &[SearchHit],
    query: &str,
    ms: u128,
    sel: usize,
    w: usize,
    h: usize,
) -> io::Result<()> {
    const SEL_BG: &str = "48;5;236";

    let query_words: Vec<String> = query
        .split_whitespace()
        .map(|s| s.to_lowercase())
        .collect();

    execute!(stdout, cursor::MoveTo(0, 0))?;

    // Header
    let header = format!("search: \"{}\"  {} result(s)  {}ms", query, hits.len(), ms);
    let header_t: String = header.chars().take(w).collect();
    write!(stdout, "\x1b[1m{header_t}\x1b[0m")?;
    execute!(stdout, terminal::Clear(ClearType::UntilNewLine))?;

    let content_h = h.saturating_sub(2); // header + status bar
    let scroll = if sel >= content_h { sel + 1 - content_h } else { 0 };
    let mut row = 1usize;

    for (i, hit) in hits.iter().enumerate().skip(scroll) {
        if row >= content_h { break; }

        // ── Layout (left→right): badge  title  repo  excerpt  dir ──────────
        //
        // Fixed overhead: 2 (indent) + 5 (badge) + 2 (sep after badge) = 9
        // Dir: up to 28 chars, always at the end
        // Repo: up to 18 chars, only when non-empty
        // Excerpt: up to 45 chars, only when non-empty
        // Title: whatever's left, min 8

        let dir_raw: String   = hit.dir.chars().take(28).collect();
        let dir_vis           = dir_raw.chars().count();

        // Don't repeat the repo name when it's the same as the title (repo hits).
        let repo_raw: String  = if !hit.repo_name.is_empty() && hit.repo_name != hit.title {
            hit.repo_name.chars().take(18).collect()
        } else {
            String::new()
        };
        let repo_vis = repo_raw.chars().count();

        // Right-side budget consumed by dir + repo
        let right_fixed = 2 + dir_vis + if repo_vis > 0 { 2 + repo_vis } else { 0 };

        // Excerpt gets up to 45 chars of whatever's left after a min title of 10
        let excerpt_budget = w.saturating_sub(9 + 10 + right_fixed + 2).min(45);
        let excerpt_raw: String = hit.excerpt.chars().take(excerpt_budget).collect();
        let excerpt_vis = excerpt_raw.chars().count();

        // Title fills the rest
        let title_budget = w.saturating_sub(
            9 + right_fixed + if excerpt_vis > 0 { 2 + excerpt_vis } else { 0 }
        ).max(8);
        let title_raw: String = hit.title.chars().take(title_budget).collect();

        // Apply query-word highlighting to title and excerpt
        let title_hl   = highlight(&title_raw, &query_words);
        let excerpt_hl = highlight(&excerpt_raw, &query_words);

        let badge_col = hit.kind.color();
        let badge     = hit.kind.badge();

        let mut line = format!(
            "\x1b[{badge_col}m{badge}\x1b[0m  \x1b[38;5;255m{title_hl}\x1b[0m"
        );
        if repo_vis > 0 {
            line.push_str(&format!("  \x1b[38;5;248m{repo_raw}\x1b[0m"));
        }
        if excerpt_vis > 0 {
            line.push_str(&format!("  \x1b[38;5;242m{excerpt_hl}\x1b[0m"));
        }
        line.push_str(&format!("  \x1b[38;5;238m{dir_raw}\x1b[0m"));

        print_row(stdout, &line, i == sel, SEL_BG, w, row as u16)?;
        row += 1;
    }

    while row < content_h {
        execute!(stdout, cursor::MoveTo(0, row as u16), terminal::Clear(ClearType::UntilNewLine))?;
        row += 1;
    }

    // Status bar
    let bar = "  ↑↓/jk: navigate   space/→: open   q/esc: quit  ";
    let bar_t: String = bar.chars().take(w).collect();
    let padded = format!("{:<width$}", bar_t, width = w);
    execute!(stdout, cursor::MoveTo(0, (h - 1) as u16))?;
    write!(stdout, "\x1b[7m{padded}\x1b[0m")?;

    stdout.flush()
}

fn print_row(stdout: &mut impl Write, line: &str, selected: bool, bg: &str, w: usize, row: u16) -> io::Result<()> {
    let content = format!("  {line}");
    execute!(stdout, cursor::MoveTo(0, row))?;
    if selected {
        let colored = with_bg(&content, bg);
        let vis = visible_len(&content);
        let pad = w.saturating_sub(vis);
        write!(stdout, "\x1b[{bg}m{colored}{}\x1b[0m", " ".repeat(pad))?;
    } else {
        write!(stdout, "{content}")?;
        execute!(stdout, terminal::Clear(ClearType::UntilNewLine))?;
    }
    Ok(())
}

// ── Direct name search ────────────────────────────────────────────────────────

fn search_sessions_by_name(query: &str) -> Vec<SearchHit> {
    let words: Vec<String> = query
        .split_whitespace()
        .map(|w| w.to_lowercase())
        .collect();
    if words.is_empty() {
        return vec![];
    }

    let Ok(conn) = crate::db::connect() else { return vec![]; };
    let Ok(mut stmt) = conn.prepare(
        "SELECT session_id, session_name, cwd FROM sessions WHERE session_name != ''"
    ) else { return vec![]; };

    let Ok(mapped) = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))) else {
        return vec![];
    };

    mapped
        .flatten()
        .filter_map(|(session_id, session_name, cwd): (String, String, String)| {
            let normalized = session_name.to_lowercase().replace(['-', '_'], " ");
            if words.iter().all(|w| normalized.contains(w.as_str())) {
                Some(SearchHit {
                    kind: HitKind::Session,
                    title: session_name,
                    repo_name: last_component(&cwd),
                    excerpt: String::new(),
                    dir: short_path(&cwd),
                    session_id: Some(session_id),
                    repo_dir: None,
                    start_ts: None,
                })
            } else {
                None
            }
        })
        .collect()
}

fn search_repos_by_name(query: &str) -> Vec<SearchHit> {
    let words: Vec<String> = query
        .split_whitespace()
        .map(|w| w.to_lowercase())
        .collect();
    if words.is_empty() {
        return vec![];
    }

    let Ok(conn) = crate::db::connect() else { return vec![]; };
    let Ok(mut stmt) = conn.prepare(
        "SELECT name, directory FROM repositories WHERE name != ''"
    ) else { return vec![]; };

    let Ok(mapped) = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?))) else {
        return vec![];
    };

    mapped
        .flatten()
        .filter_map(|(name, directory): (String, String)| {
            let normalized = name.to_lowercase().replace(['-', '_'], " ");
            if words.iter().all(|w| normalized.contains(w.as_str())) {
                Some(SearchHit {
                    kind: HitKind::Repo,
                    title: name,
                    repo_name: String::new(), // same as title
                    excerpt: String::new(),
                    dir: short_path(&directory),
                    session_id: None,
                    repo_dir: Some(directory),
                    start_ts: None,
                })
            } else {
                None
            }
        })
        .collect()
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Highlight query words in `text` with bold amber. Works on byte positions in
/// the (ASCII-safe) lowercased copy, applied back to the original text.
fn highlight(text: &str, words: &[String]) -> String {
    if words.is_empty() || text.is_empty() {
        return text.to_string();
    }

    let lower = text.to_lowercase();
    let mut ranges: Vec<(usize, usize)> = vec![];

    for word in words {
        let mut start = 0;
        while let Some(pos) = lower[start..].find(word.as_str()) {
            let abs = start + pos;
            let end = abs + word.len();
            if lower.is_char_boundary(abs) && lower.is_char_boundary(end) {
                ranges.push((abs, end));
            }
            start = abs + 1;
        }
    }

    if ranges.is_empty() {
        return text.to_string();
    }

    ranges.sort_unstable();
    let mut merged: Vec<(usize, usize)> = vec![];
    for (s, e) in ranges {
        if let Some(last) = merged.last_mut() {
            if s < last.1 {
                last.1 = last.1.max(e);
                continue;
            }
        }
        merged.push((s, e));
    }

    let mut out = String::new();
    let mut cursor = 0;
    for (s, e) in merged {
        out.push_str(&text[cursor..s]);
        out.push_str("\x1b[38;5;220;1m");
        out.push_str(&text[s..e]);
        out.push_str("\x1b[0m");
        cursor = e;
    }
    out.push_str(&text[cursor..]);
    out
}

fn with_bg(s: &str, bg: &str) -> String {
    let reinsert = format!("\x1b[0m\x1b[{bg}m");
    let body = s.replace("\x1b[0m", &reinsert);
    format!("\x1b[{bg}m{body}")
}

fn visible_len(s: &str) -> usize {
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

fn short_path(path: &str) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    if !home.is_empty() && path.starts_with(&home) {
        format!("~{}", &path[home.len()..])
    } else {
        path.to_string()
    }
}

fn last_component(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}
