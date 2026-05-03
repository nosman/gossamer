use anyhow::{Context, Result};
use sea_orm::{ActiveValue::Set, ColumnTrait, EntityTrait, QueryFilter};
use std::{env, process::Command};

use crate::{db, entity::repository};

pub async fn run() -> Result<()> {
    let cwd = env::current_dir().context("failed to get current directory")?;
    let cwd_str = cwd.to_string_lossy().to_string();

    let remote = git_remote(&cwd_str)?;
    let name = repo_name_from_remote(&remote);

    println!("Running `entire configure`...");
    let status = Command::new("entire")
        .arg("configure")
        .status()
        .context("`entire configure` failed to launch — is entireio installed?")?;

    if !status.success() {
        anyhow::bail!("`entire configure` exited with status {}", status);
    }

    let db = db::connect().await?;

    let existing = repository::Entity::find()
        .filter(repository::Column::Directory.eq(&cwd_str))
        .one(&db)
        .await?;

    if existing.is_some() {
        anyhow::bail!("'{}' is already registered with gossamer", cwd_str);
    }

    repository::Entity::insert(repository::ActiveModel {
        directory: Set(cwd_str.clone()),
        remote: Set(remote),
        name: Set(name.clone()),
        ..Default::default()
    })
    .exec(&db)
    .await
    .context("failed to register repository")?;

    println!("Initialized '{}' ({})", name, cwd_str);
    Ok(())
}

fn git_remote(dir: &str) -> Result<String> {
    let out = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(dir)
        .output()
        .context("failed to run git")?;

    if !out.status.success() {
        anyhow::bail!("not a git repository or no 'origin' remote is configured");
    }

    Ok(String::from_utf8(out.stdout)?.trim().to_string())
}

fn repo_name_from_remote(remote: &str) -> String {
    remote
        .rsplit('/')
        .next()
        .unwrap_or(remote)
        .trim_end_matches(".git")
        .to_string()
}
