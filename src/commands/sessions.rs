use anyhow::Result;
use chrono::{DateTime, Utc};
use comfy_table::{presets::UTF8_FULL, Table};
use sea_orm::{EntityTrait, QueryOrder};

use crate::{db, entity::session};

pub async fn run() -> Result<()> {
    let db = db::connect().await?;
    let sessions = session::Entity::find()
        .order_by_desc(session::Column::UpdatedAt)
        .all(&db)
        .await?;

    if sessions.is_empty() {
        println!("No sessions found.");
        return Ok(());
    }

    let now = Utc::now();
    let mut table = Table::new();
    table.load_preset(UTF8_FULL);
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

    println!("{}", colorize(&table.to_string(), &sessions, now));
    Ok(())
}

fn colorize(s: &str, sessions: &[session::Model], now: DateTime<Utc>) -> String {
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

    let mut out = s.to_string();

    // Agent name colors
    for (name, code) in AGENTS {
        out = out.replace(name, &format!("\x1b[38;5;{code}m{name}\x1b[0m"));
    }

    // Activity dots — the dot is already in the rendered string for correct
    // column width; we just wrap it in the right ANSI color here.
    for session in sessions {
        let age = (now - session.updated_at).num_seconds();
        let (dot, code) = if age < 3_600 {
            ("● ", 82)   // green
        } else if age < 86_400 {
            ("● ", 214)  // amber
        } else {
            continue;
        };
        out = out.replacen(dot, &format!("\x1b[38;5;{code}m●\x1b[0m "), 1);
    }

    out
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
