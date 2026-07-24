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
    Checkpoint,
    Session,
    Repo,
    RepoHeader, // non-selectable separator injected between repo groups
}

impl HitKind {
    fn label(&self) -> &'static str {
        match self {
            HitKind::Log        => "log",
            HitKind::Checkpoint => "cp",
            HitKind::Session    => "ses",
            HitKind::Repo       => "rep",
            HitKind::RepoHeader => "",
        }
    }
}

struct SearchHit {
    kind: HitKind,
    title: String,
    dir: String,
    excerpt_lines: Vec<String>, // context lines: prev turn, matched turn, next turn
    match_line_idx: usize,      // which index in excerpt_lines is the actual match
    session_id: Option<String>,
    repo_dir: Option<String>,
    turn_id: Option<String>,       // JSONL message uuid — used for precise navigation
    hit_ts: Option<String>,        // timestamp of the matched turn (for display)
    hit_off: Option<u64>,          // byte offset in the JSONL of the matched line
    checkpoint_id: Option<String>, // for HitKind::Checkpoint — navigate to the specific checkpoint card
    branch: String,
    // enriched from gossamer DB after search
    agent: String,
    backed_up: bool,
    updated_at: String,
    remote: String,
    repo_name: String,
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
    repo_name: String,
    session_id: Option<String>,
    repo_dir: Option<String>,
    kind: HitKind,
    rows: Vec<GroupRow>,
    author: String,
}

struct GroupRow {
    hit_ts: Option<String>,
    hit_off: Option<u64>,
    turn_id: Option<String>,
    checkpoint_id: Option<String>,
    lines: Vec<String>,
    /// Index into `lines` of the actually-matched chunk (others are context).
    match_line_idx: usize,
    is_checkpoint: bool,
}

// ── Entry point ───────────────────────────────────────────────────────────────

