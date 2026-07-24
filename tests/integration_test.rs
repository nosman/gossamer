// Integration tests for gossamer CLI.
//
// Each test gets an isolated HOME in a tempdir so the gossamer DB, claude hooks,
// and shell rc files don't touch the real user's environment.
//
// The tests invoke the compiled binary directly via CARGO_BIN_EXE_entire-gossamer.

use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tempfile::TempDir;

fn bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_entire-gossamer"))
}

// ── Test environment ──────────────────────────────────────────────────────────

struct TestEnv {
    home: TempDir,
    repo: TempDir,
    // Temporary bin dir containing a no-op stub for `entire`.
    // Placed at the front of PATH so gossamer never calls the real `entire`.
    _stub_bin: TempDir,
    stub_bin_path: PathBuf,
}

impl TestEnv {
    fn new() -> Self {
        let home = TempDir::new().expect("create temp home");
        let repo = TempDir::new().expect("create temp repo");
        let stub_bin = TempDir::new().expect("create stub bin dir");

        // Write a no-op `entire` stub so commands like `gossamer clean` don't
        // block on (or output noise from) the real `entire` binary.
        let stub_entire = stub_bin.path().join("entire");
        fs::write(&stub_entire, "#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&stub_entire).unwrap().permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&stub_entire, perms).unwrap();
        }
        let stub_bin_path = stub_bin.path().to_path_buf();

        // Bare-bones git repo with a fake remote
        run_git(repo.path(), &["init", "-b", "main"]);
        run_git(
            repo.path(),
            &["remote", "add", "origin", "https://github.com/test/my-repo.git"],
        );

        // Minimal initial commit so the repo is non-empty
        fs::write(repo.path().join("README.md"), "test repo\n").unwrap();
        run_git(repo.path(), &["-c", "user.email=t@t.com", "-c", "user.name=Test", "add", "README.md"]);
        run_git(repo.path(), &["-c", "user.email=t@t.com", "-c", "user.name=Test", "commit", "-m", "init"]);

        // Pre-create .entire/settings.json so gossamer init skips the interactive wizard
        let entire_dir = repo.path().join(".entire");
        fs::create_dir_all(&entire_dir).unwrap();
        fs::write(
            entire_dir.join("settings.json"),
            r#"{"version": 1, "agents": []}"#,
        )
        .unwrap();

        TestEnv { home, repo, _stub_bin: stub_bin, stub_bin_path }
    }

    fn gossamer(&self, args: &[&str]) -> Command {
        // Prepend the stub bin dir to PATH so `entire` resolves to our no-op
        // stub instead of the real binary (which may block or produce noise).
        let original_path = std::env::var("PATH").unwrap_or_default();
        let path = format!("{}:{}", self.stub_bin_path.display(), original_path);

        let mut cmd = Command::new(bin());
        cmd.args(args)
            .current_dir(self.repo.path())
            .env("HOME", self.home.path())
            .env("SHELL", "/bin/zsh")
            .env("PATH", path)
            // Unset WARP_ASSETS so witchcraft asset detection is clean
            .env_remove("WARP_ASSETS");
        cmd
    }

    // Run `gossamer init` and assert success
    fn init(&self) {
        let out = self.gossamer(&["init"]).output().expect("gossamer init");
        assert!(
            out.status.success(),
            "gossamer init failed\nstdout: {}\nstderr: {}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr),
        );
    }

    // Create a fake Claude JSONL session file under $HOME/.claude/projects/
    fn create_fake_session(&self, session_id: &str, session_name: &str, cwd: &str) {
        let projects_dir = self.home.path().join(".claude/projects/test-project");
        fs::create_dir_all(&projects_dir).unwrap();
        let content = format!(
            "{}\n{}\n{}\n",
            r#"{"type":"system","cwd":"CWD","timestamp":"2024-01-01T00:00:00Z"}"#
                .replace("CWD", cwd),
            format!(r#"{{"type":"custom-title","customTitle":"{session_name}","timestamp":"2024-01-01T00:00:01Z"}}"#),
            r#"{"type":"user","message":{"content":"Make some edits please"},"cwd":"CWD","gitBranch":"main","timestamp":"2024-01-01T00:01:00Z"}"#
                .replace("CWD", cwd),
        );
        fs::write(projects_dir.join(format!("{session_id}.jsonl")), content).unwrap();
    }

    // Register a session directly by piping a session-start hook payload to the binary
    fn session_start(&self, session_id: &str) {
        let cwd = self.repo.path().to_string_lossy().to_string();
        let payload = serde_json::json!({"session_id": session_id, "cwd": cwd}).to_string();
        let mut child = self
            .gossamer(&["session-start"])
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.as_mut().unwrap().write_all(payload.as_bytes()).unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success(), "session-start failed: {}", String::from_utf8_lossy(&out.stderr));
    }
}

