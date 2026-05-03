use anyhow::Result;
use comfy_table::{presets::UTF8_FULL, Table};
use sea_orm::EntityTrait;

use crate::{db, entity::repository};

pub async fn run() -> Result<()> {
    let db = db::connect().await?;
    let repos = repository::Entity::find().all(&db).await?;

    if repos.is_empty() {
        println!("No repositories tracked. Run `gossamer init` in a git repo to get started.");
        return Ok(());
    }

    let mut table = Table::new();
    table.load_preset(UTF8_FULL);
    table.set_header(["Name", "Directory", "Remote"]);

    for repo in &repos {
        table.add_row([&repo.name, &repo.directory, &repo.remote]);
    }

    println!("{table}");
    Ok(())
}
