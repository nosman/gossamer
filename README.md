# gossamer

Gossamer is a CLI for tracking AI coding sessions across your git repositories. It sits on top of [entireio](https://entire.io) (`entire`), which checkpoints AI agent conversations to a dedicated `entire/checkpoints/v1` git branch as you work. Gossamer indexes those checkpoints (plus live Claude Code session logs) into a local SQLite database, gives you an interactive terminal UI for browsing repos, worktrees, and past sessions, and layers semantic search on top via a local embedding/vector-search library (witchcraft) — so you can find "that session where I fixed the auth bug" without remembering which repo or day it happened. It also wires into Claude Code's hooks to auto-track sessions as they start and stop, and provides shell helpers (`gr`) and worktree-aware resume/new-session commands so you can jump straight back into any tracked conversation.

## Overview

### Repo browser (`gossamer repo`)

<!-- screenshot: docs/screenshots/repo.png -->

### Session transcript viewer (`gossamer show`)

<!-- screenshot: docs/screenshots/show.png -->

### Semantic search (`gossamer search`)

<!-- screenshot: docs/screenshots/search.png -->

## Installation

**Prerequisite:** gossamer depends on [witchcraft](https://github.com/dropbox/witchcraft) (public, but fetched via an `ssh://git@github.com/...` URL in `Cargo.toml`). You need a working SSH key registered with GitHub for the `cargo install` fetch step to succeed — no special access to the repo itself is required since it's public.

```bash
# Build and install the gossamer binary
cargo install --path .
```

If you're using the npm-packaged skill (installs the gossamer Claude Code skill into `~/.claude/plugins`):

```bash
npm install -g .
# or, after publishing:
npx gossamer-skill
```

## Commands

Every command that produces output supports a `--json` flag to print machine-readable JSON instead of launching the interactive TUI (useful for scripting or when stdout isn't a terminal).

### `gossamer init`

Registers the current git repository with gossamer.

```bash
cd ~/code/my-repo
gossamer init
```

What it does:
1. Reads `git remote get-url origin` to derive a repo name.
2. If `.entire/settings.json` doesn't exist and the `entire/checkpoints/v1` branch isn't present, runs an interactive wizard (`entire configure`, `entire agent add <agent>`) to set up checkpointing.
3. Installs a `post-commit` git hook that runs `gossamer index` after checkpoint commits.
4. Installs Claude Code `SessionStart`/`Stop` hooks (`~/.claude/settings.json`) pointing at `gossamer session-start` / `gossamer session-stop`.
5. Installs a `gr` shell function into `~/.zshrc` or `~/.bash_profile` so you can `cd` into a tracked repo.
6. Adds the repo to gossamer's database.

Requires a git repo with an `origin` remote. Safe to re-run.

### `gossamer` / `gossamer repo`

The default command. Opens an interactive TUI listing every repo gossamer tracks.

```bash
gossamer
gossamer repo --json
```

Keybindings:
- `space` / `→` — drill into a repo's sessions and worktrees
- `s` — open the new-session wizard (pick agent → optional branch → name → prompt)
- `c` — `cd` into the repo (only works when launched via the `gr` shell wrapper)
- `/` — jump into semantic search

Inside a repo's sessions view:
- `space` / `→` — view a session's transcript (same as `gossamer show`)
- `r` — resume the session
- `n` — create a new git worktree
- `s` — new session wizard

### `gossamer sessions [--all]`

Lists recent sessions (past 3 days by default) across all tracked repos, sourced from both the gossamer DB and live `~/.claude/projects/**/*.jsonl` files.

```bash
gossamer sessions
gossamer sessions --all
gossamer sessions --json
```

Current-repo sessions are shown first, then the rest by recency. Same keybindings as the sessions view in `gossamer repo`.

### `gossamer index`

Full re-index of all tracked repos from their `entire/checkpoints/v1` branches (and shadow branches for in-progress sessions).

```bash
gossamer index
gossamer index --json
```

For each repo, this fetches the checkpoint branch if a remote is configured, walks its tree for `metadata.json`/`full.jsonl` pairs, upserts sessions into the database, and re-embeds session content for search if witchcraft assets are configured. This runs automatically via the `post-commit` hook installed by `gossamer init`.

### `gossamer refresh`

Incremental version of `index` — only processes checkpoint commits since the last indexed commit for each repo. Faster than a full `index` for day-to-day use.

```bash
gossamer refresh
gossamer refresh --json
```

### `gossamer show <session-id-or-path>`

Opens an interactive transcript viewer for a session, rendering assistant messages as Markdown.

```bash
gossamer show 3f9c1a2e-...
gossamer show ~/.claude/projects/my-repo/3f9c1a2e-....jsonl
```

Accepts a session UUID (looked up in the DB or `~/.claude/projects/`) or a direct path to a JSONL transcript file. Use arrow keys to move between turns.

### `gossamer search <query...> [-n <top_k>]`

Semantic search across all indexed session transcripts.

```bash
gossamer search fix the login redirect bug
gossamer search "database migration" -n 5
gossamer search flaky test --json
```

Requires witchcraft assets to be configured (see `gossamer config`). Results are grouped by session with excerpts showing the matched context. `-n` / `--top-k` controls how many results to return (default 10).

### `gossamer new-session [-b <branch>] [-n <name>] [prompt]`

Launches an AI agent (Claude Code by default), optionally in a fresh git worktree.

```bash
gossamer new-session
gossamer new-session -b feature/new-auth -n "auth-rework" "Refactor the login flow to use JWTs"
```

If `-b` is given, creates a new worktree on that branch before launching. If `-n` is given, the session name is picked up by the `session-start` hook so it shows up named in `gossamer sessions`. Any prompt argument is also copied to your clipboard. This command replaces the current process with the agent.

### `gossamer resume <session-id>`

Resumes a previous session, recreating its worktree if needed.

```bash
gossamer resume 3f9c1a2e
```

Looks up the session's working directory and git branch (from the DB or its JSONL file), checks out or creates the matching worktree, and launches the agent there. Accepts a full UUID or an unambiguous prefix.

### `gossamer clean <session-id>`

Deletes a session entirely.

```bash
gossamer clean 3f9c1a2e-...
gossamer clean "my session name" --json
```

Runs `entire clean <session-id>` (non-fatal if it fails), then removes the session from the `sessions`/`event_log` tables and from the witchcraft search index. Accepts a session UUID, a session name, or a custom title.

### `gossamer purge [--dry-run]`

Removes stale sessions from the database — ones that no longer exist in any checkpoint branch or `~/.claude/projects/` JSONL file.

```bash
gossamer purge --dry-run
gossamer purge
gossamer purge --json
```

Use `--dry-run` to preview what would be removed before actually deleting.

### `gossamer discover [--dry-run]`

Scans your Claude Code session history for git repos (with a GitHub remote) that aren't yet registered with gossamer, and registers them.

```bash
gossamer discover --dry-run
gossamer discover
```

Handy for backfilling gossamer's repo list from work you've already done without running `gossamer init` everywhere.

### `gossamer tidy [--dry-run] [--days <n>] [--force] [--sessions]`

Removes git worktrees that have had no recent session activity.

```bash
gossamer tidy --dry-run
gossamer tidy --days 14
gossamer tidy --force --sessions
```

- `--dry-run` — list stale worktrees without removing them
- `--days` — inactivity threshold before a worktree is considered stale (default 7)
- `--force` — pass `--force` to `git worktree remove`, removing worktrees with uncommitted changes
- `--sessions` — also delete sessions whose `cwd` was inside a removed worktree

### `gossamer attach <session-id> [-a <agent>] [-f]`

Attaches an existing (previously untracked) session to entireio and indexes it.

```bash
gossamer attach 3f9c1a2e-... -a claude-code
gossamer attach 3f9c1a2e-... --force
```

Runs `entire attach <session-id>` with the given agent name, then indexes the session into gossamer's database and search index. `-f`/`--force` is passed through to `entire attach`.

### `gossamer config [<assets-path>]`

Shows or sets the witchcraft assets directory used for semantic search (model weights + tokenizer).

```bash
gossamer config                      # show current path
gossamer config ~/models/witchcraft  # set the path
```

Semantic search (`gossamer search`) is the only feature that depends on this; everything else works without it. You can also set the `WARP_ASSETS` environment variable instead.

## Development

```bash
# Build and install after any source change
cargo install --path .

# Run the integration test suite
cargo test --test integration_test

# Run a specific test
cargo test --test integration_test test_index_with_checkpoint_branch
```

Integration tests run against isolated `HOME` and repo directories, so they never touch your real gossamer database or Claude Code settings.
