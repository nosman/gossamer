use anyhow::{Context, Result};
use sea_orm::{ActiveValue::Set, ColumnTrait, EntityTrait, QueryFilter};
use std::{env, fs, io::Write, path::PathBuf, process::Command};

use crate::{db, entity::repository};

// Marker used to detect an already-installed hook and as the hook body.
const HOOK_MARKER: &str = "# gossamer:";
const HOOK_SNIPPET: &str = r#"
# gossamer: re-index sessions after entireio checkpoints
if git log -1 --format="%B" | grep -q "Entire-Checkpoint:"; then
    gossamer index >/dev/null 2>&1 || true
fi"#;

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

    install_post_commit_hook(&cwd_str)?;

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

fn install_post_commit_hook(repo_dir: &str) -> Result<()> {
    // --git-common-dir always returns the real .git directory, even from inside a worktree.
    let out = Command::new("git")
        .args(["rev-parse", "--git-common-dir"])
        .current_dir(repo_dir)
        .output()
        .context("failed to run git")?;

    if !out.status.success() {
        anyhow::bail!("could not locate .git directory");
    }

    let git_dir = PathBuf::from(String::from_utf8(out.stdout)?.trim().to_string());
    let git_dir = if git_dir.is_absolute() {
        git_dir
    } else {
        PathBuf::from(repo_dir).join(git_dir)
    };

    let hook_path = git_dir.join("hooks").join("post-commit");

    if hook_path.exists() {
        let content = fs::read_to_string(&hook_path)?;
        if content.contains(HOOK_MARKER) {
            println!("post-commit hook already contains gossamer indexing, skipping.");
            return Ok(());
        }
        // Append to the hook entireio already installed.
        let mut file = fs::OpenOptions::new().append(true).open(&hook_path)?;
        writeln!(file, "{}", HOOK_SNIPPET)?;
    } else {
        fs::create_dir_all(hook_path.parent().unwrap())?;
        fs::write(&hook_path, format!("#!/bin/sh\n{}\n", HOOK_SNIPPET))?;
    }

    // Ensure the hook is executable on Unix.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&hook_path)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&hook_path, perms)?;
    }

    println!(
        "Installed post-commit hook at {}",
        hook_path.display()
    );
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
