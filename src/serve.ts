#!/usr/bin/env node
import { startServer } from "./server.js";

const args = process.argv.slice(2);
const get = (flag: string, def: string): string => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};

const defaultDb = `${process.env.HOME ?? "~"}/.claude/hook-handler.db`;
const dbPath  = get("--db",       defaultDb);
const port    = parseInt(get("--port",    "3000"), 10);
const repoDir = get("--repo-dir", process.cwd());

await startServer(dbPath, port, repoDir);
