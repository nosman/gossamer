use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use crossterm::{
    cursor,
    event::{self, Event, KeyCode},
    execute,
    terminal::{self, ClearType, EnterAlternateScreen, LeaveAlternateScreen},
};
use std::io::{self, IsTerminal, Write};

// ── Hit types ─────────────────────────────────────────────────────────────────

#[derive(Clone)]
enum HitKind {
    Log,
    Session,
    Repo,
}

impl HitKind {
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
    dir: String,
    excerpt_lines: Vec<String>, // context lines: prev turn, matched turn, next turn
    session_id: Option<String>,
    repo_dir: Option<String>,
    start_ts: Option<String>,   // for navigation in show::run_at
    hit_ts: Option<String>,     // timestamp of the matched turn (for display)
    branch: String,
    // enriched from gossamer DB after search
    agent: String,
    backed_up: bool,
    updated_at: String,
    remote: String,
    author: String, // session author (first-checkpoint commit author), name > email > os_user
}

// Groups hits from the same session together under one header row.
struct Group {
    title: String,
    dir: String,
    branch: String,
    agent: String,
    backed_up: bool,
    updated_at: String,
    remote: String,
    session_id: Option<String>,
    repo_dir: Option<String>,
    kind: HitKind,
    rows: Vec<GroupRow>,
    author: String,
}

struct GroupRow {
    hit_ts: Option<String>,
    start_ts: Option<String>,
    lines: Vec<String>,
}

// ── Entry point ───────────────────────────────────────────────────────────────

