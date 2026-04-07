# Gossamer

**Never lose the context behind your code again.**

Gossamer is a desktop control panel for your Claude Code sessions. It indexes, searches, and backs up every AI session you've ever run — so the thinking, the decisions, the rabbit holes, the breakthroughs — all of it is preserved and searchable forever.

And because Gossamer integrates with **[Entire.io](https://entire.io)**, your AI sessions are linked directly to your Git commits. Every line of code has a story. Now you can actually read it.

---

## What it does

- **Index** every Claude Code session automatically as you work
- **Search** across all your sessions — find that conversation where you figured out the auth bug three months ago
- **Back up** sessions so nothing is ever lost, even across machines
- **Link sessions to commits** via Entire.io — click any commit and see the full AI conversation behind it
- **Browse checkpoints** — step through the evolution of a session with diffs and context at every turn
- **Resume sessions** — jump back into past conversations right where you left off
- **MCP server** — query your session history directly from Claude Code or any MCP-compatible AI tool

---

## Requirements

- [Node.js](https://nodejs.org) v18+
- [Entire CLI](https://entire.io) installed and configured in your repo
- VS Code 1.85+

---

## Installation

Build and install the VS Code extension locally:

```bash
# Install dependencies and build everything
npm install
./scripts/package-vsix.sh

# Install into VS Code
code --install-extension gossamer.vsix
```

---

## Getting started

### 1. Install the Entire CLI

```bash
brew install entire/tap/entire
```

Then enable it inside any repo you want Gossamer to track:

```bash
cd your-project
entire configure
```

This sets up session capture and links your AI sessions to Git commits.

### 2. Open a workspace in VS Code

Open any folder with Entire configured. Gossamer activates automatically and the session browser opens in column 2. If Entire isn't detected, Gossamer walks you through the setup.

### 3. That's it

Repos are registered automatically on first open. The server starts in the background, indexes your session history, and begins live-updating as you work.

---

## VS Code extension

The VS Code extension is the primary interface. Open any workspace with Entire configured — Gossamer activates automatically.

Features:
- Session list with live updates, search (`Cmd+Shift+F`), and new session spawning
- Per-session conversation view with checkpoint timeline and full markdown + image rendering
- Checkpoint tree in the activity bar: file diffs, `summary.txt` per checkpoint, rewind command
- Resume any session in an embedded terminal

---

## MCP server

Gossamer's backend exposes an MCP server at `http://localhost:3456/mcp` (same port as the HTTP API). This lets Claude Code — or any MCP-compatible tool — query your session history directly during a conversation.

### Available tools

| Tool | Description |
|------|-------------|
| `search` | Full-text search across all session chat history |
| `list_sessions` | List sessions by recency; filter to active-only |
| `get_session` | Full session detail including conversation events |
| `list_repos` | Registered repos with current branch and latest checkpoint |
| `list_branch_checkpoints` | Checkpoints on a branch, parsed from git history |
| `list_session_checkpoints` | Checkpoints within a specific session |
| `get_checkpoint_diff` | Unified diff for a checkpoint, optionally filtered to a file |

### Setup

Run the install script once after setup. It reads the port from `~/.gossamer/config.json` and writes the MCP entry into your AI tool config files automatically:

```bash
npm run install-mcp
```

This updates:
- **Claude Code** → `~/.claude.json`
- **Codex CLI** → `~/.codex/config.yaml` (if present)

To preview what it will do without writing anything:

```bash
node scripts/install-mcp.mjs --dry-run
```

Re-run any time you change the port in `~/.gossamer/config.json`.

### Changing the port

The default port is `3456`. To use a different port, add it to `~/.gossamer/config.json`:

```json
{
  "port": 4000,
  "repos": [...]
}
```

Then re-run `npm run install-mcp` to update your MCP config.

### Manual configuration

If you prefer to configure your tool manually, add this to its MCP servers config:

```json
{
  "mcpServers": {
    "gossamer": {
      "type": "http",
      "url": "http://localhost:3456/mcp"
    }
  }
}
```

---

## Architecture

Gossamer has two components:

| Component | What it does |
|-----------|-------------|
| **Server** (`src/serve.ts`) | Node.js + Express + WebSocket server. Indexes sessions from disk, syncs with Entire.io, and serves a real-time API on `localhost:3456`. Also hosts the MCP server at `/mcp`. |
| **VS Code extension** (`packages/vscode/`) | Primary UI — session browser, checkpoint tree, diffs, search, and terminal integration. Starts the server as a child process. |

The extension starts the server automatically when a workspace is opened. Run the server standalone with `npm run serve`.

---

## How the Entire.io integration works

Gossamer uses the Entire CLI to associate your Claude Code sessions with the Git commits they produced. When you make a commit while Claude Code is active, Entire captures the link between the session and the commit hash.

From Gossamer you can:
- See which session produced which commit
- Open a commit and read the full AI conversation that led to it
- Never wonder "why did we write it this way?" again

Make sure the Entire CLI is installed and you're logged in before starting Gossamer.

---

## Your data, your machine

Gossamer is built on a simple principle: your AI sessions are yours. No telemetry, no cloud sync, no third-party storage. Everything stays local by default.

- **Configuration** lives at `~/.gossamer/config.json`. It is created automatically the first time you open a repo in Gossamer, and stores the list of registered repos, their database paths, and the server port. You can edit it by hand.
- **SQLite database** — each repo gets its own database at `~/.gossamer/repos/<name>.db` (where `<name>` is the repo's folder name). Readable with any SQLite tool, deletable whenever you want.
- **Git worktree** — Gossamer creates a `.gossamer/checkpoints/` directory inside each repo root. This is a git worktree used to read the `entire/checkpoints/v1` branch without switching branches. Add `.gossamer/` to your `.gitignore` to keep it out of `git status`.
- **Session history** is stored in your local Git repository. Push it to your own remote to back it up or share it across machines — on your terms, using infrastructure you already control.
- **The server is local.** Gossamer's backend runs on `localhost` and never opens an external connection.

You decide what gets backed up, who has access, and when it gets deleted. Gossamer never touches your data without you.

---

## Development

```bash
# Install dependencies
npm install

# Build core + server
npm run build

# Build the VS Code extension (TypeScript) + webview (React/Vite)
npm run build -w packages/vscode

# Watch mode for the extension only (rebuilds on save)
npm run watch -w packages/vscode

# Package as a .vsix for local installation
./scripts/package-vsix.sh
code --install-extension gossamer.vsix

# Run the server standalone
npm run serve

# Database UI (Prisma Studio)
npm run db:studio
```

The server runs on port `3456` by default (configurable in `~/.gossamer/config.json`). The MCP endpoint is at `http://localhost:3456/mcp`.

---

## Coming soon

- Team sharing — share session history with your whole org

---

Built for developers who care about the work behind the work.
