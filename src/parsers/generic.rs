//! Session-metadata parsing for any agent that isn't Claude Code, built on
//! the agnostic `scraper` module instead of a bespoke per-format struct.
//! See `parsers::mod::dispatch_session`/`dispatch_shadow_session` for how
//! sessions land here.

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};

use super::{CheckpointMetadata, ParsedSession};
use crate::scraper::{self, is_wrapper_prompt, Role};

pub fn parse_session(meta_bytes: &[u8], jsonl_bytes: &[u8]) -> Result<ParsedSession> {
    let meta: CheckpointMetadata = serde_json::from_slice(meta_bytes)
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
        .unwrap_or_else(|| format!("session:{}", &meta.session_id[..meta.session_id.len().min(8)]));

    let agent_name = meta.agent.unwrap_or_else(|| "Unknown Agent".to_string());
    let meta_branch = meta.branch.unwrap_or_default();
    let meta_tokens_used = meta.token_usage.and_then(|u| u.output_tokens).unwrap_or(0);

    let (info, turns) = scraper::scan(jsonl_bytes);

    let session_name = derive_session_name(&turns, metadata_intent);
    let updated_at = turns
        .iter()
        .filter(|t| t.ts_ms > 0)
        .max_by_key(|t| t.ts_ms)
        .and_then(|t| t.timestamp.clone())
        .and_then(|s| DateTime::parse_from_rfc3339(&s).ok())
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or(created_at);

    let branch = info.branch.unwrap_or(meta_branch);
    let tokens_used = if meta_tokens_used > 0 { meta_tokens_used } else { info.tokens_used };

    Ok(ParsedSession {
        session_id: meta.session_id,
        agent_name,
        created_at: created_at.to_rfc3339(),
        updated_at: updated_at.to_rfc3339(),
        cwd: info.cwd.unwrap_or_default(),
        session_name,
        branch,
        name_is_explicit: false,
        tokens_used,
    })
}

/// Shadow-branch sessions have no `metadata.json`, so the agent name is a
/// best-effort guess sniffed out of the transcript itself (e.g. Codex's
/// `session_meta.payload.originator == "Codex Desktop"`).
pub fn parse_shadow_session(jsonl_bytes: &[u8], session_id: &str) -> Result<ParsedSession> {
    let (info, turns) = scraper::scan(jsonl_bytes);

    let default_name = format!("session:{}", &session_id[..session_id.len().min(8)]);
    let session_name = derive_session_name(&turns, default_name);

    let created_at = turns
        .iter()
        .filter(|t| t.ts_ms > 0)
        .min_by_key(|t| t.ts_ms)
        .and_then(|t| t.timestamp.clone())
        .and_then(|s| DateTime::parse_from_rfc3339(&s).ok())
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(Utc::now);
    let updated_at = turns
        .iter()
        .filter(|t| t.ts_ms > 0)
        .max_by_key(|t| t.ts_ms)
        .and_then(|t| t.timestamp.clone())
        .and_then(|s| DateTime::parse_from_rfc3339(&s).ok())
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or(created_at);

    Ok(ParsedSession {
        session_id: session_id.to_string(),
        agent_name: info.agent_hint.unwrap_or_else(|| "Unknown Agent".to_string()),
        created_at: created_at.to_rfc3339(),
        updated_at: updated_at.to_rfc3339(),
        cwd: info.cwd.unwrap_or_default(),
        session_name,
        branch: info.branch.unwrap_or_default(),
        name_is_explicit: false,
        tokens_used: info.tokens_used,
    })
}

/// First meaningful user turn (skipping wrapper-tag-only prompts), falling
/// back to the first user turn at all, falling back to `default`.
fn derive_session_name(turns: &[scraper::Turn], default: String) -> String {
    let mut first_any: Option<String> = None;
    for turn in turns {
        if !matches!(turn.role, Role::User) {
            continue;
        }
        let text = scraper::turn_text(turn);
        if first_any.is_none() {
            first_any = Some(text.clone());
        }
        if !is_wrapper_prompt(&text) {
            return crate::commands::session_list::sanitize_one_line(&text);
        }
    }
    let name = first_any.unwrap_or(default);
    crate::commands::session_list::sanitize_one_line(&name)
}
