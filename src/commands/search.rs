use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use std::io::{IsTerminal, Read, Seek, SeekFrom, Write};
use std::path::PathBuf;

// ── ANSI helpers ─────────────────────────────────────────────────────────────

struct Palette {
    enabled: bool,
}

impl Palette {
    fn new() -> Self {
        Self { enabled: std::io::stdout().is_terminal() }
    }
    fn paint(&self, code: &str, s: &str) -> String {
        if self.enabled { format!("\x1b[{}m{}\x1b[0m", code, s) } else { s.to_string() }
    }
    fn bold(&self, s: &str)        -> String { self.paint("1", s) }
    fn dim(&self, s: &str)         -> String { self.paint("38;5;240", s) }
    fn green(&self, s: &str)       -> String { self.paint("38;5;82", s) }
    fn cyan(&self, s: &str)        -> String { self.paint("38;5;75", s) }
    fn magenta(&self, s: &str)     -> String { self.paint("38;5;177", s) }
    fn yellow(&self, s: &str)      -> String { self.paint("38;5;220", s) }
    fn white(&self, s: &str)       -> String { self.paint("38;5;255", s) }
    fn gray(&self, s: &str)        -> String { self.paint("38;5;245", s) }
}

// ── Time formatting ───────────────────────────────────────────────────────────

fn relative_time(iso: &str) -> String {
    let Ok(dt) = DateTime::parse_from_rfc3339(iso) else {
        return iso.get(..16).unwrap_or(iso).to_string();
    };
    let secs = (Utc::now() - dt.with_timezone(&Utc)).num_seconds().max(0);
    match secs {
        s if s < 60        => "just now".to_string(),
        s if s < 3_600     => format!("{} min{} ago", s/60,     if s/60==1     {""} else {"s"}),
        s if s < 86_400    => format!("{} hr{} ago",  s/3_600,  if s/3_600==1  {""} else {"s"}),
        s if s < 604_800   => format!("{} day{} ago", s/86_400, if s/86_400==1 {""} else {"s"}),
        s if s < 2_592_000 => format!("{} wk{} ago", s/604_800,if s/604_800==1{""} else {"s"}),
        s if s < 31_536_000=> format!("{} mo ago",   s/2_592_000),
        s                  => format!("{} yr{} ago", s/31_536_000, if s/31_536_000==1{""} else {"s"}),
    }
}

// ── Search ────────────────────────────────────────────────────────────────────

