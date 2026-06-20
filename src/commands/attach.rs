use anyhow::{Context, Result};
use std::process::Command;

use crate::{ingest, watermark};

pub fn run(session_id: &str, agent: &str, force: bool, json: bool) -> Result<()> {
    let mut cmd = Command::new("entire");
    cmd.args(["session", "attach"]).arg(session_id);
    if !agent.is_empty() && agent != "claude-code" {
        cmd.args(["--agent", agent]);
    }
    if force {
        cmd.arg("--force");
    }

    let status = cmd.status().context("failed to run `entire attach`")?;
    if !status.success() {
        anyhow::bail!("`entire attach` exited with status {}", status);
    }

    // Clear watermark so the newly attached session (whose JSONL mtime may be
    // older than the watermark) gets picked up by the ingest scan.
    let wm = watermark::claude_path();
    if wm.exists() {
        std::fs::remove_file(&wm).ok();
    }

    let mut wc_db = ingest::open_search_db()?;
    let turns = ingest::claude_code::ingest_claude_code(&mut wc_db)?;
    if turns > 0 {
        if !json { println!("{turns} turn(s) ingested."); }
        ingest::embed_and_index(&wc_db)?;
    } else if !json {
        println!("No new turns to index.");
    }

    if json {
        println!("{}", serde_json::to_string_pretty(&serde_json::json!({
            "ok": true,
            "session_id": session_id,
            "turns_ingested": turns,
        }))?);
    }

    Ok(())
}
