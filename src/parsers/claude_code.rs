//! Claude Code JSONL pipeline. Each line is a top-level
//! `{"type": "user"|"assistant"|"system"|"custom-title", ...}` event.
//! User/assistant turns carry their content in `message.content`, which can
//! be either a plain string or an array of `{"type": "text"|"tool_use"|..., ...}`
//! blocks. cwd and gitBranch are stamped onto each user/system entry.

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::Value;

use super::ParsedSession;

pub fn parse_session(meta_bytes: &[u8], jsonl_bytes: &[u8]) -> Result<ParsedSession> {
    #[derive(Deserialize)]
    struct SessionMetadata {
        session_id: String,
        agent: Option<String>,
        created_at: Option<String>,
        branch: Option<String>,
        summary: Option<Summary>,
    }
    #[derive(Deserialize)]
    struct Summary {
        intent: Option<String>,
    }

    let meta: SessionMetadata = serde_json::from_slice(meta_bytes)
        .context("failed to parse metadata.json")?;

    let created_at: DateTime<Utc> = meta
        .created_at
        .as_deref()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(Utc::now);

    let metadata_intent = meta
        .summary
        .and_then(|s| s.intent)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("session:{}", &meta.session_id[..8]));

    let agent_name = meta.agent.unwrap_or_else(|| "Claude Code".to_string());
    let meta_branch = meta.branch.unwrap_or_default();

    let mut latest: Option<DateTime<Utc>> = None;
    let mut cwd = String::new();
    let mut first_meaningful_prompt: Option<String> = None;
    let mut first_any_prompt: Option<String> = None;
    let mut custom_title: Option<String> = None;
    let mut jsonl_branch = String::new();

    for line in jsonl_bytes.split(|&b| b == b'\n') {
        if line.is_empty() { continue; }
        let v: Value = match serde_json::from_slice(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if let Some(ts) = v.get("timestamp").and_then(Value::as_str) {
            if let Ok(dt) = DateTime::parse_from_rfc3339(ts) {
                let dt: DateTime<Utc> = dt.with_timezone(&Utc);
                if latest.map_or(true, |l| dt > l) { latest = Some(dt); }
            }
        }

        if cwd.is_empty() {
            if let Some(c) = v.get("cwd").and_then(Value::as_str) { cwd = c.to_string(); }
        }

        if let Some(b) = v.get("gitBranch").and_then(Value::as_str) {
            if !b.is_empty() { jsonl_branch = b.to_string(); }
        }

        match v.get("type").and_then(Value::as_str) {
            Some("custom-title") => {
                if let Some(t) = v.get("customTitle").and_then(Value::as_str) {
                    if !t.trim().is_empty() { custom_title = Some(t.trim().to_string()); }
                }
            }
            Some("user") => {
                if let Some(text) = extract_user_text(&v["message"]["content"]) {
                    if first_any_prompt.is_none() { first_any_prompt = Some(text.clone()); }
                    if first_meaningful_prompt.is_none() && !is_wrapper_prompt(&text) {
                        first_meaningful_prompt = Some(text);
                    }
                }
            }
            _ => {}
        }
    }

    let updated_at = latest.unwrap_or(created_at);
    let name_is_explicit = custom_title.is_some();
    let session_name = custom_title
        .or(first_meaningful_prompt)
        .or(first_any_prompt)
        .unwrap_or(metadata_intent);
    let session_name = crate::commands::session_list::sanitize_one_line(&session_name);
    let branch = if !jsonl_branch.is_empty() { jsonl_branch } else { meta_branch };

    Ok(ParsedSession {
        session_id: meta.session_id,
        agent_name,
        created_at: created_at.to_rfc3339(),
        updated_at: updated_at.to_rfc3339(),
        cwd,
        session_name,
        branch,
        name_is_explicit,
    })
}

pub fn parse_shadow_session(jsonl_bytes: &[u8], session_id: &str) -> Result<ParsedSession> {
    let mut earliest: Option<DateTime<Utc>> = None;
    let mut latest: Option<DateTime<Utc>> = None;
    let mut cwd = String::new();
    let mut first_meaningful_prompt: Option<String> = None;
    let mut first_any_prompt: Option<String> = None;
    let mut custom_title: Option<String> = None;
    let mut branch = String::new();

    for line in jsonl_bytes.split(|&b| b == b'\n') {
        if line.is_empty() { continue; }
        let v: Value = match serde_json::from_slice(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if let Some(ts) = v.get("timestamp").and_then(Value::as_str) {
            if let Ok(dt) = DateTime::parse_from_rfc3339(ts) {
                let dt: DateTime<Utc> = dt.with_timezone(&Utc);
                if earliest.map_or(true, |e| dt < e) { earliest = Some(dt); }
                if latest.map_or(true, |l| dt > l)   { latest   = Some(dt); }
            }
        }

        if cwd.is_empty() {
            if let Some(c) = v.get("cwd").and_then(Value::as_str) { cwd = c.to_string(); }
        }

        if let Some(b) = v.get("gitBranch").and_then(Value::as_str) {
            if !b.is_empty() { branch = b.to_string(); }
        }

        match v.get("type").and_then(Value::as_str) {
            Some("custom-title") => {
                if let Some(t) = v.get("customTitle").and_then(Value::as_str) {
                    if !t.trim().is_empty() { custom_title = Some(t.trim().to_string()); }
                }
            }
            Some("user") => {
                if let Some(text) = extract_user_text(&v["message"]["content"]) {
                    if first_any_prompt.is_none() { first_any_prompt = Some(text.clone()); }
                    if first_meaningful_prompt.is_none() && !is_wrapper_prompt(&text) {
                        first_meaningful_prompt = Some(text);
                    }
                }
            }
            _ => {}
        }
    }

    let created_at = earliest.unwrap_or_else(Utc::now);
    let updated_at = latest.unwrap_or(created_at);
    let name_is_explicit = custom_title.is_some();
    let session_name = custom_title
        .or(first_meaningful_prompt)
        .or(first_any_prompt)
        .unwrap_or_else(|| format!("session:{}", &session_id[..session_id.len().min(8)]));
    let session_name = crate::commands::session_list::sanitize_one_line(&session_name);

    Ok(ParsedSession {
        session_id: session_id.to_string(),
        agent_name: "Claude Code".to_string(),
        created_at: created_at.to_rfc3339(),
        updated_at: updated_at.to_rfc3339(),
        cwd,
        session_name,
        branch,
        name_is_explicit,
    })
}

/// Pull a user message's text out of either the string or block-array shape
/// that Claude Code uses. Trims and returns None for empty content.
fn extract_user_text(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() { None } else { Some(t.to_string()) }
        }
        Value::Array(blocks) => {
            let texts: Vec<&str> = blocks.iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect();
            let joined = texts.join("\n");
            let t = joined.trim();
            if t.is_empty() { None } else { Some(t.to_string()) }
        }
        _ => None,
    }
}

/// Prompts whose first line is just a wrapper tag carry no user intent —
/// they're slash-command metadata, bash output captured by Claude Code, task
/// notifications, etc. Skip these when deciding the session's display name.
fn is_wrapper_prompt(text: &str) -> bool {
    let first_line = text.lines().next().unwrap_or("").trim_start();
    const TAGS: &[&str] = &[
        "<command-message",
        "<command-name",
        "<local-command-caveat",
        "<local-command-stdout",
        "<local-command-stderr",
        "<task-notification",
        "<system-reminder",
        "<bash-input",
        "<bash-stdout",
        "<bash-stderr",
    ];
    TAGS.iter().any(|tag| first_line.starts_with(tag))
}
