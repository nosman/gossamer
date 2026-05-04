use anyhow::Result;
use chrono::Utc;
use sea_orm::{sea_query::OnConflict, ActiveValue::Set, EntityTrait};
use serde::Deserialize;
use std::io::Read;

use crate::{db, entity::session};

#[derive(Deserialize)]
struct HookInput {
    session_id: String,
    cwd: Option<String>,
}

pub async fn run() -> Result<()> {
    let mut stdin = String::new();
    std::io::stdin().read_to_string(&mut stdin)?;

    let input: HookInput = serde_json::from_str(stdin.trim())?;

    let db = db::connect().await?;
    let now = Utc::now();
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "unknown".to_string());

    session::Entity::insert(session::ActiveModel {
        session_id: Set(input.session_id),
        agent_name: Set("Claude Code".to_string()),
        user: Set(user),
        created_at: Set(now),
        updated_at: Set(now),
        cwd: Set(input.cwd.unwrap_or_default()),
        session_name: Set(String::new()),
    })
    .on_conflict(
        OnConflict::column(session::Column::SessionId)
            .do_nothing()
            .to_owned(),
    )
    .exec(&db)
    .await?;

    Ok(())
}
