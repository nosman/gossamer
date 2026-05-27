//! Codex JSONL pipeline.
//!
//! Schema (per line):
//! ```
//! {"timestamp":"...","type":"<event_type>","payload":{...}}
//! ```
//!
//! Event types we care about:
//! - `session_meta`  — `payload.cwd`, `payload.timestamp`, etc.
//! - `response_item` — actual conversation turns. `payload.type` is one of
//!   `message`, `function_call`, `function_call_output`, `custom_tool_call`,
//!   `custom_tool_call_output`, `reasoning`.
//!   For `message`: `payload.role` is `user` | `assistant`, and
//!   `payload.content` is an array of `{type, text}` blocks where user
//!   blocks use `input_text` and assistant blocks use `output_text`.
//! - `turn_context`, `event_msg`, `compacted` — currently ignored for
//!   session_name extraction.
//!
//! Codex doesn't appear to have a `/rename` equivalent, so name_is_explicit
//! is always false. If/when one shows up, we'll detect it the same way we
//! do for Claude Code's `custom-title` events.

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
    }

    let meta: SessionMetadata = serde_json::from_slice(meta_bytes)
        .context("failed to parse metadata.json")?;

    let created_at: DateTime<Utc> = meta
        .created_at
        .as_deref()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(Utc::now);

    let agent_name = meta.agent.unwrap_or_else(|| "Codex".to_string());
    let branch = meta.branch.unwrap_or_default();

    let mut cwd = String::new();
    let mut latest: Option<DateTime<Utc>> = None;
    let mut first_meaningful_prompt: Option<String> = None;
    let mut first_any_prompt: Option<String> = None;

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

        let event_type = v.get("type").and_then(Value::as_str).unwrap_or("");
        let payload = &v["payload"];

        match event_type {
            "session_meta" => {
                if cwd.is_empty() {
                    if let Some(c) = payload.get("cwd").and_then(Value::as_str) {
                        cwd = c.to_string();
                    }
                }
            }
            "response_item" => {
                if payload.get("type").and_then(Value::as_str) != Some("message") { continue; }
                if payload.get("role").and_then(Value::as_str) != Some("user") { continue; }
                let Some(text) = extract_user_text(&payload["content"]) else { continue };
                if first_any_prompt.is_none() { first_any_prompt = Some(text.clone()); }
                if first_meaningful_prompt.is_none() && !is_wrapper_prompt(&text) {
                    first_meaningful_prompt = Some(text);
                }
            }
            _ => {}
        }
    }

    let updated_at = latest.unwrap_or(created_at);
    let session_name = first_meaningful_prompt
        .or(first_any_prompt)
        .unwrap_or_else(|| format!("session:{}", &meta.session_id[..meta.session_id.len().min(8)]));
    let session_name = crate::commands::session_list::sanitize_one_line(&session_name);

    Ok(ParsedSession {
        session_id: meta.session_id,
        agent_name,
        created_at: created_at.to_rfc3339(),
        updated_at: updated_at.to_rfc3339(),
        cwd,
        session_name,
        branch,
        name_is_explicit: false,
    })
}

/// Pull text out of a Codex user message's content array. User blocks use
/// `input_text`; everything else (images, tool refs, etc.) is ignored.
fn extract_user_text(content: &Value) -> Option<String> {
    let Value::Array(blocks) = content else { return None };
    let texts: Vec<&str> = blocks.iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("input_text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect();
    if texts.is_empty() { return None; }
    let joined = texts.join("\n");
    let trimmed = joined.trim();
    if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
}

/// Codex prefixes every session with auto-injected context that looks like a
/// user message but isn't. Skip those when picking the first meaningful
/// prompt. Also covers generic XML-tag-only wrappers, mirroring the
/// Claude Code heuristic.
fn is_wrapper_prompt(text: &str) -> bool {
    let first_line = text.lines().next().unwrap_or("").trim_start();
    // Codex injects the contents of AGENTS.md as the opening user turn.
    if first_line.starts_with("# AGENTS.md instructions for") { return true; }
    // Generic tag-only wrappers (system context, environment, etc.).
    const TAGS: &[&str] = &[
        "<INSTRUCTIONS",
        "<environment_context",
        "<user_instructions",
        "<system_message",
    ];
    TAGS.iter().any(|tag| first_line.starts_with(tag))
}
