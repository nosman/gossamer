# Gossamer — Project Guide for Claude

## What is Gossamer?

Gossamer is a **VS Code extension** that provides a real-time session browser for [Claude Code](https://claude.ai/claude-code) sessions indexed by the [Entire.io CLI](https://entire.io). It shows active and historical sessions, checkpoints (file-level diffs per turn), and chat history with full markdown and image support.

> **Entire.io is a hard dependency.** Gossamer reads from two git branches that the Entire CLI writes to:
> - `entire/checkpoints/v1` — indexed checkpoint data (transcripts, metadata, file diffs)
> - `entire/shadow/<session-id>` — live session data written while Claude Code is running

## Repository Layout

```
gossamer/
├── packages/
│   ├── core/                  # Shared indexing logic (npm workspace: @gossamer/core)
│   │   ├── src/
│   │   │   ├── indexer.ts     # Reads entire/checkpoints/v1, writes to SQLite via Prisma
│   │   │   ├── db.ts          # Prisma client factory (per-repo DB path)
│   │   │   ├── gitUtils.ts    # Git helpers (read branches, file contents)
│   │   │   └── search.ts      # Full-text search over LogContent
│   │   └── prisma/
│   │       └── schema.prisma  # DB schema (CheckpointMetadata, LogEvent, LogContent, …)
│   └── vscode/                # VS Code extension (npm workspace: gossamer-vscode)
│       ├── src/
│       │   ├── extension.ts           # Activation entry point, command registration
│       │   ├── GossamerPanel.ts       # Main sessions webview panel + server lifecycle
│       │   ├── SessionDetailPanel.ts  # Per-session detail webview panel
│       │   ├── CheckpointTreeProvider.ts # Sidebar tree: branch history + checkpoints
│       │   ├── OnboardingPanel.ts     # First-run flow for new workspaces
│       │   └── diffUtils.ts           # Virtual doc provider for native VS Code diffs
│       └── src/webview/               # React app bundled by Vite (runs inside webviews)
│           ├── screens/
│           │   ├── ActiveSessions.tsx # Sessions table (main panel)
│           │   └── SessionDetail.tsx  # Chat history + tool use view
│           ├── components/
│           │   ├── SessionRow.tsx     # One row in the sessions table
│           │   ├── EventItem.tsx      # User/assistant/system event cards
│           │   ├── ToolGroupItem.tsx  # Collapsible tool-use groups
│           │   └── MarkdownView.tsx   # Markdown renderer
│           └── api.ts                 # fetch/WebSocket wrappers (talks to the server)
├── src/                       # Server-side Node.js (compiled to dist/)
│   ├── serve.ts               # CLI entry: resolves repo + DB, calls startServer()
│   ├── server.ts              # Express + WebSocket API server
│   ├── config.ts              # ~/.gossamer/config.json read/write helpers
│   ├── mcp-server.ts          # MCP server (search, checkpoints, sessions tools)
│   └── mcp.ts                 # MCP CLI entry point
└── scripts/
    └── install-mcp.mjs        # Writes gossamer MCP config into ~/.claude/claude.json
```

## Configuration: `~/.gossamer/config.json`

The top-level config lives at `~/.gossamer/config.json`. It is created automatically during onboarding.

```json
{
  "port": 3456,
  "repos": [
    {
      "name": "my-project",
      "localPath": "/Users/you/my-project",
      "remote": "git@github.com:you/my-project.git",
      "dbPath": "/Users/you/.gossamer/repos/my-project.db"
    }
  ]
}
```

**Each repo gets its own SQLite database** at the path in `dbPath` (default: `~/.gossamer/repos/<name>.db`). The Prisma schema in `packages/core/prisma/schema.prisma` defines the tables; push schema changes with:

```
npm run db:push -w packages/core
```

## The Two Main Components

### 1. Server (`src/server.ts` → `dist/server.js`)

An **Express + WebSocket** process that:
- Reads from the repo's SQLite DB (populated by the indexer)
- Serves a REST API (`GET /api/sessions`, `GET /api/v2/sessions/:id/log-events`, etc.)
- Broadcasts `sessions_updated` over WebSocket when new data arrives
- Polls the git shadow branch every 2 s for live session updates

The server is **spawned as a child process** by `GossamerPanel.ts` when the VS Code extension activates. It is kept alive as a static singleton so it survives the webview panel being closed/reopened (minimize/restore pattern). Kill and restart it with the **`Gossamer: Restart Server`** command.

Entry point for the server process: `dist/serve.js` (compiled from `src/serve.ts`).

### 2. Webview (`packages/vscode/src/webview/`)

A **React + Mantine** single-page app bundled by Vite into `dist/webview/assets/index.js`. It is injected into VS Code `WebviewPanel` instances by `GossamerPanel.ts` and `SessionDetailPanel.ts`.

The webview talks to the server over HTTP and WebSocket. The server port is injected at load time via `window.__GOSSAMER_PORT__`.

Key webview facts:
- `acquireVsCodeApi()` may only be called once — stored on `window.__vscodeApi` and accessed via `src/webview/vscodeApi.ts`
- UI uses **Mantine** exclusively — do not import from `primitives.tsx`
- Images in user/assistant messages are stored as base64 in `LogContent.imageData` and rendered as `<img src="data:…">` — the webview CSP must include `img-src data: https: http:`

## Build

```bash
# Build everything (core Prisma client + server TS + vscode extension + webview)
npm run build                        # builds core + root src/
npm run build -w packages/vscode     # builds extension JS + webview bundle

# Dev: watch mode for the extension only
npm run watch -w packages/vscode

# The extension is tested from the gossamer-testing git worktree (testing branch)
# so VS Code can load the built extension while the main repo is being edited
```

## Entire.io Integration

Gossamer only works in repos where Entire.io is enabled. Detection: check for `.entire/settings.json` in the workspace root.

The indexer (`packages/core/src/indexer.ts`) reads:
- `entire/checkpoints/v1` — checkpoint metadata and JSONL transcripts
- `entire/shadow/*` branches — live hook events written by the Entire CLI hooks

Shadow branch events are polled by the server and written to `ShadowSession` + `LogEvent` tables, enabling the real-time "live" badge and auto-scroll in the session detail view.

## MCP Server

A secondary process (`dist/mcp.js`) exposes Gossamer data as MCP tools (search, list checkpoints, list repos, active sessions). Configure it via `npm run install-mcp`, which writes the MCP entry into `~/.claude/claude.json` using the port from `~/.gossamer/config.json`.
