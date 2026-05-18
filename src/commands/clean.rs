use anyhow::{Context, Result};
use std::process::Command;

use crate::{db, ingest};
use witchcraft::types::{
    SqlConditionInternal, SqlOperator, SqlStatementInternal, SqlStatementType, SqlValue,
};

pub fn run(session_id: &str) -> Result<()> {
    let status = Command::new("entire")
        .arg("clean")
        .arg(session_id)
        .status()
        .context("failed to run `entire clean`")?;
    if !status.success() {
        anyhow::bail!("`entire clean` exited with status {}", status);
    }

    let conn = db::connect()?;
    let rows = conn.execute(
        "DELETE FROM sessions WHERE session_id = ?1",
        rusqlite::params![session_id],
    )?;
    conn.execute(
        "DELETE FROM event_log WHERE session_id = ?1",
        rusqlite::params![session_id],
    )?;

    if rows > 0 {
        println!("Removed '{}' from gossamer DB.", session_id);
    } else {
        println!("Session '{}' was not in gossamer DB.", session_id);
    }

    let Ok(mut wc_db) = ingest::open_search_db() else {
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
        Ok(_) => println!("Removed search index entries for '{}'.", session_id),
        Err(e) => eprintln!("Warning: could not clean search DB: {e}"),
    }

    Ok(())
}
