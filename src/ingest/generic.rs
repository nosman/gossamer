//! Semantic-search chunking for any agent that isn't Claude Code, built on
//! the agnostic `scraper` module. Mirrors `ingest::claude_code::ingest_session`'s
//! turn-grouping/sanitization approach so search results read the same way
//! regardless of which agent produced the session.

use anyhow::Result;
use uuid::Uuid;

use witchcraft::DB;

use crate::ingest::claude_code::{sanitize, MAX_CHUNK_CODEPOINTS, MIN_CHUNK_CODEPOINTS};
use crate::scraper::{self, is_wrapper_prompt, turn_text, Role};

const GENERIC_NAMESPACE: Uuid = Uuid::from_bytes([
    0x5a, 0x1c, 0x9e, 0x77, 0x3f, 0x02, 0x4b, 0x6d, 0x92, 0xe8, 0x1b, 0x4a, 0x6f, 0xd3, 0x8c, 0x0e,
]);

/// Chunk one session's transcript into the search DB. Returns the number of
/// docs written and (always `None` for now — no agent-agnostic equivalent of
/// Claude's `custom-title` entries has shown up yet) a custom title.
pub fn ingest_session(
    db: &mut DB,
    session_id: &str,
    agent_name: &str,
    content: &str,
    project_name: &str,
) -> Result<(usize, Option<String>)> {
    let (info, turns) = scraper::scan(content.as_bytes());
    if turns.is_empty() {
        return Ok((0, None));
    }

    let project_name = info
        .cwd
        .as_deref()
        .map(|cwd| cwd.trim_start_matches('/').to_string())
        .unwrap_or_else(|| project_name.to_string());

    // Prefer the first meaningful user turn (skipping wrapper-tag-only
    // context blocks like Codex's `<environment_context>`) so the header
    // shown on every chunk and in search results reads as real user intent
    // — see parsers::generic::derive_session_name for the DB-layer twin.
    let user_texts: Vec<String> = turns.iter()
        .filter(|t| matches!(t.role, Role::User))
        .map(turn_text)
        .collect();
    let session_title: String = user_texts.iter()
        .find(|t| !is_wrapper_prompt(t))
        .or_else(|| user_texts.first())
        .map(|t| t.chars().take(240).collect())
        .unwrap_or_default();

    let mut interactions: Vec<&[scraper::Turn]> = Vec::new();
    let mut start = 0;
    for (i, turn) in turns.iter().enumerate() {
        if matches!(turn.role, Role::User) && i > start {
            interactions.push(&turns[start..i]);
            start = i;
        }
    }
    interactions.push(&turns[start..]);

    let assistant_label = format!("[{agent_name}]");
    let mut count = 0;
    for (turn_idx, interaction) in interactions.iter().enumerate() {
        let header = format!("[{project_name}] {session_title}\n");
        let mut all_parts = vec![header];
        let mut turns_meta: Vec<serde_json::Value> = Vec::new();

        for turn in *interaction {
            let text = sanitize(&turn_text(turn));
            if text.is_empty()
                || !(MIN_CHUNK_CODEPOINTS..=MAX_CHUNK_CODEPOINTS).contains(&text.chars().count())
            {
                continue;
            }
            let label = if matches!(turn.role, Role::User) { "[User]" } else { assistant_label.as_str() };
            all_parts.push(format!("{label} {text}\n"));
            turns_meta.push(serde_json::json!({
                "role": if matches!(turn.role, Role::User) { "user" } else { "assistant" },
                "timestamp": turn.timestamp,
            }));
        }

        let lengths: Vec<usize> = all_parts.iter().map(|p| p.chars().count()).collect();
        let body = all_parts.join("");

        if turns_meta.is_empty() || body.trim().is_empty() {
            continue;
        }

        let uuid = Uuid::new_v5(&GENERIC_NAMESPACE, format!("{session_id}:{turn_idx}").as_bytes());

        let metadata = serde_json::json!({
            "source": agent_name.to_lowercase(),
            "project": project_name,
            "session_id": session_id,
            "session_name": session_title,
            "turn": turn_idx,
            "turns": turns_meta,
            "branch": info.branch,
        })
        .to_string();

        let ts = interaction
            .iter()
            .find_map(|t| t.timestamp.as_deref())
            .unwrap_or_default();
        let date = iso8601_timestamp::Timestamp::parse(ts);
        db.add_doc(&uuid, date, &metadata, &body, Some(lengths))?;
        count += 1;
    }

    Ok((count, None))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db(name: &str) -> DB {
        let path = std::env::temp_dir().join(format!("gossamer_generic_ingest_test_{name}.db"));
        let _ = std::fs::remove_file(&path);
        DB::new(path).expect("open db")
    }

    #[test]
    fn chunks_codex_session_with_wrapper_prompt_and_tool_call() {
        let jsonl = r#"{"timestamp":"2026-07-14T15:39:15.0Z","type":"event_msg","payload":{"type":"user_message","message":"<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>"}}
{"timestamp":"2026-07-14T15:39:16.0Z","type":"event_msg","payload":{"type":"user_message","message":"fix the flaky test"}}
{"timestamp":"2026-07-14T15:39:17.0Z","type":"event_msg","payload":{"type":"agent_message","message":"On it."}}
{"timestamp":"2026-07-14T15:39:18.0Z","type":"response_item","payload":{"type":"function_call","name":"exec","arguments":"{\"cmd\":\"pytest\"}","call_id":"c1"}}
{"timestamp":"2026-07-14T15:39:19.0Z","type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":[{"type":"input_text","text":"1 passed"}]}}"#;

        let mut db = test_db("wrapper_and_tool");
        let (count, custom_title) = ingest_session(&mut db, "sess-1", "Codex", jsonl, "myproject").unwrap();
        // One doc per user-turn boundary: the wrapper-context turn and the
        // real prompt (+ its assistant/tool-call turns) split into two.
        assert_eq!(count, 2);
        assert!(custom_title.is_none());

        let mut stmt = db.query("SELECT metadata, body FROM document ORDER BY rowid").unwrap();
        let mut rows = stmt.query([]).unwrap();
        let mut metadatas = Vec::new();
        let mut bodies = Vec::new();
        while let Some(row) = rows.next().unwrap() {
            metadatas.push(row.get::<_, String>(0).unwrap());
            bodies.push(row.get::<_, String>(1).unwrap());
        }
        assert_eq!(bodies.len(), 2);

        // Session title (shared across both docs) skips the wrapper-tag turn
        // in favor of the real prompt.
        for metadata in &metadatas {
            assert!(metadata.contains("\"source\":\"codex\""));
            assert!(metadata.contains("fix the flaky test"));
            assert!(!metadata.contains("environment_context"));
        }

        let all_bodies = bodies.join("\n");
        assert!(all_bodies.contains("[User] fix the flaky test"));
        assert!(all_bodies.contains("[Codex] On it."));
        assert!(all_bodies.contains("[Tool: exec]"));
        assert!(all_bodies.contains("pytest"));
        assert!(all_bodies.contains("1 passed"));
    }
}
