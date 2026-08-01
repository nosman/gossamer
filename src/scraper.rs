//! Agent-agnostic transcript scraper.
//!
//! Claude Code's JSONL has a well-known, stable shape and gets its own
//! bespoke, tuned parser (`parsers::claude_code` / `ingest::claude_code`).
//! Everything else — Codex today, whatever tomorrow — goes through this
//! module instead of a bespoke parser per format. Rather than deserializing
//! into a format-specific struct, `scan` walks each JSONL line generically
//! and looks for a small set of recognizable signals (a `role` field, a
//! `type` naming a known role synonym, text under `text`/`message`, tool
//! calls shaped like `{name, input|arguments}`) at the top level and one
//! level of nesting under `payload` (Codex's raw session log wraps
//! everything in `{"type": "event_msg"|"response_item", "payload": {...}}`).
//! A new agent format that reuses any of these conventions needs no new
//! code here at all; one that doesn't just falls through as unrecognized
//! noise rather than erroring.
//!
//! Turns carry structured `Part`s (text / tool calls with their arguments
//! and result, uncapped) so a rich consumer like the `show` transcript
//! viewer can render tool calls as interactive elements. `turn_text`
//! flattens a turn into a single string (with length caps applied) for
//! consumers that just want a search-indexable blob, e.g. `ingest::generic`.

use serde_json::Value;
use std::collections::HashMap;

#[derive(PartialEq, Eq, Clone, Copy)]
pub enum Role {
    User,
    Assistant,
}

#[derive(Clone, PartialEq)]
pub enum Part {
    Text(String),
    ToolCall {
        id: Option<String>,
        name: String,
        input: Value,
        /// Uncapped result/output text, if the call has resolved yet.
        result: Option<String>,
    },
}

pub struct Turn {
    pub role: Role,
    pub parts: Vec<Part>,
    pub timestamp: Option<String>,
    pub ts_ms: i64,
}

#[derive(Default)]
pub struct ScanInfo {
    pub cwd: Option<String>,
    pub branch: Option<String>,
    /// Best-effort agent display name, sniffed from fields like
    /// `originator` ("Codex Desktop") or a per-line `agent` field
    /// ("codex" on compact transcripts). None when nothing was found.
    pub agent_hint: Option<String>,
    /// Cumulative output tokens, opportunistically read from a running
    /// `payload.info.total_token_usage.output_tokens` counter (Codex's
    /// `token_count` events). Last value wins since it's a running total,
    /// not a per-turn delta. 0 when the format doesn't report this.
    pub tokens_used: i64,
}

const MAX_TOOL_ARG_CHARS: usize = 500;
const MAX_TOOL_OUTPUT_CHARS: usize = 800;

/// Sniff whether `jsonl_bytes` looks like Claude Code's format: a top-level
/// `type` in Claude's known enum, with `message.role`/`message.content` for
/// user/assistant lines. Used only when there's no `metadata.json` to
/// consult (shadow branches) — checkpoint dispatch instead trusts the
/// `agent` field on `metadata.json`.
pub fn looks_like_claude_shape(jsonl_bytes: &[u8]) -> bool {
    let mut checked = 0;
    for line in jsonl_bytes.split(|&b| b == b'\n') {
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_slice::<Value>(line) else { continue };
        let Some(t) = v.get("type").and_then(Value::as_str) else { continue };
        match t {
            "user" | "assistant" => {
                if v["message"]["role"].is_string() {
                    return true;
                }
            }
            "system" | "custom-title" | "summary" => return true,
            _ => {}
        }
        checked += 1;
        if checked >= 20 {
            break;
        }
    }
    false
}

