use anyhow::{Context, Result};
use serde::Deserialize;
use std::cell::RefCell;
use std::collections::HashMap;
use std::process::Command;

use crate::{db, ingest};

pub(crate) const BRANCH: &str = "entire/checkpoints/v1";

/// Resolves a session's owning repository. Remote URL is the source of truth
/// — local paths are incidental to where someone happened to clone a repo.
/// Order of precedence:
///   1. **Mode B** (indexed repo's remote IS some tracked project's declared
///      `.entire/settings.json::checkpoint_remote`): pick the project that
///      uses this shared checkpoint repo; disambiguate by cwd if multiple.
///   2. **Mode A** (we have an indexing context but it isn't a shared
///      checkpoint repo): the file IS in this repo's checkpoint branch, so
///      by direct evidence it's this repo's session. The indexing context's
///      remote URL is authoritative — no need to consult the cwd.
///   3. **Backfill / no indexing context**: derive remote from cwd.
///      a. `git -C cwd remote get-url origin` matched against `repositories.remote`
///      b. cwd longest-prefix against tracked dirs (cross-machine fallback)
///      c. user-home-stripped suffix match (Scott's `/Users/sholodak/cosmos/X`
///         matches my `/Users/stsoucas/cosmos/X`)
///   4. Returns None if no signal at all.
///
/// Results of `git remote get-url origin` are cached so the cwd-derivation
/// path doesn't shell out repeatedly during a long index.
pub(crate) struct RepoResolver {
    repos: Vec<(i64, String, String)>,           // (id, directory, remote)
    by_remote: HashMap<String, i64>,             // normalized remote URL → repo_id
    project_for_checkpoint: HashMap<String, Vec<i64>>, // normalized cp-remote URL → project ids
    cwd_remote_cache: RefCell<HashMap<String, Option<String>>>,
}

