use anyhow::Result;
use chrono::{DateTime, Utc};
use comfy_table::{presets::UTF8_HORIZONTAL_ONLY, Table};
use sea_orm::{EntityTrait, QueryOrder};
use std::{collections::HashSet, env};

use crate::{db, entity::{repository, session}};

pub async fn run(all: bool) -> Result<()> {
    let db = db::connect().await?;

    let repos = repository::Entity::find().all(&db).await?;
    let cwd = env::current_dir().ok().map(|p| p.to_string_lossy().to_string());
    let current_repo_dir: Option<String> = cwd.as_deref().and_then(|cwd| {
        repos.iter()
            .find(|r| cwd.starts_with(r.directory.as_str()))
            .map(|r| r.directory.clone())
    });

    let sessions = session::Entity::find()
        .order_by_desc(session::Column::UpdatedAt)
        .all(&db)
        .await?;

    let cutoff = Utc::now() - chrono::Duration::days(3);
    let sessions: Vec<_> = if all {
        sessions
    } else {
        sessions.into_iter().filter(|s| s.updated_at >= cutoff).collect()
    };

    // Sessions in the current repo float to the top; both groups keep updated_at order.
    let sessions: Vec<_> = if let Some(ref dir) = current_repo_dir {
        let (local, rest): (Vec<_>, Vec<_>) = sessions
            .into_iter()
            .partition(|s| s.cwd.starts_with(dir.as_str()));
        local.into_iter().chain(rest).collect()
    } else {
        sessions
    };

    if sessions.is_empty() {
        println!("No sessions found.");
        return Ok(());
    }

    let now = Utc::now();
    let mut table = Table::new();
    table.load_preset(UTF8_HORIZONTAL_ONLY);
    table.set_header(["", "Session ID", "Last Prompt", "Agent", "User", "CWD", "Created", "Updated"]);

    for s in &sessions {
        let age = (now - s.updated_at).num_seconds();
        let dot = if age < 3_600 { "● " } else if age < 86_400 { "● " } else { "" };

        table.add_row([
            dot,
            s.session_id.as_str(),
            &truncate(&s.session_name, 50),
            s.agent_name.as_str(),
            s.user.as_str(),
            s.cwd.as_str(),
            &relative_time(s.created_at),
            &relative_time(s.updated_at),
        ]);
    }

    println!("{}", colorize(&table.to_string(), &sessions, now, current_repo_dir.as_deref()));
    Ok(())
}

fn colorize(s: &str, sessions: &[session::Model], now: DateTime<Utc>, current_repo_dir: Option<&str>) -> String {
    const AGENTS: &[(&str, u8)] = &[
        ("Claude Code", 214),
        ("Copilot",     99),
        ("Cursor",      33),
        ("Gemini",      75),
        ("Aider",       42),
        ("ChatGPT",     35),
        ("Windsurf",    44),
        ("Amazon Q",    208),
    ];

    // Pre-compute local line indices before any ANSI codes are injected.
    let local_lines: HashSet<usize> = if let Some(dir) = current_repo_dir {
        s.lines().enumerate()
            .filter(|(_, line)| line.contains(dir))
            .map(|(i, _)| i)
            .collect()
    } else {
        HashSet::new()
    };

    let mut out = s.to_string();

    // Current repo CWD in pale yellow.
    if let Some(dir) = current_repo_dir {
        out = out.replace(dir, &format!("\x1b[38;5;229m{dir}\x1b[0m"));
    }

    // Agent name colors.
    for (name, code) in AGENTS {
        out = out.replace(name, &format!("\x1b[38;5;{code}m{name}\x1b[0m"));
    }

    // Activity dot colors.
    for session in sessions {
        let age = (now - session.updated_at).num_seconds();
        let (dot, code) = if age < 3_600 {
            ("● ", 82)
        } else if age < 86_400 {
            ("● ", 214)
        } else {
            continue;
        };
        out = out.replacen(dot, &format!("\x1b[38;5;{code}m●\x1b[0m "), 1);
    }

    // Apply base color per line: white for local rows, light grey for everything else.
    out.lines().enumerate().map(|(i, line)| {
        let base: u8 = if local_lines.contains(&i) { 255 } else { 245 };
        let inner = line.replace("\x1b[0m", &format!("\x1b[0m\x1b[38;5;{base}m"));
        format!("\x1b[38;5;{base}m{inner}\x1b[0m")
    }).collect::<Vec<_>>().join("\n")
}

fn relative_time(dt: DateTime<Utc>) -> String {
    let secs = (Utc::now() - dt).num_seconds();
    match secs {
        s if s < 60 => "just now".to_string(),
        s if s < 3_600 => format!("{} min{} ago", s / 60, if s / 60 == 1 { "" } else { "s" }),
        s if s < 86_400 => format!("{} hr{} ago", s / 3_600, if s / 3_600 == 1 { "" } else { "s" }),
        s if s < 604_800 => format!("{} day{} ago", s / 86_400, if s / 86_400 == 1 { "" } else { "s" }),
        s if s < 2_592_000 => format!("{} wk{} ago", s / 604_800, if s / 604_800 == 1 { "" } else { "s" }),
        s if s < 31_536_000 => format!("{} mo ago", s / 2_592_000),
        s => format!("{} yr{} ago", s / 31_536_000, if s / 31_536_000 == 1 { "" } else { "s" }),
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max - 1).collect::<String>())
    }
}