/// Flatten a turn's parts into a single display/search string: plain text as-is,
/// tool calls as a `[Tool: name] args` line with a `→ result` line if resolved.
/// Length-capped, unlike the raw `Part` data — this is for search-index bodies.
pub fn turn_text(turn: &Turn) -> String {
    let mut out = String::new();
    for part in &turn.parts {
        if !out.is_empty() {
            out.push('\n');
        }
        match part {
            Part::Text(s) => out.push_str(s),
            Part::ToolCall { name, input, result, .. } => {
                out.push_str(&format!("[Tool: {name}] {}", truncate(&tool_call_arg_display(input), MAX_TOOL_ARG_CHARS)));
                if let Some(r) = result {
                    if !r.trim().is_empty() {
                        out.push_str("\n→ ");
                        out.push_str(&truncate(r, MAX_TOOL_OUTPUT_CHARS));
                    }
                }
            }
        }
    }
    out
}

/// Render a tool call's `input` back to a compact display string. Our own
/// single-field synthetic wrapper (`{"input": "<raw string>"}`, used when the
/// source format didn't give us real JSON arguments) unwraps back to the raw
/// string; a genuine multi-field object renders as JSON.
fn tool_call_arg_display(input: &Value) -> String {
    if let Some(obj) = input.as_object() {
        if obj.len() == 1 {
            if let Some(s) = obj.values().next().and_then(Value::as_str) {
                return s.to_string();
            }
        }
    }
    input.to_string()
}

/// Walk a JSONL transcript generically, extracting session-level info and a
/// chronological list of user/assistant turns. Unrecognized lines (control
/// events, reasoning traces, session metadata, etc.) are silently skipped.
pub fn scan(jsonl_bytes: &[u8]) -> (ScanInfo, Vec<Turn>) {
    let mut info = ScanInfo::default();
    let mut turns: Vec<Turn> = Vec::new();
    // call_id -> (turn index, part index), so a later `*_output` line can
    // attach its result to the exact tool-call part that made the call.
    let mut pending_calls: HashMap<String, (usize, usize)> = HashMap::new();

    for line in jsonl_bytes.split(|&b| b == b'\n') {
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_slice::<Value>(line) else { continue };

        let timestamp = first_str(&v, &["timestamp", "ts"]).map(str::to_string);
        let ts_ms = timestamp
            .as_deref()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.timestamp_millis())
            .unwrap_or(0);

        // Session-level info can show up on lines that carry no turn content
        // (e.g. Codex's `session_meta`), so this check is independent of
        // whether the line classifies as a turn below.
        collect_session_info(&v, &mut info);
        if let Some(n) = v.pointer("/payload/info/total_token_usage/output_tokens").and_then(Value::as_i64) {
            info.tokens_used = n;
        }

        // Tool-call output lines don't carry a role of their own — attach
        // them to the call they answer, then move on.
        if let Some(call_id) = first_str(&v, &["call_id"]) {
            if let Some(&(t_idx, p_idx)) = pending_calls.get(call_id) {
                if let Some(out) = extract_output_text(&v) {
                    if let Part::ToolCall { result, .. } = &mut turns[t_idx].parts[p_idx] {
                        *result = Some(out);
                    }
                }
                continue;
            }
        }

        let Some((role, envelope)) = classify(&v) else { continue };
        let parts = extract_parts(envelope);
        if parts.is_empty() {
            continue;
        }

        // Codex's raw log reports the same user/assistant message twice —
        // once as a UI-facing `event_msg` notification and once as the
        // `response_item` conversation-history entry — so only collapse
        // an exact repeat of the immediately preceding turn, not any
        // earlier occurrence (a user genuinely repeating themselves later
        // in the conversation should still count as two turns).
        if turns.last().is_some_and(|last| last.role == role && last.parts == parts) {
            continue;
        }

        turns.push(Turn { role, parts, timestamp, ts_ms });
        let t_idx = turns.len() - 1;
        for (p_idx, part) in turns[t_idx].parts.iter().enumerate() {
            if let Part::ToolCall { id: Some(cid), .. } = part {
                pending_calls.insert(cid.clone(), (t_idx, p_idx));
            }
        }
    }

    turns.sort_by_key(|t| t.ts_ms);
    (info, turns)
}