/// Returns `Ok(true)` if the user pressed `q` (or Ctrl+C) anywhere within the
/// search TUI or any nested viewer — parent TUI loops should propagate this
/// as a full-app exit. `Ok(false)` means a normal back-out (Esc).
pub fn run(query: &str, top_k: usize, json: bool) -> Result<bool> {
    let assets = crate::config::resolve_warp_assets()
        .ok_or_else(|| anyhow::anyhow!(
            "Witchcraft assets not configured.\nRun: gossamer config <path-to-witchcraft-assets>"
        ))?;

    let db_path = dirs::home_dir()
        .ok_or_else(|| anyhow::anyhow!("cannot determine home directory"))?
        .join(".gossamer/search.db");

    let db = witchcraft::DB::new_reader(db_path)
        .map_err(|e| anyhow::anyhow!("failed to open search DB: {e}"))?;
    let device = witchcraft::make_device();
    let embedder = witchcraft::Embedder::new(&device, &assets)
        .context("failed to load embedder")?;
    let mut cache = witchcraft::EmbeddingsCache::new(1);

    const FLOOR:         f32 = 0.20;
    const LOG_THRESHOLD: f32 = 0.40;
    const SES_THRESHOLD: f32 = 0.25;
    const REP_THRESHOLD: f32 = 0.25;

    let t0 = std::time::Instant::now();
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

    for hit in search_sessions_by_name(query) {
        let already = hits.iter().any(|h| {
            matches!(h.kind, HitKind::Session) && h.session_id == hit.session_id
        });
        if !already { hits.insert(0, hit); }
    }
    for hit in search_repos_by_name(query) {
        let already = hits.iter().any(|h| {
            matches!(h.kind, HitKind::Repo) && h.repo_dir == hit.repo_dir
        });
        if !already { hits.insert(0, hit); }
    }
    hits.truncate(top_k);
    enrich_hits(&mut hits);

    let groups = build_groups(hits);

    if json || !io::stdout().is_terminal() {
        let arr: Vec<serde_json::Value> = groups.iter().map(|g| {
            let hits_json: Vec<serde_json::Value> = g.rows.iter().map(|r| serde_json::json!({
                "timestamp": r.hit_ts,
                "excerpt": r.lines.join(" "),
            })).collect();
            serde_json::json!({
                "kind": g.kind.label(),
                "session_id": g.session_id,
                "session_name": g.title,
                "dir": g.dir,
                "branch": g.branch,
                "author": g.author,
                "agent": g.agent,
                "updated_at": g.updated_at,
                "backed_up": g.backed_up,
                "remote": g.remote,
                "hits": hits_json,
            })
        }).collect();
        println!("{}", serde_json::to_string_pretty(&serde_json::json!({
            "query": query,
            "results": arr,
        }))?);
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

    let result = tui_loop(&mut stdout, &groups, query, ms);

    execute!(stdout, LeaveAlternateScreen, cursor::Show)?;
    terminal::disable_raw_mode()?;

    result
}

/// The ingest pipeline prefixes user turns with `[User] ` so the embedded
/// body string distinguishes roles. The author column now carries that
/// information at the row level, so strip the inline tag from excerpts.
fn strip_user_label(s: &str) -> String {
    s.strip_prefix("[User] ")
        .or_else(|| s.strip_prefix("[User]"))
        .unwrap_or(s)
        .to_string()
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
                dir: short_path(&cwd),
                excerpt_lines: vec![],
                session_id: meta["session_id"].as_str().map(str::to_string),
                repo_dir: None,
                start_ts: None, hit_ts: None, branch: String::new(),
                agent: String::new(), backed_up: false, updated_at: String::new(), author: String::new(),
                remote: String::new(),
            }
        }
        "repo" => {
            let name = meta["repo_name"].as_str().unwrap_or("").to_string();
            let dir  = meta["repo_dir"].as_str().unwrap_or("").to_string();
            SearchHit {
                kind: HitKind::Repo,
                title: name,
                dir: short_path(&dir),
                excerpt_lines: vec![],
                session_id: None,
                repo_dir: Some(dir),
                start_ts: None, hit_ts: None, branch: String::new(),
                agent: String::new(), backed_up: false, updated_at: String::new(), author: String::new(),
                remote: String::new(),
            }
        }
        _ => {
            // "claude" — session log turn
            let name   = meta["session_name"].as_str().unwrap_or("").to_string();
            let project = meta["project"].as_str().unwrap_or("").to_string();
            let branch  = meta["branch"].as_str().unwrap_or("").to_string();

            // Collect context: previous turn, matched turn, next turn.
            // bodies[0] is the header; bodies[N] for N>0 is a conversation turn.
            // Strip the "[User] " prefix the ingest pipeline bakes into every
            // user turn — the author column already shows who the user was,
            // so the inline label is redundant. "[Claude]" is kept because it
            // distinguishes assistant turns and has no column-level analog.
            let mut excerpt_lines: Vec<String> = Vec::new();
            if sub_idx > 1 {
                if let Some(prev) = bodies.get(sub_idx - 1) {
                    let t: String = strip_user_label(prev.trim()).chars().take(220).collect();
                    if !t.is_empty() { excerpt_lines.push(t); }
                }
            }
            if let Some(matched) = bodies.get(sub_idx) {
                let t: String = strip_user_label(matched.trim()).chars().take(400).collect();
                if !t.is_empty() { excerpt_lines.push(t); }
            }
            if sub_idx + 1 < bodies.len() {
                if let Some(next) = bodies.get(sub_idx + 1) {
                    let t: String = strip_user_label(next.trim()).chars().take(220).collect();
                    if !t.is_empty() { excerpt_lines.push(t); }
                }
            }

            let hit_ts = if sub_idx > 0 {
                meta["turns"][sub_idx - 1]["timestamp"].as_str()
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
            } else {
                None
            };

            SearchHit {
                kind: HitKind::Log,
                title: name,
                dir: short_path(&project),
                excerpt_lines,
                session_id: meta["session_id"].as_str().map(str::to_string),
                repo_dir: None,
                start_ts: hit_ts.clone(),
                hit_ts,
                branch,
                agent: String::new(), backed_up: false, updated_at: String::new(), author: String::new(),
                remote: String::new(),
            }
        }
    }
}

// ── Group building ────────────────────────────────────────────────────────────

