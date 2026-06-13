use anyhow::{Context, Result};
use crossterm::{event::{self, Event, KeyCode}, terminal};
use serde_json::{json, Value};
use std::{env, fs, io::{self, BufRead, Write}, path::PathBuf, process::Command};

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

pub fn run(_json: bool) -> Result<()> {
    let cwd = env::current_dir().context("failed to get current directory")?;
    let cwd_str = cwd.to_string_lossy().to_string();

    let remote = git_remote(&cwd_str)?;
    let name = repo_name_from_remote(&remote);

    let (has_settings, has_branch) = entire_check(&cwd_str);
    if has_settings {
        println!("Found .entire/settings.json — respecting existing entire configuration.");
    } else if has_branch {
        println!("Found entire/checkpoints/v1 branch — entire already initialized, skipping configure.");
    } else {
        run_configure_wizard(&cwd_str)?;
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

// ── Wizard ────────────────────────────────────────────────────────────────────

fn run_configure_wizard(cwd_str: &str) -> Result<()> {
    println!("\n  entire setup\n");

    // ── Boolean questions (default: sensible safe values) ─────────────────────
    let skip_push     = !ask_yn("Auto-push sessions on git push", true)?;
    let telemetry     = ask_yn("Enable anonymous telemetry", false)?;
    let abs_hook_path = ask_yn("Absolute git hook path (for GUI clients like GitHub Desktop)", false)?;

    // ── Optional string fields ────────────────────────────────────────────────
    let checkpoint_remote = ask_optional("Checkpoint remote (e.g. github:org/repo)")?;
    let summarize_prov    = ask_optional("Summarize provider (e.g. anthropic)")?;
    let summarize_model   = if summarize_prov.is_some() {
        ask_optional("Summarize model (e.g. claude-sonnet-4-6)")?
    } else {
        None
    };

    println!();

    // ── Build and run `entire configure` ──────────────────────────────────────
    let mut configure_args = vec!["configure".to_string()];
    if skip_push     { configure_args.push("--skip-push-sessions".to_string()); }
    if telemetry     { configure_args.push("--telemetry".to_string()); }
    if abs_hook_path { configure_args.push("--absolute-git-hook-path".to_string()); }
    if let Some(r) = &checkpoint_remote {
        configure_args.extend(["--checkpoint-remote".to_string(), r.clone()]);
    }
    if let Some(p) = &summarize_prov {
        configure_args.extend(["--summarize-provider".to_string(), p.clone()]);
    }
    if let Some(m) = &summarize_model {
        configure_args.extend(["--summarize-model".to_string(), m.clone()]);
    }

    println!("Running: entire {}", configure_args.join(" "));
    let status = Command::new("entire")
        .args(&configure_args)
        .current_dir(cwd_str)
        .status()
        .context("`entire configure` failed to launch — is entireio installed?")?;
    if !status.success() {
        anyhow::bail!("`entire configure` exited with {}", status);
    }

    // ── Register Claude Code with entireio ────────────────────────────────────
    println!("Running: entire agent add claude-code");
    let s = Command::new("entire")
        .args(["agent", "add", "claude-code"])
        .current_dir(cwd_str)
        .status()
        .context("failed to run `entire agent add`")?;
    if !s.success() {
        eprintln!("warning: `entire agent add claude-code` exited with {s}");
    }

    Ok(())
}

// ── Prompt helpers ────────────────────────────────────────────────────────────

fn ask_yn(prompt: &str, default_yes: bool) -> Result<bool> {
    let hint = if default_yes { "[Y/n]" } else { "[y/N]" };
    print!("  {prompt}? {hint} ");
    io::stdout().flush()?;

    terminal::enable_raw_mode()?;
    let mut answer: Result<bool> = Ok(default_yes);
    loop {
        match event::read() {
            Err(e) => { answer = Err(e.into()); break; }
            Ok(Event::Key(k)) => match k.code {
                KeyCode::Enter                        => break,
                KeyCode::Char('y') | KeyCode::Char('Y') => { answer = Ok(true);  break; }
                KeyCode::Char('n') | KeyCode::Char('N') => { answer = Ok(false); break; }
                KeyCode::Esc => { answer = Err(anyhow::anyhow!("setup aborted")); break; }
                _ => {}
            }
            _ => {}
        }
    }
    terminal::disable_raw_mode()?;
    let val = answer?;
    println!("{}", if val { "yes" } else { "no" });
    Ok(val)
}

fn ask_optional(prompt: &str) -> Result<Option<String>> {
    print!("  {prompt} (blank to skip): ");
    io::stdout().flush()?;
    let mut line = String::new();
    io::stdin().lock().read_line(&mut line)?;
    let s = line.trim().to_string();
    Ok(if s.is_empty() { None } else { Some(s) })
}

// ── Rest of init (hooks, DB registration) ────────────────────────────────────

fn entire_check(repo_dir: &str) -> (bool, bool) {
    let has_settings = std::path::Path::new(repo_dir)
        .join(".entire")
        .join("settings.json")
        .exists();

    let has_branch = Command::new("git")
        .args(["show-ref", "--verify", "--quiet", "refs/heads/entire/checkpoints/v1"])
        .current_dir(repo_dir)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    (has_settings, has_branch)
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

    let hooks_obj = settings
        .as_object_mut()
        .context("settings.json is not an object")?
        .entry("hooks")
        .or_insert(json!({}))
        .as_object_mut()
        .context("hooks is not an object")?;

    // SessionStart
    {
        let start_hooks = hooks_obj
            .entry("SessionStart")
            .or_insert(json!([]))
            .as_array_mut()
            .context("SessionStart is not an array")?;

        let already = start_hooks.iter().any(|e| {
            e.get("hooks")
                .and_then(Value::as_array)
                .map_or(false, |cmds| {
                    cmds.iter().any(|c| {
                        c.get("command").and_then(Value::as_str) == Some("gossamer session-start")
                    })
                })
        });
        if !already {
            start_hooks.push(json!({
                "matcher": "",
                "hooks": [{ "type": "command", "command": "gossamer session-start" }]
            }));
            println!("Registered Claude Code SessionStart hook.");
        } else {
            println!("Claude Code SessionStart hook already registered, skipping.");
        }
    }

    // Stop
    {
        let stop_hooks = hooks_obj
            .entry("Stop")
            .or_insert(json!([]))
            .as_array_mut()
            .context("Stop is not an array")?;

        let already = stop_hooks.iter().any(|e| {
            e.get("hooks")
                .and_then(Value::as_array)
                .map_or(false, |cmds| {
                    cmds.iter().any(|c| {
                        c.get("command").and_then(Value::as_str)
                            == Some("gossamer session-stop >/dev/null 2>&1")
                    })
                })
        });
        if !already {
            stop_hooks.push(json!({
                "matcher": "",
                "hooks": [{ "type": "command", "command": "gossamer session-stop >/dev/null 2>&1" }]
            }));
            println!("Registered Claude Code Stop hook.");
        } else {
            println!("Claude Code Stop hook already registered, skipping.");
        }
    }

    if let Some(parent) = settings_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&settings_path, serde_json::to_string_pretty(&settings)?)?;
    println!("Claude Code hooks saved to {}.", settings_path.display());
    Ok(())
}

fn install_shell_function() -> Result<()> {
    let home = dirs::home_dir().context("could not find home directory")?;

    let shell = std::env::var("SHELL").unwrap_or_default();
    let rc_path = if shell.contains("zsh") {
        home.join(".zshrc")
    } else if shell.contains("bash") {
        let bp = home.join(".bash_profile");
        if bp.exists() { bp } else { home.join(".bashrc") }
    } else {
        println!("Shell function not installed (unknown shell '{shell}'). Add manually:");
        println!("  gr() {{ local p; p=$(gossamer repo); [[ -n \"$p\" ]] && cd \"$p\"; }}");
        return Ok(());
    };

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
