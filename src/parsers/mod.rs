pub mod claude_code;
pub mod generic;

use anyhow::Result;
use serde::Deserialize;

pub struct ParsedSession {
    pub session_id: String,
    pub agent_name: String,
    pub created_at: String,   // RFC 3339
    pub updated_at: String,   // RFC 3339
    pub cwd: String,
    pub session_name: String,
    pub branch: String,
    pub name_is_explicit: bool,
    /// Sum of output_tokens across all assistant turns.
    pub tokens_used: i64,
}

/// `metadata.json` shape shared by every agent's checkpoints — both Claude
/// Code and Codex populate the same `agent`/`created_at`/`branch`/
/// `token_usage` fields.
#[derive(Deserialize)]
pub(crate) struct CheckpointMetadata {
    pub session_id: String,
    pub agent: Option<String>,
    pub created_at: Option<String>,
    pub branch: Option<String>,
    pub summary: Option<Summary>,
    pub token_usage: Option<TokenUsage>,
}

#[derive(Deserialize)]
pub(crate) struct Summary {
    pub intent: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct TokenUsage {
    pub output_tokens: Option<i64>,
}

/// Parse a checkpoint's `metadata.json` + `full.jsonl` into a normalized
/// session row. Dispatches on `metadata.json`'s `agent` field — Claude Code's
/// bespoke parser is the default (matching prior behavior when the field is
/// missing), everything else goes through the agnostic parser.
pub fn dispatch_session(meta_bytes: &[u8], jsonl_bytes: &[u8]) -> Result<ParsedSession> {
    let agent = serde_json::from_slice::<serde_json::Value>(meta_bytes)
        .ok()
        .and_then(|v| v.get("agent").and_then(|a| a.as_str()).map(str::to_string));

    if is_claude_agent(agent.as_deref()) {
        claude_code::parse_session(meta_bytes, jsonl_bytes)
    } else {
        generic::parse_session(meta_bytes, jsonl_bytes)
    }
}

/// Parse a shadow-branch full.jsonl (no metadata.json sibling, so the agent
/// is inferred by sniffing the JSONL's own shape).
pub fn dispatch_shadow_session(jsonl_bytes: &[u8], session_id: &str) -> Result<ParsedSession> {
    if crate::scraper::looks_like_claude_shape(jsonl_bytes) {
        claude_code::parse_shadow_session(jsonl_bytes, session_id)
    } else {
        generic::parse_shadow_session(jsonl_bytes, session_id)
    }
}

pub(crate) fn is_claude_agent(agent: Option<&str>) -> bool {
    match agent {
        Some(a) => a.to_lowercase().contains("claude"),
        None => true,
    }
}
