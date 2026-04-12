# Gossamer

**Never lose the context behind your code again.**

Gossamer is a VS Code extension that gives you a real-time control panel for your [Claude Code](https://claude.ai/claude-code) sessions. It indexes, searches, and backs up every AI session you've ever run — so the thinking, the decisions, the rabbit holes, the breakthroughs — all of it is preserved and searchable forever.

Because Gossamer integrates with **[Entire.io](https://entire.io)**, your AI sessions are linked directly to your Git commits. Every line of code has a story. Now you can actually read it.

---

## Installation

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nosman.gossamer-vscode), or search for **Gossamer** in the VS Code Extensions panel.

---

## Requirements

- [Node.js](https://nodejs.org) v18+
- [Entire CLI](https://entire.io) — Gossamer will prompt you to install and configure it if needed
- VS Code 1.85+

---

## Getting started

### 1. Open a workspace in VS Code

Install the extension and open any folder. If Entire isn't set up yet, Gossamer detects this and shows a setup screen that walks you through two steps:

1. **Install Entire** — click the button to open a terminal with `brew install entireio/tap/entire` pre-typed, then press Enter to run it
2. **Enable Entire in your project** — click the button to open a terminal with `entire configure` pre-typed in your workspace folder, then press Enter

Gossamer watches for the configuration to appear and transitions to the main panel automatically once both steps are done.

### 2. That's it

Repos are registered automatically on first open. A local server starts in the background, indexes your session history, and begins live-updating as you work.

---

## Main experiences

### Sessions table

The main panel shows all your Claude Code sessions across every registered repo. Each row shows:

- **Name** — session slug or ID, with a live badge for currently active sessions
- **Branch** — the Git branch the session ran on
- **Repo** — which repo the session belongs to
- **Updated** — last activity time (relative)
- **User** — the Git user who ran the session
- **Intent** — auto-generated summary of what the session was about
- **Parent** — parent session ID for sub-agent chains
- **Started** — when the session began

All columns except Name, Intent, and Parent are sortable by clicking the header. The table live-updates via WebSocket as sessions change. Use the **Archived** toggle to view archived sessions, or **Sync** to re-index from Git.

### Session detail

Click any session to open a full conversation view. Shows the complete chat history with:

- Full markdown rendering, including code blocks and images
- Tool use groups (file reads, writes, bash commands, etc.) collapsed by default — click to expand
- Checkpoint timeline on the right — each checkpoint links to a per-file diff showing exactly what changed at that turn
- A **Resume** button that opens an embedded terminal and starts a new Claude Code session continuing from this one

### Checkpoints sidebar

The activity bar on the left has a **Gossamer** panel showing a checkpoint tree for the current workspace. Each checkpoint corresponds to one turn of a session and shows:

- The branch the checkpoint was made on
- The commit hash
- A summary of what changed

Right-click a checkpoint to:
- **Show Checkpoint Diff** — opens a native VS Code diff for any changed file
- **Rewind to Checkpoint** — runs `entire rewind <id>` in a terminal, restoring your working tree to that point
- **Copy Checkpoint ID** / **Copy Commit Hash**

---

## Command palette

| Command | Description | Keybinding |
|---------|-------------|------------|
| `Gossamer: Open Session Viewer` | Open the main sessions panel | — |
| `Gossamer: Toggle Panel` | Show or minimize the sessions panel | `Ctrl+K G` |
| `Gossamer: Search Sessions` | Full-text search across all sessions | `Cmd+Shift+F` (when panel is active) |
| `Gossamer: Focus Checkpoints Sidebar` | Focus the checkpoints activity bar view | `Ctrl+K Ctrl+G` |
| `Gossamer: Restart Server` | Kill and restart the background server | — |
| `Gossamer: Show Checkpoint Diff` | Open a VS Code diff for a checkpoint file | — |
| `Rewind to Checkpoint` | Restore working tree to a checkpoint (context menu) | — |
| `Copy Checkpoint ID` | Copy checkpoint ID to clipboard (context menu) | — |
| `Copy Commit Hash` | Copy commit hash to clipboard (context menu) | — |

---

## MCP server

Gossamer's backend also exposes an MCP server at `http://localhost:3456/mcp`, letting Claude Code query your session history directly during a conversation.

Available tools: `search`, `list_sessions`, `get_session`, `list_repos`, `list_branch_checkpoints`, `list_session_checkpoints`, `get_checkpoint_diff`.

Run `npm run install-mcp` (from the Gossamer repo) to wire it up automatically.

---

## Your data, your machine

No telemetry, no cloud sync, no third-party storage. Everything stays local.

- **Config** at `~/.gossamer/config.json` — created automatically on first open
- **SQLite database** — one per repo at `~/.gossamer/repos/<name>.db`
- **Session history** in your local Git repo — push to your own remote to back it up
- **Server is local** — runs on `localhost`, never opens an external connection

---

Built for developers who care about the work behind the work.
