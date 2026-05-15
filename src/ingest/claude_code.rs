use anyhow::Result;
use regex::Regex;
use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

use witchcraft::DB;

use crate::watermark;

const MIN_CHUNK_CODEPOINTS: usize = 5;
const MAX_CHUNK_CODEPOINTS: usize = 4000;

const CLAUDE_CODE_NAMESPACE: Uuid = Uuid::from_bytes([
    0xa3, 0xf7, 0xc8, 0xd1, 0x6e, 0x2b, 0x4a, 0x91, 0xb5, 0xd0, 0x8f, 0x1e, 0x3c, 0x7a, 0x9b,
    0x2d,
]);

#[derive(Deserialize)]
struct SessionEntry {
    #[serde(rename = "type")]
    entry_type: String,
    timestamp: Option<String>,
    message: Option<Message>,
    #[serde(rename = "gitBranch")]
    git_branch: Option<String>,
    #[serde(rename = "customTitle")]
    custom_title: Option<String>,
    cwd: Option<String>,
}

#[derive(Deserialize)]
struct Message {
    role: Option<String>,
    content: Option<Content>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Content {
    Text(String),
    Blocks(Vec<ContentBlock>),
}

#[derive(Deserialize)]
struct ContentBlock {
    #[serde(rename = "type")]
    block_type: String,
    #[serde(default)]
    text: Option<String>,
}

struct Chunk {
    role: String,
    text: String,
    timestamp: String,
    ts_ms: i64,
    byte_offset: u64,
    byte_len: u64,
    git_branch: Option<String>,
}

struct SessionInfo {
    custom_title: Option<String>,
    cwd: Option<String>,
}

fn codepoint_len(s: &str) -> usize {
    s.chars().count()
}

fn extract_text(content: &Content) -> Option<String> {
    match content {
        Content::Text(s) => Some(s.clone()),
        Content::Blocks(blocks) => {
            let texts: Vec<&str> = blocks
                .iter()
                .filter(|b| b.block_type == "text")
                .filter_map(|b| b.text.as_deref())
                .collect();
            if texts.is_empty() {
                None
            } else {
                Some(texts.join("\n"))
            }
        }
    }
}

fn sanitize(text: &str) -> String {
    let s = strip_system_content(text);
    let s = strip_code(&s);
    let s = strip_tables(&s);
    compact(&s)
}

fn strip_system_content(text: &str) -> String {
    let mut s = text.to_string();
    let re_open = Regex::new(r"<([a-z][a-z0-9]*(?:[-:][a-z0-9_]+)+)[\s>]").unwrap();
    loop {
        let m = match re_open.find(&s) {
            Some(m) => m,
            None => break,
        };
        let start = m.start();
        let caps = re_open.captures(&s[start..]).unwrap();
        let tag_name = caps.get(1).unwrap().as_str().to_string();
        let close_tag = format!("</{tag_name}>");
        let after_open = match s[start..].find('>') {
            Some(i) => start + i + 1,
            None => break,
        };
        let end = match s[after_open..].find(&close_tag) {
            Some(i) => after_open + i + close_tag.len(),
            None => {
                let line_end = s[start..].find('\n').map(|i| start + i + 1).unwrap_or(s.len());
                s.replace_range(start..line_end, "");
                continue;
            }
        };
        s.replace_range(start..end, "");
    }
    let re = Regex::new(r"\[Request interrupted by user[^\]]*\]").unwrap();
    s = re.replace_all(&s, "").to_string();
    if let Some(idx) = s.find("This session is being continued from a previous conversation") {
        s.truncate(idx);
    }
    s
}

fn strip_code(text: &str) -> String {
    let re = Regex::new(r"```[\s\S]*?```").unwrap();
    let s = re.replace_all(text, " ").to_string();
    let re = Regex::new(r"```[\s\S]*$").unwrap();
    let s = re.replace_all(&s, " ").to_string();
    let re = Regex::new(r"`[^`]*`").unwrap();
    re.replace_all(&s, " ").to_string()
}

fn strip_tables(text: &str) -> String {
    text.lines()
        .filter(|line| {
            let t = line.trim();
            !(t.starts_with('|') && t.ends_with('|'))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn compact(text: &str) -> String {
    let re = Regex::new(r"\s{2,}").unwrap();
    re.replace_all(text, " ").trim().to_string()
}

fn decode_project_name(dir_name: &str) -> String {
    dir_name.replace('-', "/").trim_start_matches('/').to_string()
}

fn file_mtime_ms(path: &Path) -> Option<i64> {
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as i64)
}

fn parse_session_file(path: &Path) -> (SessionInfo, Vec<Chunk>) {
    let raw = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return (SessionInfo { custom_title: None, cwd: None }, vec![]),
    };

    let mut chunks = Vec::new();
    let mut info = SessionInfo { custom_title: None, cwd: None };
    let mut offset: u64 = 0;

    for line in raw.lines() {
        let line_offset = offset;
        offset += line.len() as u64 + 1; // +1 for newline

        if line.trim().is_empty() {
            continue;
        }

        let entry: SessionEntry = match serde_json::from_str(line) {
            Ok(e) => e,
            Err(_) => continue,
        };

        if entry.entry_type == "custom-title" {
            if let Some(ref title) = entry.custom_title {
                info.custom_title = Some(title.clone());
            }
            continue;
        }

        if info.cwd.is_none() {
            if let Some(ref cwd) = entry.cwd {
                info.cwd = Some(cwd.clone());
            }
        }

        if entry.entry_type != "user" && entry.entry_type != "assistant" {
            continue;
        }

        let msg = match &entry.message {
            Some(m) => m,
            None => continue,
        };

        let role = match &msg.role {
            Some(r) if r == "user" || r == "assistant" => r.clone(),
            _ => continue,
        };

        let content = match &msg.content {
            Some(c) => c,
            None => continue,
        };

        let raw_text = match extract_text(content) {
            Some(t) => t,
            None => continue,
        };

        let text = sanitize(&raw_text);
        if text.is_empty() {
            continue;
        }

        if !(MIN_CHUNK_CODEPOINTS..=MAX_CHUNK_CODEPOINTS).contains(&codepoint_len(&text)) {
            continue;
        }

        let timestamp = match &entry.timestamp {
            Some(ts) if !ts.is_empty() => ts.clone(),
            _ => continue,
        };

        let ts_ms = chrono::DateTime::parse_from_rfc3339(&timestamp)
            .map(|dt| dt.timestamp_millis())
            .unwrap_or(0);

        if ts_ms <= 0 {
            continue;
        }

        chunks.push(Chunk {
            role,
            text,
            timestamp,
            ts_ms,
            byte_offset: line_offset,
            byte_len: line.len() as u64,
            git_branch: entry.git_branch,
        });
    }

    chunks.sort_by_key(|c| c.ts_ms);
    (info, chunks)
}

fn ingest_session(db: &mut DB, path: &Path, project_name: &str, mtime_ms: i64) -> Result<usize> {
    let (info, chunks) = parse_session_file(path);
    if chunks.is_empty() {
        return Ok(0);
    }

    let project_name = info
        .cwd
        .as_deref()
        .map(|cwd| cwd.trim_start_matches('/').to_string())
        .unwrap_or_else(|| project_name.to_string());

    let session_id = path.file_stem().unwrap().to_string_lossy();

    let session_title: String = info.custom_title.unwrap_or_else(|| {
        chunks
            .iter()
            .find(|c| c.role == "user")
            .map(|c| c.text.chars().take(240).collect())
            .unwrap_or_default()
    });

    // Split into interactions: each starts at a user message
    let mut interactions: Vec<&[Chunk]> = Vec::new();
    let mut start = 0;
    for (i, chunk) in chunks.iter().enumerate() {
        if chunk.role == "user" && i > start {
            interactions.push(&chunks[start..i]);
            start = i;
        }
    }
    interactions.push(&chunks[start..]);

    let mut count = 0;
    for (turn_idx, interaction) in interactions.iter().enumerate() {
        let header = format!("[{project_name}] {session_title}\n");
        let mut all_parts = vec![header];
        let mut turns_meta: Vec<serde_json::Value> = Vec::new();

        for chunk in *interaction {
            let label = if chunk.role == "user" { "[User]" } else { "[Claude]" };
            all_parts.push(format!("{label} {}\n", chunk.text));
            turns_meta.push(serde_json::json!({
                "role": chunk.role,
                "timestamp": chunk.timestamp,
                "off": chunk.byte_offset,
                "len": chunk.byte_len,
            }));
        }

        let lengths: Vec<usize> = all_parts.iter().map(|p| p.chars().count()).collect();
        let body = all_parts.join("");

        if body.trim().is_empty() {
            continue;
        }

        let uuid = Uuid::new_v5(
            &CLAUDE_CODE_NAMESPACE,
            format!("{session_id}:{turn_idx}").as_bytes(),
        );

        let branch: Option<&str> = interaction
            .iter()
            .filter_map(|c| c.git_branch.as_deref())
            .last();

        let metadata = serde_json::json!({
            "source": "claude",
            "project": project_name,
            "session_id": session_id.to_string(),
            "session_name": session_title,
            "turn": turn_idx,
            "path": path.to_string_lossy(),
            "cwd": info.cwd,
            "mtime_ms": mtime_ms,
            "turns": turns_meta,
            "branch": branch,
        })
        .to_string();

        let date = iso8601_timestamp::Timestamp::parse(&interaction[0].timestamp);
        db.add_doc(&uuid, date, &metadata, &body, Some(lengths))?;
        count += 1;
    }

    Ok(count)
}

/// Ingest new or modified Claude Code sessions from ~/.claude/projects/ into
/// the witchcraft DB. Uses a watermark file to skip unchanged sessions on
/// subsequent runs. Returns the number of session turns ingested.
pub fn ingest_claude_code(db: &mut DB) -> Result<usize> {
    let home = std::env::var("HOME").unwrap_or_default();
    let projects_dir = PathBuf::from(&home).join(".claude/projects");

    if !projects_dir.is_dir() {
        return Ok(0);
    }

    let wm_path = watermark::claude_path();
    let wm_ts = watermark::mtime_ms(&wm_path);

    let mut turn_count = 0usize;

    let mut entries: Vec<_> = fs::read_dir(&projects_dir)?
        .filter_map(|e| e.ok())
        .collect();
    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        let dir_path = entry.path();
        if !dir_path.is_dir() {
            continue;
        }

        let dir_name = entry.file_name().to_string_lossy().to_string();
        let project_name = decode_project_name(&dir_name);

        let mut jsonl_files: Vec<PathBuf> = fs::read_dir(&dir_path)?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|ext| ext == "jsonl"))
            .collect();
        jsonl_files.sort();

        for jsonl_path in &jsonl_files {
            if !watermark::file_newer_than(jsonl_path, wm_ts) {
                continue;
            }
            let mtime_ms = file_mtime_ms(jsonl_path).unwrap_or(0);
            eprintln!("{}", jsonl_path.display());
            match ingest_session(db, jsonl_path, &project_name, mtime_ms) {
                Ok(n) => turn_count += n,
                Err(e) => eprintln!("  warning: failed to ingest {}: {e}", jsonl_path.display()),
            }
        }
    }

    watermark::touch(&wm_path);
    Ok(turn_count)
}
