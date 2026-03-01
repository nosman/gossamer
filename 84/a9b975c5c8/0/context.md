# Session Context

## User Prompts

### Prompt 1

Implement the following plan:

# Plan: React Native App + Local API Server

## Context
Sessions and events live in SQLite (`~/.claude/hook-handler.db`). Instead of generating static
markdown files, add a live Expo web app that displays active sessions and their events, fed by
a local Express + WebSocket server added as a `claude-hook-handler serve` subcommand.

---

## Architecture
```
claude-hook-handler serve --db ~/.claude/hook-handler.db --port 3000
        ↓ HTTP + WebSocket (localhost:3...

### Prompt 2

`cd app && npm install && npx expo start --web`

### Prompt 3

open http://localhost:19006