/// Classify a line as a User/Assistant turn, returning the sub-object whose
/// fields (`role`/`type`/`content`/`message`/`text`) should be used for text
/// extraction. Checks the line itself and one level of nesting under
/// `payload` (Codex's `{"type":"event_msg","payload":{...}}` wrapper).
fn classify(v: &Value) -> Option<(Role, &Value)> {
    for envelope in [v, v.get("payload").unwrap_or(&Value::Null)] {
        if envelope.is_null() {
            continue;
        }
        if let Some(role) = envelope.get("role").and_then(Value::as_str) {
            match role {
                "user" => return Some((Role::User, envelope)),
                "assistant" => return Some((Role::Assistant, envelope)),
                _ => continue, // developer/system/tool — not a turn
            }
        }
        if let Some(t) = envelope.get("type").and_then(Value::as_str) {
            match t {
                "user" | "user_message" => return Some((Role::User, envelope)),
                "assistant" | "agent_message" | "agent_reasoning" => {
                    return Some((Role::Assistant, envelope));
                }
                "function_call" | "custom_tool_call" | "tool_use" => {
                    return Some((Role::Assistant, envelope));
                }
                _ => {}
            }
        }
    }
    None
}

/// Pull structured parts out of a classified envelope: a plain `message`/
/// `text` field or `content` string becomes a single `Part::Text`; a
/// `content` array becomes one part per block; a tool-call-shaped envelope
/// (`name` + `arguments`/`input`) becomes a single `Part::ToolCall`.
fn extract_parts(envelope: &Value) -> Vec<Part> {
    if envelope.get("name").and_then(Value::as_str).is_some() {
        return vec![tool_call_part(envelope)];
    }

    if let Some(s) = first_str(envelope, &["message", "text"]) {
        return text_part(s);
    }

    match envelope.get("content") {
        Some(Value::String(s)) => text_part(s),
        Some(Value::Array(blocks)) => blocks.iter().filter_map(extract_block_part).collect(),
        _ => vec![],
    }
}

fn text_part(s: &str) -> Vec<Part> {
    if s.trim().is_empty() { vec![] } else { vec![Part::Text(s.to_string())] }
}

/// Extract a part from a single content/output block. Blocks are treated as
/// text-bearing purely by the presence of a `.text` field, not by their
/// declared `type` tag — Codex uses `"input_text"` where Claude uses
/// `"text"`, so keying off the tag name would miss it.
fn extract_block_part(block: &Value) -> Option<Part> {
    if let Value::String(s) = block {
        return text_part(s).pop();
    }
    if let Some(s) = block.get("text").and_then(Value::as_str) {
        return text_part(s).pop();
    }
    if block.get("name").and_then(Value::as_str).is_some() {
        return Some(tool_call_part(block));
    }
    None
}

/// Build a `Part::ToolCall` from a tool-call-shaped object, whether it's a
/// top-level envelope (Codex's raw `function_call`/`custom_tool_call`
/// payloads) or a block inside a `content` array (compact-transcript
/// `tool_use` blocks). Arguments are kept as real JSON when parseable
/// (Codex's `arguments` field is a JSON-encoded string); otherwise the raw
/// string (e.g. `custom_tool_call`'s JS source) is wrapped as a single
/// synthetic field so downstream renderers still have something to show.
/// An inline `result`/`output` on the same object is captured directly —
/// Codex's raw log instead reports results on a later, `call_id`-correlated
/// line, handled by `pending_calls` in `scan`.
fn tool_call_part(source: &Value) -> Part {
    let name = source.get("name").and_then(Value::as_str).unwrap_or("tool").to_string();
    let id = first_str(source, &["call_id", "id"]).map(String::from);
    let raw_args = first_str(source, &["arguments", "input"]).unwrap_or("");
    let input = serde_json::from_str::<Value>(raw_args)
        .ok()
        .filter(Value::is_object)
        .unwrap_or_else(|| {
            if raw_args.is_empty() {
                serde_json::json!({})
            } else {
                serde_json::json!({ "input": raw_args })
            }
        });
    let result = extract_output_text(source);
    Part::ToolCall { id, name, input, result }
}

