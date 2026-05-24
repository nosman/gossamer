use anyhow::{Context, Result};
use serde::Deserialize;
use std::path::PathBuf;
use std::process::Command;

use crate::commands::index::{BRANCH, checkpoint_remote_url};

pub fn run(session_id: &str, force: bool, json: bool) -> Result<()> {
    let repo_dir = std::env::current_dir()
        .context("failed to get current directory")?
        .to_string_lossy()
        .to_string();

    // If push_sessions is enabled, entire already syncs the checkpoint branch on push.
    if push_sessions_enabled(&repo_dir) {
        if json {
            println!(
                "{}",
                serde_json::json!({
                    "ok": true,
                    "skipped": true,
                    "reason": "push_sessions is enabled; entire already syncs the checkpoint branch"
                })
            );
        } else {
            println!(
                "push_sessions is enabled — entire already keeps the checkpoint branch \
                 synced automatically. Nothing to do."
            );
        }
        return Ok(());
    }

    let resolved = resolve_session_id(session_id)
        .ok_or_else(|| anyhow::anyhow!("no session found matching '{}'", session_id))?;

    if resolved.len() < 10 {
        anyhow::bail!("session ID '{}' is unexpectedly short", resolved);
    }

    let prefix2 = &resolved[..2];
    let id10 = &resolved[..10];
    let session_dir = format!("{}/{}", prefix2, id10);

    // If the session has no checkpoint on the branch yet, attach it now.
    if !session_has_checkpoint(&repo_dir, &session_dir) {
        if !json {
            println!(
                "Session not found on {} — running `entire attach {}`...",
                BRANCH, resolved
            );
        }
        let status = Command::new("entire")
            .args(["attach", &resolved])
            .current_dir(&repo_dir)
            .status()
            .context("failed to run `entire attach`")?;
        if !status.success() {
            anyhow::bail!("`entire attach` exited with {}", status);
        }
        if !session_has_checkpoint(&repo_dir, &session_dir) {
            anyhow::bail!(
                "no checkpoint found for '{}' after attach — is this session tracked by entire?",
                resolved
            );
        }
    }

    let remote_url = checkpoint_remote_url(&repo_dir).ok_or_else(|| {
        anyhow::anyhow!(
            "no checkpoint remote configured in .entire/settings.json; \
             add one with `entire configure --checkpoint-remote github:org/repo`"
        )
    })?;

    // Find the latest commit on the checkpoint branch that touches this session's directory.
    let log_out = Command::new("git")
        .args(["log", "--format=%H", BRANCH, "--", &session_dir])
        .current_dir(&repo_dir)
        .output()
        .context("failed to run git log")?;

    let latest_commit = String::from_utf8(log_out.stdout)
        .context("git log output is not valid UTF-8")?
        .lines()
        .next()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "no checkpoint commit found for session '{}' on {}",
                resolved,
                BRANCH
            )
        })?;

    if !json {
        println!(
            "Pushing commit {} to {}...",
            &latest_commit[..8],
            remote_url
        );
    }

    let push_refspec = format!("{}:refs/heads/{}", latest_commit, BRANCH);
    let mut push_args = vec!["push"];
    if force {
        push_args.push("--force");
    }
    push_args.push(&remote_url);
    push_args.push(&push_refspec);

    let status = Command::new("git")
        .args(&push_args)
        .current_dir(&repo_dir)
        .status()
        .context("failed to run git push")?;

    if !status.success() {
        if force {
            anyhow::bail!("git push failed");
        } else {
            anyhow::bail!(
                "git push failed (the remote may have diverged); \
                 retry with `gossamer handoff --force {}` to force push",
                session_id
            );
        }
    }

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "ok": true,
                "session_id": resolved,
                "commit": latest_commit,
                "remote": remote_url,
            }))?
        );
    } else {
        println!("Session {} pushed to remote.", resolved);
    }

    Ok(())
}

/// Returns true when `push_sessions` is unset or true in `.entire/settings.json`.
/// Returns false only when explicitly set to false (i.e. `--skip-push-sessions` was used).
fn push_sessions_enabled(repo_dir: &str) -> bool {
    #[derive(Deserialize)]
    struct EntireSettings {
        push_sessions: Option<bool>,
    }

    let path = std::path::Path::new(repo_dir)
        .join(".entire")
        .join("settings.json");
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return true,
    };
    let settings: EntireSettings = match serde_json::from_str(&raw) {
        Ok(s) => s,
        Err(_) => return true,
    };
    settings.push_sessions.unwrap_or(true)
}

/// Returns true if there is at least one checkpoint file for `session_dir`
/// on the `entire/checkpoints/v1` branch.
fn session_has_checkpoint(repo_dir: &str, session_dir: &str) -> bool {
    Command::new("git")
        .args(["ls-tree", "-r", "--name-only", BRANCH, "--", session_dir])
        .current_dir(repo_dir)
        .output()
        .map(|o| !o.stdout.is_empty())
        .unwrap_or(false)
}

fn resolve_session_id(id: &str) -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let projects = PathBuf::from(&home).join(".claude/projects");
    if let Ok(entries) = std::fs::read_dir(&projects) {
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let Ok(files) = std::fs::read_dir(&dir) else {
                continue;
            };
            for file in files.flatten() {
                let path = file.path();
                if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    if stem == id || stem.starts_with(id) {
                        return Some(stem.to_string());
                    }
                }
            }
        }
    }
    let conn = crate::db::connect().ok()?;
    conn.query_row(
        "SELECT session_id FROM sessions WHERE session_id LIKE ?1 || '%' LIMIT 1",
        [id],
        |row| row.get::<_, String>(0),
    )
    .ok()
}
