# AGENTS.md — Gossamer

## What is Gossamer?

Gossamer is a CLI tool that tracks AI coding sessions across git repositories. It sits on top of **entireio** (`entire`), a session checkpointing tool that commits AI agent conversation logs to a dedicated git branch (`entire/checkpoints/v1`). Gossamer adds:

- A SQLite database (`~/.gossamer/gossamer.db`) that indexes sessions and repositories
- An interactive TUI (terminal UI) for browsing repos and sessions
- Semantic search over session transcripts via **witchcraft** (a local embedding/vector-search library)
- Shell integration (`gr` function for `cd`-ing into a tracked repo)
- Claude Code hook integration (auto-ingests sessions on start/stop)

## Repository Layout

```
src/
  main.rs              # CLI entry point, Clap command definitions
  db.rs                # SQLite connection + schema migrations
  config.rs            # Witchcraft assets path config (~/.gossamer/warp_assets)
  watermark.rs         # File mtime utilities
  entity/
    repository.rs      # Repository struct
    session.rs         # Session struct
  commands/
    init.rs            # `gossamer init` — repo registration, hook installation
    status.rs          # `gossamer repo` — TUI repo browser + new session wizard
    sessions.rs        # `gossamer sessions` — TUI session list
    show.rs            # `gossamer show` — session transcript viewer
    search.rs          # `gossamer search` — semantic search TUI
    index.rs           # `gossamer index` — full re-index from checkpoint branch
    refresh.rs         # `gossamer refresh` — incremental index (new commits only)
    new_session.rs     # `gossamer new-session` — launch agent in optional worktree
    resume.rs          # `gossamer resume` — resume a session (worktree-aware)
    clean.rs           # `gossamer clean` — delete session from DB + search index
    attach.rs          # `gossamer attach` — attach an existing entire session
    session_start.rs   # `gossamer session-start` — Claude Code SessionStart hook
    session_stop.rs    # `gossamer session-stop` — Claude Code Stop hook
  ingest/
    mod.rs             # Search DB ingestion: sessions, repos, embed + index
    claude_code.rs     # Ingest Claude Code session logs from checkpoint branch
tests/
  integration_test.rs  # Integration tests (binary invocation, isolated HOME)
```

## Commands

All commands that produce output have a `--json` flag that switches from interactive TUI to machine-readable JSON on stdout.

### `gossamer init`

Registers the current git repository with gossamer. Steps:

1. Reads `git remote get-url origin` for the remote URL and derives the repo name from it.
2. Checks for `.entire/settings.json` or the `entire/checkpoints/v1` branch. If neither exists, runs an interactive wizard that calls `entire configure` and `entire agent add <agent>`.
3. Installs a post-commit hook (`.git/hooks/post-commit`) that runs `gossamer index` after checkpoint commits.
4. Installs Claude Code hooks (`~/.claude/settings.json`): `SessionStart` → `gossamer session-start`, `Stop` → `gossamer session-stop`.
5. Installs a `gr` shell function in `~/.zshrc` or `~/.bash_profile` for interactive `cd`.
6. Inserts the repo into the `repositories` table.

**Requires:** a git repo with an `origin` remote. Safe to run multiple times (idempotent).

### `gossamer repo` (default command)

Interactive TUI listing all tracked repositories. From the repo list you can:
- `space` / `→` — drill into a repo's sessions and worktrees
- `s` — open the new-session wizard (agent picker → optional branch → name → prompt)
- `c` — `cd` to the repo (only when invoked via the `gr` shell wrapper)
- `/` — semantic search

From the sessions sub-screen:
- `space` / `→` — view session transcript (`gossamer show`)
- `r` — resume session
- `n` — create a new git worktree
- `s` — new session wizard

`--json` output: `{ "repos": [ { "name", "directory", "remote", "worktrees": [...], "sessions": [...] } ] }`

### `gossamer sessions [--all]`

Lists sessions from the past 3 days (or all with `--all`). Sources:
1. The `sessions` table in the gossamer DB (sessions indexed from checkpoint branch).
2. JSONL files in `~/.claude/projects/**/*.jsonl` (live Claude Code sessions not yet indexed).

Sessions from the current repo are shown first, then by recency. Interactive TUI with same keybindings as above.

`--json` output: `{ "sessions": [ { "session_id", "session_name", "cwd", "branch", "agent", "updated_at", "backed_up" } ] }`

### `gossamer index [--json]`

