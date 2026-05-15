use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::{env, fs, io::Write, path::PathBuf, process::Command};

use crate::db;

const HOOK_MARKER: &str = "# gossamer:";
const HOOK_SNIPPET: &str = r#"
# gossamer: re-index sessions after entireio checkpoints
if git log -1 --format="%B" | grep -q "Entire-Checkpoint:"; then
    gossamer index >/dev/null 2>&1 || true
fi"#;

const SHELL_MARKER: &str = "# gossamer-shell-init";
const SHELL_SNIPPET: &str = r#"
# gossamer-shell-init: cd into a repo selected interactively
gr() {
  local tmp
  tmp=$(mktemp)
  GOSSAMER_CDPATH="$tmp" gossamer repo
  local dest
  dest=$(cat "$tmp" 2>/dev/null)
  rm -f "$tmp"
  [[ -n "$dest" ]] && cd "$dest"
}"#;

pub fn run() -> Result<()> {
    let cwd = env::current_dir().context("failed to get current directory")?;
    let cwd_str = cwd.to_string_lossy().to_string();

    let remote = git_remote(&cwd_str)?;
    let name = repo_name_from_remote(&remote);

    if entire_already_configured(&cwd_str) {
        println!("`entire` hooks already installed, skipping `entire configure`.");
    } else {
        println!("Running `entire configure`...");
        let status = Command::new("entire")
            .arg("configure")
            .status()
            .context("`entire configure` failed to launch — is entireio installed?")?;

        if !status.success() {
            anyhow::bail!("`entire configure` exited with status {}", status);
        }
    }

    install_post_commit_hook(&cwd_str)?;
    install_claude_hook()?;
    install_shell_function()?;

    let conn = db::connect()?;

    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM repositories WHERE directory = ?1",
            [&cwd_str],
            |_| Ok(true),
        )
        .unwrap_or(false);

    if exists {
        println!("'{}' is already registered with gossamer.", name);
        return Ok(());
    }

    conn.execute(
        "INSERT INTO repositories (directory, remote, name) VALUES (?1, ?2, ?3)",
        rusqlite::params![cwd_str, remote, name],
    )
    .context("failed to register repository")?;

    println!("Initialized '{}' ({}).", name, cwd_str);
    Ok(())
}

fn entire_already_configured(repo_dir: &str) -> bool {
    let git_dir = match git_common_dir(repo_dir) {
        Ok(d) => d,
        Err(_) => return false,
    };
    let post_commit = git_dir.join("hooks").join("post-commit");
    fs::read_to_string(post_commit)
        .map(|c| c.contains("entire hooks git"))
        .unwrap_or(false)
}

fn install_post_commit_hook(repo_dir: &str) -> Result<()> {
    let git_dir = git_common_dir(repo_dir)?;
    let hook_path = git_dir.join("hooks").join("post-commit");

    if hook_path.exists() {
        let content = fs::read_to_string(&hook_path)?;
        if content.contains(HOOK_MARKER) {
            println!("post-commit hook already contains gossamer indexing, skipping.");
            return Ok(());
        }
        let mut file = fs::OpenOptions::new().append(true).open(&hook_path)?;
        writeln!(file, "{}", HOOK_SNIPPET)?;
    } else {
        fs::create_dir_all(hook_path.parent().unwrap())?;
        fs::write(&hook_path, format!("#!/bin/sh\n{}\n", HOOK_SNIPPET))?;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&hook_path)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&hook_path, perms)?;
    }

    println!("Installed post-commit hook at {}.", hook_path.display());
    Ok(())
}

fn git_common_dir(repo_dir: &str) -> Result<PathBuf> {
    let out = Command::new("git")
        .args(["rev-parse", "--git-common-dir"])
        .current_dir(repo_dir)
        .output()
        .context("failed to run git")?;

    if !out.status.success() {
        anyhow::bail!("could not locate .git directory");
    }

    let rel = PathBuf::from(String::from_utf8(out.stdout)?.trim().to_string());
    Ok(if rel.is_absolute() {
        rel
    } else {
        PathBuf::from(repo_dir).join(rel)
    })
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

fn install_claude_hook() -> Result<()> {
    let settings_path = dirs::home_dir()
        .context("could not find home directory")?
        .join(".claude")
        .join("settings.json");

    let mut settings: Value = if settings_path.exists() {
        let raw = fs::read_to_string(&settings_path)?;
        serde_json::from_str(&raw).unwrap_or(json!({}))
    } else {
        json!({})
    };

    let hooks = settings
        .as_object_mut()
        .context("settings.json is not an object")?
        .entry("hooks")
        .or_insert(json!({}))
        .as_object_mut()
        .context("hooks is not an object")?
        .entry("SessionStart")
        .or_insert(json!([]))
        .as_array_mut()
        .context("SessionStart is not an array")?;

    let already_registered = hooks.iter().any(|entry| {
        entry
            .get("hooks")
            .and_then(Value::as_array)
            .map_or(false, |cmds| {
                cmds.iter().any(|c| {
                    c.get("command").and_then(Value::as_str) == Some("gossamer session-start")
                })
            })
    });

    if already_registered {
        println!("Claude Code SessionStart hook already registered, skipping.");
        return Ok(());
    }

    hooks.push(json!({
        "matcher": "",
        "hooks": [{ "type": "command", "command": "gossamer session-start" }]
    }));

    if let Some(parent) = settings_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&settings_path, serde_json::to_string_pretty(&settings)?)?;
    println!("Registered Claude Code SessionStart hook in {}.", settings_path.display());
    Ok(())
}

fn install_shell_function() -> Result<()> {
    let home = dirs::home_dir().context("could not find home directory")?;

    // Detect which rc file to use based on $SHELL
    let shell = std::env::var("SHELL").unwrap_or_default();
    let rc_path = if shell.contains("zsh") {
        home.join(".zshrc")
    } else if shell.contains("bash") {
        // Prefer .bash_profile on macOS, .bashrc elsewhere
        let bp = home.join(".bash_profile");
        if bp.exists() { bp } else { home.join(".bashrc") }
    } else {
        // Unknown shell — skip silently
        println!("Shell function not installed (unknown shell '{shell}'). Add manually:");
        println!("  gr() {{ local p; p=$(gossamer repo); [[ -n \"$p\" ]] && cd \"$p\"; }}");
        return Ok(());
    };

    // Check if already installed
    if rc_path.exists() {
        let content = fs::read_to_string(&rc_path)?;
        if content.contains(SHELL_MARKER) {
            println!("Shell function `gr` already in {}, skipping.", rc_path.display());
            return Ok(());
        }
    }

    let mut file = fs::OpenOptions::new().create(true).append(true).open(&rc_path)?;
    writeln!(file, "{}", SHELL_SNIPPET)?;
    println!("Added `gr` shell function to {}.", rc_path.display());
    println!("Run `source {}` or open a new terminal to activate it.", rc_path.display());
    Ok(())
}

fn repo_name_from_remote(remote: &str) -> String {
    remote
        .rsplit('/')
        .next()
        .unwrap_or(remote)
        .trim_end_matches(".git")
        .to_string()
}