fn build_groups(hits: Vec<SearchHit>) -> Vec<Group> {
    let mut groups: Vec<Group> = Vec::new();
    let mut log_group_idx: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

    for hit in hits {
        match hit.kind {
            HitKind::Log => {
                let sid = hit.session_id.clone().unwrap_or_default();
                if let Some(&gi) = log_group_idx.get(&sid) {
                    groups[gi].rows.push(GroupRow {
                        hit_ts: hit.hit_ts,
                        start_ts: hit.start_ts,
                        lines: hit.excerpt_lines,
                    });
                } else {
                    let gi = groups.len();
                    if !sid.is_empty() { log_group_idx.insert(sid, gi); }
                    groups.push(Group {
                        title: hit.title,
                        dir: hit.dir,
                        branch: hit.branch,
                        agent: hit.agent,
                        backed_up: hit.backed_up,
                        updated_at: hit.updated_at,
                        remote: hit.remote,
                        session_id: hit.session_id,
                        repo_dir: None,
                        kind: HitKind::Log,
                        author: hit.author,
                        rows: vec![GroupRow {
                            hit_ts: hit.hit_ts,
                            start_ts: hit.start_ts,
                            lines: hit.excerpt_lines,
                        }],
                    });
                }
            }
            HitKind::Session => {
                groups.push(Group {
                    title: hit.title,
                    dir: hit.dir,
                    branch: String::new(),
                    agent: hit.agent,
                    backed_up: hit.backed_up,
                    updated_at: hit.updated_at,
                    remote: hit.remote,
                    session_id: hit.session_id,
                    repo_dir: None,
                    kind: HitKind::Session,
                    author: hit.author,
                    rows: vec![],
                });
            }
            HitKind::Repo => {
                groups.push(Group {
                    title: hit.title,
                    dir: hit.dir,
                    branch: String::new(),
                    agent: String::new(),
                    backed_up: false,
                    updated_at: String::new(),
                    remote: hit.remote,
                    session_id: None,
                    repo_dir: hit.repo_dir,
                    kind: HitKind::Repo,
                    author: String::new(),
                    rows: vec![],
                });
            }
        }
    }

    groups
}

// ── TUI ───────────────────────────────────────────────────────────────────────

