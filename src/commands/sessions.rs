use anyhow::Result;
use comfy_table::{presets::UTF8_FULL, Table};
use sea_orm::EntityTrait;

use crate::{db, entity::session};

pub async fn run() -> Result<()> {
    let db = db::connect().await?;
    let sessions = session::Entity::find().all(&db).await?;

    if sessions.is_empty() {
        println!("No sessions found.");
        return Ok(());
    }

    let mut table = Table::new();
    table.load_preset(UTF8_FULL);
    table.set_header(["Session ID", "Name", "Agent", "User", "CWD", "Created", "Updated"]);

    for s in &sessions {
        table.add_row([
            &s.session_id,
            &s.session_name,
            &s.agent_name,
            &s.user,
            &s.cwd,
            &s.created_at.format("%Y-%m-%d %H:%M").to_string(),
            &s.updated_at.format("%Y-%m-%d %H:%M").to_string(),
        ]);
    }

    println!("{table}");
    Ok(())
}
