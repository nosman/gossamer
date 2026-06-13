pub mod claude_code;

use anyhow::Result;

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

/// Parse a checkpoint's `metadata.json` + `full.jsonl` into a normalized session row.
pub fn dispatch_session(meta_bytes: &[u8], jsonl_bytes: &[u8]) -> Result<ParsedSession> {
    claude_code::parse_session(meta_bytes, jsonl_bytes)
}

/// Parse a shadow-branch full.jsonl (no metadata.json sibling).
pub fn dispatch_shadow_session(jsonl_bytes: &[u8], session_id: &str) -> Result<ParsedSession> {
    claude_code::parse_shadow_session(jsonl_bytes, session_id)
}
