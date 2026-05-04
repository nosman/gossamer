use anyhow::Result;
use comfy_table::{presets::UTF8_HORIZONTAL_ONLY, Table};
use sea_orm::EntityTrait;
use std::{collections::HashSet, env};

use crate::{db, entity::repository};

pub async fn run() -> Result<()> {
    let db = db::connect().await?;
    let repos = repository::Entity::find().all(&db).await?;

    if repos.is_empty() {
        println!("No repositories tracked. Run `gossamer init` in a git repo to get started.");
        return Ok(());
    }

    let cwd = env::current_dir().ok().map(|p| p.to_string_lossy().to_string());
    let current_dir = cwd.as_deref().and_then(|cwd| {
        repos.iter()
            .find(|r| cwd.starts_with(r.directory.as_str()))
            .map(|r| r.directory.as_str())
    });

    let mut table = Table::new();
    table.load_preset(UTF8_HORIZONTAL_ONLY);
    table.set_header(["", "Name", "Directory", "Remote"]);

    for repo in &repos {
        let marker = if current_dir == Some(repo.directory.as_str()) { "▶" } else { "" };
        table.add_row([marker, &repo.name, &repo.directory, &repo.remote]);
    }

    println!("{}", colorize(&table.to_string(), current_dir));
    Ok(())
}

fn colorize(s: &str, current_dir: Option<&str>) -> String {
    // Pre-compute local line indices before any ANSI codes are injected.
    let local_lines: HashSet<usize> = if let Some(dir) = current_dir {
        s.lines().enumerate()
            .filter(|(_, line)| line.contains(dir))
            .map(|(i, _)| i)
            .collect()
    } else {
        HashSet::new()
    };

    let mut out = s.to_string();

    // Highlight the marker and current directory in pale yellow.
    out = out.replace("▶", "\x1b[38;5;229m▶\x1b[0m");
    if let Some(dir) = current_dir {
        out = out.replace(dir, &format!("\x1b[38;5;229m{dir}\x1b[0m"));
    }

    // Apply base color per line: white for local rows, light grey for everything else.
    out.lines().enumerate().map(|(i, line)| {
        let base: u8 = if local_lines.contains(&i) { 255 } else { 245 };
        let inner = line.replace("\x1b[0m", &format!("\x1b[0m\x1b[38;5;{base}m"));
        format!("\x1b[38;5;{base}m{inner}\x1b[0m")
    }).collect::<Vec<_>>().join("\n")
}