/// Returns `Ok(true)` if the user pressed `q` (or Ctrl+C) anywhere within the
/// search TUI or any nested viewer — parent TUI loops should propagate this
/// as a full-app exit. `Ok(false)` means a normal back-out (Esc).
pub fn run(query: &str, top_k: usize, json: bool) -> Result<bool> {
    let assets = crate::config::resolve_warp_assets()
        .ok_or_else(|| anyhow::anyhow!(
            "Witchcraft assets not configured.\nRun: entire gossamer assets <path-to-witchcraft-assets>"
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

    // Collect all above-threshold witchcraft hits (up to top_k*4), then cap
    // at 2 per session so one long session can't crowd out the rest.
    const MAX_HITS_PER_SESSION: usize = 2;
    let mut session_hit_counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut hits: Vec<SearchHit> = raw
        .iter()
        .filter_map(|(score, meta, bodies, sub_idx, _date)| {
            let hit = parse_hit(meta, bodies, *sub_idx as u32);
            let threshold = match hit.kind {
                HitKind::Log | HitKind::Checkpoint => LOG_THRESHOLD,
                HitKind::Session                   => SES_THRESHOLD,
                HitKind::Repo | HitKind::RepoHeader => REP_THRESHOLD,
            };
            if *score >= threshold { Some(hit) } else { None }
        })
        .filter(|hit| {
            // Session/Repo hits (no turn content) are not subject to the cap.
            let Some(sid) = &hit.session_id else { return true; };
            if matches!(hit.kind, HitKind::Session | HitKind::Repo) { return true; }
            let count = session_hit_counts.entry(sid.clone()).or_insert(0);
            if *count < MAX_HITS_PER_SESSION { *count += 1; true } else { false }
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
        let arr: Vec<serde_json::Value> = groups.iter().filter(|g| !matches!(g.kind, HitKind::RepoHeader)).map(|g| {
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
                dir: super::short_path(&cwd),
                excerpt_lines: vec![], match_line_idx: 0,
                session_id: meta["session_id"].as_str().map(str::to_string),
                repo_dir: None,
                turn_id: None, hit_ts: None, hit_off: None, checkpoint_id: None, branch: String::new(),
                agent: String::new(), backed_up: false, updated_at: String::new(), author: String::new(),
                remote: String::new(), repo_name: String::new(),
            }
        }
        "repo" => {
            let name = meta["repo_name"].as_str().unwrap_or("").to_string();
            let dir  = meta["repo_dir"].as_str().unwrap_or("").to_string();
            SearchHit {
                kind: HitKind::Repo,
                title: name,
                dir: super::short_path(&dir),
                excerpt_lines: vec![], match_line_idx: 0,
                session_id: None,
                repo_dir: Some(dir),
                turn_id: None, hit_ts: None, hit_off: None, checkpoint_id: None, branch: String::new(),
                agent: String::new(), backed_up: false, updated_at: String::new(), author: String::new(),
                remote: String::new(), repo_name: String::new(),
            }
        }
        "checkpoint" => {
            let name    = meta["session_name"].as_str().unwrap_or("").to_string();
            let project = meta["project"].as_str().unwrap_or("").to_string();
            let message = bodies.first()
                .and_then(|b| b.lines().find(|l| l.starts_with("[Checkpoint] ")))
                .map(|l| l.trim_start_matches("[Checkpoint] ").to_string())
                .unwrap_or_default();
            SearchHit {
                kind: HitKind::Checkpoint,
                title: name,
                dir: super::short_path(&project),
                excerpt_lines: if message.is_empty() { vec![] } else { vec![message] },
                match_line_idx: 0,
                session_id: meta["session_id"].as_str().map(str::to_string),
                repo_dir: None,
                turn_id: None,
                hit_ts: None,
                hit_off: None,
                checkpoint_id: meta["checkpoint_id"].as_str().map(str::to_string),
                branch: String::new(),
                agent: String::new(), backed_up: false, updated_at: String::new(),
                author: String::new(), remote: String::new(), repo_name: String::new(),
            }
        }
        _ => {
            // "claude" — session log turn.
            // sub_idx=0 means the [project] header line matched — not a useful
            // content hit (session-name matching is handled separately). Drop it.
            if sub_idx == 0 {
                return SearchHit {
                    kind: HitKind::Session,
                    title: meta["session_name"].as_str().unwrap_or("").to_string(),
                    dir: super::short_path(meta["project"].as_str().unwrap_or("")),
                    excerpt_lines: vec![], match_line_idx: 0,
                    session_id: meta["session_id"].as_str().map(str::to_string),
                    repo_dir: None,
                    turn_id: None, hit_ts: None, hit_off: None, checkpoint_id: None,
                    branch: meta["branch"].as_str().unwrap_or("").to_string(),
                    agent: String::new(), backed_up: false, updated_at: String::new(),
                    author: String::new(), remote: String::new(), repo_name: String::new(),
                };
            }

            let name    = meta["session_name"].as_str().unwrap_or("").to_string();
            let project = meta["project"].as_str().unwrap_or("").to_string();
            let branch  = meta["branch"].as_str().unwrap_or("").to_string();

            let mut excerpt_lines: Vec<String> = Vec::new();
            // Track which line in excerpt_lines is the actual match (not context).
            let mut match_line_idx: usize = 0;
            if sub_idx > 1 {
                if let Some(prev) = bodies.get(sub_idx - 1) {
                    let t: String = strip_user_label(prev.trim()).chars().take(220).collect();
                    if !t.is_empty() {
                        excerpt_lines.push(t);
                        match_line_idx = excerpt_lines.len(); // matched line will follow
                    }
                }
            }
            if let Some(matched) = bodies.get(sub_idx) {
                let t: String = strip_user_label(matched.trim()).chars().take(400).collect();
                if !t.is_empty() {
                    match_line_idx = excerpt_lines.len();
                    excerpt_lines.push(t);
                }
            }
            if sub_idx + 1 < bodies.len() {
                if let Some(next) = bodies.get(sub_idx + 1) {
                    let t: String = strip_user_label(next.trim()).chars().take(220).collect();
                    if !t.is_empty() { excerpt_lines.push(t); }
                }
            }

            // sub_idx 0 = header matched, 1+ = turns[sub_idx-1] matched.
            let turn_meta = if sub_idx > 0 { &meta["turns"][sub_idx - 1] } else { &serde_json::Value::Null };
            let hit_ts  = turn_meta["timestamp"].as_str().filter(|s| !s.is_empty()).map(str::to_string);
            let turn_id = turn_meta["uuid"].as_str().filter(|s| !s.is_empty()).map(str::to_string);
            let hit_off = turn_meta["off"].as_u64();

            SearchHit {
                kind: HitKind::Log,
                title: name,
                dir: super::short_path(&project),
                excerpt_lines,
                match_line_idx,
                session_id: meta["session_id"].as_str().map(str::to_string),
                repo_dir: None,
                turn_id,
                hit_ts,
                hit_off,
                checkpoint_id: None,
                branch,
                agent: String::new(), backed_up: false, updated_at: String::new(), author: String::new(),
                remote: String::new(), repo_name: String::new(),
            }
        }
    }
}

// ── Group building ────────────────────────────────────────────────────────────

// Each hit becomes its own selectable group — one header row + one excerpt row.
// We do not merge multiple hits from the same session; that produced a wall of
// text that couldn't be navigated individually.
const MAX_HITS_PER_SESSION: usize = 3;

fn build_groups(hits: Vec<SearchHit>) -> Vec<Group> {
    let mut groups: Vec<Group> = Vec::new();
    let mut hits_per_session: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

    for hit in hits {
        match hit.kind {
            HitKind::Log | HitKind::Checkpoint => {
                let is_cp = matches!(hit.kind, HitKind::Checkpoint);
                // Log hits with no excerpt are header-only matches (sub_idx==0);
                // they produce blank rows and convey nothing useful — drop them.
                if !is_cp && hit.excerpt_lines.is_empty() {
                    continue;
                }
                // Cap per-session hits so one very-relevant session doesn't
                // consume all result slots.
                if let Some(sid) = &hit.session_id {
                    let n = hits_per_session.entry(sid.clone()).or_insert(0);
                    if *n >= MAX_HITS_PER_SESSION { continue; }
                    *n += 1;
                }
                groups.push(Group {
                    title: hit.title,
                    dir: hit.dir,
                    branch: hit.branch,
                    agent: hit.agent,
                    backed_up: hit.backed_up,
                    updated_at: hit.updated_at,
                    remote: hit.remote,
                    repo_name: hit.repo_name,
                    session_id: hit.session_id,
                    repo_dir: None,
                    kind: if is_cp { HitKind::Checkpoint } else { HitKind::Log },
                    author: hit.author,
                    rows: vec![GroupRow {
                        hit_ts: hit.hit_ts,
                        hit_off: hit.hit_off,
                        turn_id: hit.turn_id,
                        checkpoint_id: hit.checkpoint_id,
                        lines: hit.excerpt_lines,
                        match_line_idx: hit.match_line_idx,
                        is_checkpoint: is_cp,
                    }],
                });
            }
            HitKind::Session => {
                // Skip if this session already appeared as a Log/Checkpoint hit,
                // or if we've already emitted a Session hit for it.
                if let Some(sid) = &hit.session_id {
                    let n = hits_per_session.entry(sid.clone()).or_insert(0);
                    if *n > 0 { continue; }
                    *n += 1;
                }
                groups.push(Group {
                    title: hit.title,
                    dir: hit.dir,
                    branch: String::new(),
                    agent: hit.agent,
                    backed_up: hit.backed_up,
                    updated_at: hit.updated_at,
                    remote: hit.remote,
                    repo_name: hit.repo_name,
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
                    repo_name: hit.repo_name,
                    session_id: None,
                    repo_dir: hit.repo_dir,
                    kind: HitKind::Repo,
                    author: String::new(),
                    rows: vec![],
                });
            }
            HitKind::RepoHeader => {} // never produced by parse_hit
        }
    }

    // Stable sort by repo_name (falling back to dir) so hits from the same
    // repo cluster together while preserving relevance ordering within each repo.
    groups.sort_by(|a, b| {
        let ka = if !a.repo_name.is_empty() { &a.repo_name } else { &a.dir };
        let kb = if !b.repo_name.is_empty() { &b.repo_name } else { &b.dir };
        ka.cmp(kb)
    });

    // Inject a non-selectable RepoHeader sentinel before each new repo.
    let mut with_headers: Vec<Group> = Vec::with_capacity(groups.len() + 4);
    let mut current_key = String::new();
    for g in groups {
        let key = if !g.repo_name.is_empty() { g.repo_name.clone() } else { g.dir.clone() };
        if key != current_key {
            current_key = key.clone();
            with_headers.push(Group {
                title: key,
                dir: String::new(), branch: String::new(), agent: String::new(),
                backed_up: false, updated_at: String::new(), remote: String::new(),
                repo_name: String::new(), session_id: None, repo_dir: None,
                kind: HitKind::RepoHeader, rows: vec![], author: String::new(),
            });
        }
        with_headers.push(g);
    }
    with_headers
}

// ── TUI ───────────────────────────────────────────────────────────────────────

fn tui_loop(stdout: &mut impl Write, groups: &[Group], query: &str, ms: u128) -> Result<bool> {
    let mut sel    = first_selectable(groups);
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
                KeyCode::Esc | KeyCode::Left => break,
                KeyCode::Char('c') if k.modifiers.contains(crossterm::event::KeyModifiers::CONTROL) => {
                    execute!(stdout, LeaveAlternateScreen, cursor::Show).ok();
                    terminal::disable_raw_mode().ok();
                    std::process::exit(0);
                }
                KeyCode::Up   | KeyCode::Char('k') => { sel = prev_selectable(groups, sel); }
                KeyCode::Down | KeyCode::Char('j') => { sel = next_selectable(groups, sel); }
                KeyCode::Char('g') => { sel = first_selectable(groups); scroll = 0; }
                KeyCode::Char('G') => { sel = last_selectable(groups); }
                KeyCode::Char(' ') | KeyCode::Right | KeyCode::Enter => {
                    if let Some(group) = groups.get(sel) {
                        execute!(stdout, LeaveAlternateScreen, cursor::Show).ok();
                        terminal::disable_raw_mode().ok();

                        let nested_quit = match group.kind {
                            HitKind::Log | HitKind::Checkpoint | HitKind::Session => {
                                if let Some(id) = &group.session_id {
                                    let tid  = group.rows.first().and_then(|r| r.turn_id.as_deref());
                                    let hts  = group.rows.first().and_then(|r| r.hit_ts.as_deref());
                                    let hoff = group.rows.first().and_then(|r| r.hit_off);
                                    let cpid = group.rows.first().and_then(|r| r.checkpoint_id.as_deref());
                                    super::show::run_at(id, tid, hts, hoff, cpid).unwrap_or(false)
                                } else { false }
                            }
                            HitKind::Repo => {
                                if let Some(dir) = &group.repo_dir {
                                    let _ = super::status::run_for_dir(dir);
                                }
                                false
                            }
                            HitKind::RepoHeader => false,
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
    if matches!(g.kind, HitKind::RepoHeader) { return 1; }
    1 + g.rows.iter().map(|r| r.lines.len().max(1)).sum::<usize>() + 1 // +1 for blank separator
}

fn is_selectable(g: &Group) -> bool {
    !matches!(g.kind, HitKind::RepoHeader)
}

fn next_selectable(groups: &[Group], from: usize) -> usize {
    (from + 1..groups.len()).find(|&i| is_selectable(&groups[i])).unwrap_or(from)
}

fn prev_selectable(groups: &[Group], from: usize) -> usize {
    (0..from).rev().find(|&i| is_selectable(&groups[i])).unwrap_or(from)
}

fn first_selectable(groups: &[Group]) -> usize {
    groups.iter().position(is_selectable).unwrap_or(0)
}

fn last_selectable(groups: &[Group]) -> usize {
    groups.iter().rposition(is_selectable).unwrap_or(0)
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
    const TS_W: usize = 12; // fixed width of the timestamp column in excerpt rows

    let content_h = h.saturating_sub(2);
    let mut buf: Vec<u8> = Vec::with_capacity((w + 60) * (h + 2));

    // Title bar
    queue!(buf, cursor::MoveTo(0, 0), terminal::Clear(ClearType::UntilNewLine))?;
    let result_count = groups.iter().filter(|g| is_selectable(g)).count();
    let hdr = format!("  search: \"{}\"  {} result(s)  {}ms", query, result_count, ms);
    write!(buf, "\x1b[1m{}\x1b[0m", hdr.chars().take(w).collect::<String>())?;

    // Pre-compute column widths across all groups for tabular alignment.
    let name_w   = groups.iter().map(|g| g.title.trim().chars().count()).max().unwrap_or(0).min(45);
    let agent_w  = groups.iter().map(|g| g.agent.chars().count()).max().unwrap_or(0);
    let author_w = groups.iter().map(|g| g.author.chars().count()).max().unwrap_or(0);
    let branch_w = groups.iter().map(|g| g.branch.chars().count()).max().unwrap_or(0).min(30);

    let accent = t.accent;
    // Write one content line into the buffer using the ▌ bar for selection.
    let mut write_row = |buf: &mut Vec<u8>, line: &str, selected: bool, screen_row: usize| -> io::Result<()> {
        queue!(buf, cursor::MoveTo(0, screen_row as u16), terminal::Clear(ClearType::UntilNewLine))?;
        if selected {
            write!(buf, "\x1b[{accent}m▌\x1b[0m {line}")?;
        } else {
            write!(buf, "  {line}")?;
        }
        Ok(())
    };

    let mut screen_row = 1usize; // next terminal row to write (row 0 is title bar)
    let mut abs_row    = 0usize; // absolute content row (before scroll is applied)

    for (gi, group) in groups.iter().enumerate() {
        if screen_row > content_h { break; }
        let selected = gi == sel;

        // ── Repo section header (non-selectable) ─────────────────────────
        if matches!(group.kind, HitKind::RepoHeader) {
            if abs_row >= scroll && screen_row <= content_h {
                queue!(buf, cursor::MoveTo(0, screen_row as u16), terminal::Clear(ClearType::UntilNewLine))?;
                let label = &group.title;
                let dash_w = w.saturating_sub(label.chars().count() + 5);
                let dashes: String = "─".repeat(dash_w.min(w));
                write!(buf, "  \x1b[{lk}m{label}\x1b[0m \x1b[{dm}m{dashes}\x1b[0m",
                    lk = t.link, dm = t.text_dim)?;
                screen_row += 1;
            }
            abs_row += 1;
            continue;
        }

        // ── Session header ────────────────────────────────────────────────
        if abs_row >= scroll && screen_row <= content_h {
            let age     = age_secs_hit(&group.updated_at);
            let dot_col = match age {
                a if a < 900   => t.fresh,
                a if a < 3_600 => t.moderate,
                _              => t.text_dim,
            };
            let (name_col, meta_col, dot_char) = if group.backed_up {
                (t.backed_name, t.backed_meta, "★")
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
                let a: String = group.agent.chars().take(agent_w).collect();
                let pad = " ".repeat(agent_w - a.chars().count());
                if group.backed_up {
                    let col = agent_color(&group.agent);
                    line.push_str(&format!("  \x1b[38;5;{col}m{a}{pad}\x1b[0m"));
                } else {
                    line.push_str(&format!("  \x1b[{st}m{a}{pad}\x1b[0m", st = t.stale));
                }
            }

            if let Some(sid) = &group.session_id {
                let id_short: String = sid.chars().take(8).collect();
                let ts = rel_time_hit(&group.updated_at);
                line.push_str(&format!("  \x1b[{meta_col}m{id_short}  {ts}\x1b[0m"));
            } else if matches!(group.kind, HitKind::Repo) {
                line.push_str(&format!("  \x1b[{meta_col}mrepo\x1b[0m"));
            }

            // Header row: full background highlight so the session name pops.
            super::render_row(&mut buf, &line, selected, screen_row, w)?;
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
                    // Matched line is brighter than context lines.
                    let is_match_line = li == row.match_line_idx;
                    let line_color = if is_match_line { t.text_primary } else { t.text_secondary };
                    let match_marker = if is_match_line { "▶ " } else { "  " };

                    let exc_line = if li == 0 && row.is_checkpoint {
                        let ts_padded = format!("{ts_str:>TS_W$}");
                        let avail2 = avail.saturating_sub(5 + 2); // [cp] + marker
                        let text_t: String = text.chars().take(avail2).collect();
                        format!(
                            "  \x1b[{dm}m{ts_padded}\x1b[0m  \x1b[{lb}m[cp]\x1b[0m {match_marker}\x1b[{lc}m{text_t}\x1b[0m",
                            dm = t.text_dim, lb = t.label, lc = line_color,
                        )
                    } else if li == 0 {
                        let ts_padded = format!("{ts_str:>TS_W$}");
                        let avail2 = avail.saturating_sub(2); // marker
                        let text_t: String = text.chars().take(avail2).collect();
                        format!(
                            "  \x1b[{dm}m{ts_padded}\x1b[0m  {match_marker}\x1b[{lc}m{text_t}\x1b[0m",
                            dm = t.text_dim, lc = line_color,
                        )
                    } else {
                        let avail2 = avail.saturating_sub(2); // marker
                        let text_t: String = text.chars().take(avail2).collect();
                        format!("{excerpt_indent}{match_marker}\x1b[{lc}m{text_t}\x1b[0m", lc = line_color)
                    };

                    // Excerpt rows: ▌ bar ties them visually to the selected header.
                    write_row(&mut buf, &exc_line, selected, screen_row)?;
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

    super::draw_statusbar(&mut buf, "  ↑↓/jk: navigate   space/→: open   ←/esc: back   q: quit  ", w, h)?;

    stdout.write_all(&buf)?;
    stdout.flush()
}


// ── DB enrichment ─────────────────────────────────────────────────────────────

fn enrich_hits(hits: &mut Vec<SearchHit>) {
    let Ok(conn) = crate::db::connect() else { return };
    for hit in hits.iter_mut() {
        if let Some(sid) = &hit.session_id {
            // Pull agent + remote + repo_name, plus the first checkpoint's author.
            if let Ok((agent, updated_at, remote, repo_name, author_name, author_email, author_os_user)) =
                conn.query_row(
                    "SELECT s.agent_name, s.updated_at, COALESCE(r.remote, ''),
                            COALESCE(r.name, ''),
                            COALESCE(c.author_name, ''), COALESCE(c.author_email, ''),
                            COALESCE(c.os_user, '')
                     FROM sessions s
                     LEFT JOIN repositories r
                       ON (s.repo_id = r.id
                           OR s.cwd = r.directory
                           OR s.cwd LIKE r.directory || '/%')
                     LEFT JOIN checkpoints c
                       ON c.session_id = s.session_id
                      AND c.checkpoint_id = (
                            SELECT checkpoint_id FROM checkpoints
                            WHERE session_id = s.session_id
                            ORDER BY last_turn_ts ASC LIMIT 1
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
                        row.get::<_, String>(6)?,
                    )),
                )
            {
                hit.agent      = agent;
                hit.updated_at = updated_at;
                hit.backed_up  = true;
                hit.remote     = remote;
                hit.repo_name  = repo_name;
                hit.author     = if !author_name.trim().is_empty() { author_name }
                                 else if !author_email.trim().is_empty() { author_email }
                                 else { author_os_user };
            }
        } else if let Some(dir) = &hit.repo_dir.clone() {
            if let Ok((remote, repo_name)) = conn.query_row(
                "SELECT COALESCE(remote, ''), COALESCE(name, '') FROM repositories WHERE directory = ?1",
                [dir.as_str()],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            ) {
                hit.remote    = remote;
                hit.repo_name = repo_name;
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
                    dir: super::short_path(&cwd),
                    excerpt_lines: vec![], match_line_idx: 0,
                    session_id: Some(session_id),
                    repo_dir: None,
                    turn_id: None, hit_ts: None, hit_off: None, checkpoint_id: None, branch: String::new(),
                    agent: String::new(), backed_up: false, updated_at: String::new(), author: String::new(),
                    remote: String::new(), repo_name: String::new(),
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
                    title: name.clone(),
                    dir: super::short_path(&directory),
                    excerpt_lines: vec![], match_line_idx: 0,
                    session_id: None,
                    repo_dir: Some(directory),
                    turn_id: None, hit_ts: None, hit_off: None, checkpoint_id: None, branch: String::new(),
                    agent: String::new(), backed_up: false, updated_at: String::new(), author: String::new(),
                    remote, repo_name: name,
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