/// Extract result/output text from a tool-call-output line or an inline
/// `result`/`output` field, checking the line itself and one level of
/// nesting under `payload`. Handles a plain string, an array of blocks, or
/// an object with its own `output` string (Codex compact transcript's
/// `{"output": "...", "status": "success"}`).
fn extract_output_text(v: &Value) -> Option<String> {
    for envelope in [v, v.get("payload").unwrap_or(&Value::Null)] {
        if envelope.is_null() {
            continue;
        }
        let Some(out) = envelope.get("output").or_else(|| envelope.get("result")) else { continue };
        match out {
            Value::String(s) => return Some(s.clone()),
            Value::Array(blocks) => {
                let parts: Vec<String> = blocks.iter().filter_map(|b| match extract_block_part(b) {
                    Some(Part::Text(s)) => Some(s),
                    _ => None,
                }).collect();
                if !parts.is_empty() {
                    return Some(parts.join("\n"));
                }
            }
            Value::Object(_) => {
                if let Some(s) = out.get("output").and_then(Value::as_str) {
                    return Some(s.to_string());
                }
            }
            _ => {}
        }
    }
    None
}

fn collect_session_info(v: &Value, info: &mut ScanInfo) {
    if info.cwd.is_none() {
        if let Some(c) = first_str(v, &["cwd"]) {
            info.cwd = Some(c.to_string());
        }
    }
    if info.branch.is_none() {
        if let Some(b) = first_str(v, &["gitBranch", "branch"]) {
            info.branch = Some(b.to_string());
        }
    }
    if info.agent_hint.is_none() {
        if let Some(a) = first_str(v, &["agent"]) {
            info.agent_hint = Some(a.to_string());
        } else if let Some(o) = first_str(v, &["originator"]) {
            info.agent_hint = Some(normalize_originator(o));
        }
    }
}

/// "Codex Desktop" / "Codex CLI" -> "Codex"; anything else passed through.
fn normalize_originator(originator: &str) -> String {
    originator
        .split_whitespace()
        .next()
        .unwrap_or(originator)
        .to_string()
}

/// Look for the first of `keys` as a string field, checking the value
/// itself and one level of nesting under `payload`.
fn first_str<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a str> {
    for envelope in [v, v.get("payload").unwrap_or(&Value::Null)] {
        for key in keys {
            if let Some(s) = envelope.get(*key).and_then(Value::as_str) {
                if !s.is_empty() {
                    return Some(s);
                }
            }
        }
    }
    None
}

/// True when `text` opens with an XML-ish wrapper tag (`<environment_context>`,
/// `<command-message>`, `<recommended_plugins>`, ...) rather than actual user
/// intent. Different agents invent their own tag names for this kind of
/// injected context/metadata, so this matches on the generic shape of an
/// opening tag rather than a per-agent name list.
pub fn is_wrapper_prompt(text: &str) -> bool {
    let first_line = text.lines().next().unwrap_or("").trim_start();
    let Some(rest) = first_line.strip_prefix('<') else { return false };
    let tag: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '-' || *c == '_').collect();
    !tag.is_empty() && rest[tag.len()..].starts_with(|c: char| c == '>' || c.is_whitespace())
}