impl RepoResolver {
    pub fn new(conn: &rusqlite::Connection) -> Result<Self> {
        let mut stmt = conn.prepare("SELECT id, directory, remote FROM repositories")?;
        let repos: Vec<(i64, String, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<Result<_, _>>()?;

        let mut by_remote = HashMap::new();
        let mut project_for_checkpoint: HashMap<String, Vec<i64>> = HashMap::new();
        for (id, dir, remote) in &repos {
            if !remote.is_empty() {
                by_remote.insert(normalize_remote(remote), *id);
            }
            if let Some(cp_url) = checkpoint_remote_url(dir) {
                project_for_checkpoint.entry(normalize_remote(&cp_url))
                    .or_default()
                    .push(*id);
            }
        }

        Ok(Self {
            repos,
            by_remote,
            project_for_checkpoint,
            cwd_remote_cache: RefCell::new(HashMap::new()),
        })
    }

    pub fn resolve(&self, cwd: &str, indexing_context: Option<i64>) -> Option<i64> {
        // ── INDEXING CONTEXT (when we have one) ────────────────────────
        // We know the remote URL of the repo we're scanning — that IS the
        // session's remote URL, modulo the Mode B fan-out.
        if let Some(ctx_id) = indexing_context {
            if let Some(ctx_remote) = self.remote_of(ctx_id) {
                // 1. Mode B: ctx is a shared checkpoint repo. Disambiguate
                //    among the projects that use it as their checkpoint
                //    remote.
                if let Some(candidates) = self.project_for_checkpoint.get(&ctx_remote) {
                    if candidates.len() == 1 { return Some(candidates[0]); }
                    for &cand in candidates {
                        if let Some((_, dir, _)) = self.repos.iter().find(|(id, _, _)| *id == cand) {
                            if let Some(name) = std::path::Path::new(dir).file_name().and_then(|s| s.to_str()) {
                                if cwd.contains(name) { return Some(cand); }
                            }
                        }
                    }
                    if !candidates.is_empty() { return Some(candidates[0]); }
                }
                // 2. Mode A: ctx IS the project. Direct evidence — the file
                //    is in this repo's checkpoint branch — beats any cwd
                //    heuristic we could run.
                return Some(ctx_id);
            }
        }

        // ── NO INDEXING CONTEXT (backfill) ─────────────────────────────
        // We're walking ~/.claude/projects without knowing which repo's
        // branch each session came from. Derive remote from cwd.

        // 3a. cwd is a local git workdir — ask it for origin URL.
        if !cwd.is_empty() {
            if let Some(remote_url) = self.cached_origin(cwd) {
                if let Some(&id) = self.by_remote.get(&normalize_remote(&remote_url)) {
                    return Some(id);
                }
            }
        }

        // 3b/c. Path heuristics — brittle, but the only thing left for
        //       cross-machine cwds that don't exist locally.
        self.from_path(cwd)
    }

    fn from_path(&self, cwd: &str) -> Option<i64> {
        if cwd.is_empty() { return None; }
        // a) cwd is literally inside a tracked dir.
        let mut best: Option<(usize, i64)> = None;
        for (id, dir, _) in &self.repos {
            if cwd.starts_with(dir.as_str()) {
                let n = dir.len();
                if best.map_or(true, |(b, _)| n > b) { best = Some((n, *id)); }
            }
        }
        if let Some((_, id)) = best { return Some(id); }

        // b) Same project, different user-home. `/Users/sholodak/cosmos/foo`
        //    matches my `/Users/stsoucas/cosmos/foo` after stripping the
        //    leading `/Users/<user>/`.
        let cwd_suffix = strip_user_home(cwd)?;
        let mut best: Option<(usize, i64)> = None;
        for (id, dir, _) in &self.repos {
            if let Some(dir_suffix) = strip_user_home(dir) {
                if path_prefix_match(cwd_suffix, dir_suffix) {
                    let n = dir_suffix.len();
                    if best.map_or(true, |(b, _)| n > b) { best = Some((n, *id)); }
                }
            }
        }
        best.map(|(_, id)| id)
    }

    fn remote_of(&self, repo_id: i64) -> Option<String> {
        self.repos.iter().find(|(id, _, _)| *id == repo_id).map(|(_, _, r)| normalize_remote(r))
    }

    fn cached_origin(&self, cwd: &str) -> Option<String> {
        let mut cache = self.cwd_remote_cache.borrow_mut();
        if let Some(hit) = cache.get(cwd) { return hit.clone(); }
        let resolved = git_origin_url(cwd);
        cache.insert(cwd.to_string(), resolved.clone());
        resolved
    }
}

fn git_origin_url(cwd: &str) -> Option<String> {
    if !std::path::Path::new(cwd).is_dir() { return None; }
    let out = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(cwd)
        .output().ok()?;
    if !out.status.success() { return None; }
    let s = String::from_utf8(out.stdout).ok()?;
    let s = s.trim();
    if s.is_empty() { None } else { Some(s.to_string()) }
}

/// Strip a leading `/Users/<x>/` or `/home/<x>/` prefix from a path. Returns
/// the remainder (project-relative path). None if the path doesn't start with
/// a recognized home prefix or has nothing after the username segment.
fn strip_user_home(path: &str) -> Option<&str> {
    for home_root in ["/Users/", "/home/"] {
        if let Some(rest) = path.strip_prefix(home_root) {
            return rest.split_once('/').map(|(_user, after)| after);
        }
    }
    None
}

/// Like `starts_with` but only matches at a path boundary, so
/// `cosmos/cosmos-graphql-foo` does NOT match prefix `cosmos/cosmos-graphql`.
fn path_prefix_match(haystack: &str, needle: &str) -> bool {
    if haystack == needle { return true; }
    if !haystack.starts_with(needle) { return false; }
    // Char immediately after the needle must be a path separator.
    haystack.as_bytes().get(needle.len()) == Some(&b'/')
}

/// Normalize a git remote URL into a comparable form. SSH and HTTPS variants
/// of the same repo (`git@github.com:owner/repo.git` vs
/// `https://github.com/owner/repo`) both collapse to the same key.
pub(crate) fn normalize_remote(url: &str) -> String {
    let s = url.trim().trim_end_matches('/').trim_end_matches(".git");
    if let Some(rest) = s.strip_prefix("git@") {
        if let Some((host, path)) = rest.split_once(':') {
            return format!("https://{}/{}", host.to_lowercase(), path);
        }
    }
    if let Some(rest) = s.strip_prefix("ssh://git@") {
        return format!("https://{}", rest.to_lowercase());
    }
    s.to_lowercase()
}

#[derive(Clone)]
pub(crate) struct CommitAuthor {
    pub sha: String,
    pub name: String,
    pub email: String,
}

struct PendingCheckpoint {
    session_id: String,
    checkpoint_number: u32,
    jsonl_path: String,
    last_turn_ts: String,
    os_user: Option<String>,
    direct: Option<CommitAuthor>,
}

/// Walk ~/.claude/projects/**/*.jsonl and upsert any session whose UUID
/// isn't already in the DB. Picks up sessions that ran before `gossamer init`
/// installed the session-start hook, plus any session that for whatever
/// reason never got captured by entire's checkpoint branch.
pub(crate) fn backfill_local_jsonls(
    conn: &rusqlite::Connection,
    _repos: &[(i64, String, String)],
    resolver: &RepoResolver,
) -> Result<usize> {
    let home = std::env::var("HOME").map_err(|_| anyhow::anyhow!("HOME unset"))?;
    let projects = std::path::PathBuf::from(&home).join(".claude/projects");
    let Ok(dirs) = std::fs::read_dir(&projects) else { return Ok(0); };

    let known: std::collections::HashSet<String> = {
        let mut out = std::collections::HashSet::new();
        if let Ok(mut stmt) = conn.prepare("SELECT session_id FROM sessions") {
            if let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) {
                for r in rows.flatten() { out.insert(r); }
            }
        }
        out
    };

    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "unknown".to_string());

    let mut count = 0usize;
    for dir in dirs.flatten() {
        let path = dir.path();
        if !path.is_dir() { continue; }
        let Ok(files) = std::fs::read_dir(&path) else { continue; };
        for f in files.flatten() {
            let p = f.path();
            if p.extension().and_then(|e| e.to_str()) != Some("jsonl") { continue; }
            let Some(sid) = p.file_stem().and_then(|s| s.to_str()).map(str::to_string) else { continue; };
            if known.contains(&sid) { continue; }

            let Ok(bytes) = std::fs::read(&p) else { continue; };
            let parsed = match crate::parsers::dispatch_shadow_session(&bytes, &sid) {
                Ok(t) => t,
                Err(_) => continue,
            };

            // No indexing context here — backfill doesn't know which repo's
            // branch this came from. Resolver tries cwd-prefix then git
            // remote; gives up if neither matches a tracked project.
            let repo_id = resolver.resolve(&parsed.cwd, None);

            if upsert_session(conn, &parsed.session_id, &parsed.agent_name, &user,
                              &parsed.created_at, &parsed.updated_at, &parsed.cwd, &parsed.session_name,
                              &parsed.branch, repo_id, parsed.name_is_explicit).is_ok() {
                count += 1;
            }
        }
    }
    Ok(count)
}

