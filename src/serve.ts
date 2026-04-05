#!/usr/bin/env node
import { realpathSync } from "fs";
import { startServer } from "./server.js";
import { readConfig, DEFAULT_PORT } from "./config.js";

const args = process.argv.slice(2);
const get = (flag: string, def: string): string => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};

const tryRealpath = (p: string): string => { try { return realpathSync(p); } catch { return p; } };

const defaultDb   = `${process.env.HOME ?? "~"}/.claude/hook-handler.db`;
const repoDir     = tryRealpath(get("--repo-dir", process.cwd()));

// Resolve port: CLI flag > config file > default
const config      = readConfig();
const port        = parseInt(get("--port", String(config.port ?? DEFAULT_PORT)), 10);

// Resolve dbPath: if repoDir matches a config entry (after resolving symlinks) use its dbPath
const repoEntry = config.repos.find((r) => tryRealpath(r.localPath) === repoDir);
const dbPath    = repoEntry?.dbPath ?? get("--db", defaultDb);

await startServer(dbPath, port, repoDir);
