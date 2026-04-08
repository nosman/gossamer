#!/usr/bin/env node
import { realpathSync } from "fs";
import { basename } from "path";
import { startServer } from "./server.js";
import { readConfig, defaultDbPath, DEFAULT_PORT } from "./config.js";

const args = process.argv.slice(2);
const get = (flag: string, def: string): string => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};

const tryRealpath = (p: string): string => { try { return realpathSync(p); } catch { return p; } };

const repoDir     = tryRealpath(get("--repo-dir", process.cwd()));

// Resolve port: CLI flag > config file > default
const config      = readConfig();
const port        = parseInt(get("--port", String(config.port ?? DEFAULT_PORT)), 10);

// Resolve dbPath: if repoDir matches a config entry (after resolving symlinks) use its dbPath.
// For new repos, derive a per-repo DB path (~/.gossamer/repos/<name>.db) instead of sharing
// a single database across all repos.
const repoEntry = config.repos.find((r) => tryRealpath(r.localPath) === repoDir);
const dbPath    = repoEntry?.dbPath ?? get("--db", defaultDbPath(basename(repoDir)));

await startServer(dbPath, port, repoDir);
