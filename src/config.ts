import { readFileSync, writeFileSync, mkdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface RepoConfig {
  name: string;
  remote: string;
  localPath: string;
  dbPath: string;
  checkpointRemote?: string;
}

export const DEFAULT_PORT = 3456;

export interface GossamerConfig {
  repos: RepoConfig[];
  port?: number;
}

const CONFIG_DIR  = join(homedir(), ".gossamer");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export function getConfigPath(): string {
  return CONFIG_PATH;
}

// readConfig() is on the hot path of every API request (findRepoForPath, dbForRepo, …)
// — a fresh fs.readFileSync + JSON.parse per call adds up fast. Cache by mtime: if the
// file hasn't been touched since the last read, return the cached parse.
let cachedConfig: GossamerConfig | null = null;
let cachedMtimeMs = -1;

export function readConfig(): GossamerConfig {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(CONFIG_PATH).mtimeMs;
  } catch {
    // File missing — return empty config and remember that.
    if (cachedConfig && cachedMtimeMs === -1) return cachedConfig;
    cachedConfig = { repos: [] };
    cachedMtimeMs = -1;
    return cachedConfig;
  }
  if (cachedConfig && cachedMtimeMs === mtimeMs) return cachedConfig;
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  cachedConfig = JSON.parse(raw) as GossamerConfig;
  cachedMtimeMs = mtimeMs;
  return cachedConfig;
}

export function writeConfig(config: GossamerConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  // Refresh cache immediately so the next reader doesn't race the mtime check.
  cachedConfig = config;
  try { cachedMtimeMs = statSync(CONFIG_PATH).mtimeMs; } catch { cachedMtimeMs = -1; }
}

export function addRepo(repo: RepoConfig): void {
  const config = readConfig();
  const existing = config.repos.findIndex((r) => r.localPath === repo.localPath);
  if (existing >= 0) {
    config.repos[existing] = repo;
  } else {
    config.repos.push(repo);
  }
  writeConfig(config);
}

export function removeRepo(localPath: string): void {
  const config = readConfig();
  config.repos = config.repos.filter((r) => r.localPath !== localPath);
  writeConfig(config);
}

export function findRepo(localPath: string): RepoConfig | undefined {
  return readConfig().repos.find((r) => r.localPath === localPath);
}

/** Find a repo whose localPath is an ancestor of (or exact match for) the given path. */
export function findRepoForPath(fsPath: string): RepoConfig | undefined {
  const config = readConfig();
  const exact = config.repos.find((r) => r.localPath === fsPath);
  if (exact) return exact;
  return config.repos.find((r) => {
    const prefix = r.localPath.endsWith("/") ? r.localPath : r.localPath + "/";
    return fsPath.startsWith(prefix);
  });
}

/** Derive a default DB path for a new repo: ~/.gossamer/repos/<name>.db */
export function defaultDbPath(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(CONFIG_DIR, "repos", `${safe}.db`);
}

/** Path to the bare checkpoint repo clone: ~/.gossamer/checkpoint-repos/<safe-name>.git */
export function checkpointRepoPath(repoName: string): string {
  const safe = repoName.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(CONFIG_DIR, "checkpoint-repos", `${safe}.git`);
}

/** Path to the checkpoint-branch worktree: ~/.gossamer/checkpoints/<safe-name> */
export function checkpointWorktreePath(repoName: string): string {
  const safe = repoName.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(CONFIG_DIR, "checkpoints", safe);
}
