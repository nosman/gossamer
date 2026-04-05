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
- [Entire CLI](https://entire.io) installed
- Claude Code installed and configured

---

## Installation

```bash
brew tap nosman/gossamer
brew install --cask gossamer
```

Then open **Gossamer.app** from your Applications folder.

> **If macOS says the app is damaged**, run `xattr -cr /Applications/Gossamer.app` and try again. This is a Gatekeeper restriction on unsigned apps.

---

## Getting started

### 1. Install the Entire CLI and enable it in your repo

Install the [Entire CLI](https://entire.io), then run the following inside any repo you want Gossamer to track:

```bash
entire enable
```

This hooks into your Git workflow so Gossamer can link AI sessions to commits.

### 2. Open Gossamer

Launch **Gossamer.app** from your Applications folder, or open the **VS Code extension** from the Gossamer icon in the activity bar. Either starts the backend server automatically.

### 3. Add your repo

Gossamer will detect repos with Entire enabled and register them automatically. You can also add a repo manually from the Repos tab (desktop app) or by opening any workspace folder in VS Code with Entire enabled.

---

## VS Code extension

The VS Code extension is the primary interface for most workflows. Install it from the `packages/vscode` directory and open any workspace with Entire enabled — Gossamer opens automatically.

Features available in the extension:
- Session list with live updates, search (`Cmd+Shift+F`), and new session spawning
- Per-session conversation view with checkpoint timeline
- Native checkpoint tree in the activity bar sidebar with file diffs
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

Gossamer has three components:

| Component | What it does |
|-----------|-------------|
| **Server** (`src/serve.ts`) | Node.js + Express + WebSocket server. Indexes Claude Code sessions from disk, syncs with Entire.io, and serves a real-time API on `localhost:3456`. Also hosts the MCP server at `/mcp`. |
| **VS Code extension** (`packages/vscode/`) | Primary UI — session browser, checkpoint tree, diffs, search, and terminal integration. Starts the server as a child process. |
| **Desktop app** (`app/`) | Electron app built with React + Mantine. Alternative to the VS Code extension. |

Both the desktop app and VS Code extension start the server automatically. Run the server standalone with `npm run serve`.

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

- **Search index and database** are stored in a single SQLite file per repo at `~/.gossamer/<YOUR_REPO>.db` — on your machine, readable with any SQLite tool, deletable whenever you want.
- **Session history** is stored in your local Git repository. Push it to your own remote to back it up or share it across machines — on your terms, using infrastructure you already control.
- **The server is local.** Gossamer's backend runs on `localhost` and never opens an external connection. The Electron app talks only to that local server.

You decide what gets backed up, who has access, and when it gets deleted. Gossamer never touches your data without you.

---

## Development

```bash
# Build everything
npm run build

# Server only
npm run serve

# VS Code extension (watch mode)
cd packages/vscode && npm run watch

# Desktop app (Electron + Vite HMR)
cd app && npm run dev

# Database UI
npm run db:studio
```

The server runs on port `3456` by default (configurable in `~/.gossamer/config.json`). The MCP endpoint is at `http://localhost:3456/mcp`.

---

## Coming soon

- Team sharing — share session history with your whole org

---

Built for developers who care about the work behind the work.
