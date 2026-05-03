use std::{
    fs::File,
    io::{BufRead, BufReader},
    path::Path,
};

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use dirs::home_dir;
use sea_orm::{sea_query::OnConflict, ActiveValue::Set, DatabaseConnection, EntityTrait};
use serde::Deserialize;
use serde_json::Value;

use crate::{
    db,
    entity::{repository, session},
};

pub async fn run() -> Result<()> {
    let db = db::connect().await?;
    let repos = repository::Entity::find().all(&db).await?;

    if repos.is_empty() {
        println!("No repositories tracked. Run `gossamer init` first.");
        return Ok(());
    }

    let checkpoints_root = home_dir()
        .context("cannot determine home directory")?
        .join(".gossamer")
        .join("checkpoints");

    let mut grand_total = 0usize;

    for repo in &repos {
        let repo_dir = checkpoints_root.join(&repo.name);
        if !repo_dir.exists() {
            println!("'{}': no checkpoints directory found, skipping.", repo.name);
            continue;
        }

        match index_repo(&db, &repo_dir).await {
            Ok(n) => {
                println!("'{}': indexed {} session(s).", repo.name, n);
                grand_total += n;
            }
            Err(e) => eprintln!("'{}': error — {}", repo.name, e),
        }
    }

    println!("\n{} session(s) indexed.", grand_total);
    Ok(())
}

async fn index_repo(db: &DatabaseConnection, repo_dir: &Path) -> Result<usize> {
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "unknown".to_string());

    let mut count = 0;

    // Walk XX/ prefix dirs, skipping hidden entries like .git
    for prefix_entry in std::fs::read_dir(repo_dir)? {
        let prefix_dir = prefix_entry?.path();
        if !prefix_dir.is_dir() || is_hidden(&prefix_dir) {
            continue;
        }

        // Walk yyyyyyyyyy/ checkpoint dirs
        for checkpoint_entry in std::fs::read_dir(&prefix_dir)? {
            let checkpoint_dir = checkpoint_entry?.path();
            if !checkpoint_dir.is_dir() {
                continue;
            }

            // Walk session index dirs: 0/, 1/, 2/ ...
            for session_entry in std::fs::read_dir(&checkpoint_dir)? {
                let session_dir = session_entry?.path();
                if !session_dir.is_dir() {
                    continue;
                }

                // Only process numeric session index directories
                let is_index_dir = session_dir
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|s| s.chars().all(|c| c.is_ascii_digit()))
                    .unwrap_or(false);
                if !is_index_dir {
                    continue;
                }

                let metadata_path = session_dir.join("metadata.json");
                let jsonl_path = session_dir.join("full.jsonl");
                if !metadata_path.exists() || !jsonl_path.exists() {
                    continue;
                }

                match parse_session(&metadata_path, &jsonl_path, &user) {
                    Ok(model) => {
                        upsert_session(db, model).await?;
                        count += 1;
                    }
                    Err(e) => eprintln!("  skipping {:?}: {}", session_dir, e),
                }
            }
        }
    }

    Ok(count)
}

fn parse_session(metadata_path: &Path, jsonl_path: &Path, user: &str) -> Result<session::ActiveModel> {
    let meta: SessionMetadata = serde_json::from_reader(BufReader::new(File::open(metadata_path)?))
        .with_context(|| format!("failed to parse {:?}", metadata_path))?;

    let created_at = meta
        .created_at
        .as_deref()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|dt: DateTime<chrono::FixedOffset>| dt.with_timezone(&Utc))
        .unwrap_or_else(Utc::now);

    let session_name = meta
        .summary
        .and_then(|s| s.intent)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("session:{}", &meta.session_id[..8]));

    let agent_name = meta.agent.unwrap_or_else(|| "unknown".to_string());

    // Scan JSONL: latest timestamp, first cwd, and last human-typed user prompt
    let mut latest: Option<DateTime<Utc>> = None;
    let mut cwd = String::new();
    let mut last_prompt: Option<String> = None;

    for line in BufReader::new(File::open(jsonl_path)?).lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let v: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if let Some(ts) = v.get("timestamp").and_then(Value::as_str) {
            if let Ok(dt) = DateTime::parse_from_rfc3339(ts) {
                let dt: DateTime<Utc> = dt.with_timezone(&Utc);
                if latest.map_or(true, |l| dt > l) {
                    latest = Some(dt);
                }
            }
        }

        if cwd.is_empty() {
            if let Some(c) = v.get("cwd").and_then(Value::as_str) {
                cwd = c.to_string();
            }
        }

        // Only capture plain string content — arrays are tool results, not human prompts
        if v.get("type").and_then(Value::as_str) == Some("user") {
            if let Some(Value::String(text)) = v.get("message").and_then(|m| m.get("content")) {
                let text = text.trim().to_string();
                if !text.is_empty() {
                    last_prompt = Some(text);
                }
            }
        }
    }

    let updated_at = latest.unwrap_or(created_at);
    let session_name = last_prompt.unwrap_or(session_name);

    Ok(session::ActiveModel {
        session_id: Set(meta.session_id),
        agent_name: Set(agent_name),
        user: Set(user.to_string()),
        created_at: Set(created_at),
        updated_at: Set(updated_at),
        cwd: Set(cwd),
        session_name: Set(session_name),
    })
}

async fn upsert_session(db: &DatabaseConnection, model: session::ActiveModel) -> Result<()> {
    session::Entity::insert(model)
        .on_conflict(
            OnConflict::column(session::Column::SessionId)
                .update_columns([
                    session::Column::AgentName,
                    session::Column::UpdatedAt,
                    session::Column::Cwd,
                    session::Column::SessionName,
                ])
                .to_owned(),
        )
        .exec(db)
        .await?;
    Ok(())
}

fn is_hidden(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.starts_with('.'))
        .unwrap_or(false)
}

// Only the fields we need from the session-level metadata.json
#[derive(Deserialize)]
struct SessionMetadata {
    session_id: String,
    agent: Option<String>,
    created_at: Option<String>,
    summary: Option<Summary>,
}

#[derive(Deserialize)]
struct Summary {
    intent: Option<String>,
}