Full re-index of all tracked repos from their `entire/checkpoints/v1` branches. For each repo:
1. Optionally fetches the branch from a remote checkpoint URL (from `.entire/settings.json`).
2. Runs `git ls-tree -r --name-only entire/checkpoints/v1` to find `metadata.json` files at paths matching `<x>/<session_id>/<number>/metadata.json`.
3. Parses each session's metadata and JSONL transcript, upserts into the `sessions` table.
4. Ingests session names, repo info, and Claude Code logs into the witchcraft search DB.
5. Embeds and indexes if witchcraft assets are configured.

`--json` output: `{ "sessions_indexed", "log_turns", "session_names", "repos" }`

### `gossamer refresh [--json]`

Like `index` but incremental — only processes commits on `entire/checkpoints/v1` since the last indexed commit (stored as `last_indexed_commit` on the repository row).

### `gossamer show <session-id-or-path>`

Interactive TUI for reading a session transcript. Accepts a session UUID (looked up in DB and `~/.claude/projects/`) or a direct path to a JSONL file. Renders assistant messages as Markdown via `termimad`. Arrow keys navigate turns.

### `gossamer search <query...> [-n <top_k>]`

Semantic search using witchcraft. Requires witchcraft assets to be configured (`gossamer config <path>` or `$WARP_ASSETS`). Returns hits grouped by session, with excerpts showing context around the matched turn.

`--json` output: `{ "query", "results": [ { "kind", "session_id", "session_name", "dir", "agent", "hits": [...] } ] }`

### `gossamer new-session [-a agent] [-b branch] [-n name] [prompt]`

Launches an AI agent (default: `claude`). If `-b` is given, creates a new git worktree on that branch first. If `-n` is given, writes the name to `~/.gossamer/pending_session_name` so the `session-start` hook can pick it up. The prompt is copied to the clipboard via `pbcopy`. Uses `exec()` to replace the process with the agent.

### `gossamer resume <session-id>`

Resumes a session. Looks up the session's `cwd` and git branch from the DB or JSONL file, creates a worktree if needed, and launches the agent in the correct directory.

### `gossamer clean <session-id> [--json]`

Deletes a session:
1. Runs `entire clean <session-id>` (non-fatal if it fails).
2. Deletes from the `sessions` and `event_log` tables.
3. Deletes from the witchcraft search DB.

Accepts a session UUID, a session name, or a custom title (scanned from JSONL files).

### `gossamer attach <session-id> [-a agent] [-f]`

Attaches an existing session to entireio via `entire attach`, then indexes it.

### `gossamer config [<assets-path>]`

Shows or sets the witchcraft assets directory path. Stored in `~/.gossamer/warp_assets`.

### `gossamer session-start` (hidden)

Called by the Claude Code `SessionStart` hook. Reads JSON from stdin: `{ "session_id": "...", "cwd": "..." }`. Inserts the session into the DB. If `~/.gossamer/pending_session_name` exists, uses it as the session name and deletes the file.

### `gossamer session-stop` (hidden)

Called by the Claude Code `Stop` hook. Reads JSON from stdin. Ingests the finished session into the witchcraft search DB and re-embeds if assets are configured. Non-fatal on all errors.

## Database Schema

Located at `~/.gossamer/gossamer.db` (SQLite).

```sql
repositories (
    id INTEGER PRIMARY KEY,
    directory TEXT UNIQUE,   -- absolute path to repo root
    remote TEXT,             -- git remote URL
    name TEXT,               -- derived from remote (last path segment, no .git)
    last_indexed_commit TEXT, -- HEAD of entire/checkpoints/v1 at last full index
    last_search_commit TEXT   -- HEAD at last search DB index (used by refresh)
)

sessions (
    session_id TEXT PRIMARY KEY,  -- UUID from entireio / Claude Code
    agent_name TEXT,
    user TEXT,
    created_at TEXT,  -- RFC 3339
    updated_at TEXT,  -- RFC 3339
    cwd TEXT,         -- working directory when the session started
    session_name TEXT,
    tokens_used INTEGER DEFAULT 0
)

event_log (
    id INTEGER PRIMARY KEY,
    session_id TEXT,
    message_id TEXT,
    type TEXT,
    data TEXT
)
```

## entireio Integration

**entireio** (`entire`) is an external tool that checkpoints AI coding sessions to a git branch. Gossamer wraps it in several ways:

