//! Per-agent JSONL parsing pipelines.
//!
//! entire normalizes only `metadata.json` across agents. The `full.jsonl` file
//! it captures next to it is the raw transcript in whatever schema the agent
//! emits — Claude Code's `{"type":"user","message":{...}}` lines look nothing
//! like Codex's `{"type":"response_item","payload":{...}}` lines. We dispatch
//! on the agent name from metadata.json and route to a per-agent parser.
//!
//! Today there are two real pipelines (Claude Code, Codex). Adding a new
//! agent is a new module + a branch in `dispatch_session`.

use anyhow::Result;

pub mod claude_code;
pub mod codex;

/// Output of any parser. Replaces the 8-tuple we had before.
pub struct ParsedSession {
    pub session_id: String,
    pub agent_name: String,
    pub created_at: String,   // RFC 3339
    pub updated_at: String,   // RFC 3339
    pub cwd: String,
    pub session_name: String,
    pub branch: String,
    pub name_is_explicit: bool,
}

/// Agents we know how to parse `full.jsonl` for. Anything we don't recognize
/// in metadata.json falls through to ClaudeCode since that was the original
/// (and still most common) shape.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Agent {
    ClaudeCode,
    Codex,
}

pub fn detect_agent(meta_bytes: &[u8]) -> Agent {
    let v: serde_json::Value = serde_json::from_slice(meta_bytes).unwrap_or_default();
    match v["agent"].as_str().unwrap_or("") {
        "Codex" => Agent::Codex,
        _ => Agent::ClaudeCode,
    }
}

/// Parse a checkpoint's `metadata.json` + `full.jsonl` into a normalized
/// session row. Dispatches on agent.
pub fn dispatch_session(meta_bytes: &[u8], jsonl_bytes: &[u8]) -> Result<ParsedSession> {
    match detect_agent(meta_bytes) {
        Agent::ClaudeCode => claude_code::parse_session(meta_bytes, jsonl_bytes),
        Agent::Codex      => codex::parse_session(meta_bytes, jsonl_bytes),
    }
}

/// Parse a shadow-branch full.jsonl (no metadata.json sibling). Today this
/// only fires for Claude Code — entire's shadow-branch mechanism is part of
/// the Claude Code integration. If/when other agents grow shadow refs, this
/// becomes a dispatch like `dispatch_session`.
pub fn dispatch_shadow_session(jsonl_bytes: &[u8], session_id: &str) -> Result<ParsedSession> {
    claude_code::parse_shadow_session(jsonl_bytes, session_id)
}