/// Extract the OS username from a session's cwd. The JSONL captures the cwd
/// on the machine that ran the conversation, so `/Users/sholodak/...` reliably
/// identifies Scott even when the checkpoint reached us via a merge commit.
pub(crate) fn cwd_to_os_user(cwd: &str) -> Option<String> {
    let rest = cwd.strip_prefix("/Users/")
        .or_else(|| cwd.strip_prefix("/home/"))?;
    let user = rest.split('/').next()?;
    if user.is_empty() { None } else { Some(user.to_string()) }
}

pub fn run(json: bool) -> Result<()> {
    let conn = db::connect()?;

    let mut stmt = conn.prepare("SELECT id, directory, name FROM repositories")?;
    let repos: Vec<(i64, String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<Result<_, _>>()?;

    if repos.is_empty() {
        if json {
            println!("{}", serde_json::json!({"sessions_indexed": 0, "log_turns": 0}));
        } else {
            println!("No repositories tracked. Run `gossamer init` first.");
        }
        return Ok(());
    }

    let resolver = RepoResolver::new(&conn)?;

    let mut grand_total = 0usize;

    for (repo_id, dir, name) in &repos {
        match index_repo(&conn, *repo_id, dir, name, &resolver) {
            Ok(0) => { if !json { println!("'{}': no {} branch found.", name, BRANCH); } }
            Ok(n) => {
                if !json { println!("'{}': indexed {} session(s).", name, n); }
                grand_total += n;
            }
            Err(e) => eprintln!("'{}': error — {}", name, e),
        }
    }

    let backfilled = backfill_local_jsonls(&conn, &repos, &resolver).unwrap_or(0);
    if !json && backfilled > 0 {
        println!("Backfilled {} local session(s) from ~/.claude/projects.", backfilled);
    }
    grand_total += backfilled;

    if !json { println!("\n{} session(s) indexed.", grand_total); }

    if !json { println!("\nIndexing into search DB..."); }
    let mut wc_db = ingest::open_search_db()?;
    let turns    = ingest::claude_code::ingest_claude_code(&mut wc_db)?;
    let sessions = ingest::ingest_sessions(&mut wc_db).unwrap_or(0);
    let repos_n  = ingest::ingest_repos(&mut wc_db).unwrap_or(0);
    if !json { println!("{turns} log turn(s), {sessions} session name(s), {repos_n} repo(s) indexed."); }
    ingest::embed_and_index(&wc_db)?;

    if json {
        println!("{}", serde_json::to_string_pretty(&serde_json::json!({
            "sessions_indexed": grand_total,
            "log_turns": turns,
            "session_names": sessions,
            "repos": repos_n,
        }))?);
    }

    Ok(())
}

pub(crate) fn is_meta_path(l: &str) -> bool {
    l.ends_with("/metadata.json")
        && l.matches('/').count() == 3
        && l.split('/').nth(2).map_or(false, |s| s.chars().all(|c| c.is_ascii_digit()))
}

fn index_repo(conn: &rusqlite::Connection, repo_id: i64, repo_dir: &str, _repo_name: &str, resolver: &RepoResolver) -> Result<usize> {
    fetch_checkpoint_branch(repo_dir);

    let check = Command::new("git")
        .args(["rev-parse", "--verify", BRANCH])
        .current_dir(repo_dir)
        .output()
        .context("failed to run git")?;

    if !check.status.success() {
        return Ok(0);
    }

    let ls = Command::new("git")
        .args(["ls-tree", "-r", "--name-only", BRANCH])
        .current_dir(repo_dir)
        .output()
        .context("git ls-tree failed")?;

    let listing = String::from_utf8(ls.stdout)?;

    let meta_paths: Vec<&str> = listing.lines().filter(|l| is_meta_path(l)).collect();

    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "unknown".to_string());

    // Path→author map built from non-merge commits only. Sessions that
    // arrived via "Merge remote session logs" batch imports are not in here —
    // they fall back to cwd-derived attribution below.
    let direct_authors = build_commit_authors(repo_dir).unwrap_or_default();

    // Pass 1: parse every session, register session row, and accumulate
    // checkpoint info. We also learn os_user→author mappings from sessions
    // that have a direct (non-merge) commit, so we can attribute merge-only
    // sessions to the right human in pass 2.
    let mut pending: Vec<PendingCheckpoint> = Vec::new();
    let mut os_user_authors: HashMap<String, CommitAuthor> = HashMap::new();

    for meta_path in meta_paths {
        let jsonl_path = format!("{}full.jsonl", &meta_path[..meta_path.len() - "metadata.json".len()]);

        let meta_bytes = match git_show(repo_dir, meta_path) {
            Ok(b) => b,
            Err(e) => { eprintln!("  skipping {}: {}", meta_path, e); continue; }
        };
        let jsonl_bytes = match git_show(repo_dir, &jsonl_path) {
            Ok(b) => b,
            Err(_) => continue,
        };

        let parsed = match crate::parsers::dispatch_session(&meta_bytes, &jsonl_bytes) {
            Ok(p) => p,
            Err(e) => { eprintln!("  skipping {}: {}", meta_path, e); continue; }
        };

        let resolved_id = resolver.resolve(&parsed.cwd, Some(repo_id));
        upsert_session(conn, &parsed.session_id, &parsed.agent_name, &user,
                       &parsed.created_at, &parsed.updated_at, &parsed.cwd, &parsed.session_name,
                       &parsed.branch, resolved_id, parsed.name_is_explicit)?;

        let checkpoint_number = checkpoint_number_from_path(meta_path).unwrap_or(0);
        let os_user = cwd_to_os_user(&parsed.cwd);
        let direct = direct_authors.get(&jsonl_path)
            .or_else(|| direct_authors.get(meta_path))
            .cloned();

        if let (Some(u), Some(a)) = (&os_user, &direct) {
            os_user_authors.entry(u.clone()).or_insert_with(|| a.clone());
        }

        pending.push(PendingCheckpoint {
            session_id: parsed.session_id,
            checkpoint_number,
            jsonl_path,
            last_turn_ts: parsed.updated_at,
            os_user,
            direct,
        });
    }

    let mut count = pending.len();

    // Pass 2: resolve authors and persist. A merge-only session inherits
    // the author we learned from another session sharing its os_user.
    for p in pending {
        let author = p.direct.or_else(|| {
            p.os_user.as_ref().and_then(|u| os_user_authors.get(u).cloned())
        });
        let os_user_str = p.os_user.unwrap_or_default();
        upsert_checkpoint(conn, &p.session_id, p.checkpoint_number,
                          author.as_ref(), &p.last_turn_ts,
                          &p.jsonl_path, repo_dir, &os_user_str)?;
    }

    // Save commit watermark so `gossamer refresh` knows where to start next time.
    if let Ok(out) = Command::new("git").args(["rev-parse", BRANCH]).current_dir(repo_dir).output() {
        if out.status.success() {
            let head = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let _ = conn.execute(
                "UPDATE repositories SET last_indexed_commit = ?1 WHERE directory = ?2",
                rusqlite::params![head, repo_dir],
            );
        }
    }

    // Then sweep shadow branches for in-progress sessions that haven't been
    // checkpointed yet. These often advance several prompts ahead of the
    // checkpoint branch.
    count += index_shadow_branches(conn, repo_id, repo_dir, resolver)?;

    Ok(count)
}

