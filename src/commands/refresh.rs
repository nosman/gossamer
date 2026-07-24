use anyhow::Result;
use std::process::Command;

use crate::db;
use super::index::{
    BRANCH, RepoResolver, fetch_checkpoint_branch, git_show, index_shadow_branches, is_meta_path,
    upsert_session,
};

pub fn run(json: bool) -> Result<()> {
    let conn = db::connect()?;

    let mut stmt = conn.prepare("SELECT id, directory, name FROM repositories")?;
    let repos: Vec<(i64, String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<Result<_, _>>()?;

    if repos.is_empty() {
        if json {
            println!("{}", serde_json::json!({"sessions_indexed": 0}));
        } else {
            println!("No repositories tracked. Run `entire gossamer init` first.");
        }
        return Ok(());
    }

    let resolver = RepoResolver::new(&conn)?;

    let mut grand_total = 0usize;

    for (repo_id, dir, name) in &repos {
        match refresh_repo(&conn, *repo_id, dir, &resolver) {
            Ok(0) => { if !json { println!("'{}': up to date.", name); } }
            Ok(n) => {
                if !json { println!("'{}': {} new session(s) indexed.", name, n); }
                grand_total += n;
            }
            Err(e) => eprintln!("'{}': error — {}", name, e),
        }
    }

    let names_filled = crate::ingest::backfill_session_names().unwrap_or(0);

    if json {
        println!("{}", serde_json::to_string_pretty(&serde_json::json!({
            "sessions_indexed": grand_total,
            "names_backfilled": names_filled,
        }))?);
    } else {
        println!();
        if grand_total > 0 {
            println!("{} new session(s) indexed.", grand_total);
        } else {
            println!("All repositories up to date.");
        }
        if names_filled > 0 {
            println!("{} session name(s) backfilled.", names_filled);
        }
    }

    Ok(())
}

fn refresh_repo(conn: &rusqlite::Connection, repo_id: i64, repo_dir: &str, resolver: &RepoResolver) -> Result<usize> {
    fetch_checkpoint_branch(repo_dir);

    // Shadow branches advance on every prompt, so we always sweep them — even
    // when the checkpoint head is unchanged, an active session can have new
    // turns visible only on its shadow ref.
    let shadow_count = index_shadow_branches(conn, repo_id, repo_dir, resolver).unwrap_or(0);

    // Check checkpoint branch exists.
    let check = Command::new("git")
        .args(["rev-parse", "--verify", BRANCH])
        .current_dir(repo_dir)
        .output()?;

    if !check.status.success() {
        return Ok(shadow_count);
    }

    let current_head = String::from_utf8(check.stdout)?.trim().to_string();

    // Load stored watermark.
    let stored_head: Option<String> = conn.query_row(
        "SELECT last_indexed_commit FROM repositories WHERE directory = ?1",
        [repo_dir],
        |row| row.get(0),
    ).ok().flatten();

    if stored_head.as_deref() == Some(current_head.as_str()) {
        return Ok(shadow_count); // checkpoint unchanged; shadow may still have new turns
    }

    // Collect metadata paths: added or modified since watermark (or all if first run).
    let meta_paths: Vec<String> = if let Some(ref last) = stored_head {
        // git diff gives a deduplicated file list between two tree states, so each
        // session appears at most once even if it was checkpointed many times.
        let out = Command::new("git")
            .args(["diff", "--name-only", "--diff-filter=AM", last, BRANCH])
            .current_dir(repo_dir)
            .output()?;
        String::from_utf8(out.stdout)?
            .lines()
            .filter(|l| is_meta_path(l))
            .map(str::to_string)
            .collect()
    } else {
        let out = Command::new("git")
            .args(["ls-tree", "-r", "--name-only", BRANCH])
            .current_dir(repo_dir)
            .output()?;
        String::from_utf8(out.stdout)?
            .lines()
            .filter(|l| is_meta_path(l))
            .map(str::to_string)
            .collect()
    };

    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "unknown".to_string());

    let mut count = 0;
    for meta_path in &meta_paths {
        let jsonl_path = format!(
            "{}full.jsonl",
            &meta_path[..meta_path.len() - "metadata.json".len()]
        );
        let meta_bytes = match git_show(repo_dir, meta_path) {
            Ok(b) => b,
            Err(e) => { eprintln!("  skipping {}: {}", meta_path, e); continue; }
        };
        let jsonl_bytes = match git_show(repo_dir, &jsonl_path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        match crate::parsers::dispatch_session(&meta_bytes, &jsonl_bytes) {
            Ok(p) => {
                let resolved_id = resolver.resolve(&p.cwd, Some(repo_id));
                upsert_session(conn, &p.session_id, &p.agent_name, &user,
                               &p.created_at, &p.updated_at, &p.cwd, &p.session_name,
                               &p.branch, resolved_id, p.name_is_explicit, p.tokens_used)?;
                count += 1;
            }
            Err(e) => eprintln!("  skipping {}: {}", meta_path, e),
        }
    }

    // Advance watermark.
    conn.execute(
        "UPDATE repositories SET last_indexed_commit = ?1 WHERE directory = ?2",
        rusqlite::params![current_head, repo_dir],
    )?;

    Ok(count + shadow_count)
}
