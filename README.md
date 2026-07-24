# gossamer

Gossamer is an [Entire](https://entire.io) (`entire`) CLI plugin for tracking AI coding sessions across your git repositories. It sits on top of entireio, which checkpoints AI agent conversations to a dedicated `entire/checkpoints/v1` git branch as you work. Gossamer ingests those checkpoints (plus live Claude Code session logs) into a local SQLite database, gives you an interactive terminal UI for browsing repos, worktrees, and past sessions, and layers semantic search on top via a local embedding/vector-search library (witchcraft) — so you can find "that session where I fixed the auth bug" without remembering which repo or day it happened. It also wires into Claude Code's hooks to auto-track sessions as they start and stop, and provides shell helpers (`gr`) and worktree-aware resume/launch commands so you can jump straight back into any tracked conversation.

Gossamer ships as the binary `entire-gossamer`, invoked as `entire gossamer ...` once installed (or directly as `entire-gossamer ...` — see [Install](#installation)). It complements entire's own session/checkpoint commands (`entire session ...`, `entire checkpoint ...`) rather than replacing them: entire has no concept of git worktrees and only exposes raw transcript bytes, so gossamer is the locally browsable catalog, worktree manager, and search layer built on top.

## Overview

### Repo browser (`entire gossamer repo`)

<!-- screenshot: docs/screenshots/repo.png -->

### Session transcript viewer (`entire gossamer show`)

<!-- screenshot: docs/screenshots/show.png -->

### Semantic search (`entire gossamer search`)

<!-- screenshot: docs/screenshots/search.png -->

## Installation

**Prerequisites:** the [Entire CLI](https://entire.io) · Git · a Rust toolchain.

**Dependency note:** gossamer depends on [witchcraft](https://github.com/dropbox/witchcraft) (public, but fetched via an `ssh://git@github.com/...` URL in `Cargo.toml`). You need a working SSH key registered with GitHub for the build's fetch step to succeed — no special access to the repo itself is required since it's public.

```bash
# 1. Build the plugin binary
git clone https://github.com/nosman/gossamer.git
cd gossamer
cargo build --release

# 2. Install it into Entire's managed plugin directory
entire plugin install ./target/release/entire-gossamer --force

# 3. Verify
entire gossamer --help
entire gossamer          # opens the repo browser TUI
```

Entire plugins are local executables, not a hosted marketplace: `entire gossamer` works because Entire finds an `entire-gossamer` binary in its managed plugin directory or on `$PATH`. `entire plugin install` symlinks the binary you point it at into that managed directory (`~/.local/share/entire/plugins/bin` on macOS/Linux by default); Entire itself prepends that directory to `$PATH` for the subprocesses it spawns, but your interactive shell won't see it unless you add it yourself. So `entire gossamer ...` is the reliable invocation from any shell; calling `entire-gossamer ...` directly also works, but only once that directory (or wherever else you installed the binary) is actually on your shell's `$PATH`.

If you're using the npm-packaged skill (installs the gossamer Claude Code skill into `~/.claude/plugins` — a separate, unrelated plugin system from Entire's):

```bash
npm install -g .
# or, after publishing:
npx gossamer-skill
```

## Commands

Every command that produces output supports a `--json` flag to print machine-readable JSON instead of launching the interactive TUI (useful for scripting or when stdout isn't a terminal).

### `entire gossamer init`

Registers the current git repository with gossamer.

```bash
cd ~/code/my-repo
entire gossamer init
```

What it does:
1. Reads `git remote get-url origin` to derive a repo name.
2. If `.entire/settings.json` doesn't exist and the `entire/checkpoints/v1` branch isn't present, runs an interactive wizard (`entire configure`, `entire agent add <agent>`) to set up checkpointing.
3. Installs a `post-commit` git hook that runs `entire gossamer ingest` after checkpoint commits.
4. Installs Claude Code `SessionStart`/`Stop` hooks (`~/.claude/settings.json`) pointing at `entire gossamer session-start` / `entire gossamer session-stop`.
5. Installs a `gr` shell function into `~/.zshrc` or `~/.bash_profile` so you can `cd` into a tracked repo.
6. Adds the repo to gossamer's database.

Requires a git repo with an `origin` remote. Safe to re-run — re-running after upgrading from a pre-plugin install also migrates any existing Claude Code hooks from the old `gossamer ...` commands to `entire gossamer ...` in place.

### `entire gossamer` / `entire gossamer repo`

The default command. Opens an interactive TUI listing every repo gossamer tracks.

```bash
entire gossamer
entire gossamer repo --json
```

Keybindings:
- `space` / `→` — drill into a repo's sessions and worktrees
- `s` — open the launch wizard (pick agent → optional branch → name → prompt)
- `c` — `cd` into the repo (only works when launched via the `gr` shell wrapper)
- `/` — jump into semantic search

Inside a repo's sessions view:
- `space` / `→` — view a session's transcript (same as `entire gossamer show`)
- `r` — resume the session
- `n` — create a new git worktree
- `s` — launch wizard

### `entire gossamer sessions [--all]`

Lists recent sessions (past 3 days by default) across all tracked repos, sourced from both the gossamer DB and live `~/.claude/projects/**/*.jsonl` files.

```bash
entire gossamer sessions
entire gossamer sessions --all
entire gossamer sessions --json
```

Current-repo sessions are shown first, then the rest by recency. Same keybindings as the sessions view in `entire gossamer repo`.

### `entire gossamer ingest [--incremental]`

Scans all tracked repos' `entire/checkpoints/v1` branches (and shadow branches for in-progress sessions) and ingests sessions into the local database — this is the layer that gives gossamer a locally browsable view of checkpoints, since entire itself only exposes raw transcript bytes.

```bash
entire gossamer ingest               # full re-ingest of every tracked repo
entire gossamer ingest --json
entire gossamer ingest --incremental # only checkpoint commits since the last ingest for each repo (faster, for day-to-day use)
entire gossamer ingest --incremental --json
```

For each repo, this fetches the checkpoint branch if a remote is configured, walks its tree for `metadata.json`/`full.jsonl` pairs, upserts sessions into the database, and re-embeds session content for search if witchcraft assets are configured. A full ingest runs automatically via the `post-commit` hook installed by `entire gossamer init`.

### `entire gossamer show <session-id-or-path>`

Opens an interactive transcript viewer for a session, rendering assistant messages as Markdown.

```bash
entire gossamer show 3f9c1a2e-...
entire gossamer show ~/.claude/projects/my-repo/3f9c1a2e-....jsonl
```

Accepts a session UUID (looked up in the DB or `~/.claude/projects/`) or a direct path to a JSONL transcript file. Use arrow keys to move between turns.

### `entire gossamer search <query...> [-n <top_k>]`

Semantic search across all indexed session transcripts.

```bash
entire gossamer search fix the login redirect bug
entire gossamer search "database migration" -n 5
entire gossamer search flaky test --json
```

Requires witchcraft assets to be configured (see `entire gossamer assets`). Results are grouped by session with excerpts showing the matched context. `-n` / `--top-k` controls how many results to return (default 10).

### `entire gossamer launch [-b <branch>] [-n <name>] [prompt]`

Launches an AI agent (Claude Code by default), optionally in a fresh git worktree — entire has no concept of worktrees, so this is what makes "start fresh on a new branch" possible at all.

```bash
entire gossamer launch
entire gossamer launch -b feature/new-auth -n "auth-rework" "Refactor the login flow to use JWTs"
```

If `-b` is given, creates a new worktree on that branch before launching. If `-n` is given, the session name is picked up by the `session-start` hook so it shows up named in `entire gossamer sessions`. Any prompt argument is also copied to your clipboard. This command replaces the current process with the agent.

### `entire gossamer resume <session-id>`

Resumes a previous session, recreating its worktree if needed.

```bash
entire gossamer resume 3f9c1a2e
```

Looks up the session's working directory and git branch (from the DB or its JSONL file), checks out or creates the matching worktree, and launches the agent there — falling back to `entire session resume <branch>` when it can't resolve the session from local Claude Code data directly. Accepts a full UUID or an unambiguous prefix.

### `entire gossamer clean <session-id>`

Deletes a session entirely.

```bash
entire gossamer clean 3f9c1a2e-...
entire gossamer clean "my session name" --json
```

Runs `entire clean <session-id>` (non-fatal if it fails), then removes the session from the `sessions`/`event_log` tables and from the witchcraft search index. Accepts a session UUID, a session name, or a custom title.

### `entire gossamer purge [--dry-run]`

Removes stale sessions from the database — ones that no longer exist in any checkpoint branch or `~/.claude/projects/` JSONL file.

```bash
entire gossamer purge --dry-run
entire gossamer purge
entire gossamer purge --json
```

Use `--dry-run` to preview what would be removed before actually deleting.

### `entire gossamer discover [--dry-run]`

Scans your Claude Code session history for git repos (with a GitHub remote) that aren't yet registered with gossamer, and registers them.

```bash
entire gossamer discover --dry-run
entire gossamer discover
```

Handy for backfilling gossamer's repo list from work you've already done without running `entire gossamer init` everywhere.

### `entire gossamer tidy [--dry-run] [--days <n>] [--force] [--sessions]`

Removes git worktrees that have had no recent session activity.

```bash
entire gossamer tidy --dry-run
entire gossamer tidy --days 14
entire gossamer tidy --force --sessions
```

- `--dry-run` — list stale worktrees without removing them
- `--days` — inactivity threshold before a worktree is considered stale (default 7)
- `--force` — pass `--force` to `git worktree remove`, removing worktrees with uncommitted changes
- `--sessions` — also delete sessions whose `cwd` was inside a removed worktree

### `entire gossamer attach <session-id> [-a <agent>] [-f]`

Attaches an existing (previously untracked) session to entireio and indexes it.

```bash
entire gossamer attach 3f9c1a2e-... -a claude-code
entire gossamer attach 3f9c1a2e-... --force
```

Runs `entire attach <session-id>` with the given agent name, then indexes the session into gossamer's database and search index. `-f`/`--force` is passed through to `entire attach`.

### `entire gossamer assets [<assets-path>]`

Shows or sets the witchcraft assets directory used for semantic search (model weights + tokenizer).

```bash
entire gossamer assets                      # show current path
entire gossamer assets ~/models/witchcraft  # set the path
```

Semantic search (`entire gossamer search`) is the only feature that depends on this; everything else works without it. You can also set the `WARP_ASSETS` environment variable instead.

## Development

```bash
# Build and reinstall after any source change
cargo build --release
entire plugin install ./target/release/entire-gossamer --force

# Run the integration test suite
cargo test --test integration_test

# Run a specific test
cargo test --test integration_test test_index_with_checkpoint_branch
```

Integration tests invoke the compiled `entire-gossamer` binary directly (not through `entire`) against isolated `HOME` and repo directories, so they never touch your real gossamer database or Claude Code settings.
