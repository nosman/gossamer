use anyhow::Result;
use std::process::Command;

use crate::{db, ingest};
use witchcraft::types::{
    SqlConditionInternal, SqlOperator, SqlStatementInternal, SqlStatementType, SqlValue,
};

/// Resolve a session identifier (UUID or name) to the UUID used as the JSONL file stem.
/// Priority: exact session_id in DB → session_name in DB → customTitle scan of JSONL files → input as-is.
fn resolve_session_id(conn: &rusqlite::Connection, input: &str) -> String {
    if conn.query_row(
        "SELECT 1 FROM sessions WHERE session_id = ?1",
        rusqlite::params![input], |_| Ok(()),
    ).is_ok() {
        return input.to_string();
    }

    if let Ok(id) = conn.query_row(
        "SELECT session_id FROM sessions WHERE session_name = ?1 LIMIT 1",
        rusqlite::params![input], |row| row.get::<_, String>(0),
    ) {
        return id;
    }

    if let Some(id) = find_jsonl_by_title(input) {
        return id;
    }

    input.to_string()
}

fn find_jsonl_by_title(title: &str) -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let projects = std::path::PathBuf::from(&home).join(".claude/projects");
    for dir in std::fs::read_dir(&projects).ok()?.flatten() {
        for file in std::fs::read_dir(dir.path()).ok()?.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") { continue; }
            let Ok(content) = std::fs::read_to_string(&path) else { continue };
            for line in content.lines() {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
                if v["type"].as_str() == Some("custom-title")
                    && v["customTitle"].as_str() == Some(title)
                {
                    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                        return Some(stem.to_string());
                    }
                }
            }
        }
    }
    None
}

pub fn run(session_id_or_name: &str, json: bool) -> Result<()> {
    let conn = db::connect()?;
    let session_id = resolve_session_id(&conn, session_id_or_name);

    // entire clean — non-fatal (session may already be gone from entireio).
    match Command::new("entire").arg("clean").arg(&session_id).status() {
        Ok(s) if s.success() => {}
        Ok(s)  => eprintln!("warning: `entire clean` exited with {s}"),
        Err(e) => eprintln!("warning: could not run `entire clean`: {e}"),
    }

    let rows = conn.execute(
        "DELETE FROM sessions WHERE session_id = ?1",
        rusqlite::params![session_id],
    )?;
    conn.execute(
        "DELETE FROM event_log WHERE session_id = ?1",
        rusqlite::params![session_id],
    )?;

    if !json {
        if rows > 0 {
            println!("Removed '{}' from gossamer DB.", session_id);
        } else {
            println!("'{}' was not in gossamer DB.", session_id);
        }
    }

    let Ok(mut wc_db) = ingest::open_search_db() else {
        if json { println!("{}", serde_json::json!({"ok": true, "session_id": session_id, "db_rows_deleted": rows})); }
        return Ok(());
    };

    let filter = SqlStatementInternal {
        statement_type: SqlStatementType::Condition,
        condition: Some(SqlConditionInternal {
            key: "$.session_id".to_string(),
            operator: SqlOperator::Equals,
            value: Some(SqlValue::String(session_id.to_string())),
        }),
        logic: None,
        statements: None,
    };

    match wc_db.delete_with_filter(&filter) {
        Ok(_)  => { if !json { println!("Removed search index entries for '{}'.", session_id); } }
        Err(e) => eprintln!("Warning: could not clean search DB: {e}"),
    }

    if json {
        println!("{}", serde_json::to_string_pretty(&serde_json::json!({
            "ok": true,
            "session_id": session_id,
            "db_rows_deleted": rows,
        }))?);
    }

    Ok(())
}
