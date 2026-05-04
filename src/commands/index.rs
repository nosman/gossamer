use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use sea_orm::{sea_query::OnConflict, ActiveValue::Set, DatabaseConnection, EntityTrait};
use serde::Deserialize;
use serde_json::Value;
use std::{path::Path, process::Command};

use crate::{
    db,
    entity::{repository, session},
};

const BRANCH: &str = "entire/checkpoints/v1";

pub async fn run() -> Result<()> {
    let db = db::connect().await?;
    let repos = repository::Entity::find().all(&db).await?;

    if repos.is_empty() {
        println!("No repositories tracked. Run `gossamer init` first.");
        return Ok(());
    }

    let mut grand_total = 0usize;

    for repo in &repos {
        match index_repo(&db, &repo.directory, &repo.name).await {
            Ok(0) => println!("'{}': no {} branch found.", repo.name, BRANCH),
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

async fn index_repo(db: &DatabaseConnection, repo_dir: &str, _repo_name: &str) -> Result<usize> {
    // If a checkpoint remote is configured, fetch the branch from there first.
    if let Some(remote_url) = checkpoint_remote_url(repo_dir) {
        let _ = Command::new("git")
            .args(["fetch", &remote_url, &format!("{}:{}", BRANCH, BRANCH)])
            .current_dir(repo_dir)
            .output();
    }

    // Bail early if the branch doesn't exist in this repo.
    let check = Command::new("git")
        .args(["rev-parse", "--verify", BRANCH])
        .current_dir(repo_dir)
        .output()
        .context("failed to run git")?;

    if !check.status.success() {
        return Ok(0);
    }

    // List every file tracked on the branch.
    let ls = Command::new("git")
        .args(["ls-tree", "-r", "--name-only", BRANCH])
        .current_dir(repo_dir)
        .output()
        .context("git ls-tree failed")?;

    let listing = String::from_utf8(ls.stdout)?;

    // Session metadata lives at XX/yyyyyyyyyy/N/metadata.json where N is all digits.
    let meta_paths: Vec<&str> = listing
        .lines()
        .filter(|l| {
            l.ends_with("/metadata.json")
                && l.matches('/').count() == 3
                && l.split('/').nth(2).map_or(false, |s| s.chars().all(|c| c.is_ascii_digit()))
        })
        .collect();

    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "unknown".to_string());

    let mut count = 0;

    for meta_path in meta_paths {
        let jsonl_path = format!("{}full.jsonl", &meta_path[..meta_path.len() - "metadata.json".len()]);

        let meta_bytes = match git_show(repo_dir, meta_path) {
            Ok(b) => b,
            Err(e) => { eprintln!("  skipping {}: {}", meta_path, e); continue; }
        };
        let jsonl_bytes = match git_show(repo_dir, &jsonl_path) {
            Ok(b) => b,
            Err(_) => continue,
        };

        match parse_session(&meta_bytes, &jsonl_bytes, &user) {
            Ok(model) => {
                upsert_session(db, model).await?;
                count += 1;
            }
            Err(e) => eprintln!("  skipping {}: {}", meta_path, e),
        }
    }

    Ok(count)
}

fn git_show(repo_dir: &str, path: &str) -> Result<Vec<u8>> {
    let out = Command::new("git")
        .args(["show", &format!("{}:{}", BRANCH, path)])
        .current_dir(repo_dir)
        .output()
        .context("failed to run git show")?;

    if !out.status.success() {
        anyhow::bail!("object not found: {}", path);
    }
    Ok(out.stdout)
}

/// Reads .entire/settings.json and returns a git URL for the checkpoint remote if configured.
/// Mirrors the SSH/HTTPS protocol of the project's own origin remote.
fn checkpoint_remote_url(repo_dir: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct EntireSettings {
        strategy_options: Option<StrategyOptions>,
    }
    #[derive(Deserialize)]
    struct StrategyOptions {
        checkpoint_remote: Option<CheckpointRemote>,
    }
    #[derive(Deserialize)]
    struct CheckpointRemote {
        repo: String,
    }

    let settings_path = Path::new(repo_dir).join(".entire").join("settings.json");
    let raw = std::fs::read_to_string(settings_path).ok()?;
    let settings: EntireSettings = serde_json::from_str(&raw).ok()?;
    let cp_repo = settings.strategy_options?.checkpoint_remote?.repo;

    // Derive the URL protocol from the project's own origin remote.
    let use_ssh = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(repo_dir)
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|u| u.trim_start().starts_with("git@") || u.trim_start().starts_with("ssh://"))
        .unwrap_or(true);

    let url = if use_ssh {
        format!("git@github.com:{}.git", cp_repo)
    } else {
        format!("https://github.com/{}.git", cp_repo)
    };

    Some(url)
}

fn parse_session(meta_bytes: &[u8], jsonl_bytes: &[u8], user: &str) -> Result<session::ActiveModel> {
    let meta: SessionMetadata = serde_json::from_slice(meta_bytes)
        .context("failed to parse metadata.json")?;

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

    let mut latest: Option<DateTime<Utc>> = None;
    let mut cwd = String::new();
    let mut last_prompt: Option<String> = None;

    for line in jsonl_bytes.split(|&b| b == b'\n') {
        if line.is_empty() {
            continue;
        }
        let v: Value = match serde_json::from_slice(line) {
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
