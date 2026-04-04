import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface RepoConfig {
  name: string;
  remote: string;
  localPath: string;
  dbPath: string;
}

export interface GossamerConfig {
  repos: RepoConfig[];
}

const CONFIG_DIR  = join(homedir(), ".gossamer");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function readConfig(): GossamerConfig {
  if (!existsSync(CONFIG_PATH)) {
    return { repos: [] };
  }
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(raw) as GossamerConfig;
}

export function writeConfig(config: GossamerConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
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