pub(crate) fn git_show(repo_dir: &str, path: &str) -> Result<Vec<u8>> {
    git_show_at(repo_dir, BRANCH, path)
}

pub(crate) fn git_show_at(repo_dir: &str, branch: &str, path: &str) -> Result<Vec<u8>> {
    let out = Command::new("git")
        .args(["show", &format!("{}:{}", branch, path)])
        .current_dir(repo_dir)
        .output()
        .context("failed to run git show")?;

    if !out.status.success() {
        anyhow::bail!("object not found: {}:{}", branch, path);
    }
    Ok(out.stdout)
}

/// Match the in-progress session layout entireio writes to shadow branches:
/// `.entire/metadata/<session-uuid>/full.jsonl`. Returns the session UUID.
pub(crate) fn shadow_session_id(path: &str) -> Option<&str> {
    let rest = path.strip_prefix(".entire/metadata/")?;
    let (uuid, tail) = rest.split_once('/')?;
    if tail != "full.jsonl" {
        return None;
    }
    if uuid.is_empty() || uuid.contains('/') {
        return None;
    }
    Some(uuid)
}

/// List all `entire/*` branches that aren't the canonical checkpoint branch.
/// These are the per-worktree shadow branches entireio commits to on every
/// prompt, so they advance long before the next checkpoint commit lands.
pub(crate) fn list_shadow_branches(repo_dir: &str) -> Vec<String> {
    let out = Command::new("git")
        .args(["for-each-ref", "--format=%(refname:short)", "refs/heads/entire/"])
        .current_dir(repo_dir)
        .output();

    let Ok(out) = out else { return vec![]; };
    if !out.status.success() { return vec![]; }

    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .filter(|b| !b.starts_with("entire/checkpoints/"))
        .map(str::to_string)
        .collect()
}