fn tui_loop(stdout: &mut impl Write, groups: &[Group], query: &str, ms: u128) -> Result<bool> {
    let mut sel    = 0usize;
    let mut scroll = 0usize;
    let mut quit_app = false;

    loop {
        let (w, h) = terminal::size().unwrap_or((120, 40));
        let w = w as usize;
        let h = h as usize;
        let content_h = h.saturating_sub(2);

        let sel_start = group_start_of(groups, sel);
        let sel_end   = sel_start + groups.get(sel).map_or(1, rows_for_group);
        if sel_start < scroll                { scroll = sel_start; }
        else if sel_end > scroll + content_h { scroll = sel_end.saturating_sub(content_h); }

        draw(stdout, groups, query, ms, sel, scroll, w, h)?;

        match event::read()? {
            Event::Key(k) => match k.code {
                KeyCode::Char('q') => { quit_app = true; break; }
                KeyCode::Esc => break,
                KeyCode::Char('c') if k.modifiers.contains(crossterm::event::KeyModifiers::CONTROL) => {
                    execute!(stdout, LeaveAlternateScreen, cursor::Show).ok();
                    terminal::disable_raw_mode().ok();
                    std::process::exit(0);
                }
                KeyCode::Up   | KeyCode::Char('k') => { if sel > 0 { sel -= 1; } }
                KeyCode::Down | KeyCode::Char('j') => { if sel + 1 < groups.len() { sel += 1; } }
                KeyCode::Char('g') => { sel = 0; scroll = 0; }
                KeyCode::Char('G') => { sel = groups.len().saturating_sub(1); }
                KeyCode::Char(' ') | KeyCode::Right | KeyCode::Enter => {
                    if let Some(group) = groups.get(sel) {
                        execute!(stdout, LeaveAlternateScreen, cursor::Show).ok();
                        terminal::disable_raw_mode().ok();

                        let nested_quit = match group.kind {
                            HitKind::Log | HitKind::Session => {
                                if let Some(id) = &group.session_id {
                                    let ts = group.rows.first().and_then(|r| r.start_ts.as_deref());
                                    super::show::run_at(id, ts).unwrap_or(false)
                                } else { false }
                            }
                            HitKind::Repo => {
                                if let Some(dir) = &group.repo_dir {
                                    let _ = super::status::run_for_dir(dir);
                                }
                                false
                            }
                        };

                        if nested_quit { quit_app = true; break; }

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

    Ok(quit_app)
}

fn rows_for_group(g: &Group) -> usize {
    1 + g.rows.iter().map(|r| r.lines.len().max(1)).sum::<usize>() + 1 // +1 for blank separator
}

fn group_start_of(groups: &[Group], idx: usize) -> usize {
    groups[..idx.min(groups.len())].iter().map(rows_for_group).sum()
}

// ── Rendering ─────────────────────────────────────────────────────────────────

fn draw(
    stdout: &mut impl Write,
    groups: &[Group],
    query:  &str,
    ms:     u128,
    sel:    usize,
    scroll: usize,
    w:      usize,
    h:      usize,
) -> io::Result<()> {
    use crossterm::queue;
    let t = crate::theme::get();
    let sel_bg = t.sel_bg;
    const TS_W: usize = 12; // fixed width of the timestamp column in excerpt rows

    let content_h = h.saturating_sub(2);
    let mut buf: Vec<u8> = Vec::with_capacity((w + 60) * (h + 2));

    // Title bar
    queue!(buf, cursor::MoveTo(0, 0), terminal::Clear(ClearType::UntilNewLine))?;
    let hdr = format!("  search: \"{}\"  {} result(s)  {}ms", query, groups.len(), ms);
    write!(buf, "\x1b[1m{}\x1b[0m", hdr.chars().take(w).collect::<String>())?;

    // Pre-compute column widths across all groups for tabular alignment.
    let name_w   = groups.iter().map(|g| g.title.trim().chars().count()).max().unwrap_or(0).min(45);
    let agent_w  = groups.iter().map(|g| g.agent.chars().count()).max().unwrap_or(0);
    let author_w = groups.iter().map(|g| g.author.chars().count()).max().unwrap_or(0);
    let branch_w = groups.iter().map(|g| g.branch.chars().count()).max().unwrap_or(0).min(30);

    let mut screen_row = 1usize; // next terminal row to write (row 0 is title bar)
    let mut abs_row    = 0usize; // absolute content row (before scroll is applied)

    for (gi, group) in groups.iter().enumerate() {
        if screen_row > content_h { break; }
        let selected = gi == sel;

        // ── Session header ────────────────────────────────────────────────
        if abs_row >= scroll && screen_row <= content_h {
            let age     = age_secs_hit(&group.updated_at);
            let dot_col = match age {
                a if a < 900   => t.fresh,
                a if a < 3_600 => t.moderate,
                _              => t.text_dim,
            };
            let (name_col, meta_col, dot_char) = if group.backed_up {
                (t.backed_name, t.backed_meta, "*")
            } else {
                (t.unbacked_name, t.unbacked_meta, "·")
            };

            let name: String = group.title.trim().chars().take(name_w).collect();
            let name_padded  = format!("{name:<name_w$}");
            let mut line = format!(
                "\x1b[{dot_col}m{dot_char}\x1b[0m \x1b[{name_col}m{name_padded}\x1b[0m  \x1b[{dm}m{}\x1b[0m",
                group.dir, dm = t.text_dim,
            );

            if branch_w > 0 {
                let branch_col = if group.backed_up { t.link } else { t.stale };
                let b: String = group.branch.chars().take(branch_w).collect();
                let pad = " ".repeat(branch_w - b.chars().count());
                line.push_str(&format!("  \x1b[{branch_col}m{b}{pad}\x1b[0m"));
            }

            if author_w > 0 {
                let a: String = group.author.chars().take(author_w).collect();
                let pad = " ".repeat(author_w - a.chars().count());
                let col = super::author_color(&group.author);
                line.push_str(&format!("  \x1b[38;5;{col}m{a}\x1b[0m{pad}"));
            }

            if agent_w > 0 {
                let col = if group.backed_up { agent_color(&group.agent) } else { t.stale_agent };
                let a: String = group.agent.chars().take(agent_w).collect();
                let pad = " ".repeat(agent_w - a.chars().count());
                line.push_str(&format!("  \x1b[38;5;{col}m{a}{pad}\x1b[0m"));
            }

            if let Some(sid) = &group.session_id {
                let id_short: String = sid.chars().take(8).collect();
                let ts = rel_time_hit(&group.updated_at);
                line.push_str(&format!("  \x1b[{meta_col}m{id_short}  {ts}\x1b[0m"));
            } else if matches!(group.kind, HitKind::Repo) {
                line.push_str(&format!("  \x1b[{meta_col}mrepo\x1b[0m"));
            }

            render_row(&mut buf, &line, selected, sel_bg, screen_row, w)?;
            screen_row += 1;
        }
        abs_row += 1;

        // ── Excerpt rows ──────────────────────────────────────────────────
        for row in &group.rows {
            let ts_str = row.hit_ts.as_deref().map(rel_time_hit).unwrap_or_default();
            let n_lines = row.lines.len().max(1);
            let excerpt_indent = " ".repeat(2 + TS_W + 2);

            for li in 0..n_lines {
                if abs_row >= scroll && screen_row <= content_h {
                    let text = row.lines.get(li).map(String::as_str).unwrap_or("");
                    let avail = w.saturating_sub(2 + TS_W + 2);
                    let text_t: String = text.chars().take(avail).collect();

                    let exc_line = if li == 0 {
                        let ts_padded = format!("{ts_str:>TS_W$}");
                        format!(
                            "  \x1b[{dm}m{ts_padded}\x1b[0m  \x1b[{sc}m{text_t}\x1b[0m",
                            dm = t.text_dim, sc = t.text_secondary,
                        )
                    } else {
                        format!("{excerpt_indent}\x1b[{sc}m{text_t}\x1b[0m", sc = t.text_secondary)
                    };

                    render_row(&mut buf, &exc_line, selected, sel_bg, screen_row, w)?;
                    screen_row += 1;
                }
                abs_row += 1;
            }
        }

        // Blank separator row between groups
        if abs_row >= scroll && screen_row <= content_h {
            queue!(buf, cursor::MoveTo(0, screen_row as u16), terminal::Clear(ClearType::UntilNewLine))?;
            screen_row += 1;
        }
        abs_row += 1;
    }

    // Clear any leftover rows below the results.
    while screen_row <= content_h {
        queue!(buf, cursor::MoveTo(0, screen_row as u16), terminal::Clear(ClearType::UntilNewLine))?;
        screen_row += 1;
    }

    // Status bar
    let bar = "  ↑↓/jk: navigate   space/→: open   q/esc: quit  ";
    let padded = format!("{:<width$}", bar.chars().take(w).collect::<String>(), width = w);
    queue!(buf, cursor::MoveTo(0, (h - 1) as u16))?;
    write!(buf, "\x1b[7m{padded}\x1b[0m")?;

    stdout.write_all(&buf)?;
    stdout.flush()
}

fn render_row(buf: &mut Vec<u8>, line: &str, selected: bool, bg: &str, row: usize, w: usize) -> io::Result<()> {
    use crossterm::queue;
    queue!(buf, cursor::MoveTo(0, row as u16), terminal::Clear(ClearType::UntilNewLine))?;
    if selected {
        let colored = with_bg(line, bg);
        let vis = visible_len(line);
        let pad = w.saturating_sub(vis);
        write!(buf, "\x1b[{bg}m{colored}{}\x1b[0m", " ".repeat(pad))?;
    } else {
        write!(buf, "{line}")?;
    }
    Ok(())
}

// ── DB enrichment ─────────────────────────────────────────────────────────────

fn enrich_hits(hits: &mut Vec<SearchHit>) {
    let Ok(conn) = crate::db::connect() else { return };
    for hit in hits.iter_mut() {
        if let Some(sid) = &hit.session_id {
            // Pull agent + remote, plus the first checkpoint's author (matching
            // the resolution session_list::query_db uses: name > email > os_user).
            if let Ok((agent, updated_at, remote, author_name, author_email, author_os_user)) =
                conn.query_row(
                    "SELECT s.agent_name, s.updated_at, COALESCE(r.remote, ''),
                            COALESCE(c.author_name, ''), COALESCE(c.author_email, ''),
                            COALESCE(c.os_user, '')
                     FROM sessions s
                     LEFT JOIN repositories r
                       ON (s.cwd = r.directory OR s.cwd LIKE r.directory || '/%')
                     LEFT JOIN checkpoints c
                       ON c.session_id = s.session_id
                      AND c.checkpoint_number = (
                            SELECT MIN(checkpoint_number) FROM checkpoints
                            WHERE session_id = s.session_id
                          )
                     WHERE s.session_id = ?1",
                    [sid.as_str()],
                    |row| Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                    )),
                )
            {
                hit.agent      = agent;
                hit.updated_at = updated_at;
                hit.backed_up  = true;
                hit.remote     = remote;
                hit.author     = if !author_name.trim().is_empty() { author_name }
                                 else if !author_email.trim().is_empty() { author_email }
                                 else { author_os_user };
            }
        } else if let Some(dir) = &hit.repo_dir.clone() {
            if let Ok(remote) = conn.query_row(
                "SELECT COALESCE(remote, '') FROM repositories WHERE directory = ?1",
                [dir.as_str()],
                |row| row.get::<_, String>(0),
            ) {
                hit.remote = remote;
            }
        }
    }
}

// ── Direct name search ────────────────────────────────────────────────────────

fn search_sessions_by_name(query: &str) -> Vec<SearchHit> {
    let words: Vec<String> = query.split_whitespace().map(|w| w.to_lowercase()).collect();
    if words.is_empty() { return vec![]; }

    let Ok(conn) = crate::db::connect() else { return vec![]; };
    let Ok(mut stmt) = conn.prepare(
        "SELECT session_id, session_name, cwd FROM sessions WHERE session_name != ''"
    ) else { return vec![]; };

    stmt.query_map([], |row| Ok((row.get::<_,String>(0)?, row.get::<_,String>(1)?, row.get::<_,String>(2)?)))
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|(session_id, session_name, cwd): (String, String, String)| {
            let normalized = session_name.to_lowercase().replace(['-', '_'], " ");
            if words.iter().all(|w| normalized.contains(w.as_str())) {
                Some(SearchHit {
                    kind: HitKind::Session,
                    title: session_name,
                    dir: short_path(&cwd),
                    excerpt_lines: vec![],
                    session_id: Some(session_id),
                    repo_dir: None,
                    start_ts: None, hit_ts: None, branch: String::new(),
                    agent: String::new(), backed_up: false, updated_at: String::new(), author: String::new(),
                    remote: String::new(),
                })
            } else {
                None
            }
        })
        .collect()
}

fn search_repos_by_name(query: &str) -> Vec<SearchHit> {
    let words: Vec<String> = query.split_whitespace().map(|w| w.to_lowercase()).collect();
    if words.is_empty() { return vec![]; }

    let Ok(conn) = crate::db::connect() else { return vec![]; };
    let Ok(mut stmt) = conn.prepare(
        "SELECT name, directory, COALESCE(remote, '') FROM repositories WHERE name != ''"
    ) else { return vec![]; };

    stmt.query_map([], |row| Ok((row.get::<_,String>(0)?, row.get::<_,String>(1)?, row.get::<_,String>(2)?)))
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|(name, directory, remote): (String, String, String)| {
            let normalized = name.to_lowercase().replace(['-', '_'], " ");
            if words.iter().all(|w| normalized.contains(w.as_str())) {
                Some(SearchHit {
                    kind: HitKind::Repo,
                    title: name,
                    dir: short_path(&directory),
                    excerpt_lines: vec![],
                    session_id: None,
                    repo_dir: Some(directory),
                    start_ts: None, hit_ts: None, branch: String::new(),
                    agent: String::new(), backed_up: false, updated_at: String::new(), author: String::new(),
                    remote,
                })
            } else {
                None
            }
        })
        .collect()
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn rel_time_hit(iso: &str) -> String {
    if iso.is_empty() { return String::new(); }
    let Ok(dt) = DateTime::parse_from_rfc3339(iso) else { return String::new(); };
    let secs = (Utc::now() - dt.with_timezone(&Utc)).num_seconds().max(0);
    if secs < 604_800 {
        match secs {
            s if s < 60     => "just now".into(),
            s if s < 3_600  => format!("{} min ago", s / 60),
            s if s < 86_400 => format!("{} hr ago",  s / 3_600),
            s               => format!("{} day{} ago", s / 86_400, if s / 86_400 == 1 { "" } else { "s" }),
        }
    } else {
        dt.with_timezone(&chrono::Local).format("%m/%d/%y").to_string()
    }
}

fn age_secs_hit(iso: &str) -> i64 {
    if iso.is_empty() { return i64::MAX; }
    let Ok(dt) = DateTime::parse_from_rfc3339(iso) else { return i64::MAX; };
    (Utc::now() - dt.with_timezone(&Utc)).num_seconds().max(0)
}

use super::agent_color;

fn with_bg(s: &str, bg: &str) -> String {
    let reinsert = format!("\x1b[0m\x1b[{bg}m");
    format!("\x1b[{bg}m{}", s.replace("\x1b[0m", &reinsert))
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