pub fn run(query: &str, top_k: usize) -> Result<()> {
    let assets = PathBuf::from(std::env::var("WARP_ASSETS").unwrap_or_else(|_| "assets".into()));
    if !assets.exists() {
        anyhow::bail!("Set WARP_ASSETS to the witchcraft assets directory to enable search.");
    }

    let db_path = dirs::home_dir()
        .context("cannot determine home directory")?
        .join(".gossamer/search.db");

    let db = witchcraft::DB::new_reader(db_path).context("failed to open search DB")?;
    let device = witchcraft::make_device();
    let embedder = witchcraft::Embedder::new(&device, &assets).context("failed to load embedder")?;
    let mut cache = witchcraft::EmbeddingsCache::new(1);

    let now = std::time::Instant::now();
    let results = witchcraft::search(&db, &embedder, &mut cache, query, 0.5, top_k, true, None)?;
    let search_ms = now.elapsed().as_millis();

    let p = Palette::new();
    let mut out = std::io::BufWriter::new(std::io::stdout());

    let header = format!("[[ {query} ]]  {} result(s)  {search_ms} ms", results.len());
    writeln!(out, "\n{}\n", p.bold(&header))?;

    if results.is_empty() {
        writeln!(out, "no results")?;
        return Ok(());
    }

    let sep = p.dim("───────────────────────────────────────────────────────────");

    for (_score, metadata_json, bodies, sub_idx, date) in &results {
        let meta: serde_json::Value = serde_json::from_str(metadata_json).unwrap_or_default();

        let project     = meta["project"].as_str().unwrap_or("");
        let session_id  = meta["session_id"].as_str().unwrap_or("");
        let session_name= meta["session_name"].as_str().unwrap_or("");
        let turn        = meta["turn"].as_u64().unwrap_or(0);
        let path        = meta["path"].as_str().unwrap_or("");
        let branch      = meta["branch"].as_str().unwrap_or("");

        let turns: Vec<(String, String, u64, u64)> = meta["turns"]
            .as_array()
            .map(|arr| arr.iter().map(|v| (
                v["role"].as_str().unwrap_or("").to_string(),
                v["timestamp"].as_str().unwrap_or("").to_string(),
                v["off"].as_u64().unwrap_or(0),
                v["len"].as_u64().unwrap_or(0),
            )).collect())
            .unwrap_or_default();

        writeln!(out, "{sep}")?;

        // ── meta line ──────────────────────────────────────────────────────
        let ts_str = turns.first()
            .filter(|t| !t.1.is_empty())
            .map(|t| relative_time(&t.1))
            .unwrap_or_else(|| relative_time(date));

        let short_id = if session_id.len() > 8 { &session_id[..8] } else { session_id };
        let name_display: String = session_name.chars().take(55).collect();

        let mut meta_line = format!(
            "{}  {}  {} {}",
            p.green(&ts_str),
            p.cyan(project),
            p.dim("claude"),
            p.magenta(short_id),
        );
        if !name_display.is_empty() {
            meta_line.push_str(&format!("  {}", p.white(&format!("\"{name_display}\""))));
        }
        meta_line.push_str(&p.dim(&format!("  turn {turn}")));
        if !branch.is_empty() {
            meta_line.push_str(&format!("  {}", p.yellow(&format!("[{branch}]"))));
        }
        writeln!(out, "{meta_line}")?;

        // ── turns ──────────────────────────────────────────────────────────
        // sub_idx 0 = header chunk; turns start at sub_idx 1
        let mi = if *sub_idx > 0 { (*sub_idx as usize).saturating_sub(1) } else { 0 };
        let ctx_start = mi.saturating_sub(1);
        let ctx_end = (mi + 2).min(turns.len());

        if !turns.is_empty() {
            for i in ctx_start..ctx_end {
                let (role, ts, off, len) = &turns[i];
                let matched = i == mi;

                let label = if role == "user" {
                    p.green("[User]")
                } else {
                    p.cyan("[Claude]")
                };
                let ts_rel = p.dim(&relative_time(ts));
                let prefix_str = if matched { ">>>" } else { "   " };
                let prefix = if matched { p.bold(prefix_str) } else { p.dim(prefix_str) };

                writeln!(out, "{prefix} {label}  {ts_rel}")?;

                let text = read_turn(path, *off, *len)
                    .or_else(|| {
                        let idx = i.min(bodies.len().saturating_sub(1));
                        Some(bodies[idx].clone())
                    })
                    .unwrap_or_default();

                for line in text.lines().filter(|l| !l.trim().is_empty()).take(10) {
                    let rendered = if matched {
                        format!("{}   {}", p.bold(">>>"), p.white(line))
                    } else {
                        format!("       {}", p.gray(line))
                    };
                    writeln!(out, "{rendered}")?;
                }
            }
        } else {
            let idx = (*sub_idx as usize).min(bodies.len().saturating_sub(1));
            let start = idx.saturating_sub(1);
            let end = (idx + 2).min(bodies.len());
            for i in start..end {
                let matched = i == idx;
                let prefix = if matched { p.bold(">>>") } else { p.dim("   ") };
                for line in bodies[i].lines().filter(|l| !l.trim().is_empty()).take(6) {
                    let text = if matched { p.white(line) } else { p.gray(line) };
                    writeln!(out, "{prefix}   {text}")?;
                }
            }
        }
    }
    writeln!(out, "{sep}")?;
    Ok(())
}

// ── JSONL byte-offset reader ──────────────────────────────────────────────────

fn read_turn(path: &str, offset: u64, len: u64) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    f.seek(SeekFrom::Start(offset)).ok()?;
    let mut buf = vec![0u8; len as usize];
    f.read_exact(&mut buf).ok()?;
    let line = String::from_utf8(buf).ok()?;
    let v: serde_json::Value = serde_json::from_str(&line).ok()?;
    let msg = v.get("message")?;
    match msg.get("content")? {
        c if c.is_string() => Some(c.as_str()?.to_string()),
        c if c.is_array() => {
            let texts: Vec<&str> = c.as_array()?
                .iter()
                .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect();
            if texts.is_empty() { None } else { Some(texts.join("\n")) }
        }
        _ => None,
    }
}