/// Scan every shadow branch in the repo and upsert any sessions found. Shadow
/// branches commit on every prompt, so this picks up in-progress sessions long
/// before they reach `entire/checkpoints/v1`.
pub(crate) fn index_shadow_branches(conn: &rusqlite::Connection, repo_id: i64, repo_dir: &str, resolver: &RepoResolver) -> Result<usize> {
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "unknown".to_string());

    let mut count = 0usize;

    for branch in list_shadow_branches(repo_dir) {
        let ls = Command::new("git")
            .args(["ls-tree", "-r", "--name-only", &branch, "--", ".entire/metadata/"])
            .current_dir(repo_dir)
            .output();
        let Ok(ls) = ls else { continue };
        if !ls.status.success() { continue }
        let listing = String::from_utf8_lossy(&ls.stdout);

        for line in listing.lines() {
            let Some(session_id) = shadow_session_id(line) else { continue };

            let jsonl_bytes = match git_show_at(repo_dir, &branch, line) {
                Ok(b) => b,
                Err(_) => continue,
            };

            match crate::parsers::dispatch_shadow_session(&jsonl_bytes, session_id) {
                Ok(p) => {
                    let resolved_id = resolver.resolve(&p.cwd, Some(repo_id));
                    upsert_session(conn, &p.session_id, &p.agent_name, &user,
                                   &p.created_at, &p.updated_at, &p.cwd, &p.session_name,
                                   &p.branch, resolved_id, p.name_is_explicit)?;
                    count += 1;
                }
                Err(e) => eprintln!("  skipping {}:{} — {}", branch, line, e),
            }
        }
    }

    Ok(count)
}