| entireio command | When gossamer calls it |
|---|---|
| `entire configure [flags]` | During `gossamer init` wizard (skipped if `.entire/settings.json` exists) |
| `entire agent add <agent>` | During `gossamer init` wizard, for each selected agent |
| `entire clean <session-id>` | During `gossamer clean` (non-fatal) |
| `entire attach <session-id>` | During `gossamer attach` |

The checkpoint branch `entire/checkpoints/v1` has the following tree structure:

```
<prefix>/<session-uuid>/<checkpoint-number>/metadata.json
<prefix>/<session-uuid>/<checkpoint-number>/full.jsonl
```

Where `metadata.json` contains `{ session_id, agent, created_at, summary: { intent } }` and `full.jsonl` is the full conversation transcript in Claude Code JSONL format.

Gossamer identifies metadata files by the rule: path has exactly 3 `/` characters and the third path segment is all digits (see `is_meta_path` in `commands/index.rs`).

In addition to the checkpoint branch, entireio also keeps **shadow branches** of the form `entire/<short-hash>-<short-id>` (one per active worktree/session). These commit on every prompt, well ahead of the periodic checkpoint commits. Each shadow branch carries the full working tree plus `.entire/metadata/<session-uuid>/full.jsonl` and `prompt.txt`. There is no `metadata.json` on shadow branches — gossamer derives `created_at`, `cwd`, `session_name`, etc. directly from the JSONL (see `parse_shadow_session` / `index_shadow_branches` in `commands/index.rs`). Shadow branches are swept on every `gossamer index` and `gossamer refresh`, even when the checkpoint head is unchanged, so in-progress sessions appear with up-to-date `updated_at`.

## Rust Tech Stack

| Crate | Purpose |
|---|---|
| `clap` (derive) | CLI argument parsing |
| `rusqlite` (bundled) | SQLite database, bundled so no system sqlite needed |
| `serde` + `serde_json` | JSON serialization/deserialization |
| `chrono` | Date/time parsing and formatting (RFC 3339) |
| `anyhow` | Error handling with context |
| `crossterm` | Cross-platform terminal control (raw mode, alternate screen, key events) |
| `termimad` | Markdown rendering in the terminal (used in `show`) |
| `dirs` | Platform-appropriate home directory resolution |
| `witchcraft` | Private library (git dependency): local embedding model + vector search DB |
| `uuid` | UUID v5 generation for stable document IDs in the search DB |
| `iso8601-timestamp` | Timestamp parsing for witchcraft document dates |
| `regex` | Text sanitization in the ingest pipeline |
| `comfy-table` | (imported but currently unused in active code paths) |

**witchcraft** is a public Dropbox library (`github.com/dropbox/witchcraft`), loaded via an SSH git URL (`git@github.com:dropbox/witchcraft.git`) in `Cargo.toml`. It provides:
- `witchcraft::DB` — a SQLite-backed vector store
- `witchcraft::Embedder` — loads a quantized T5 model from a local assets directory
- `witchcraft::embed_chunks` / `witchcraft::index_chunks` — batch embedding pipeline
- `witchcraft::search` — semantic similarity search
- `witchcraft::make_device` — selects CPU/GPU

The witchcraft assets path (model weights, tokenizer) must be configured via `gossamer config <path>` or the `$WARP_ASSETS` environment variable. Semantic search is optional; all other commands work without it.

## Development Workflow

```bash
# Build and install after any source change
cargo install --path .

# Run all integration tests (build + run, no pre-installed binary needed)
cargo test --test integration_test

# Run a specific test
cargo test --test integration_test test_index_with_checkpoint_branch
```

Integration tests in `tests/integration_test.rs` create isolated `TempDir` instances for both `HOME` and the git repo, so they never touch the real gossamer DB or Claude settings. The binary under test is located via `env!("CARGO_BIN_EXE_gossamer")` — Cargo builds it automatically before running tests.

## Key Invariants

- `gossamer init` must be run inside a git repo that has an `origin` remote configured.
- All TUI commands fall back to plain text or JSON output when stdout is not a terminal (`--json` flag or piped output).
- The `entire/checkpoints/v1` branch is never written by gossamer — it is read-only from gossamer's perspective.
- `session-start` and `session-stop` are designed to be called by Claude Code hooks; they swallow errors to avoid interrupting the agent workflow.
- The gossamer DB path and witchcraft search DB path both respect the `HOME` environment variable, making it straightforward to test in isolation.