fn truncate(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let truncated: String = s.chars().take(max_chars).collect();
    format!("{truncated}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_codex_user_and_assistant_messages() {
        let jsonl = r#"{"timestamp":"2026-07-14T15:39:16.517Z","type":"event_msg","payload":{"type":"user_message","message":"hello there"}}
{"timestamp":"2026-07-14T15:39:18.938Z","type":"event_msg","payload":{"type":"agent_message","message":"hi back"}}"#;
        let (_, turns) = scan(jsonl.as_bytes());
        assert_eq!(turns.len(), 2);
        assert!(matches!(turns[0].role, Role::User));
        assert_eq!(turn_text(&turns[0]), "hello there");
        assert!(matches!(turns[1].role, Role::Assistant));
        assert_eq!(turn_text(&turns[1]), "hi back");
    }

    #[test]
    fn correlates_tool_call_with_its_output() {
        let jsonl = r#"{"timestamp":"2026-07-14T15:39:22.5Z","type":"response_item","payload":{"type":"function_call","name":"exec","arguments":"{\"cmd\":\"pwd\"}","call_id":"c1"}}
{"timestamp":"2026-07-14T15:39:23.0Z","type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":[{"type":"input_text","text":"/repo"}]}}"#;
        let (_, turns) = scan(jsonl.as_bytes());
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].parts.len(), 1);
        let Part::ToolCall { id, name, input, result } = &turns[0].parts[0] else { panic!("expected a tool call") };
        assert_eq!(id.as_deref(), Some("c1"));
        assert_eq!(name, "exec");
        assert_eq!(input["cmd"].as_str(), Some("pwd"));
        assert_eq!(result.as_deref(), Some("/repo"));

        let text = turn_text(&turns[0]);
        assert!(text.contains("[Tool: exec]"));
        assert!(text.contains("pwd"));
        assert!(text.contains("→ /repo"));
    }

    #[test]
    fn custom_tool_call_wraps_non_json_input_as_single_field() {
        let jsonl = r#"{"timestamp":"2026-07-14T15:39:22.5Z","type":"response_item","payload":{"type":"custom_tool_call","name":"exec","input":"console.log(1)","call_id":"c1"}}"#;
        let (_, turns) = scan(jsonl.as_bytes());
        let Part::ToolCall { input, .. } = &turns[0].parts[0] else { panic!("expected a tool call") };
        assert_eq!(input["input"].as_str(), Some("console.log(1)"));
        assert!(turn_text(&turns[0]).contains("console.log(1)"));
    }

    #[test]
    fn collapses_duplicate_user_message_across_envelopes() {
        // Codex logs the same user message once as a `response_item` and once
        // as an `event_msg` notification — real shape seen in ~/p/entire-graph.
        let jsonl = r#"{"timestamp":"2026-07-14T15:39:16.517Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello there"}]}}
{"timestamp":"2026-07-14T15:39:16.518Z","type":"event_msg","payload":{"type":"user_message","message":"hello there"}}"#;
        let (_, turns) = scan(jsonl.as_bytes());
        assert_eq!(turns.len(), 1);
        assert_eq!(turn_text(&turns[0]), "hello there");
    }

    #[test]
    fn skips_developer_and_control_events() {
        let jsonl = r#"{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"system prompt"}]}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}
{"type":"session_meta","payload":{"cwd":"/repo","originator":"Codex Desktop"}}"#;
        let (info, turns) = scan(jsonl.as_bytes());
        assert!(turns.is_empty());
        assert_eq!(info.cwd.as_deref(), Some("/repo"));
        assert_eq!(info.agent_hint.as_deref(), Some("Codex"));
    }

    #[test]
    fn wrapper_prompt_detection_is_agent_agnostic() {
        // Claude's own wrapper tags...
        assert!(is_wrapper_prompt("<command-message>foo</command-message>"));
        // ...and Codex's differently-named ones (real shape seen in
        // ~/p/entire-graph) are both recognized by tag shape, not by name.
        assert!(is_wrapper_prompt("<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>"));
        assert!(is_wrapper_prompt("<recommended_plugins>\nHere is a list...\n</recommended_plugins>"));
        assert!(!is_wrapper_prompt("Continue the work from the completed CLI handoff."));
    }

    #[test]
    fn claude_shape_sniff() {
        let claude = br#"{"type":"user","message":{"role":"user","content":"hi"}}"#;
        assert!(looks_like_claude_shape(claude));
        let codex = br#"{"type":"event_msg","payload":{"type":"user_message","message":"hi"}}"#;
        assert!(!looks_like_claude_shape(codex));
    }
}