/// Pull `entire/checkpoints/v1` from wherever it lives. entireio supports two
/// deployment modes:
///   1. Separate checkpoint repo: `.entire/settings.json` has
///      `strategy_options.checkpoint_remote.repo = "<owner>/<repo>"`.
///   2. Same as main repo: entire pushes the checkpoint branch directly to
///      `origin`. This is the default for newer setups (cosmos-agents).
/// Try both — fetches are idempotent and no-op when up to date. We ignore
/// failures so an offline run or a missing remote doesn't abort indexing.
pub(crate) fn fetch_checkpoint_branch(repo_dir: &str) {
    let refspec = format!("{}:{}", BRANCH, BRANCH);
    if let Some(remote_url) = checkpoint_remote_url(repo_dir) {
        let _ = Command::new("git")
            .args(["fetch", &remote_url, &refspec])
            .current_dir(repo_dir)
            .output();
    }
    let _ = Command::new("git")
        .args(["fetch", "origin", &refspec])
        .current_dir(repo_dir)
        .output();
}

pub(crate) fn checkpoint_remote_url(repo_dir: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct EntireSettings {
        strategy_options: Option<StrategyOptions>,
    }
    #[derive(Deserialize)]
    struct StrategyOptions {
        checkpoint_remote: Option<CheckpointRemote>,
    }
    #[derive(Deserialize)]
    struct CheckpointRemote {
        repo: String,
    }

    let settings_path = std::path::Path::new(repo_dir).join(".entire").join("settings.json");
    let raw = std::fs::read_to_string(settings_path).ok()?;
    let settings: EntireSettings = serde_json::from_str(&raw).ok()?;
    let cp_repo = settings.strategy_options?.checkpoint_remote?.repo;

    let use_ssh = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(repo_dir)
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|u| u.trim_start().starts_with("git@") || u.trim_start().starts_with("ssh://"))
        .unwrap_or(true);

    let url = if use_ssh {
        format!("git@github.com:{}.git", cp_repo)
    } else {
        format!("https://github.com/{}.git", cp_repo)
    };

    Some(url)
}

/// Walk `entire/checkpoints/v1` once and map every added file path to the
/// commit that introduced it. We restrict to commits whose subject begins
/// with "Checkpoint:" — entireio's standard prefix for the direct, single-
/// session commit produced by the local agent. Batch imports such as
/// "Merge remote session logs" carry the importer's identity, not the
/// conversation author's, so we ignore them here and fall back to a
/// cwd-derived attribution for the sessions they bring in.
///
/// Note: `--no-merges` is not sufficient because the checkpoint remote
/// often ships these merge commits without their parents in our local
/// clone, so git treats them as parentless and includes them anyway.
pub(crate) fn build_commit_authors(repo_dir: &str) -> Result<HashMap<String, CommitAuthor>> {
    let out = Command::new("git")
        .args([
            "log",
            "--grep=^Checkpoint: ",
            "--diff-filter=A",
            "--name-only",
            "--format=__COMMIT__%x09%H%x09%an%x09%ae",
            BRANCH,
        ])
        .current_dir(repo_dir)
        .output()
        .context("git log --diff-filter=A failed")?;

    if !out.status.success() {
        return Ok(HashMap::new());
    }

    let text = String::from_utf8(out.stdout)?;
    let mut map: HashMap<String, CommitAuthor> = HashMap::new();
    let mut current: Option<CommitAuthor> = None;

    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("__COMMIT__\t") {
            let mut parts = rest.splitn(3, '\t');
            let sha = parts.next().unwrap_or("").to_string();
            let name = parts.next().unwrap_or("").to_string();
            let email = parts.next().unwrap_or("").to_string();
            current = Some(CommitAuthor { sha, name, email });
            continue;
        }
        if line.is_empty() { continue; }
        if let Some(a) = &current {
            map.entry(line.to_string()).or_insert_with(|| a.clone());
        }
    }

    Ok(map)
}

