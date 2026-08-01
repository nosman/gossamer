# AGENTS.md — Gossamer

## What is Gossamer?

Gossamer is an **Entire CLI plugin** that tracks AI coding sessions across git repositories. It ships as the binary `entire-gossamer` and is invoked as `entire gossamer ...` (or directly as `entire-gossamer ...` once installed — see [entire-plugin.yml](entire-plugin.yml)). It sits on top of **entireio** (`entire`), a session checkpointing tool that commits AI agent conversation logs to a dedicated git branch (`entire/checkpoints/v1`). Gossamer adds:

- A SQLite database (`~/.gossamer/gossamer.db`) that indexes sessions and repositories
- An interactive TUI (terminal UI) for browsing repos and sessions
- Semantic search over session transcripts via **witchcraft** (a local embedding/vector-search library)
- Shell integration (`gr` function for `cd`-ing into a tracked repo)
- Claude Code hook integration (auto-ingests sessions on start/stop)
- Git worktree management (`entire` has no concept of worktrees) and a locally browsable transcript view (`entire` only exposes raw transcript bytes, not a normalized structure)

## Plugin Mechanism

Entire CLI plugins are discovered as `entire-<name>` executables on `$PATH` or in Entire's managed plugin directory (`~/.local/share/entire/plugins/bin` by default). `entire-plugin.yml` at the repo root (`name: gossamer`) is metadata only — the actual dispatch is `entire gossamer <args...>` → `entire-gossamer <args...>` (argv passthrough, no RPC). Install/update with:

```bash
cargo build --release
entire plugin install ./target/release/entire-gossamer --force
```

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
    init.rs            # `entire gossamer init` — repo registration, hook installation
    status.rs          # `entire gossamer repo` — TUI repo browser + launch wizard
    sessions.rs        # `entire gossamer sessions` — TUI session list
    show.rs            # `entire gossamer show` — session transcript viewer
    search.rs          # `entire gossamer search` — semantic search TUI
    index.rs           # `entire gossamer ingest` — full ingest from checkpoint branch
    refresh.rs         # `entire gossamer ingest --incremental` — incremental ingest (new commits only)
    new_session.rs     # `entire gossamer launch` — launch agent in optional worktree
    resume.rs          # `entire gossamer resume` — resume a session (worktree-aware)
    clean.rs           # `entire gossamer clean` — delete session from DB + search index
    attach.rs          # `entire gossamer attach` — attach an existing entire session
    session_start.rs   # `entire gossamer session-start` — Claude Code SessionStart hook
    session_stop.rs    # `entire gossamer session-stop` — Claude Code Stop hook
  parsers/
    mod.rs             # dispatch_session/dispatch_shadow_session — pick a parser by agent
    claude_code.rs     # Claude Code JSONL -> ParsedSession (session_id, cwd, name, branch, ...)
    generic.rs         # Agnostic ParsedSession parser for every other agent (Codex, etc.)
  scraper.rs           # Agent-agnostic transcript walker shared by parsers/generic.rs and
                        # ingest/generic.rs — extracts user/assistant turns + tool calls by
                        # structural signal (role/type fields, content/text/message keys),
                        # not a per-format struct
  ingest/
    mod.rs             # Search DB ingestion driver: ingest_checkpoint_sessions dispatches
                        # per-session by agent, plus session names, repos, embed + index
    claude_code.rs     # Claude Code JSONL -> search-DB chunks (bespoke, tuned parser)
    generic.rs         # scraper-based search-DB chunks for every other agent
tests/
  integration_test.rs  # Integration tests (binary invocation, isolated HOME)
