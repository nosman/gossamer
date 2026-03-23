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

---

## Getting started

### 1. Install the Entire CLI and enable it in your repo

Install the [Entire CLI](https://entire.io), then run the following inside any repo you want Gossamer to track:

```bash
entire enable
```

This hooks into your Git workflow so Gossamer can link AI sessions to commits.

### 2. Open Gossamer

Launch **Gossamer.app** from your Applications folder. The app starts its own backend server automatically.

### 3. Add your repo in the Repos tab

Open Gossamer, go to the **Repos** tab, and add the local path to the repo you ran `entire enable` in. Gossamer will start indexing your sessions immediately.

---

## Architecture

Gossamer has two components that run together:

| Component | What it does |
|-----------|-------------|
| **Server** (`src/serve.ts`) | Node.js + Express + WebSocket server. Indexes Claude Code sessions from disk, syncs with Entire.io, and serves a real-time API on `localhost:3000`. |
| **App** (`app/`) | Electron desktop app built with React + Mantine. Connects to the local server and renders your session history, search, checkpoints, and diffs. |

Both start with `npm start`.

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

To work on the server and app separately:

```bash
# Server only (hot-reloads with tsc --watch)
npm run serve

# App only (Electron + Vite HMR)
cd app && npm run dev
```

Database UI:

```bash
npm run db:studio
```

---

## Coming soon

- Team sharing — share session history with your whole org

---

Built for developers who care about the work behind the work.