/// Extract `<num>` from `<prefix>/<sessuuid>/<num>/metadata.json`.
pub(crate) fn checkpoint_number_from_path(meta_path: &str) -> Option<u32> {
    meta_path.split('/').nth(2)?.parse().ok()
}

pub(crate) fn upsert_checkpoint(
    conn: &rusqlite::Connection,
    session_id: &str,
    checkpoint_number: u32,
    author: Option<&CommitAuthor>,
    last_turn_ts: &str,
    jsonl_path: &str,
    repo_dir: &str,
    os_user: &str,
) -> Result<()> {
    let (sha, name, email) = author
        .map(|a| (a.sha.as_str(), a.name.as_str(), a.email.as_str()))
        .unwrap_or(("", "", ""));
    conn.execute(
        "INSERT INTO checkpoints
            (session_id, checkpoint_number, commit_sha, author_name, author_email,
             last_turn_ts, jsonl_path, repo_dir, os_user)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(session_id, checkpoint_number) DO UPDATE SET
            commit_sha   = excluded.commit_sha,
            author_name  = excluded.author_name,
            author_email = excluded.author_email,
            last_turn_ts = excluded.last_turn_ts,
            jsonl_path   = excluded.jsonl_path,
            repo_dir     = excluded.repo_dir,
            os_user      = excluded.os_user",
        rusqlite::params![
            session_id,
            checkpoint_number as i64,
            sha,
            name,
            email,
            last_turn_ts,
            jsonl_path,
            repo_dir,
            os_user,
        ],
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn upsert_session(
    conn: &rusqlite::Connection,
    session_id: &str,
    agent_name: &str,
    user: &str,
    created_at: &str,
    updated_at: &str,
    cwd: &str,
    session_name: &str,
    branch: &str,
    repo_id: Option<i64>,
    name_is_explicit: bool,
) -> Result<()> {
    // Callers are responsible for resolving repo_id through RepoResolver
    // before calling — see resolve_repo_id docstring for precedence.
    //
    // agent_name is preserved on update if the existing row already has one —
    // shadow branches don't carry a reliable agent identifier, so we don't want
    // a shadow upsert to clobber an agent_name that the checkpoint scan or the
    // session-start hook already set authoritatively. Same idea for branch
    // and repo_id: a checkpoint pass that doesn't have these shouldn't wipe
    // out values previously written by a more authoritative pass.
    //
    // name_is_explicit + session_name are tied: an explicit name (from
    // /rename) always wins over a derived one (first prompt). Same-tier
    // updates overwrite normally.
    conn.execute(
        "INSERT INTO sessions
            (session_id, agent_name, user, created_at, updated_at, cwd, session_name, branch, repo_id, name_is_explicit)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(session_id) DO UPDATE SET
           agent_name       = CASE WHEN COALESCE(sessions.agent_name, '') = ''
                                   THEN excluded.agent_name
                                   ELSE sessions.agent_name END,
           updated_at       = MAX(sessions.updated_at, excluded.updated_at),
           cwd              = CASE WHEN excluded.cwd != '' THEN excluded.cwd ELSE sessions.cwd END,
           session_name     = CASE
                                WHEN excluded.name_is_explicit = 1 THEN excluded.session_name
                                WHEN sessions.name_is_explicit = 1 THEN sessions.session_name
                                ELSE excluded.session_name
                              END,
           name_is_explicit = CASE
                                WHEN excluded.name_is_explicit = 1 OR sessions.name_is_explicit = 1 THEN 1
                                ELSE 0
                              END,
           branch           = CASE WHEN excluded.branch != '' THEN excluded.branch ELSE sessions.branch END,
           repo_id          = COALESCE(excluded.repo_id, sessions.repo_id)",
        rusqlite::params![
            session_id, agent_name, user, created_at, updated_at,
            cwd, session_name, branch, repo_id,
            if name_is_explicit { 1i64 } else { 0i64 }
        ],
    )?;
    Ok(())
}