```

## Commands

All commands that produce output have a `--json` flag that switches from interactive TUI to machine-readable JSON on stdout.

### `entire gossamer init`

Registers the current git repository with gossamer. Steps:

1. Reads `git remote get-url origin` for the remote URL and derives the repo name from it.
2. Checks for `.entire/settings.json` or the `entire/checkpoints/v1` branch. If neither exists, runs an interactive wizard that calls `entire configure` and `entire agent add <agent>`.
3. Installs a post-commit hook (`.git/hooks/post-commit`) that runs `entire gossamer ingest` after checkpoint commits.
4. Installs Claude Code hooks (`~/.claude/settings.json`): `SessionStart` → `entire gossamer session-start`, `Stop` → `entire gossamer session-stop`. If an existing hook still points at the pre-rename `gossamer session-start`/`gossamer session-stop` commands, it's migrated to `entire gossamer ...` in place rather than duplicated (see `upsert_hook_command` in `init.rs`). Hook/shell-integration commands go through `entire gossamer ...` rather than calling the `entire-gossamer` binary by name directly, because Entire's managed plugin directory is only on `$PATH` inside `entire`'s own subprocess dispatch — not necessarily in the shell a git hook or Claude Code hook runs in.
5. Installs a `gr` shell function in `~/.zshrc` or `~/.bash_profile` for interactive `cd`.
6. Inserts the repo into the `repositories` table.

**Requires:** a git repo with an `origin` remote. Safe to run multiple times (idempotent).

### `entire gossamer repo` (default command)

Interactive TUI listing all tracked repositories. From the repo list you can:
- `space` / `→` — drill into a repo's sessions and worktrees
- `s` — open the launch wizard (agent picker → optional branch → name → prompt)
- `c` — `cd` to the repo (only when invoked via the `gr` shell wrapper)
- `/` — semantic search

From the sessions sub-screen:
- `space` / `→` — view session transcript (`entire gossamer show`)
- `r` — resume session
- `n` — create a new git worktree
- `s` — launch wizard

`--json` output: `{ "repos": [ { "name", "directory", "remote", "worktrees": [...], "sessions": [...] } ] }`

### `entire gossamer sessions [--all]`

Lists sessions from the past 3 days (or all with `--all`). Sources:
1. The `sessions` table in the gossamer DB (sessions ingested from checkpoint branch).
2. JSONL files in `~/.claude/projects/**/*.jsonl` (live Claude Code sessions not yet ingested).

Sessions from the current repo are shown first, then by recency. Interactive TUI with same keybindings as above.

`--json` output: `{ "sessions": [ { "session_id", "session_name", "cwd", "branch", "agent", "updated_at", "backed_up" } ] }`

### `entire gossamer ingest [--json] [--incremental]`

Ingests all tracked repos' `entire/checkpoints/v1` branches into the local DB — the layer that gives gossamer a locally browsable view of checkpoints (entire itself only exposes raw transcript bytes via `entire session info --transcript`, not a normalized structure).

Without `--incremental`, does a full re-ingest. For each repo:
1. Optionally fetches the branch from a remote checkpoint URL (from `.entire/settings.json`).
2. Runs `git ls-tree -r --name-only entire/checkpoints/v1` to find `metadata.json` files at paths matching `<x>/<session_id>/<number>/metadata.json`.
3. Parses each session's metadata and JSONL transcript via `parsers::dispatch_session`, upserts into the `sessions` table.
4. Ingests session names, repo info, and session transcripts into the witchcraft search DB via `ingest::ingest_checkpoint_sessions`.
5. Embeds and indexes if witchcraft assets are configured.

Both the `sessions`-table parse (step 3) and the search-DB chunking (step 4) dispatch per-session on `metadata.json`'s `agent` field: Claude Code gets its own bespoke, tuned parser (`parsers::claude_code` / `ingest::claude_code`); everything else (Codex today) goes through an agent-agnostic parser (`parsers::generic` / `ingest::generic`, built on `scraper::scan`) that recognizes user/assistant turns and tool calls by structural signal — a `role` field, known `type` synonyms, `text`/`message`/`content` keys — rather than a bespoke struct per format. Shadow branches (no `metadata.json`) instead sniff the JSONL's own shape (`scraper::looks_like_claude_shape`) to pick a parser.

`--json` output: `{ "sessions_indexed", "log_turns", "session_names", "repos" }`

With `--incremental`, only processes commits on `entire/checkpoints/v1` since the last ingest (stored as `last_indexed_commit` on the repository row) — faster, and what the post-commit hook could use for day-to-day runs (currently it runs a full ingest; see `init.rs`).

### `entire gossamer show <session-id-or-path>`

Interactive TUI for reading a session transcript. Accepts a session UUID (looked up in DB and `~/.claude/projects/`) or a direct path to a JSONL file. Renders assistant messages as Markdown via `termimad`. Arrow keys navigate turns.

`parse()` dispatches on the session's `agent_name` the same way `parsers::dispatch_session` does: Claude Code's per-line JSONL walk for Claude sessions, `scraper::scan` for everything else. Both paths build the same `Card` list (Header/UserMsg/AsstMsg/ToolRound/...) and share the same post-processing pipeline (merging consecutive assistant turns, splitting tool calls into interactive `ToolRound` cards), so tool calls render identically regardless of agent.

### `entire gossamer search <query...> [-n <top_k>]`

Semantic search using witchcraft. Requires witchcraft assets to be configured (`entire gossamer assets <path>` or `$WARP_ASSETS`). Returns hits grouped by session, with excerpts showing context around the matched turn.

`--json` output: `{ "query", "results": [ { "kind", "session_id", "session_name", "dir", "agent", "hits": [...] } ] }`

### `entire gossamer launch [-a agent] [-b branch] [-n name] [prompt]`

Launches an AI agent (default: `claude`). If `-b` is given, creates a new git worktree on that branch first — entire has no worktree concept, so this is what makes "start fresh on a new branch" possible. If `-n` is given, writes the name to `~/.gossamer/pending_session_name` so the `session-start` hook can pick it up. The prompt is copied to the clipboard via `pbcopy`. Uses `exec()` to replace the process with the agent.

### `entire gossamer resume <session-id>`

Resumes a session. Looks up the session's `cwd` and git branch from the DB or JSONL file, creates a worktree if needed, and launches the agent in the correct directory. Prefers a direct `claude --resume <id>` when the session's cwd/branch can be resolved locally; falls back to shelling out to `entire session resume <branch>` (which resolves the session but doesn't launch or manage worktrees itself — that's what `resume.rs`/`show::resume_via_entire` add) and `exec()`-ing the command it prints.

### `entire gossamer clean <session-id> [--json]`

Deletes a session:
1. Runs `entire clean <session-id>` (non-fatal if it fails).
2. Deletes from the `sessions` and `event_log` tables.
3. Deletes from the witchcraft search DB.

Accepts a session UUID, a session name, or a custom title (scanned from JSONL files).

### `entire gossamer attach <session-id> [-a agent] [-f]`

Attaches an existing session to entireio via `entire attach`, then indexes it.

### `entire gossamer assets [<assets-path>]`

Shows or sets the witchcraft assets directory path. Stored in `~/.gossamer/warp_assets`.

### `entire gossamer session-start` (hidden)

Called by the Claude Code `SessionStart` hook. Reads JSON from stdin: `{ "session_id": "...", "cwd": "..." }`. Inserts the session into the DB. If `~/.gossamer/pending_session_name` exists, uses it as the session name and deletes the file.

### `entire gossamer session-stop` (hidden)

Called by the Claude Code `Stop` hook. Reads JSON from stdin. Ingests the finished session into the witchcraft search DB and re-embeds if assets are configured. Non-fatal on all errors.

## Database Schema

Located at `~/.gossamer/gossamer.db` (SQLite).

```sql
repositories (
    id INTEGER PRIMARY KEY,
    directory TEXT UNIQUE,   -- absolute path to repo root
    remote TEXT,             -- git remote URL
    name TEXT,               -- derived from remote (last path segment, no .git)
    last_indexed_commit TEXT, -- HEAD of entire/checkpoints/v1 at last full ingest
    last_search_commit TEXT   -- HEAD at last search DB index (used by incremental ingest)
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

**entireio** (`entire`) is an external tool that checkpoints AI coding sessions to a git branch. Gossamer wraps it in several ways, and is complementary to entire's own session/checkpoint commands rather than a replacement for them — entire has no worktree concept and its own transcript access (`entire session info --transcript`) is raw bytes, not a normalized, locally browsable view.

| entireio command | When gossamer calls it |
|---|---|
| `entire configure [flags]` | During `entire gossamer init` wizard (skipped if `.entire/settings.json` exists) |
| `entire agent add <agent>` | During `entire gossamer init` wizard, for each selected agent |
| `entire clean <session-id>` | During `entire gossamer clean` (non-fatal) |
| `entire attach <session-id>` | During `entire gossamer attach` |
| `entire session resume <branch>` | Fallback path in `entire gossamer resume` when a direct `claude --resume` can't be resolved locally |

The checkpoint branch `entire/checkpoints/v1` has the following tree structure:

```
<prefix>/<session-uuid>/<checkpoint-number>/metadata.json
<prefix>/<session-uuid>/<checkpoint-number>/full.jsonl
```

Where `metadata.json` contains `{ session_id, agent, created_at, summary: { intent } }` and `full.jsonl` is the full conversation transcript in Claude Code JSONL format.

Gossamer identifies metadata files by the rule: path has exactly 3 `/` characters and the third path segment is all digits (see `is_meta_path` in `commands/index.rs`).

In addition to the checkpoint branch, entireio also keeps **shadow branches** of the form `entire/<short-hash>-<short-id>` (one per active worktree/session). These commit on every prompt, well ahead of the periodic checkpoint commits. Each shadow branch carries the full working tree plus `.entire/metadata/<session-uuid>/full.jsonl` and `prompt.txt`. There is no `metadata.json` on shadow branches — gossamer derives `created_at`, `cwd`, `session_name`, etc. directly from the JSONL (see `parse_shadow_session` / `index_shadow_branches` in `commands/index.rs`). Shadow branches are swept on every `entire gossamer ingest` (with or without `--incremental`), even when the checkpoint head is unchanged, so in-progress sessions appear with up-to-date `updated_at`.

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

The witchcraft assets path (model weights, tokenizer) must be configured via `entire gossamer assets <path>` or the `$WARP_ASSETS` environment variable. Semantic search is optional; all other commands work without it.

## Development Workflow

```bash
# Build and reinstall after any source change
cargo build --release
entire plugin install ./target/release/entire-gossamer --force

# Run all integration tests (build + run, no pre-installed binary needed)
cargo test --test integration_test

# Run a specific test
cargo test --test integration_test test_index_with_checkpoint_branch
```

Integration tests in `tests/integration_test.rs` create isolated `TempDir` instances for both `HOME` and the git repo, so they never touch the real gossamer DB or Claude settings. The binary under test is located via `env!("CARGO_BIN_EXE_entire-gossamer")` (the `[[bin]] name = "entire-gossamer"` target in `Cargo.toml`, while the crate/package itself is still named `gossamer`) — Cargo builds it automatically before running tests, and tests invoke it directly rather than through `entire`.

## Key Invariants

- `entire gossamer init` must be run inside a git repo that has an `origin` remote configured.
- All TUI commands fall back to plain text or JSON output when stdout is not a terminal (`--json` flag or piped output).
- The `entire/checkpoints/v1` branch is never written by gossamer — it is read-only from gossamer's perspective.
- `session-start` and `session-stop` are designed to be called by Claude Code hooks; they swallow errors to avoid interrupting the agent workflow.
- The gossamer DB path and witchcraft search DB path both respect the `HOME` environment variable, making it straightforward to test in isolation.
- The plugin binary must be named exactly `entire-gossamer` — Entire discovers plugins by the `entire-<name>` filename convention, not by `entire-plugin.yml` alone (that file is metadata only).