// ── Git plumbing helpers ──────────────────────────────────────────────────────

fn run_git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .expect("git command failed to launch");
    assert!(
        out.status.success(),
        "git {} failed\nstdout: {}\nstderr: {}",
        args.join(" "),
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );
}

fn git_hash_object(repo: &Path, content: &[u8]) -> String {
    let mut child = Command::new("git")
        .args(["hash-object", "-w", "--stdin"])
        .current_dir(repo)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("git hash-object");
    child.stdin.as_mut().unwrap().write_all(content).unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "git hash-object failed");
    String::from_utf8(out.stdout).unwrap().trim().to_string()
}

fn git_mktree(repo: &Path, entries: &str) -> String {
    let mut child = Command::new("git")
        .args(["mktree"])
        .current_dir(repo)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("git mktree");
    child.stdin.as_mut().unwrap().write_all(entries.as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "git mktree failed");
    String::from_utf8(out.stdout).unwrap().trim().to_string()
}

fn git_commit_tree(repo: &Path, tree: &str, message: &str) -> String {
    let out = Command::new("git")
        .args(["-c", "user.email=t@t.com", "-c", "user.name=Test", "commit-tree", tree, "-m", message])
        .current_dir(repo)
        .output()
        .expect("git commit-tree");
    assert!(out.status.success(), "git commit-tree failed: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).unwrap().trim().to_string()
}

// Find the first complete JSON object in mixed stdout (some commands print
// a non-JSON preamble before the JSON payload when assets are unconfigured).
fn extract_json(stdout: &[u8]) -> serde_json::Value {
    let s = String::from_utf8_lossy(stdout);
    let pos = s.find('{').unwrap_or_else(|| panic!("no JSON in output: {s}"));
    serde_json::from_str(&s[pos..]).unwrap_or_else(|e| panic!("invalid JSON: {e}\noutput: {s}"))
}

// ── Tests: init ───────────────────────────────────────────────────────────────

#[test]
fn test_init_registers_repo_in_db() {
    let env = TestEnv::new();
    env.init();

    let out = env.gossamer(&["repo", "--json"]).output().unwrap();
    assert!(out.status.success());
    let json = extract_json(&out.stdout);
    let repos = json["repos"].as_array().unwrap();
    assert_eq!(repos.len(), 1, "expected 1 repo");
    assert_eq!(repos[0]["name"].as_str().unwrap(), "my-repo");
    assert_eq!(
        repos[0]["remote"].as_str().unwrap(),
        "https://github.com/test/my-repo.git"
    );
    // On macOS /var is a symlink to /private/var; canonicalize both sides
    let stored_dir = repos[0]["directory"].as_str().unwrap();
    let expected_dir = env.repo.path().canonicalize().unwrap();
    assert_eq!(stored_dir, expected_dir.to_str().unwrap());
}

#[test]
fn test_init_installs_post_commit_hook() {
    let env = TestEnv::new();
    env.init();

    let hook = env.repo.path().join(".git/hooks/post-commit");
    assert!(hook.exists(), "post-commit hook not created");
    let content = fs::read_to_string(&hook).unwrap();
    assert!(content.contains("gossamer"), "hook should reference gossamer");
    assert!(content.contains("Entire-Checkpoint:"), "hook should check for checkpoint commits");
}

#[test]
fn test_init_registers_claude_hooks() {
    let env = TestEnv::new();
    env.init();

    let settings_path = env.home.path().join(".claude/settings.json");
    assert!(settings_path.exists(), "claude settings.json not created");
    let raw = fs::read_to_string(&settings_path).unwrap();
    let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let start_hooks = &json["hooks"]["SessionStart"];
    let stop_hooks = &json["hooks"]["Stop"];
    assert!(start_hooks.is_array(), "SessionStart hooks should be an array");
    assert!(stop_hooks.is_array(), "Stop hooks should be an array");

    let has_session_start = start_hooks.as_array().unwrap().iter().any(|entry| {
        entry["hooks"]
            .as_array()
            .map_or(false, |cmds| cmds.iter().any(|c| c["command"] == "entire gossamer session-start"))
    });
    let has_stop = stop_hooks.as_array().unwrap().iter().any(|entry| {
        entry["hooks"]
            .as_array()
            .map_or(false, |cmds| cmds.iter().any(|c| {
                c["command"].as_str().map_or(false, |s| s.contains("entire gossamer session-stop"))
            }))
    });
    assert!(has_session_start, "SessionStart hook not registered");
    assert!(has_stop, "Stop hook not registered");
}

#[test]
fn test_init_is_idempotent() {
    let env = TestEnv::new();
    env.init();
    env.init(); // second run should succeed cleanly

    let out = env.gossamer(&["repo", "--json"]).output().unwrap();
    let json = extract_json(&out.stdout);
    let repos = json["repos"].as_array().unwrap();
    assert_eq!(repos.len(), 1, "repo should appear exactly once after two inits");
}

#[test]
fn test_init_hook_idempotent() {
    let env = TestEnv::new();
    env.init();
    env.init(); // should not double-append to the hook file

    let hook = env.repo.path().join(".git/hooks/post-commit");
    let content = fs::read_to_string(&hook).unwrap();
    let occurrences = content.matches("gossamer:").count();
    assert_eq!(occurrences, 1, "gossamer marker should appear exactly once in hook");
}

// ── Tests: sessions ───────────────────────────────────────────────────────────

#[test]
fn test_sessions_empty_after_fresh_init() {
    let env = TestEnv::new();
    env.init();

    let out = env.gossamer(&["sessions", "--json", "--all"]).output().unwrap();
    assert!(out.status.success());
    let json = extract_json(&out.stdout);
    let sessions = json["sessions"].as_array().unwrap();
    assert!(sessions.is_empty(), "expected no sessions in fresh env, got {sessions:?}");
}

#[test]
fn test_sessions_shows_claude_jsonl_files() {
    let env = TestEnv::new();
    env.init();

    let cwd = env.repo.path().to_string_lossy().to_string();
    let session_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    env.create_fake_session(session_id, "My Test Session", &cwd);

    let out = env.gossamer(&["sessions", "--json", "--all"]).output().unwrap();
    assert!(out.status.success());
    let json = extract_json(&out.stdout);
    let sessions = json["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 1, "expected 1 session from claude projects");
    assert_eq!(sessions[0]["session_id"].as_str().unwrap(), session_id);
    assert_eq!(sessions[0]["session_name"].as_str().unwrap(), "My Test Session");
}

#[test]
fn test_sessions_recent_filter_excludes_old_sessions() {
    let env = TestEnv::new();
    env.init();

    // Write a session file with a very old mtime
    let projects_dir = env.home.path().join(".claude/projects/test-project");
    fs::create_dir_all(&projects_dir).unwrap();
    let cwd = env.repo.path().to_string_lossy().to_string();
    let session_id = "ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb";
    let content = format!(
        r#"{{"type":"system","cwd":"{cwd}","timestamp":"2020-01-01T00:00:00Z"}}
"#
    );
    let path = projects_dir.join(format!("{session_id}.jsonl"));
    fs::write(&path, content).unwrap();

    // Set mtime to 30 days ago (well outside the 3-day cutoff)
    let thirty_days_ago = std::time::SystemTime::now()
        - std::time::Duration::from_secs(30 * 24 * 3600);
    fs::File::open(&path)
        .unwrap()
        .set_modified(thirty_days_ago)
        .ok();

    // Without --all: should not appear
    let out = env.gossamer(&["sessions", "--json"]).output().unwrap();
    let json = extract_json(&out.stdout);
    let sessions = json["sessions"].as_array().unwrap();
    assert!(
        !sessions.iter().any(|s| s["session_id"].as_str() == Some(session_id)),
        "old session should not appear without --all"
    );

    // With --all: should appear
    let out = env.gossamer(&["sessions", "--json", "--all"]).output().unwrap();
    let json = extract_json(&out.stdout);
    let sessions = json["sessions"].as_array().unwrap();
    assert!(
        sessions.iter().any(|s| s["session_id"].as_str() == Some(session_id)),
        "old session should appear with --all"
    );
}

// ── Tests: session-start ──────────────────────────────────────────────────────

#[test]
fn test_session_start_registers_in_db() {
    let env = TestEnv::new();
    env.init();

    let session_id = "11111111-2222-3333-4444-555555555555";
    env.session_start(session_id);

    let out = env.gossamer(&["sessions", "--json", "--all"]).output().unwrap();
    let json = extract_json(&out.stdout);
    let sessions = json["sessions"].as_array().unwrap();
    let found = sessions.iter().any(|s| s["session_id"].as_str() == Some(session_id));
    assert!(found, "session {session_id} not found after session-start");
}

#[test]
fn test_session_start_is_idempotent() {
    // Running session-start twice with the same id should not fail or duplicate
    let env = TestEnv::new();
    env.init();

    let session_id = "22222222-3333-4444-5555-666666666666";
    env.session_start(session_id);
    env.session_start(session_id); // second call: INSERT OR IGNORE, should be fine

    let out = env.gossamer(&["sessions", "--json", "--all"]).output().unwrap();
    let json = extract_json(&out.stdout);
    let sessions = json["sessions"].as_array().unwrap();
    let count = sessions.iter().filter(|s| s["session_id"].as_str() == Some(session_id)).count();
    assert_eq!(count, 1, "session should appear exactly once after two session-starts");
}

#[test]
fn test_session_start_consumes_pending_name() {
    let env = TestEnv::new();
    env.init();

    // Write a pending session name file that session-start should consume
    let gossamer_dir = env.home.path().join(".gossamer");
    fs::create_dir_all(&gossamer_dir).unwrap();
    fs::write(gossamer_dir.join("pending_session_name"), "My Named Session\n").unwrap();

    let session_id = "33333333-4444-5555-6666-777777777777";
    env.session_start(session_id);

    // File should have been removed
    assert!(
        !gossamer_dir.join("pending_session_name").exists(),
        "pending_session_name file should be consumed by session-start"
    );

    // Session name should be set in the DB
    let out = env.gossamer(&["sessions", "--json", "--all"]).output().unwrap();
    let json = extract_json(&out.stdout);
    let sessions = json["sessions"].as_array().unwrap();
    let session = sessions.iter().find(|s| s["session_id"].as_str() == Some(session_id));
    assert!(session.is_some(), "session not found");
    assert_eq!(
        session.unwrap()["session_name"].as_str().unwrap(),
        "My Named Session"
    );
}

// ── Tests: session-stop ───────────────────────────────────────────────────────

#[test]
fn test_session_stop_is_non_fatal_with_empty_stdin() {
    let env = TestEnv::new();
    env.init();

    // session-stop reads stdin; empty input causes a JSON parse error which the
    // implementation propagates as Err, but the command itself should not crash
    // catastrophically. Even if it returns non-zero, it should not panic.
    let mut child = env
        .gossamer(&["session-stop"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    drop(child.stdin.take()); // close stdin immediately
    let _out = child.wait_with_output().unwrap();
    // We don't assert success because empty stdin is an error; we just check no panic/crash
}

// ── Tests: index ──────────────────────────────────────────────────────────────

#[test]
fn test_index_reports_zero_without_checkpoint_branch() {
    let env = TestEnv::new();
    env.init();

    let out = env.gossamer(&["ingest", "--json"]).output().unwrap();
    assert!(out.status.success(), "ingest failed: {}", String::from_utf8_lossy(&out.stderr));
    let json = extract_json(&out.stdout);
    assert_eq!(
        json["sessions_indexed"].as_u64(),
        Some(0),
        "expected 0 sessions indexed without checkpoint branch"
    );
}

#[test]
fn test_index_with_checkpoint_branch() {
    let env = TestEnv::new();
    env.init();

    let session_id = "fedcba98-7654-3210-fedc-ba9876543210";
    let cwd = env.repo.path().to_string_lossy().to_string();
    create_checkpoint_branch(env.repo.path(), session_id, &cwd);

    let out = env.gossamer(&["ingest", "--json"]).output().unwrap();
    assert!(
        out.status.success(),
        "ingest failed\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );
    let json = extract_json(&out.stdout);
    assert_eq!(
        json["sessions_indexed"].as_u64(),
        Some(1),
        "expected 1 session indexed from checkpoint branch, got: {json}"
    );

    // The session should now show up in sessions --json --all
    let out = env.gossamer(&["sessions", "--json", "--all"]).output().unwrap();
    let json = extract_json(&out.stdout);
    let sessions = json["sessions"].as_array().unwrap();
    let found = sessions.iter().any(|s| s["session_id"].as_str() == Some(session_id));
    assert!(found, "indexed session not found in sessions list");
}

// ── Tests: clean ─────────────────────────────────────────────────────────────

#[test]
fn test_clean_removes_session_from_db() {
    let env = TestEnv::new();
    env.init();

    let session_id = "deadbeef-dead-beef-dead-beefdeadbeef";
    env.session_start(session_id);

    // Verify it's in the DB
    let out = env.gossamer(&["sessions", "--json", "--all"]).output().unwrap();
    let json = extract_json(&out.stdout);
    assert!(
        json["sessions"].as_array().unwrap()
            .iter()
            .any(|s| s["session_id"].as_str() == Some(session_id)),
        "session should exist before clean"
    );

    // Clean it
    let out = env.gossamer(&["clean", "--json", session_id]).output().unwrap();
    assert!(out.status.success(), "clean failed: {}", String::from_utf8_lossy(&out.stderr));
    let json = extract_json(&out.stdout);
    assert_eq!(json["ok"].as_bool(), Some(true));
    assert_eq!(json["session_id"].as_str(), Some(session_id));
    assert_eq!(json["db_rows_deleted"].as_u64(), Some(1));

    // Verify it's gone
    let out = env.gossamer(&["sessions", "--json", "--all"]).output().unwrap();
    let json = extract_json(&out.stdout);
    assert!(
        !json["sessions"].as_array().unwrap()
            .iter()
            .any(|s| s["session_id"].as_str() == Some(session_id)),
        "session should be gone after clean"
    );
}

#[test]
fn test_clean_nonexistent_session_is_non_fatal() {
    let env = TestEnv::new();
    env.init();

    let out = env
        .gossamer(&["clean", "--json", "00000000-0000-0000-0000-000000000000"])
        .output()
        .unwrap();
    assert!(out.status.success(), "clean of nonexistent session should succeed");
    let json = extract_json(&out.stdout);
    assert_eq!(json["ok"].as_bool(), Some(true));
    assert_eq!(json["db_rows_deleted"].as_u64(), Some(0));
}

// ── Tests: repo (status) ──────────────────────────────────────────────────────

#[test]
fn test_repo_json_structure() {
    let env = TestEnv::new();
    env.init();

    let out = env.gossamer(&["repo", "--json"]).output().unwrap();
    assert!(out.status.success());
    let json = extract_json(&out.stdout);

    let repo = &json["repos"][0];
    assert!(repo["name"].is_string(), "name should be a string");
    assert!(repo["directory"].is_string(), "directory should be a string");
    assert!(repo["remote"].is_string(), "remote should be a string");
    assert!(repo["worktrees"].is_array(), "worktrees should be an array");
    assert!(repo["sessions"].is_array(), "sessions should be an array");
}

#[test]
fn test_repo_without_init_is_empty() {
    // Run repo --json without ever calling init; should return an empty repos list
    let env = TestEnv::new();

    let out = env.gossamer(&["repo", "--json"]).output().unwrap();
    assert!(out.status.success());
    let json = extract_json(&out.stdout);
    let repos = json["repos"].as_array().unwrap();
    assert!(repos.is_empty(), "expected empty repos list without init");
}

// ── Checkpoint branch helper ──────────────────────────────────────────────────

fn create_checkpoint_branch(repo: &Path, session_id: &str, cwd: &str) {
    let metadata = serde_json::json!({
        "session_id": session_id,
        "agent": "claude-code",
        "created_at": "2024-01-01T00:00:00Z",
        "summary": {"intent": "Test session from checkpoint branch"}
    });
    let jsonl = format!(
        "{}\n{}\n",
        serde_json::json!({"type":"system","cwd": cwd,"timestamp":"2024-01-01T00:00:00Z"}),
        serde_json::json!({"type":"user","message":{"content":"Hello"},"cwd":cwd,"timestamp":"2024-01-01T00:01:00Z"}),
    );

    // Hash the two blobs
    let meta_hash = git_hash_object(repo, metadata.to_string().as_bytes());
    let jsonl_hash = git_hash_object(repo, jsonl.as_bytes());

    // Build tree bottom-up:
    //   sessions/<session_id>/1/metadata.json
    //   sessions/<session_id>/1/full.jsonl
    //
    // is_meta_path requires exactly 3 slashes and the 3rd segment to be all-digits.
    let leaf_entries = format!(
        "100644 blob {meta_hash}\tmetadata.json\n100644 blob {jsonl_hash}\tfull.jsonl\n"
    );
    let leaf_tree = git_mktree(repo, &leaf_entries);

    let session_entries = format!("040000 tree {leaf_tree}\t1\n");
    let session_tree = git_mktree(repo, &session_entries);

    let sessions_entries = format!("040000 tree {session_tree}\t{session_id}\n");
    let sessions_tree = git_mktree(repo, &sessions_entries);

    let root_entries = format!("040000 tree {sessions_tree}\tsessions\n");
    let root_tree = git_mktree(repo, &root_entries);

    let commit = git_commit_tree(repo, &root_tree, "checkpoint");

    run_git(repo, &["branch", "entire/checkpoints/v1", &commit]);
}
