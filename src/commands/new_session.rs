use anyhow::Result;
use std::io::Write as _;

const AGENTS: &[&str] = &["claude", "gemini", "aider"];

pub fn run(
    agent: Option<String>,
    branch: Option<String>,
    name: Option<String>,
    prompt: Option<String>,
) -> Result<()> {
    let repo_dir = std::env::current_dir()?.to_string_lossy().to_string();

    let agent_cli = agent.as_deref().unwrap_or("claude");
    if !AGENTS.contains(&agent_cli) {
        anyhow::bail!("unknown agent '{}'; valid options: {}", agent_cli, AGENTS.join(", "));
    }

    let launch_dir = if let Some(ref branch_name) = branch {
        let result = create_worktree(&repo_dir, branch_name);
        if let Err(e) = result {
            anyhow::bail!("{e}");
        }
        let repo_path = std::path::Path::new(&repo_dir);
        let parent = repo_path.parent().unwrap_or(repo_path);
        let repo_name = repo_path.file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "repo".to_string());
        parent.join(format!("{repo_name}-{branch_name}")).to_string_lossy().to_string()
    } else {
        repo_dir
    };

    if let Some(ref n) = name {
        if !n.trim().is_empty() {
            let home = std::env::var("HOME").unwrap_or_default();
            let dir = std::path::PathBuf::from(&home).join(".gossamer");
            std::fs::create_dir_all(&dir)?;
            std::fs::write(dir.join("pending_session_name"), n.trim())?;
        }
    }

    if let Some(ref p) = prompt {
        if !p.is_empty() {
            if let Ok(mut child) = std::process::Command::new("pbcopy")
                .stdin(std::process::Stdio::piped())
                .spawn()
            {
                if let Some(stdin) = child.stdin.as_mut() {
                    let _ = stdin.write_all(p.as_bytes());
                }
                let _ = child.wait();
            }
        }
    }

    use std::os::unix::process::CommandExt;
    let mut cmd = std::process::Command::new(agent_cli);
    cmd.current_dir(&launch_dir);
    if let Some(ref n) = name {
        if !n.trim().is_empty() {
            cmd.args(["-n", n.trim()]);
        }
    }
    if let Some(ref p) = prompt {
        if !p.trim().is_empty() {
            cmd.arg(p.trim());
        }
    }
    let err = cmd.exec();
    anyhow::bail!("failed to launch {agent_cli}: {err}");
}

fn create_worktree(repo_dir: &str, branch: &str) -> Result<()> {
    let repo_path = std::path::Path::new(repo_dir);
    let parent = repo_path.parent()
        .ok_or_else(|| anyhow::anyhow!("cannot determine repo parent directory"))?;
    let repo_name = repo_path.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "repo".to_string());
    let wt_path = parent.join(format!("{repo_name}-{branch}"));
    let wt_str = wt_path.to_string_lossy();

    // Try -b (new branch) first, then fall back for an existing branch.
    let new_branch = std::process::Command::new("git")
        .args(["worktree", "add", "-b", branch, &wt_str])
        .current_dir(repo_dir)
        .output()?;

    if new_branch.status.success() {
        return Ok(());
    }

    let existing = std::process::Command::new("git")
        .args(["worktree", "add", &wt_str, branch])
        .current_dir(repo_dir)
        .output()?;

    if existing.status.success() {
        return Ok(());
    }

    let msg = String::from_utf8_lossy(&new_branch.stderr);
    let first = msg.lines().find(|l| !l.trim().is_empty()).unwrap_or("unknown error");
    anyhow::bail!("{first}");
}
