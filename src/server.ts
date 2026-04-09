import express from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import pty from "node-pty";
import { execSync, exec as execCb, execFile as execFileCb } from "child_process";
import { promisify } from "util";

const exec     = promisify(execCb);
const execFile = promisify(execFileCb);
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch as fsWatch, FSWatcher } from "fs";
import { homedir } from "os";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp-server.js";
import { basename, dirname, join } from "path";
import { fileURLToPath } from "url";
import { getDb, evictDb, indexAllCheckpointsV2, indexAllShadowBranches, indexLiveSessions, setupLogContentFts, syncLogContentFts, searchLogContent } from "@gossamer/core";
import type { PrismaClient } from "@gossamer/core";
import { readConfig, addRepo, removeRepo, findRepo, findRepoForPath, defaultDbPath, checkpointRepoPath, type RepoConfig } from "./config.js";

// ─── Custom title cache (reads ~/.claude/projects/…/*.jsonl for /rename events) ──

/** Map from sessionId → the latest customTitle set via /rename. */
const customTitleCache = new Map<string, string>();
/** Track file mtimes so we only re-parse files that have changed. */
const customTitleMtimes = new Map<string, number>();

function refreshCustomTitles(repoDir: string): void {
  // Claude encodes the repo path by replacing every '/' with '-'
  const encoded = repoDir.replace(/\//g, "-");
  const projectDir = join(homedir(), ".claude", "projects", encoded);
  let files: string[];
  try {
    files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return; // project dir doesn't exist for this repo yet
  }

  for (const file of files) {
    const filePath = join(projectDir, file);
    let mtime: number;
    try { mtime = statSync(filePath).mtimeMs; } catch { continue; }
    if (customTitleMtimes.get(filePath) === mtime) continue; // unchanged
    customTitleMtimes.set(filePath, mtime);

    const sessionId = file.slice(0, -".jsonl".length);
    let latestTitle: string | null = null;
    try {
      for (const line of readFileSync(filePath, "utf-8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed) as Record<string, unknown>;
          if (obj.type === "custom-title" && typeof obj.customTitle === "string") {
            latestTitle = obj.customTitle;
          }
        } catch { /* skip malformed line */ }
      }
    } catch { /* file unreadable */ }

    if (latestTitle) customTitleCache.set(sessionId, latestTitle);
    else customTitleCache.delete(sessionId);
  }
}

// ─── Schema initialisation ────────────────────────────────────────────────────

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// schema.sql is generated at build time by `prisma migrate diff --from-empty --to-schema ...`
// and transformed to use CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
// In dev: dist/schema.sql (copied by tsconfig); bundled VSIX: bundled-server/schema.sql.
const SCHEMA_SQL_DEV     = join(SCRIPT_DIR, "schema.sql");
const SCHEMA_SQL_BUNDLED = join(SCRIPT_DIR, "schema.sql"); // same name, different dir
const SCHEMA_SQL_PATH    = existsSync(SCHEMA_SQL_DEV) ? SCHEMA_SQL_DEV : SCHEMA_SQL_BUNDLED;

async function pushSchema(db: PrismaClient): Promise<void> {
  const sql = readFileSync(SCHEMA_SQL_PATH, "utf8");
  // Split on statement boundaries (semicolon + newline) and execute each one.
  // Strip leading SQL comment lines (e.g. "-- CreateTable") from each chunk
  // so that they don't prevent execution.
  const stmts = sql
    .split(/;\s*\n/)
    .map((s) => s.replace(/^(\s*--.*\n)*/gm, "").trim())
    .filter((s) => s.length > 0);
  for (const stmt of stmts) {
    await db.$executeRawUnsafe(stmt);
  }
}

// ─── Git user ─────────────────────────────────────────────────────────────────

function gitConfigGet(key: string, cwd?: string): string | null {
  try {
    return execSync(`git config ${key}`, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch { return null; }
}

function getGitUser(cwd?: string): { name: string | null; email: string | null } {
  // Try local config first (cwd), then fall back to global
  const name  = (cwd ? gitConfigGet("user.name", cwd)  : null) ?? gitConfigGet("--global user.name");
  const email = (cwd ? gitConfigGet("user.email", cwd) : null) ?? gitConfigGet("--global user.email");
  return { name, email };
}

// ─── Response types ───────────────────────────────────────────────────────────

interface SessionResponse {
  sessionId: string;
  startedAt: string;
  updatedAt: string;
  cwd: string;
  repoRoot: string | null;
  repoName: string | null;
  parentSessionId: string | null;
  childSessionIds: string[];
  gitUserName: string | null;
  gitUserEmail: string | null;
  prompt: string | null;
  summary: string | null;
  keywords: string[];
  branch: string | null;
  intent: string | null;
  slug: string | null;
  customTitle: string | null;
  agent: string | null;
  /** true when this session is currently indexed in a shadow branch */
  isLive: boolean;
}

interface OverviewResponse {
  sessionId: string;
  summary: string;
  keywords: string[];
  startedAt: string;
  endedAt: string;
}

// ─── Mapping helpers ──────────────────────────────────────────────────────────

// SQLite has a limit of 999 bind variables per statement. When doing IN queries
// over large sets, chunk and union the results.
const SQLITE_IN_CHUNK = 500;

async function findManyInChunks<T>(
  ids: string[],
  fetch: (chunk: string[]) => Promise<T[]>,
): Promise<T[]> {
  if (ids.length === 0) return [];
  const results: T[] = [];
  for (let i = 0; i < ids.length; i += SQLITE_IN_CHUNK) {
    const chunk = ids.slice(i, i + SQLITE_IN_CHUNK);
    results.push(...await fetch(chunk));
  }
  return results;
}

// ─── Server ───────────────────────────────────────────────────────────────────

export async function startServer(port: number, repoDir?: string): Promise<void> {
  // Strip CLAUDECODE so spawned sessions are not blocked by nested-session detection
  delete process.env.CLAUDECODE;

  // ── Per-repo DB registry ──────────────────────────────────────────────────
  // Each configured repo gets its own SQLite DB + PrismaClient.  There is no
  // "primary" DB — every endpoint resolves which DB to query via repo context.

  const dbRegistry = new Map<string, PrismaClient>();

  async function initRepoDb(repo: RepoConfig): Promise<void> {
    mkdirSync(dirname(repo.dbPath), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const repoDb = await getDb(repo.dbPath);
        await pushSchema(repoDb);
        await setupLogContentFts(repoDb);
        try { await syncLogContentFts(repoDb); } catch { /* non-fatal */ }
        dbRegistry.set(repo.dbPath, repoDb);
        process.stderr.write(`[gossamer] schema ready: ${repo.dbPath}\n`);
        return;
      } catch (err) {
        if (attempt === 0) {
          process.stderr.write(`[gossamer] schema push failed for ${repo.name}, deleting DB and retrying — ${err}\n`);
          evictDb(repo.dbPath);
          try { (await import("fs")).unlinkSync(repo.dbPath); } catch {}
          try { (await import("fs")).unlinkSync(repo.dbPath + "-wal"); } catch {}
          try { (await import("fs")).unlinkSync(repo.dbPath + "-shm"); } catch {}
        } else {
          process.stderr.write(`[gossamer] schema push failed for ${repo.name} after retry — ${err}\n`);
        }
      }
    }
  }

  for (const repo of readConfig().repos) {
    await initRepoDb(repo);
  }

  /** All registered DB clients. */
  function allDbs(): PrismaClient[] { return [...dbRegistry.values()]; }

  /** Resolve the DB client for a repo by its local path. */
  function dbForRepo(localPath: string): PrismaClient | null {
    const repo = findRepoForPath(localPath);
    return repo ? dbRegistry.get(repo.dbPath) ?? null : null;
  }

  /** Try each DB looking for a record — used as a fallback when no localPath is provided. */
  async function findInDbs<T>(probe: (db: PrismaClient) => Promise<T | null>): Promise<{ db: PrismaClient; result: T } | null> {
    for (const client of dbRegistry.values()) {
      const result = await probe(client);
      if (result) return { db: client, result };
    }
    return null;
  }

  /** Resolve DB from ?localPath query param, falling back to probing all DBs with a probe function. */
  async function resolveDb(localPath: string | null, probe?: (db: PrismaClient) => Promise<unknown>): Promise<PrismaClient | null> {
    if (localPath) {
      const db = dbForRepo(localPath);
      if (db) return db;
    }
    if (probe) {
      const found = await findInDbs(probe);
      if (found) return found.db;
    }
    return null;
  }

  const app = express();
  app.use(cors());
  app.use(express.json());

  // Resolve repo name from repo config once at startup
  const repoName = repoDir ? basename(repoDir) : null;

  // GET /api/sessions — reconstructed from CheckpointSessionMetadata + ShadowSession
  // Aggregates across ALL repo DBs.
  app.get("/api/sessions", async (_req, res) => {
    try {
      const qLocalPath = typeof _req.query.localPath === "string" ? _req.query.localPath : null;
      const sortDir = qLocalPath ?? repoDir;
      const dbs = allDbs();

      // Gather data from every repo DB in parallel.
      const perDb = await Promise.all(dbs.map(async (rdb) => {
        const [metas, shadows, archivedRows, logEventSessionRows] = await Promise.all([
          rdb.checkpointSessionMetadata.findMany({
            select: { sessionId: true, checkpointId: true, branch: true, agent: true, summary: { select: { intent: true } } },
            orderBy: { createdAt: "asc" },
          }),
          rdb.shadowSession.findMany(),
          rdb.archivedSession.findMany({ select: { sessionId: true } }),
          rdb.logEvent.findMany({ distinct: ["sessionId"], where: { sessionId: { not: null } }, select: { sessionId: true } }),
        ]);
        return { rdb, metas, shadows, archivedRows, logEventSessionRows };
      }));

      // Merge checkpoint meta across all DBs
      const cpMap = new Map<string, { branch: string | null; intent: string | null; checkpointId: string; agent: string | null }>();
      const allCheckpointIds = new Set<string>();
      for (const { metas } of perDb) {
        for (const m of metas) {
          cpMap.set(m.sessionId, { branch: m.branch, intent: m.summary?.intent ?? null, checkpointId: m.checkpointId, agent: m.agent ?? null });
          allCheckpointIds.add(m.checkpointId);
        }
      }

      // Git user per checkpoint (from all DBs)
      const cpUserMap = new Map<string, { gitUserName: string | null; gitUserEmail: string | null }>();
      if (allCheckpointIds.size > 0) {
        const ids = [...allCheckpointIds];
        await Promise.all(dbs.map(async (rdb) => {
          const rows = await rdb.checkpointMetadata.findMany({
            where: { checkpointId: { in: ids } },
            select: { checkpointId: true, gitUserName: true, gitUserEmail: true },
          });
          for (const r of rows) cpUserMap.set(r.checkpointId, r);
        }));
      }

      // Merge shadows, archived, logEvent sessions
      const shadowMap = new Map<string, (typeof perDb)[0]["shadows"][0]>();
      const archivedSet = new Set<string>();
      const knownIds = new Set<string>([...cpMap.keys()]);
      for (const { shadows, archivedRows, logEventSessionRows } of perDb) {
        for (const s of shadows) { shadowMap.set(s.sessionId, s); knownIds.add(s.sessionId); }
        for (const r of archivedRows) archivedSet.add(r.sessionId);
        for (const r of logEventSessionRows) { if (r.sessionId) knownIds.add(r.sessionId); }
      }

      const showArchived = _req.query.archived === "1";
      const allIds = [...knownIds]
        .filter((id) => showArchived ? archivedSet.has(id) : !archivedSet.has(id));
      if (allIds.length === 0) { res.json([]); return; }

      // Timestamps, cwd, slug, parent — aggregate from all DBs
      const timeMap = new Map<string, { startedAt: Date | null; updatedAt: Date | null }>();
      const cwdMap  = new Map<string, string | null>();
      const slugMap = new Map<string, string | null>();
      const parentMap = new Map<string, string>();
      const childMap  = new Map<string, string[]>();

      await Promise.all(dbs.map(async (rdb) => {
        const timeRows = allIds.length > 0
          ? await rdb.$queryRawUnsafe<{ sessionId: string; startedAt: string | null; updatedAt: string | null }[]>(
              `SELECT sessionId, MIN(timestamp) AS startedAt, MAX(timestamp) AS updatedAt
               FROM LogEvent
               WHERE sessionId IN (${allIds.map(() => "?").join(",")}) AND timestamp IS NOT NULL
               GROUP BY sessionId`,
              ...allIds,
            )
          : [];
        for (const r of timeRows) {
          const existing = timeMap.get(r.sessionId);
          const s = r.startedAt ? new Date(r.startedAt) : null;
          const u = r.updatedAt ? new Date(r.updatedAt) : null;
          if (!existing) { timeMap.set(r.sessionId, { startedAt: s, updatedAt: u }); }
          else {
            if (s && (!existing.startedAt || s < existing.startedAt)) existing.startedAt = s;
            if (u && (!existing.updatedAt || u > existing.updatedAt)) existing.updatedAt = u;
          }
        }

        const cwdRows = await rdb.logEvent.findMany({
          where: { sessionId: { in: allIds }, cwd: { not: null } },
          distinct: ["sessionId"],
          orderBy: { id: "asc" },
          select: { sessionId: true, cwd: true },
        });
        for (const e of cwdRows) { if (e.sessionId && !cwdMap.has(e.sessionId)) cwdMap.set(e.sessionId, e.cwd); }

        const slugRows = await rdb.logEvent.findMany({
          where: { sessionId: { in: allIds }, slug: { not: null } },
          orderBy: { id: "desc" },
          distinct: ["sessionId"],
          select: { sessionId: true, slug: true },
        });
        for (const e of slugRows) { if (e.sessionId && !slugMap.has(e.sessionId)) slugMap.set(e.sessionId, e.slug); }

        const parentRows = await rdb.sessionParent.findMany({
          select: { childSessionId: true, parentSessionId: true },
        });
        for (const r of parentRows) {
          parentMap.set(r.childSessionId, r.parentSessionId);
          if (!childMap.has(r.parentSessionId)) childMap.set(r.parentSessionId, []);
          childMap.get(r.parentSessionId)!.push(r.childSessionId);
        }
      }));

      const result: SessionResponse[] = allIds.map((sessionId) => {
        const cp     = cpMap.get(sessionId) ?? null;
        const shadow = shadowMap.get(sessionId) ?? null;
        const t      = timeMap.get(sessionId);
        const startedAt = t?.startedAt ?? shadow?.createdAt ?? null;
        const updatedAt = t?.updatedAt ?? shadow?.createdAt ?? null;
        const cpUser = cp ? cpUserMap.get(cp.checkpointId) ?? null : null;
        const cwd = cwdMap.get(sessionId) ?? shadow?.cwd ?? "";
        return {
          sessionId,
          startedAt: startedAt?.toISOString() ?? new Date(0).toISOString(),
          updatedAt: updatedAt?.toISOString() ?? new Date(0).toISOString(),
          cwd,
          repoRoot:        findRepoForPath(cwd)?.localPath ?? repoDir ?? null,
          repoName:        basename(cwd) || repoName,
          parentSessionId: parentMap.get(sessionId) ?? null,
          childSessionIds: childMap.get(sessionId) ?? [],
          gitUserName:     cpUser?.gitUserName || null,
          gitUserEmail:    cpUser?.gitUserEmail || null,
          prompt:          shadow?.prompt ?? null,
          summary:         null,
          keywords:        [],
          branch:          cp?.branch ?? shadow?.gitBranch ?? null,
          intent:          cp?.intent ?? null,
          slug:            slugMap.get(sessionId) ?? null,
          customTitle:     customTitleCache.get(sessionId) ?? null,
          agent:           cp?.agent ?? null,
          isLive:          shadow !== null,
        };
      });

      // Sort sessions from the same repo first, matched by git remote
      // so that the same repo on different machines (different cwds) sorts together.
      const sortRepo = sortDir ? findRepoForPath(sortDir) : null;
      const sortRemote = sortRepo?.remote ?? null;
      result.sort((a, b) => {
        const aRepo = a.cwd ? findRepoForPath(a.cwd) : null;
        const bRepo = b.cwd ? findRepoForPath(b.cwd) : null;
        const aLocal = sortRemote && aRepo?.remote === sortRemote ? 0 : sortDir && (a.cwd === sortDir || a.cwd.startsWith(sortDir + "/")) ? 0 : 1;
        const bLocal = sortRemote && bRepo?.remote === sortRemote ? 0 : sortDir && (b.cwd === sortDir || b.cwd.startsWith(sortDir + "/")) ? 0 : 1;
        if (aLocal !== bLocal) return aLocal - bLocal;
        return b.updatedAt.localeCompare(a.updatedAt);
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/sessions/:id
  app.get("/api/sessions/:id", async (req, res) => {
    try {
      const id = req.params.id;
      const qLocalPath = typeof req.query.localPath === "string" ? req.query.localPath : null;
      const sdb = await resolveDb(qLocalPath, async (d) =>
        await d.shadowSession.findUnique({ where: { sessionId: id }, select: { sessionId: true } })
        ?? await d.logEvent.findFirst({ where: { sessionId: id }, select: { id: true } })
        ?? await d.checkpointSessionMetadata.findFirst({ where: { sessionId: id }, select: { id: true } }),
      );
      if (!sdb) { res.status(404).json({ error: "Session not found" }); return; }

      const [latestMeta, shadow, firstCwdEvent, firstTimestampEvent, lastEvent, latestSlugEvent] = await Promise.all([
        sdb.checkpointSessionMetadata.findFirst({
          where: { sessionId: id },
          select: { branch: true, checkpointId: true, agent: true, summary: { select: { intent: true } } },
          orderBy: { createdAt: "desc" },
        }),
        sdb.shadowSession.findUnique({ where: { sessionId: id } }),
        sdb.logEvent.findFirst({
          where: { sessionId: id, cwd: { not: null } },
          orderBy: { id: "asc" },
          select: { cwd: true },
        }),
        sdb.logEvent.findFirst({
          where: { sessionId: id, timestamp: { not: null } },
          orderBy: { id: "asc" },
          select: { timestamp: true },
        }),
        sdb.logEvent.findFirst({
          where: { sessionId: id, timestamp: { not: null } },
          orderBy: { id: "desc" },
          select: { timestamp: true },
        }),
        sdb.logEvent.findFirst({
          where: { sessionId: id, slug: { not: null } },
          orderBy: { id: "desc" },
          select: { slug: true },
        }),
      ]);
      if (!latestMeta && !shadow) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      const cpMeta = latestMeta
        ? await sdb.checkpointMetadata.findUnique({
            where: { checkpointId: latestMeta.checkpointId },
            select: { gitUserName: true, gitUserEmail: true },
          })
        : null;
      const cwd = firstCwdEvent?.cwd ?? shadow?.cwd ?? "";
      const startedAt = firstTimestampEvent?.timestamp ?? shadow?.createdAt ?? null;
      const updatedAt = lastEvent?.timestamp  ?? shadow?.createdAt ?? null;
      res.json({
        sessionId:       id,
        startedAt:       startedAt?.toISOString() ?? new Date(0).toISOString(),
        updatedAt:       updatedAt?.toISOString() ?? new Date(0).toISOString(),
        cwd,
        repoRoot:        findRepoForPath(cwd)?.localPath ?? repoDir ?? null,
        repoName:        basename(cwd) || repoName,
        parentSessionId: null,
        childSessionIds: [],
        gitUserName:     cpMeta?.gitUserName || null,
        gitUserEmail:    cpMeta?.gitUserEmail || null,
        prompt:          shadow?.prompt ?? null,
        summary:         null,
        keywords:        [],
        branch:          latestMeta?.branch ?? shadow?.gitBranch ?? null,
        intent:          latestMeta?.summary?.intent ?? null,
        slug:            latestSlugEvent?.slug ?? null,
        customTitle:     customTitleCache.get(id) ?? null,
        agent:           latestMeta?.agent ?? null,
        isLive:          shadow !== null,
      } satisfies SessionResponse);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/sessions/:id/overview
  app.get("/api/sessions/:id/overview", async (req, res) => {
    try {
      const qLocalPath = typeof req.query.localPath === "string" ? req.query.localPath : null;
      const sdb = await resolveDb(qLocalPath, (d) => d.interactionOverview.findUnique({ where: { sessionId: req.params.id } }));
      if (!sdb) { res.status(404).json({ error: "No overview for this session" }); return; }
      const overview = await sdb.interactionOverview.findUnique({
        where: { sessionId: req.params.id },
      });
      if (!overview) {
        res.status(404).json({ error: "No overview for this session" });
        return;
      }
      const result: OverviewResponse = {
        sessionId: overview.sessionId,
        summary: overview.summary,
        keywords: overview.keywords ? (JSON.parse(overview.keywords) as string[]) : [],
        startedAt: overview.startedAt.toISOString(),
        endedAt: overview.endedAt.toISOString(),
      };
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/v2/sessions/:id/log-events
  app.get("/api/v2/sessions/:id/log-events", async (req, res) => {
    try {
      const qLocalPath = typeof req.query.localPath === "string" ? req.query.localPath : null;
      const sdb = await resolveDb(qLocalPath, (d) => d.logEvent.findFirst({ where: { sessionId: req.params.id }, select: { id: true } }));
      if (!sdb) { res.json([]); return; }
      const events = await sdb.logEvent.findMany({
        where:   { sessionId: req.params.id },
        orderBy: { timestamp: "asc" },
        include: {
          contents:    { orderBy: { contentIndex: "asc" } },
          usage:       true,
          hookProgress: true,
          systemData:  true,
        },
      });
      res.json(events.map((e) => ({
        id:              e.id,
        uuid:            e.uuid,
        sessionId:       e.sessionId,
        parentUuid:      e.parentUuid,
        type:            e.type,
        timestamp:       e.timestamp?.toISOString() ?? null,
        cwd:             e.cwd,
        gitBranch:       e.gitBranch,
        slug:            e.slug,
        isSidechain:     e.isSidechain,
        toolUseId:       e.toolUseId,
        parentToolUseId: e.parentToolUseId,
        contents: e.contents.map((c) => ({
          contentType:       c.contentType,
          contentIndex:      c.contentIndex,
          text:              c.text,
          thinking:          c.thinking,
          toolUseId:         c.toolUseId,
          toolName:          c.toolName,
          toolInput:         c.toolInput ? (JSON.parse(c.toolInput) as unknown) : null,
          toolResultContent: c.toolResultContent,
          isError:           c.isError,
          imageData:         c.imageData,
          imageMediaType:    c.imageMediaType,
        })),
        usage: e.usage ? {
          model:                    e.usage.model,
          stopReason:               e.usage.stopReason,
          inputTokens:              e.usage.inputTokens,
          outputTokens:             e.usage.outputTokens,
          cacheCreationInputTokens: e.usage.cacheCreationInputTokens,
          cacheReadInputTokens:     e.usage.cacheReadInputTokens,
        } : null,
        hookProgress: e.hookProgress ? {
          type:      e.hookProgress.type,
          hookEvent: e.hookProgress.hookEvent,
          hookName:  e.hookProgress.hookName,
          command:   e.hookProgress.command,
        } : null,
        systemData: e.systemData ? {
          subtype:               e.systemData.subtype,
          hookCount:             e.systemData.hookCount,
          stopReason:            e.systemData.stopReason,
          preventedContinuation: e.systemData.preventedContinuation,
          level:                 e.systemData.level,
          durationMs:            e.systemData.durationMs,
        } : null,
      })));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/v2/sessions/:sessionId/checkpoints/:checkpointId/log-events
  app.get("/api/v2/sessions/:sessionId/checkpoints/:checkpointId/log-events", async (req, res) => {
    try {
      const { sessionId, checkpointId } = req.params;
      const qLocalPath = typeof req.query.localPath === "string" ? req.query.localPath : null;
      const sdb = await resolveDb(qLocalPath, (d) => d.logEvent.findFirst({ where: { sessionId }, select: { id: true } }));
      if (!sdb) { res.json([]); return; }
      const events = await sdb.logEvent.findMany({
        where: {
          sessionId,
          sessionLink: {
            checkpointMetadata: { checkpointId },
          },
        },
        orderBy: { timestamp: "asc" },
        include: {
          contents:    { orderBy: { contentIndex: "asc" } },
          usage:       true,
          hookProgress: true,
          systemData:  true,
        },
      });
      res.json(events.map((e) => ({
        id:              e.id,
        uuid:            e.uuid,
        sessionId:       e.sessionId,
        parentUuid:      e.parentUuid,
        type:            e.type,
        timestamp:       e.timestamp?.toISOString() ?? null,
        cwd:             e.cwd,
        gitBranch:       e.gitBranch,
        slug:            e.slug,
        isSidechain:     e.isSidechain,
        toolUseId:       e.toolUseId,
        parentToolUseId: e.parentToolUseId,
        contents: e.contents.map((c) => ({
          contentType:       c.contentType,
          contentIndex:      c.contentIndex,
          text:              c.text,
          thinking:          c.thinking,
          toolUseId:         c.toolUseId,
          toolName:          c.toolName,
          toolInput:         c.toolInput ? (JSON.parse(c.toolInput) as unknown) : null,
          toolResultContent: c.toolResultContent,
          isError:           c.isError,
          imageData:         c.imageData,
          imageMediaType:    c.imageMediaType,
        })),
        usage: e.usage ? {
          model:                    e.usage.model,
          stopReason:               e.usage.stopReason,
          inputTokens:              e.usage.inputTokens,
          outputTokens:             e.usage.outputTokens,
          cacheCreationInputTokens: e.usage.cacheCreationInputTokens,
          cacheReadInputTokens:     e.usage.cacheReadInputTokens,
        } : null,
        hookProgress: e.hookProgress ? {
          type:      e.hookProgress.type,
          hookEvent: e.hookProgress.hookEvent,
          hookName:  e.hookProgress.hookName,
          command:   e.hookProgress.command,
        } : null,
        systemData: e.systemData ? {
          subtype:               e.systemData.subtype,
          hookCount:             e.systemData.hookCount,
          stopReason:            e.systemData.stopReason,
          preventedContinuation: e.systemData.preventedContinuation,
          level:                 e.systemData.level,
          durationMs:            e.systemData.durationMs,
        } : null,
      })));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── V2 helpers ─────────────────────────────────────────────────────────────

  type V2Session = {
    summary: {
      intent: string; outcome: string;
      openItems: { id: number; text: string; status: string; subSessionId: string | null }[];
      frictionItems: { text: string }[];
      repoLearnings: { text: string }[];
      codeLearnings: { path: string; finding: string }[];
      workflowLearnings: { text: string }[];
    } | null;
  };

  function mapV2Summary(summary: NonNullable<V2Session["summary"]>) {
    return {
      intent:            summary.intent,
      outcome:           summary.outcome,
      openItems:         summary.openItems.map((r) => ({ id: r.id, text: r.text, status: r.status, subSessionId: r.subSessionId })),
      friction:          summary.frictionItems.map((r) => r.text),
      repoLearnings:     summary.repoLearnings.map((r) => r.text),
      codeLearnings:     summary.codeLearnings.map((r) => ({ path: r.path, finding: r.finding })),
      workflowLearnings: summary.workflowLearnings.map((r) => r.text),
    };
  }

  const V2_SESSION_INCLUDE = {
    summary: {
      include: {
        openItems:         true,
        frictionItems:     true,
        repoLearnings:     true,
        codeLearnings:     true,
        workflowLearnings: true,
      },
    },
  } as const;

  const V2_SESSION_ORDER = { createdAt: "desc" as const };

  // GET /api/v2/checkpoints — aggregates across all repo DBs
  app.get("/api/v2/checkpoints", async (_req, res) => {
    try {
      const allResults: unknown[] = [];
      const repos = readConfig().repos;

      await Promise.all(allDbs().map(async (rdb) => {
        const checkpoints = await rdb.checkpointMetadata.findMany({
          include: { tokenUsage: true, filesTouched: { include: { filePath: true } } },
        });
        const checkpointIds = checkpoints.map((c) => c.checkpointId);
        const sessions = await rdb.checkpointSessionMetadata.findMany({
          where: { checkpointId: { in: checkpointIds } },
          orderBy: V2_SESSION_ORDER,
          include: V2_SESSION_INCLUDE,
        });
        const sessionsByCheckpoint = new Map<string, typeof sessions>();
        for (const s of sessions) {
          const arr = sessionsByCheckpoint.get(s.checkpointId) ?? [];
          arr.push(s);
          sessionsByCheckpoint.set(s.checkpointId, arr);
        }
        // Find the localPath for this DB
        const repo = repos.find((r) => dbRegistry.get(r.dbPath) === rdb);
        for (const c of checkpoints) {
          const cpSessions = sessionsByCheckpoint.get(c.checkpointId) ?? [];
          const summary = cpSessions.find((s) => s.summary)?.summary ?? null;
          const latestCreatedAt = cpSessions
            .filter((s): s is typeof s & { createdAt: Date } => s.createdAt !== null)
            .map((s) => s.createdAt)
            .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
          allResults.push({
            id:               c.id,
            checkpointId:     c.checkpointId,
            cliVersion:       c.cliVersion,
            strategy:         c.strategy,
            branch:           c.branch,
            checkpointsCount: c.checkpointsCount,
            createdAt:        latestCreatedAt?.toISOString() ?? null,
            tokenUsage: c.tokenUsage ? {
              inputTokens:         c.tokenUsage.inputTokens,
              cacheCreationTokens: c.tokenUsage.cacheCreationTokens,
              cacheReadTokens:     c.tokenUsage.cacheReadTokens,
              outputTokens:        c.tokenUsage.outputTokens,
              apiCallCount:        c.tokenUsage.apiCallCount,
            } : null,
            filesTouched:  c.filesTouched.map((f) => f.filePath.path),
            sessionCount:  cpSessions.length,
            localPath:     repo?.localPath ?? null,
            summary: summary ? mapV2Summary(summary) : null,
          });
        }
      }));
      res.json(allResults);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/v2/checkpoints/:id
  app.get("/api/v2/checkpoints/:id", async (req, res) => {
    try {
      const checkpointId = req.params.id;
      const qLocalPath = typeof req.query.localPath === "string" ? req.query.localPath : null;
      const cdb = await resolveDb(qLocalPath, (d) => d.checkpointMetadata.findUnique({ where: { checkpointId }, select: { id: true } }));
      if (!cdb) { res.status(404).json({ error: "Not found" }); return; }
      const checkpoint = await cdb.checkpointMetadata.findUnique({
        where: { checkpointId },
        include: {
          tokenUsage: true,
          filesTouched: { include: { filePath: true } },
        },
      });
      if (!checkpoint) { res.status(404).json({ error: "Not found" }); return; }

      const sessions = await cdb.checkpointSessionMetadata.findMany({
        where:   { checkpointId },
        orderBy: V2_SESSION_ORDER,
        include: V2_SESSION_INCLUDE,
      });

      const summary = sessions.find((s) => s.summary)?.summary ?? null;

      res.json({
        id:               checkpoint.id,
        checkpointId:     checkpoint.checkpointId,
        cliVersion:       checkpoint.cliVersion,
        strategy:         checkpoint.strategy,
        branch:           checkpoint.branch,
        checkpointsCount: checkpoint.checkpointsCount,
        tokenUsage: checkpoint.tokenUsage ? {
          inputTokens:         checkpoint.tokenUsage.inputTokens,
          cacheCreationTokens: checkpoint.tokenUsage.cacheCreationTokens,
          cacheReadTokens:     checkpoint.tokenUsage.cacheReadTokens,
          outputTokens:        checkpoint.tokenUsage.outputTokens,
          apiCallCount:        checkpoint.tokenUsage.apiCallCount,
        } : null,
        filesTouched:  checkpoint.filesTouched.map((f) => f.filePath.path),
        sessionCount:  sessions.length,
        summary:       summary ? mapV2Summary(summary) : null,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/v2/checkpoints/:id/diff — raw unified diff for use with diff2html
  app.get("/api/v2/checkpoints/:id/diff", async (req, res) => {
    try {
      const checkpointId = req.params.id;
      const qLocalPath = typeof req.query.localPath === "string" ? req.query.localPath : null;
      const cdb = await resolveDb(qLocalPath, (d) => d.checkpointIdGitOidJoin.findFirst({ where: { checkpointId }, select: { checkpointId: true } }));
      if (!cdb) { res.status(404).end(); return; }
      const repo = qLocalPath ? findRepo(qLocalPath) : null;
      const cpLocalPath = repo?.localPath ?? repoDir;
      if (!cpLocalPath) { res.status(404).end(); return; }
      const join = await cdb.checkpointIdGitOidJoin.findFirst({
        where: { checkpointId },
        select: { gitOid: true },
      });
      if (!join) { res.status(404).end(); return; }
      const { stdout } = await exec(
        `git -C ${JSON.stringify(cpLocalPath)} diff-tree -p --no-commit-id -r ${join.gitOid}`,
      );
      res.set("Content-Type", "text/plain; charset=utf-8");
      res.send(stdout);
    } catch {
      res.status(500).end();
    }
  });

  // GET /api/v2/checkpoints/:id/diff-stats
  app.get("/api/v2/checkpoints/:id/diff-stats", async (req, res) => {
    try {
      const checkpointId = req.params.id;
      const qLocalPath = typeof req.query.localPath === "string" ? req.query.localPath : null;
      const cdb = await resolveDb(qLocalPath, (d) => d.checkpointIdGitOidJoin.findFirst({ where: { checkpointId }, select: { checkpointId: true } }));
      if (!cdb) { res.json([]); return; }
      const repo = qLocalPath ? findRepo(qLocalPath) : null;
      const cpLocalPath = repo?.localPath ?? repoDir;
      if (!cpLocalPath) { res.json([]); return; }
      const join = await cdb.checkpointIdGitOidJoin.findFirst({
        where: { checkpointId },
        select: { gitOid: true },
      });
      if (!join) { res.json([]); return; }
      const { stdout } = await exec(
        `git -C ${JSON.stringify(cpLocalPath)} diff-tree --numstat -r ${join.gitOid}`,
      );
      const stats = stdout.trim().split("\n").filter(Boolean).map((line) => {
        const [add, del, path] = line.split("\t");
        return { path, additions: parseInt(add, 10) || 0, deletions: parseInt(del, 10) || 0 };
      });
      res.json(stats);
    } catch {
      res.json([]);
    }
  });

  // GET /api/v2/checkpoints/:id/file?path=<path>&side=before|after
  // Returns the raw file content at the commit (after) or its parent (before).
  app.get("/api/v2/checkpoints/:id/file", async (req, res) => {
    try {
      const checkpointId = req.params.id;
      const filePath = typeof req.query.path === "string" ? req.query.path : null;
      const side = req.query.side === "before" ? "before" : "after";
      const qLocalPath = typeof req.query.localPath === "string" ? req.query.localPath : null;
      if (!filePath) { res.status(400).end(); return; }
      const cdb = await resolveDb(qLocalPath, (d) => d.checkpointIdGitOidJoin.findFirst({ where: { checkpointId }, select: { checkpointId: true } }));
      if (!cdb) { res.status(404).end(); return; }
      const join = await cdb.checkpointIdGitOidJoin.findFirst({
        where: { checkpointId },
        select: { gitOid: true },
      });
      if (!join) { res.status(404).end(); return; }
      // Determine which repo contains this checkpoint's commit.
      const repo = qLocalPath ? findRepo(qLocalPath) : null;
      let cpRepoDir = repo?.localPath ?? repoDir;
      if (!cpRepoDir) {
        const sessionLink = await cdb.checkpointSessionMetadata.findFirst({
          where: { checkpointId },
          select: { sessionId: true },
        });
        if (sessionLink) {
          const shadow = await cdb.shadowSession.findUnique({
            where: { sessionId: sessionLink.sessionId },
            select: { cwd: true },
          });
          if (shadow?.cwd) cpRepoDir = shadow.cwd;
        }
      }
      if (!cpRepoDir) { res.status(400).end(); return; }
      const ref = side === "before" ? `${join.gitOid}^:${filePath}` : `${join.gitOid}:${filePath}`;
      try {
        const { stdout } = await execFile("git", ["-C", cpRepoDir, "show", ref]);
        res.set("Content-Type", "text/plain; charset=utf-8");
        res.send(stdout);
      } catch {
        // File didn't exist at this ref (new file, deleted file, or binary)
        res.set("Content-Type", "text/plain; charset=utf-8");
        res.send("");
      }
    } catch (err) {
      res.status(500).end();
    }
  });

  // GET /api/v2/sessions/:id/checkpoints
  app.get("/api/v2/sessions/:id/checkpoints", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const qLocalPath = typeof req.query.localPath === "string" ? req.query.localPath : null;
      const sdb = await resolveDb(qLocalPath, (d) => d.checkpointSessionMetadata.findFirst({ where: { sessionId }, select: { id: true } }));
      if (!sdb) { res.json([]); return; }

      const sessionRows = await sdb.checkpointSessionMetadata.findMany({
        where:   { sessionId },
        orderBy: { createdAt: "desc" },
        include: {
          ...V2_SESSION_INCLUDE,
          tokenUsage:   true,
          filesTouched: { include: { filePath: true } },
        },
      });

      const gitOidRows = await sdb.checkpointIdGitOidJoin.findMany({
        where: { checkpointId: { in: sessionRows.map((s) => s.checkpointId) } },
        select: { checkpointId: true, gitOid: true },
      });
      const gitOidMap = new Map(gitOidRows.map((r) => [r.checkpointId, r.gitOid]));

      // Look up the repo path for this session so we can read commit messages.
      const [shadow, firstCwdEv] = await Promise.all([
        sdb.shadowSession.findUnique({ where: { sessionId }, select: { cwd: true } }),
        sdb.logEvent.findFirst({ where: { sessionId, cwd: { not: null } }, orderBy: { id: "asc" }, select: { cwd: true } }),
      ]);
      const primaryDir = qLocalPath ?? firstCwdEv?.cwd ?? shadow?.cwd ?? repoDir;
      const candidateDirs = [
        primaryDir,
        ...readConfig().repos.map((r) => r.localPath).filter((p) => p !== primaryDir),
      ].filter(Boolean) as string[];

      // Fetch commit subject lines in parallel for all checkpoints that have a gitOid
      const commitMessages = new Map<string, string>();
      await Promise.all(
        gitOidRows.map(async ({ checkpointId, gitOid }) => {
          for (const dir of candidateDirs) {
            try {
              const { stdout } = await execFile("git", ["-C", dir, "log", "--format=%s", "-1", gitOid]);
              const msg = stdout.trim();
              if (msg) { commitMessages.set(checkpointId, msg); return; }
            } catch { /* try next repo */ }
          }
        }),
      );

      res.json(sessionRows.map((s) => ({
        checkpointId:  s.checkpointId,
        cliVersion:    s.cliVersion,
        branch:        s.branch,
        createdAt:     s.createdAt?.toISOString() ?? null,
        tokenUsage:    s.tokenUsage ? {
          inputTokens:         s.tokenUsage.inputTokens,
          cacheCreationTokens: s.tokenUsage.cacheCreationTokens,
          cacheReadTokens:     s.tokenUsage.cacheReadTokens,
          outputTokens:        s.tokenUsage.outputTokens,
          apiCallCount:        s.tokenUsage.apiCallCount,
        } : null,
        filesTouched:  s.filesTouched.map((f) => f.filePath.path),
        summary:       s.summary ? mapV2Summary(s.summary) : null,
        commitMessage: commitMessages.get(s.checkpointId) ?? null,
        commitHash:    gitOidMap.get(s.checkpointId) ?? null,
      })));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/branch-log?localPath=<>&branch=<>
  // Walks git log on the branch, parses "Entire-Checkpoint: <id>" trailers from
  // commit bodies, then looks up each checkpoint in the DB individually.
  app.get("/api/branch-log", async (req, res) => {
    try {
      const localPath = typeof req.query.localPath === "string" ? req.query.localPath : null;
      const branch    = typeof req.query.branch    === "string" ? req.query.branch    : null;
      if (!localPath || !branch) {
        res.status(400).json({ error: "localPath and branch are required" });
        return;
      }

      const page = typeof req.query.page === "string" ? Math.max(0, parseInt(req.query.page, 10) || 0) : 0;
      const PAGE_SIZE = 50;

      const repo = findRepoForPath(localPath);
      if (!repo) { res.status(404).json({ error: "Repo not found in config" }); return; }

      const repoDb = dbRegistry.get(repo.dbPath) ?? await getDb(repo.dbPath);

      // Walk git log and collect checkpoint IDs in commit order
      const orderedIds: string[] = [];
      const commitMessages = new Map<string, string>();
      const commitHashes   = new Map<string, string>();
      const seenIds = new Set<string>();
      try {
        const { stdout: gitOut } = await exec(
          `git -C ${JSON.stringify(repo.localPath)} log --format=%H%x00%B%x1e --max-count=${PAGE_SIZE} --skip=${page * PAGE_SIZE} ${JSON.stringify(branch)}`,
          { timeout: 10_000 },
        );
        for (const record of gitOut.split("\x1e")) {
          const nullIdx = record.indexOf("\x00");
          if (nullIdx === -1) continue;
          const hash = record.slice(0, nullIdx).trim();
          const body = record.slice(nullIdx + 1);
          const match = body.match(/^Entire-Checkpoint:\s*(\S+)$/m);
          if (match && !seenIds.has(match[1])) {
            seenIds.add(match[1]);
            orderedIds.push(match[1]);
            if (hash) commitHashes.set(match[1], hash);
            // Commit message = body with trailer line(s) removed, trimmed
            const message = body
              .split("\n")
              .filter((l) => !/^Entire-Checkpoint:\s*\S+$/.test(l.trim()))
              .join("\n")
              .trim();
            if (message) commitMessages.set(match[1], message);
          }
        }
      } catch { /* git unavailable or branch not found */ }

      const result = [];
      for (const checkpointId of orderedIds) {
        const [sessions, cpMeta] = await Promise.all([
          repoDb.checkpointSessionMetadata.findMany({
            where:   { checkpointId },
            orderBy: { createdAt: "asc" },
            include: { ...V2_SESSION_INCLUDE, tokenUsage: true, filesTouched: { include: { filePath: true } } },
          }),
          repoDb.checkpointMetadata.findUnique({
            where:  { checkpointId },
            select: { gitUserName: true, gitUserEmail: true },
          }),
        ]);
        for (const s of sessions) {
          const hasEvents = await repoDb.logEvent.findFirst({
            where: {
              sessionId: s.sessionId,
              sessionLink: { checkpointMetadata: { checkpointId: s.checkpointId } },
            },
            select: { id: true },
          });
          if (!hasEvents) continue;
          result.push({
            checkpointId:  s.checkpointId,
            sessionId:     s.sessionId,
            branch:        s.branch,
            createdAt:     s.createdAt?.toISOString() ?? null,
            gitUserName:   cpMeta?.gitUserName  ?? null,
            gitUserEmail:  cpMeta?.gitUserEmail ?? null,
            filesTouched:  s.filesTouched.map((f) => f.filePath.path),
            tokenUsage:   s.tokenUsage ? {
              inputTokens:         s.tokenUsage.inputTokens,
              cacheCreationTokens: s.tokenUsage.cacheCreationTokens,
              cacheReadTokens:     s.tokenUsage.cacheReadTokens,
              outputTokens:        s.tokenUsage.outputTokens,
              apiCallCount:        s.tokenUsage.apiCallCount,
            } : null,
            summary:       s.summary ? mapV2Summary(s.summary) : null,
            commitMessage: commitMessages.get(s.checkpointId) ?? null,
            commitHash:    commitHashes.get(s.checkpointId)   ?? null,
          });
        }
      }

      // Find the live (shadow) session on this branch, if any
      const liveShadow = await repoDb.shadowSession.findFirst({
        where: { gitBranch: branch },
        orderBy: { id: "desc" },
        select: { sessionId: true, prompt: true },
      });
      const liveSession = liveShadow
        ? { sessionId: liveShadow.sessionId, prompt: liveShadow.prompt ?? null }
        : null;

      res.json({ entries: result, hasMore: orderedIds.length === PAGE_SIZE, liveSession });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // PATCH /api/open-items/:id
  app.patch("/api/open-items/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { status, subSessionId } = req.body as { status?: string; subSessionId?: string };
    const allowed = ["open", "in_progress", "complete", "na"];
    if (status !== undefined && !allowed.includes(status)) {
      res.status(400).json({ error: "status must be open, in_progress, or complete" });
      return;
    }
    try {
      // Open items can be in any repo's DB — find which one has this ID
      const oidb = await findInDbs((d) => d.openItem.findUnique({ where: { id }, select: { id: true } }));
      if (!oidb) { res.status(404).json({ error: "Not found" }); return; }
      const updated = await oidb.db.openItem.update({
        where: { id },
        data: {
          ...(status !== undefined ? { status } : {}),
          ...(subSessionId !== undefined ? { subSessionId } : {}),
        },
      });
      res.json({ id: updated.id, status: updated.status, subSessionId: updated.subSessionId });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/sessions/spawn
  app.post("/api/sessions/spawn", async (req, res) => {
    const { prompt, cwd, openItemIds, parentSessionId } = req.body as { prompt?: string; cwd?: string; openItemIds?: number[]; parentSessionId?: string };
    if (!prompt || typeof prompt !== "string") {
      res.status(400).json({ error: "prompt is required" });
      return;
    }
    try {
      const safeCwd = (cwd ?? process.env.HOME ?? "/tmp").replace(/'/g, "'\\''");
      const safePrompt = prompt.replace(/'/g, "'\\''").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      // Pass open item IDs and parent session so the SessionStart hook can link back
      const envParts: string[] = [];
      if (openItemIds?.length) envParts.push(`GOSSAMER_SPAWN_OPEN_ITEMS='${openItemIds.join(",")}'`);
      if (parentSessionId) envParts.push(`GOSSAMER_SPAWN_PARENT_SESSION='${parentSessionId.replace(/'/g, "")}'`);
      const envPrefix = envParts.length ? envParts.join(" ") + " " : "";
      // Use AppleScript to open a new Terminal window running claude interactively
      const script = [
        `tell application "Terminal"`,
        `  activate`,
        `  do script "cd '${safeCwd}' && ${envPrefix}claude '${safePrompt}'"`,
        `end tell`,
      ].join("\n");
      execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
      // Mark selected open items as in_progress (in the correct DB)
      if (openItemIds?.length) {
        const spawnDb = cwd ? dbForRepo(cwd) : null;
        if (spawnDb) {
          await spawnDb.openItem.updateMany({
            where: { id: { in: openItemIds } },
            data: { status: "in_progress" },
          });
        }
      }
      res.json({ started: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/sessions/:id/resume
  // POST /api/sessions/:id/archive — hide session from main listing
  app.post("/api/sessions/:id/archive", async (req, res) => {
    try {
      const qLocalPath = typeof req.query.localPath === "string" ? req.query.localPath : (typeof req.body?.localPath === "string" ? req.body.localPath : null);
      const sdb = await resolveDb(qLocalPath, (d) => d.shadowSession.findUnique({ where: { sessionId: req.params.id }, select: { sessionId: true } }));
      if (!sdb) { res.status(404).json({ error: "Session not found" }); return; }
      await sdb.archivedSession.upsert({
        where: { sessionId: req.params.id },
        create: { sessionId: req.params.id },
        update: {},
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // DELETE /api/sessions/:id/archive — un-hide session
  app.delete("/api/sessions/:id/archive", async (req, res) => {
    try {
      const qLocalPath = typeof req.query.localPath === "string" ? req.query.localPath : null;
      const sdb = await resolveDb(qLocalPath, (d) => d.archivedSession.findFirst({ where: { sessionId: req.params.id }, select: { sessionId: true } }));
      if (!sdb) { res.status(404).json({ error: "Session not found" }); return; }
      await sdb.archivedSession.deleteMany({ where: { sessionId: req.params.id } });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/api/sessions/:id/resume", (req, res) => {
    const sessionId = req.params.id;
    const { cwd } = req.body as { cwd?: string };
    try {
      const safeCwd = (repoDir ?? cwd ?? process.env.HOME ?? "/tmp").replace(/'/g, "'\\''");
      const safeId = sessionId.replace(/'/g, "");
      const script = [
        `tell application "Terminal"`,
        `  activate`,
        `  do script "cd '${safeCwd}' && claude resume ${safeId}"`,
        `end tell`,
      ].join("\n");
      execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
      res.json({ started: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/search?q=TEXT[&limit=N] — searches across all repo DBs
  app.get("/api/search", async (req, res) => {
    const q     = typeof req.query.q     === "string" ? decodeURIComponent(req.query.q.trim()) : "";
    const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit)  : 50;
    if (!q) { res.status(400).json({ error: "q is required" }); return; }
    try {
      const maxPerDb = Math.min(limit, 200);
      // Search all DBs and merge results
      const allResults = (await Promise.all(allDbs().map(async (rdb) => {
        try { return await searchLogContent(rdb, q, maxPerDb); }
        catch { return []; } // FTS syntax error — skip this DB
      }))).flat();

      // Sort by rank (lower = better match) and limit
      allResults.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
      const results = allResults.slice(0, maxPerDb);

      const sessionIds = [...new Set(results.map((r) => r.sessionId))];
      // Gather user info from all DBs
      const sessionUserMap = new Map<string, { gitUserName: string | null; gitUserEmail: string | null }>();
      if (sessionIds.length > 0) {
        await Promise.all(allDbs().map(async (rdb) => {
          const metas = await rdb.checkpointSessionMetadata.findMany({
            where: { sessionId: { in: sessionIds } },
            select: { sessionId: true, checkpointId: true },
            distinct: ["sessionId"],
            orderBy: { createdAt: "desc" },
          });
          if (metas.length === 0) return;
          const cpIds = [...new Set(metas.map((m) => m.checkpointId))];
          const cpUsers = await rdb.checkpointMetadata.findMany({
            where: { checkpointId: { in: cpIds } },
            select: { checkpointId: true, gitUserName: true, gitUserEmail: true },
          });
          const cpUserMap = new Map(cpUsers.map((r) => [r.checkpointId, r]));
          for (const m of metas) {
            const u = cpUserMap.get(m.checkpointId);
            if (u && !sessionUserMap.has(m.sessionId)) {
              sessionUserMap.set(m.sessionId, { gitUserName: u.gitUserName, gitUserEmail: u.gitUserEmail });
            }
          }
        }));
      }
      res.json(results.map((r) => {
        const u = sessionUserMap.get(r.sessionId);
        return { ...r, gitUserName: u?.gitUserName || null, gitUserEmail: u?.gitUserEmail || null };
      }));
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  // ─── Repo config endpoints ───────────────────────────────────────────────────

  // GET /api/repos/status — per-repo current branch + latest checkpoint
  app.get("/api/repos/status", async (_req, res) => {
    try {
      const repos = readConfig().repos;
      const statuses = await Promise.all(repos.map(async (repo) => {
        let currentBranch: string | null = null;
        try {
          const { stdout } = await exec(`git -C ${JSON.stringify(repo.localPath)} branch --show-current`);
          currentBranch = stdout.trim() || null;
        } catch { /* not a git repo or path missing */ }
        if (!currentBranch) {
          try {
            const { stdout } = await exec(`git -C ${JSON.stringify(repo.localPath)} symbolic-ref --short HEAD`);
            currentBranch = stdout.trim() || null;
          } catch { /* detached HEAD or not a git repo */ }
        }

        let latestCheckpointId: string | null = null;
        let gitUserName: string | null = null;
        let gitUserEmail: string | null = null;
        try {
          const repoDb = dbRegistry.get(repo.dbPath) ?? await getDb(repo.dbPath);
          const latest = await repoDb.checkpointMetadata.findFirst({
            orderBy: { id: "desc" },
            select: { checkpointId: true, gitUserName: true, gitUserEmail: true },
          });
          latestCheckpointId = latest?.checkpointId ?? null;
          gitUserName       = latest?.gitUserName  ?? null;
          gitUserEmail      = latest?.gitUserEmail ?? null;
        } catch { /* db may not exist yet */ }

        if (!gitUserName && !gitUserEmail) {
          const u = getGitUser(repo.localPath);
          gitUserName  = u.name;
          gitUserEmail = u.email;
        }

        return { name: repo.name, localPath: repo.localPath, remote: repo.remote, currentBranch, latestCheckpointId, gitUserName, gitUserEmail };
      }));
      res.json(statuses);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/branches?localPath=<> — list local git branches for a repo
  app.get("/api/branches", async (req, res) => {
    try {
      const localPath = typeof req.query.localPath === "string" ? req.query.localPath : null;
      if (!localPath) {
        res.status(400).json({ error: "localPath is required" });
        return;
      }
      const { stdout } = await exec(`git -C ${JSON.stringify(localPath)} branch`);
      const branches = stdout
        .split("\n")
        .map((l) => l.replace(/^\*\s*/, "").trim())
        .filter(Boolean);
      res.json(branches);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/repos — list all repos from ~/.gossamer/config.json
  app.get("/api/repos", (_req, res) => {
    try {
      res.json(readConfig().repos);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/repos/current — return the config entry for a given repo (or the server's startup repo)
  app.get("/api/repos/current", (req, res) => {
    try {
      const qLocalPath = typeof req.query.localPath === "string" ? req.query.localPath : null;
      const targetDir = qLocalPath ?? repoDir;
      const current = targetDir
        ? readConfig().repos.find((r) => r.localPath === targetDir) ?? null
        : null;
      res.json(current);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/repos — add or update a repo { name, remote, localPath }; dbPath is auto-derived
  app.post("/api/repos", async (req, res) => {
    try {
      const { name, remote, localPath, checkpointRemote } = req.body as Partial<RepoConfig>;
      if (!name || !localPath) {
        res.status(400).json({ error: "name and localPath are required" });
        return;
      }
      // Preserve existing dbPath on re-onboard so we don't orphan an existing db.
      // For new repos, always derive a per-repo DB path — never inherit the
      // server's primary dbPath, which may be a legacy shared database.
      const existing = findRepo(localPath);
      const resolvedDbPath = existing?.dbPath ?? defaultDbPath(name);
      const entry: RepoConfig = {
        name,
        remote: remote ?? "",
        localPath,
        dbPath: resolvedDbPath,
        ...(checkpointRemote ? { checkpointRemote } : {}),
      };
      addRepo(entry);
      mkdirSync(dirname(entry.dbPath), { recursive: true });
      const repoDb = await getDb(entry.dbPath);
      process.stderr.write(`repo onboard [${name}]: pushing schema to ${entry.dbPath}\n`);
      try {
        await pushSchema(repoDb);
        await setupLogContentFts(repoDb);
        process.stderr.write(`repo onboard [${name}]: schema ready\n`);
      } catch (err) {
        // Non-fatal: schema may already be applied
        process.stderr.write(`repo onboard [${name}]: schema push warning — ${err}\n`);
      }
      // Register in the live DB registry
      dbRegistry.set(entry.dbPath, repoDb);

      // Kick off initial indexing in the background — don't block the response
      void indexCheckpointsForRepo(name, localPath, entry.dbPath);
      void indexShadowsForRepo(name, localPath, entry.dbPath);
      void indexLiveForRepo(name, localPath, entry.dbPath);

      // Start file/git watchers for the newly registered repo
      startDbWatcher(entry.dbPath, name);
      startGitWatcher(localPath, name, entry.dbPath);
      startLiveWatcher(localPath, name, entry.dbPath);

      res.status(201).json(entry);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // DELETE /api/repos — remove a repo by localPath { localPath }
  app.delete("/api/repos", (req, res) => {
    try {
      const { localPath } = req.body as { localPath?: string };
      if (!localPath) {
        res.status(400).json({ error: "localPath is required" });
        return;
      }
      // Remove from live registry
      const repo = findRepoForPath(localPath);
      if (repo) dbRegistry.delete(repo.dbPath);
      removeRepo(localPath);
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Create HTTP server and attach WebSocket server (shared port)
  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer });

  // ── Terminal WebSocket connections ────────────────────────────────────────
  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.searchParams.get("type") !== "terminal") return;

    const rawCwd = url.searchParams.get("cwd") ?? "";
    const cwd = rawCwd && existsSync(rawCwd) ? rawCwd : (process.env.HOME ?? "/");
    const shell = process.env.SHELL ?? "/bin/bash";

    // node-pty requires a clean env with no undefined values
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    // Ensure TERM is set so ncurses apps work
    env.TERM = "xterm-256color";

    const term = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd,
      env,
    });

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "data", data }));
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type: string; data?: string; cols?: number; rows?: number };
        if (msg.type === "data" && msg.data) term.write(msg.data);
        if (msg.type === "resize" && msg.cols && msg.rows) term.resize(msg.cols, msg.rows);
      } catch { /* ignore malformed */ }
    });

    ws.on("close", () => { try { term.kill(); } catch { /* already dead */ } });
  });

  const broadcast = () => {
    const message = JSON.stringify({ type: "sessions_updated" });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  };

  // ── WebSocket change detection — file watchers + fallback poll ──────────────

  // Per-db watermarks keyed by dbPath
  const wsWatermarks = new Map<string, { logEvent: number | null; checkpoint: number | null; shadow: number | null }>();

  const dbFileWatchers  = new Map<string, FSWatcher[]>();
  const gitRefWatchers  = new Map<string, FSWatcher[]>();
  const liveMetaWatchers = new Map<string, FSWatcher[]>();
  const dbDebounceTimers  = new Map<string, ReturnType<typeof setTimeout>>();
  const gitDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const liveDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  async function checkDbAndBroadcast(p: string, label: string): Promise<void> {
    try {
      const repoDb = await getDb(p);
      const [latestLogEvent, latestCheckpoint, latestShadow] = await Promise.all([
        repoDb.logEvent.findFirst({ orderBy: { id: "desc" }, select: { id: true } }),
        repoDb.checkpointMetadata.findFirst({ orderBy: { id: "desc" }, select: { id: true } }),
        repoDb.shadowSession.findFirst({ orderBy: { id: "desc" }, select: { id: true } }),
      ]);
      const cur = {
        logEvent:   latestLogEvent?.id   ?? null,
        checkpoint: latestCheckpoint?.id ?? null,
        shadow:     latestShadow?.id     ?? null,
      };
      const prev = wsWatermarks.get(p);
      if (!prev || prev.logEvent !== cur.logEvent || prev.checkpoint !== cur.checkpoint || prev.shadow !== cur.shadow) {
        wsWatermarks.set(p, cur);
        process.stderr.write(`file watcher [${label}]: change detected — broadcasting\n`);
        broadcast();
      }
    } catch { /* non-fatal — db may not exist yet */ }
  }

  function startDbWatcher(p: string, label: string): void {
    if (dbFileWatchers.has(p)) return;
    const watchers: FSWatcher[] = [];

    const trigger = () => {
      const existing = dbDebounceTimers.get(p);
      if (existing) clearTimeout(existing);
      dbDebounceTimers.set(p, setTimeout(() => {
        dbDebounceTimers.delete(p);
        void checkDbAndBroadcast(p, label);
      }, 50));
    };

    // Watch the DB file itself (updated on WAL checkpoint)
    if (existsSync(p)) {
      try { watchers.push(fsWatch(p, trigger)); } catch { /* ok */ }
    }
    // Watch the WAL file — updated on every write in WAL mode
    const walPath = p + "-wal";
    if (existsSync(walPath)) {
      try { watchers.push(fsWatch(walPath, trigger)); } catch { /* ok */ }
    }
    // Watch the parent directory to catch the WAL file appearing and DB creation
    const dir = dirname(p);
    const base = basename(p);
    try {
      watchers.push(fsWatch(dir, (_evt, filename) => {
        if (filename === base || filename === base + "-wal") trigger();
      }));
    } catch { /* ok */ }

    if (watchers.length > 0) {
      dbFileWatchers.set(p, watchers);
      process.stderr.write(`file watcher: watching ${p}\n`);
    }
  }

  function startGitWatcher(localPath: string, repoName: string, repoDdPath: string): void {
    if (gitRefWatchers.has(localPath)) return;
    const watchers: FSWatcher[] = [];

    const trigger = () => {
      const existing = gitDebounceTimers.get(localPath);
      if (existing) clearTimeout(existing);
      gitDebounceTimers.set(localPath, setTimeout(() => {
        gitDebounceTimers.delete(localPath);
        void indexShadowsForRepo(repoName, localPath, repoDdPath);
      }, 200));
    };

    const gitDir = join(localPath, ".git");
    if (existsSync(gitDir)) {
      // Watch .git/ (non-recursive) for packed-refs and FETCH_HEAD changes
      try {
        watchers.push(fsWatch(gitDir, (_evt, filename) => {
          if (filename === "packed-refs" || filename === "FETCH_HEAD") trigger();
        }));
      } catch { /* ok */ }
      // Watch .git/refs/ recursively for loose ref updates
      const refsDir = join(gitDir, "refs");
      if (existsSync(refsDir)) {
        try { watchers.push(fsWatch(refsDir, { recursive: true }, trigger)); } catch { /* ok */ }
      }
    }

    if (watchers.length > 0) {
      gitRefWatchers.set(localPath, watchers);
      process.stderr.write(`git watcher: watching ${join(localPath, ".git")}\n`);
    }
  }

  /**
   * Watch `.entire/metadata/` for changes to `full.jsonl` files and index them
   * directly from disk. This surfaces brand-new sessions within ~300ms instead
   * of waiting for Entire to commit them to a shadow branch (which can take
   * minutes, since commits happen only at checkpoint boundaries).
   */
  function startLiveWatcher(localPath: string, repoName: string, repoDdPath: string): void {
    if (liveMetaWatchers.has(localPath)) return;
    const metaDir = join(localPath, ".entire", "metadata");
    if (!existsSync(metaDir)) return;
    const watchers: FSWatcher[] = [];

    const trigger = () => {
      const existing = liveDebounceTimers.get(localPath);
      if (existing) clearTimeout(existing);
      liveDebounceTimers.set(localPath, setTimeout(() => {
        liveDebounceTimers.delete(localPath);
        void indexLiveForRepo(repoName, localPath, repoDdPath);
      }, 300));
    };

    try {
      watchers.push(fsWatch(metaDir, { recursive: true }, (_evt, filename) => {
        // Only react to transcript file writes to avoid thrash from tmp files.
        if (!filename) { trigger(); return; }
        const name = String(filename);
        if (name.endsWith("full.jsonl") || name.endsWith("prompt.txt")) trigger();
      }));
    } catch { /* recursive watch unsupported — fall back to polling */ }

    if (watchers.length > 0) {
      liveMetaWatchers.set(localPath, watchers);
      process.stderr.write(`live watcher: watching ${metaDir}\n`);
    }
  }

  // Start watchers for all configured repos
  for (const r of readConfig().repos) {
    startDbWatcher(r.dbPath, r.name);
    startGitWatcher(r.localPath, r.name, r.dbPath);
    startLiveWatcher(r.localPath, r.name, r.dbPath);
  }

  // Fallback poll — catches any events missed by the file watchers
  const poller = setInterval(async () => {
    const repos = readConfig().repos;
    const labels = new Map(repos.map((r): [string, string] => [r.dbPath, r.name]));
    await Promise.all(repos.map((r) => checkDbAndBroadcast(r.dbPath, labels.get(r.dbPath) ?? r.name)));
  }, 30_000);

  // ── Per-repo indexer helpers ───────────────────────────────────────────────

  const CHECKPOINT_BRANCH = "entire/checkpoints/v1";

  /** Clone or fetch a bare repo for a checkpoint remote. Returns the bare repo path. */
  async function ensureCheckpointRepo(repoName: string, checkpointRemote: string): Promise<string> {
    const bareRepoPath = checkpointRepoPath(repoName);
    if (!existsSync(bareRepoPath)) {
      mkdirSync(dirname(bareRepoPath), { recursive: true });
      process.stderr.write(`checkpoint indexer [${repoName}]: cloning checkpoint remote ${checkpointRemote}\n`);
      await exec(`git clone --bare ${JSON.stringify(checkpointRemote)} ${JSON.stringify(bareRepoPath)}`, { timeout: 30_000 });
    } else {
      await exec(`git -C ${JSON.stringify(bareRepoPath)} fetch origin`, { timeout: 10_000 });
    }
    return bareRepoPath;
  }

  /** Create a worktree for the checkpoint branch from a bare checkpoint repo. */
  async function ensureWorktreeFromBare(bareRepoPath: string, localPath: string): Promise<string> {
    const worktreePath = join(localPath, ".gossamer", "checkpoints");
    mkdirSync(join(localPath, ".gossamer"), { recursive: true });
    if (!existsSync(worktreePath)) {
      try {
        execSync(`git -C ${JSON.stringify(bareRepoPath)} worktree prune`, { stdio: "pipe" });
        execSync(
          `git -C ${JSON.stringify(bareRepoPath)} worktree add --detach ${JSON.stringify(worktreePath)} ${CHECKPOINT_BRANCH}`,
          { stdio: "pipe" },
        );
        process.stderr.write(`checkpoint indexer: worktree created at ${worktreePath} (from bare repo)\n`);
      } catch (err) {
        process.stderr.write(`checkpoint indexer: failed to create worktree from bare repo — ${err}\n`);
      }
    }
    return worktreePath;
  }

  async function ensureWorktree(localPath: string): Promise<string> {
    const worktreePath = join(localPath, ".gossamer", "checkpoints");
    mkdirSync(join(localPath, ".gossamer"), { recursive: true });
    if (!existsSync(worktreePath)) {
      try {
        execSync(`git -C ${JSON.stringify(localPath)} worktree prune`, { stdio: "pipe" });
        execSync(
          `git -C ${JSON.stringify(localPath)} worktree add --detach ${JSON.stringify(worktreePath)} ${CHECKPOINT_BRANCH}`,
          { stdio: "pipe" },
        );
        process.stderr.write(`checkpoint indexer: worktree created at ${worktreePath}\n`);
      } catch (err) {
        process.stderr.write(`checkpoint indexer: failed to create worktree for ${localPath} — ${err}\n`);
      }
    }
    return worktreePath;
  }

  async function indexCheckpointsForRepo(name: string, localPath: string, repoDdPath: string): Promise<void> {
    process.stderr.write(`checkpoint indexer [${name}]: running\n`);
    try {
      const repo = findRepo(localPath);
      const checkpointRemoteUrl = repo?.checkpointRemote;

      let worktreePath: string;
      if (checkpointRemoteUrl) {
        const bareRepoPath = await ensureCheckpointRepo(name, checkpointRemoteUrl);
        worktreePath = await ensureWorktreeFromBare(bareRepoPath, localPath);
      } else {
        worktreePath = await ensureWorktree(localPath);
      }

      if (!existsSync(worktreePath)) return;

      if (!checkpointRemoteUrl) {
        try {
          await exec(`git -C ${JSON.stringify(worktreePath)} fetch origin ${CHECKPOINT_BRANCH}`, { timeout: 10_000 });
        } catch { /* remote unavailable — index local state */ }
      }

      try {
        // Bare checkpoint repos store fetched refs at refs/heads/* (no remotes namespace).
        // Standard repos have refs/remotes/origin/* after fetch.
        const resetRef = checkpointRemoteUrl
          ? `refs/heads/${CHECKPOINT_BRANCH}`
          : `refs/remotes/origin/${CHECKPOINT_BRANCH}`;
        await exec(`git -C ${JSON.stringify(worktreePath)} reset --hard ${resetRef}`);
      } catch {
        // Fallback to local branch ref (e.g. no remote configured)
        try {
          await exec(`git -C ${JSON.stringify(worktreePath)} reset --hard refs/heads/${CHECKPOINT_BRANCH}`);
        } catch { /* non-fatal */ }
      }

      const repoDb = await getDb(repoDdPath);
      const { checkpoints } = await indexAllCheckpointsV2(repoDb, worktreePath, undefined, localPath);
      if (checkpoints > 0) {
        process.stderr.write(`checkpoint indexer [${name}]: indexed ${checkpoints} new checkpoint(s)\n`);
        broadcast();
      } else {
        process.stderr.write(`checkpoint indexer [${name}]: up to date\n`);
      }
    } catch (err) {
      process.stderr.write(`checkpoint indexer [${name}]: error — ${err}\n`);
    }
  }

  async function indexShadowsForRepo(name: string, localPath: string, repoDdPath: string): Promise<void> {
    process.stderr.write(`shadow indexer [${name}]: running\n`);
    refreshCustomTitles(localPath);
    try {
      const repoDb = await getDb(repoDdPath);
      const { sessions } = await indexAllShadowBranches(repoDb, localPath);
      if (sessions > 0) {
        process.stderr.write(`shadow indexer [${name}]: indexed ${sessions} new session(s)\n`);
        broadcast();
      } else {
        process.stderr.write(`shadow indexer [${name}]: up to date\n`);
      }
    } catch (err) {
      process.stderr.write(`shadow indexer [${name}]: error — ${err}\n`);
    }
  }

  async function indexLiveForRepo(name: string, localPath: string, repoDdPath: string): Promise<void> {
    try {
      const repoDb = await getDb(repoDdPath);
      const { sessions } = await indexLiveSessions(repoDb, localPath);
      if (sessions > 0) {
        process.stderr.write(`live indexer [${name}]: indexed ${sessions} live session(s)\n`);
        broadcast();
      }
    } catch (err) {
      process.stderr.write(`live indexer [${name}]: error — ${err}\n`);
    }
  }

  // ── Checkpoint auto-indexer — all repos, every 30s ────────────────────────

  const runAllCheckpoints = async () => {
    const repos = readConfig().repos;
    await Promise.all(repos.map((r) => indexCheckpointsForRepo(r.name, r.localPath, r.dbPath)));
  };

  // Seed the custom title cache for the primary repo immediately
  if (repoDir) refreshCustomTitles(repoDir);

  void runAllCheckpoints();
  const checkpointPoller = setInterval(runAllCheckpoints, 30_000);
  process.stderr.write(`checkpoint indexer: polling every 30s across ${readConfig().repos.length} repo(s)\n`);

  // ── Shadow branch indexer — git watchers + fallback poll ─────────────────────

  const runAllShadows = async () => {
    const repos = readConfig().repos;
    await Promise.all(repos.map((r) => indexShadowsForRepo(r.name, r.localPath, r.dbPath)));
  };

  void runAllShadows();
  // Fallback: re-index every 30s in case git watchers miss an event
  const shadowPoller = setInterval(runAllShadows, 30_000);
  process.stderr.write(`shadow indexer: git watchers active, fallback poll every 30s\n`);

  // ── Live session indexer — reads .entire/metadata/ directly from disk ──────
  // This catches new sessions seconds after they start, well before Entire
  // commits them to a shadow branch.

  const runAllLive = async () => {
    const repos = readConfig().repos;
    await Promise.all(repos.map((r) => indexLiveForRepo(r.name, r.localPath, r.dbPath)));
  };

  void runAllLive();
  // fs.watch on macOS can drop events for files written by other processes,
  // so poll every 3s as a safety net — reads are cheap (mtime+size comparison).
  const livePoller = setInterval(runAllLive, 3_000);
  process.stderr.write(`live indexer: fs watchers active, fallback poll every 3s\n`);

  // POST /api/sessions/sync — force immediate re-index of all shadow branches
  app.post("/api/sessions/sync", async (_req, res) => {
    try {
      await runAllShadows();
      broadcast();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Graceful shutdown
  const shutdown = () => {
    clearInterval(poller);
    clearInterval(checkpointPoller);
    clearInterval(shadowPoller);
    clearInterval(livePoller);
    for (const ws of dbFileWatchers.values()) for (const w of ws) w.close();
    for (const ws of gitRefWatchers.values()) for (const w of ws) w.close();
    for (const ws of liveMetaWatchers.values()) for (const w of ws) w.close();
    void mcpTransport.close();
    httpServer.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // ── Embedded MCP server (streamable-HTTP transport at /mcp) ─────────────────

  const mcpTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await createMcpServer(port).connect(mcpTransport);
  // Handle both POST (tool calls) and GET (SSE for server notifications)
  app.all("/mcp", async (req, res) => {
    await mcpTransport.handleRequest(req, res, req.body);
  });
  process.stderr.write(`MCP server: listening at http://localhost:${port}/mcp\n`);

  await new Promise<void>((resolve, reject) => {
    httpServer.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        process.stderr.write(`[gossamer] FATAL: port ${port} is already in use. Kill the existing process or choose a different port in ~/.gossamer/config.json.\n`);
      }
      reject(err);
    });
    httpServer.listen(port, () => {
      process.stderr.write(`claude-hook-handler serve: listening on http://localhost:${port}\n`);
      resolve();
    });
  });
}
