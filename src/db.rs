use anyhow::{Context, Result};
use dirs::home_dir;
use sea_orm::{Database, DatabaseConnection};
use std::fs;

use crate::migration::{Migrator, MigratorTrait};

pub async fn connect() -> Result<DatabaseConnection> {
    let gossamer_dir = home_dir()
        .context("cannot determine home directory")?
        .join(".gossamer");

    fs::create_dir_all(&gossamer_dir)
        .context("failed to create ~/.gossamer")?;

    let db_path = gossamer_dir.join("gossamer.db");
    let url = format!("sqlite://{}?mode=rwc", db_path.display());

    let db = Database::connect(&url)
        .await
        .context("failed to open database")?;

    Migrator::up(&db, None)
        .await
        .context("failed to run migrations")?;

    Ok(db)
}
