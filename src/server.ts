import express from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import { execSync, exec as execCb } from "child_process";
import { promisify } from "util";

const exec = promisify(execCb);
import { existsSync, mkdirSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { getDb } from "./db.js";
import type { PrismaClient } from "../prisma/generated/client/index.js";
import { indexAllCheckpointsV2, indexAllShadowBranches } from "./indexer.js";
import { setupLogContentFts, syncLogContentFts, searchLogContent } from "./search.js";
import { readConfig, addRepo, removeRepo, findRepo, defaultDbPath, type RepoConfig } from "./config.js";

// ─── Schema push ──────────────────────────────────────────────────────────────

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRISMA_BIN   = join(PROJECT_ROOT, "node_modules", ".bin", "prisma");

async function pushSchema(dbFilePath: string): Promise<void> {
  await exec(`${JSON.stringify(PRISMA_BIN)} db push`, {
    env: { ...process.env, DATABASE_URL: `file:${dbFilePath}` },
    cwd: PROJECT_ROOT,
  });
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

export async function startServer(dbPath: string, port: number, repoDir?: string): Promise<void> {
  // Strip CLAUDECODE so spawned sessions are not blocked by nested-session detection
  delete process.env.CLAUDECODE;

  const db = await getDb(dbPath);

  // Ensure FTS table exists and is up-to-date on startup
  await setupLogContentFts(db);
  await syncLogContentFts(db);

  const app = express();
  app.use(cors());
  app.use(express.json());

  // Resolve git user and repo name from repo config once at startup
  const gitUser  = getGitUser(repoDir);
  const repoName = repoDir ? basename(repoDir) : null;

  // GET /api/sessions — reconstructed from CheckpointSessionMetadata + ShadowSession
  app.get("/api/sessions", async (_req, res) => {
    try {
      // Latest checkpoint meta per sessionId (asc order so map always ends on latest)
      const allMetas = await db.checkpointSessionMetadata.findMany({
        select: {
          sessionId: true,
          checkpointId: true,
          branch: true,
          summary: { select: { intent: true } },
        },
        orderBy: { createdAt: "asc" },
      });
      const cpMap = new Map<string, { branch: string | null; intent: string | null; checkpointId: string }>();
      for (const m of allMetas) {
        cpMap.set(m.sessionId, { branch: m.branch, intent: m.summary?.intent ?? null, checkpointId: m.checkpointId });
      }

      // Git user per checkpoint (from commit author stored at index time)
      const allCheckpointIds = [...new Set(allMetas.map((m) => m.checkpointId))];
      const cpUserRows = allCheckpointIds.length > 0
        ? await db.checkpointMetadata.findMany({
            where: { checkpointId: { in: allCheckpointIds } },
            select: { checkpointId: true, gitUserName: true, gitUserEmail: true },
          })
        : [];
      const cpUserMap = new Map(cpUserRows.map((r) => [r.checkpointId, r]));

      const shadows = await db.shadowSession.findMany();
      const shadowMap = new Map(shadows.map((s) => [s.sessionId, s]));

      const allIds = [...new Set([...cpMap.keys(), ...shadows.map((s) => s.sessionId)])];
      if (allIds.length === 0) {
        res.json([]);
        return;
      }

      // Min/max LogEvent timestamps per session
      const times = await db.logEvent.groupBy({
        by: ["sessionId"],
        where: { sessionId: { in: allIds }, timestamp: { not: null } },
        _min: { timestamp: true },
        _max: { timestamp: true },
      });
      const timeMap = new Map(
        times.map((r) => [r.sessionId!, { startedAt: r._min.timestamp, updatedAt: r._max.timestamp }])
      );

      // First cwd per session
      const cwdRows = await db.logEvent.findMany({
        where: { sessionId: { in: allIds }, cwd: { not: null } },
        distinct: ["sessionId"],
        orderBy: { id: "asc" },
        select: { sessionId: true, cwd: true },
      });
      const cwdMap = new Map(cwdRows.map((e) => [e.sessionId!, e.cwd]));

      const result: SessionResponse[] = allIds.map((sessionId) => {
        const cp     = cpMap.get(sessionId) ?? null;
        const shadow = shadowMap.get(sessionId) ?? null;
        const t      = timeMap.get(sessionId);
        const startedAt = t?.startedAt ?? shadow?.createdAt ?? null;
        const updatedAt = t?.updatedAt ?? shadow?.createdAt ?? null;
        const cpUser = cp ? cpUserMap.get(cp.checkpointId) ?? null : null;
        return {
          sessionId,
          startedAt: startedAt?.toISOString() ?? new Date(0).toISOString(),
          updatedAt: updatedAt?.toISOString() ?? new Date(0).toISOString(),
          cwd:             cwdMap.get(sessionId) ?? shadow?.cwd ?? "",
          repoRoot:        repoDir ?? null,
          repoName:        repoName,
          parentSessionId: null,
          childSessionIds: [],
          gitUserName:     cpUser?.gitUserName ?? gitUser.name,
          gitUserEmail:    cpUser?.gitUserEmail ?? gitUser.email,
          prompt:          shadow?.prompt ?? null,
          summary:         null,
          keywords:        [],
          branch:          cp?.branch ?? shadow?.gitBranch ?? null,
          intent:          cp?.intent ?? null,
          isLive:          shadow !== null,
        };
      });

      result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/sessions/:id
  app.get("/api/sessions/:id", async (req, res) => {
    try {
      const id = req.params.id;
      const [latestMeta, shadow, firstEvent, lastEvent] = await Promise.all([
        db.checkpointSessionMetadata.findFirst({
          where: { sessionId: id },
          select: { branch: true, checkpointId: true, summary: { select: { intent: true } } },
          orderBy: { createdAt: "desc" },
        }),
        db.shadowSession.findUnique({ where: { sessionId: id } }),
        db.logEvent.findFirst({
          where: { sessionId: id },
          orderBy: { id: "asc" },
          select: { cwd: true, timestamp: true },
        }),
        db.logEvent.findFirst({
          where: { sessionId: id, timestamp: { not: null } },
          orderBy: { id: "desc" },
          select: { timestamp: true },
        }),
      ]);
      if (!latestMeta && !shadow) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      const cpMeta = latestMeta
        ? await db.checkpointMetadata.findUnique({
            where: { checkpointId: latestMeta.checkpointId },
            select: { gitUserName: true, gitUserEmail: true },
          })
        : null;
      const startedAt = firstEvent?.timestamp ?? shadow?.createdAt ?? null;
      const updatedAt = lastEvent?.timestamp  ?? shadow?.createdAt ?? null;
      res.json({
        sessionId:       id,
        startedAt:       startedAt?.toISOString() ?? new Date(0).toISOString(),
        updatedAt:       updatedAt?.toISOString() ?? new Date(0).toISOString(),
        cwd:             firstEvent?.cwd ?? shadow?.cwd ?? "",
        repoRoot:        repoDir ?? null,
        repoName:        repoName,
        parentSessionId: null,
        childSessionIds: [],
        gitUserName:     cpMeta?.gitUserName ?? gitUser.name,
        gitUserEmail:    cpMeta?.gitUserEmail ?? gitUser.email,
        prompt:          shadow?.prompt ?? null,
        summary:         null,
        keywords:        [],
        branch:          latestMeta?.branch ?? shadow?.gitBranch ?? null,
        intent:          latestMeta?.summary?.intent ?? null,
        isLive:          shadow !== null,
      } satisfies SessionResponse);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/sessions/:id/overview
  app.get("/api/sessions/:id/overview", async (req, res) => {
    try {
      const overview = await db.interactionOverview.findUnique({
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
      const events = await db.logEvent.findMany({
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

  // GET /api/v2/checkpoints
  app.get("/api/v2/checkpoints", async (_req, res) => {
    try {
      const checkpoints = await db.checkpointMetadata.findMany({
        include: {
          tokenUsage: true,
          filesTouched: { include: { filePath: true } },
        },
      });

      const checkpointIds = checkpoints.map((c) => c.checkpointId);

      const sessions = await db.checkpointSessionMetadata.findMany({
        where:   { checkpointId: { in: checkpointIds } },
        orderBy: V2_SESSION_ORDER,
        include: V2_SESSION_INCLUDE,
      });

      // Group sessions by checkpointId
      const sessionsByCheckpoint = new Map<string, typeof sessions>();
      for (const s of sessions) {
        const arr = sessionsByCheckpoint.get(s.checkpointId) ?? [];
        arr.push(s);
        sessionsByCheckpoint.set(s.checkpointId, arr);
      }

      res.json(checkpoints.map((c) => {
        const cpSessions = sessionsByCheckpoint.get(c.checkpointId) ?? [];
        const summary = cpSessions.find((s) => s.summary)?.summary ?? null;
        const latestCreatedAt = cpSessions
          .filter((s): s is typeof s & { createdAt: Date } => s.createdAt !== null)
          .map((s) => s.createdAt)
          .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
        return {
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
          localPath:     repoDir ?? null,
          summary: summary ? mapV2Summary(summary) : null,
        };
      }));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/v2/checkpoints/:id
  app.get("/api/v2/checkpoints/:id", async (req, res) => {
    try {
      const checkpointId = req.params.id;
      const qLocalPath = typeof req.query.localPath === "string" ? req.query.localPath : null;
      const repo = qLocalPath ? findRepo(qLocalPath) : null;
      const cdb = repo && repo.dbPath !== dbPath ? await getDb(repo.dbPath) : db;
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
      const repo = qLocalPath ? findRepo(qLocalPath) : null;
      const cdb = repo && repo.dbPath !== dbPath ? await getDb(repo.dbPath) : db;
      const cpLocalPath = repo ? repo.localPath : repoDir;
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
      const repo = qLocalPath ? findRepo(qLocalPath) : null;
      const cdb = repo && repo.dbPath !== dbPath ? await getDb(repo.dbPath) : db;
      const cpLocalPath = repo ? repo.localPath : repoDir;
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

  // GET /api/v2/sessions/:id/checkpoints
  app.get("/api/v2/sessions/:id/checkpoints", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const sessionRows = await db.checkpointSessionMetadata.findMany({
        where:   { sessionId },
        orderBy: { createdAt: "asc" },
        include: {
          ...V2_SESSION_INCLUDE,
          tokenUsage:   true,
          filesTouched: { include: { filePath: true } },
        },
      });

      res.json(sessionRows.map((s) => ({
        checkpointId: s.checkpointId,
        cliVersion:   s.cliVersion,
        branch:       s.branch,
        createdAt:    s.createdAt?.toISOString() ?? null,
        tokenUsage:   s.tokenUsage ? {
          inputTokens:         s.tokenUsage.inputTokens,
          cacheCreationTokens: s.tokenUsage.cacheCreationTokens,
          cacheReadTokens:     s.tokenUsage.cacheReadTokens,
          outputTokens:        s.tokenUsage.outputTokens,
          apiCallCount:        s.tokenUsage.apiCallCount,
        } : null,
        filesTouched: s.filesTouched.map((f) => f.filePath.path),
        summary:      s.summary ? mapV2Summary(s.summary) : null,
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

      const repo = findRepo(localPath);
      if (!repo) { res.status(404).json({ error: "Repo not found in config" }); return; }

      const repoDb = repo.dbPath === dbPath ? db : await getDb(repo.dbPath);

      // Walk git log and collect checkpoint IDs in commit order
      const orderedIds: string[] = [];
      const seenIds = new Set<string>();
      try {
        const { stdout: gitOut } = await exec(
          `git -C ${JSON.stringify(localPath)} log --format=%B%x1e --max-count=${PAGE_SIZE} --skip=${page * PAGE_SIZE} ${JSON.stringify(branch)}`,
          { timeout: 10_000 },
        );
        for (const body of gitOut.split("\x1e")) {
          const match = body.match(/^Entire-Checkpoint:\s*(\S+)$/m);
          if (match && !seenIds.has(match[1])) {
            seenIds.add(match[1]);
            orderedIds.push(match[1]);
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
            summary:   s.summary ? mapV2Summary(s.summary) : null,
          });
        }
      }

      res.json({ entries: result, hasMore: orderedIds.length === PAGE_SIZE });
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
      const updated = await db.openItem.update({
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
      // Mark selected open items as in_progress
      if (openItemIds?.length) {
        await db.openItem.updateMany({
          where: { id: { in: openItemIds } },
          data: { status: "in_progress" },
        });
      }
      res.json({ started: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/sessions/:id/resume
  app.post("/api/sessions/:id/resume", (req, res) => {
    const sessionId = req.params.id;
    const { cwd } = req.body as { cwd?: string };
    try {
      const safeCwd = (cwd ?? process.env.HOME ?? "/tmp").replace(/'/g, "'\\''");
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

  // GET /api/search?q=TEXT[&limit=N]
  app.get("/api/search", async (req, res) => {
    const q     = typeof req.query.q     === "string" ? req.query.q.trim()         : "";
    const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit)  : 50;
    if (!q) { res.status(400).json({ error: "q is required" }); return; }
    try {
      const results = await searchLogContent(db, q, Math.min(limit, 200));
      const sessionIds = [...new Set(results.map((r) => r.sessionId))];
      const sessionMetas = sessionIds.length > 0
        ? await db.checkpointSessionMetadata.findMany({
            where: { sessionId: { in: sessionIds } },
            select: { sessionId: true, checkpointId: true },
            distinct: ["sessionId"],
            orderBy: { createdAt: "desc" },
          })
        : [];
      const cpIds = [...new Set(sessionMetas.map((m) => m.checkpointId))];
      const cpUsers = cpIds.length > 0
        ? await db.checkpointMetadata.findMany({
            where: { checkpointId: { in: cpIds } },
            select: { checkpointId: true, gitUserName: true, gitUserEmail: true },
          })
        : [];
      const cpUserMap = new Map(cpUsers.map((r) => [r.checkpointId, r]));
      const sessionUserMap = new Map(sessionMetas.map((m) => {
        const u = cpUserMap.get(m.checkpointId);
        return [m.sessionId, { gitUserName: u?.gitUserName ?? null, gitUserEmail: u?.gitUserEmail ?? null }];
      }));
      res.json(results.map((r) => {
        const u = sessionUserMap.get(r.sessionId);
        return { ...r, gitUserName: u?.gitUserName ?? gitUser.name, gitUserEmail: u?.gitUserEmail ?? gitUser.email };
      }));
    } catch (err) {
      // FTS5 MATCH errors (bad syntax) come back as exceptions
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
          // Reuse the already-open primary db if this repo's dbPath matches
          const repoDb = repo.dbPath === dbPath ? db : await getDb(repo.dbPath);
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

  // GET /api/repos — list all repos from ~/.gossamer/config.json
  app.get("/api/repos", (_req, res) => {
    try {
      res.json(readConfig().repos);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/repos/current — return the config entry for the repo this server is running against
  app.get("/api/repos/current", (_req, res) => {
    try {
      const current = repoDir
        ? readConfig().repos.find((r) => r.localPath === repoDir) ?? null
        : null;
      res.json(current);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/repos — add or update a repo { name, remote, localPath }; dbPath is auto-derived
  app.post("/api/repos", async (req, res) => {
    try {
      const { name, remote, localPath } = req.body as Partial<RepoConfig>;
      if (!name || !localPath) {
        res.status(400).json({ error: "name and localPath are required" });
        return;
      }
      // Preserve existing dbPath on re-onboard so we don't orphan an existing db.
      // If this localPath is the repo the server is already serving, reuse the
      // server's primary dbPath so existing indexed data remains visible.
      const existing = findRepo(localPath);
      const resolvedDbPath =
        existing?.dbPath
        ?? (localPath === repoDir ? dbPath : null)
        ?? defaultDbPath(name);
      const entry: RepoConfig = {
        name,
        remote: remote ?? "",
        localPath,
        dbPath: resolvedDbPath,
      };
      addRepo(entry);
      mkdirSync(dirname(entry.dbPath), { recursive: true });
      process.stderr.write(`repo onboard [${name}]: pushing schema to ${entry.dbPath}\n`);
      try {
        await pushSchema(entry.dbPath);
        process.stderr.write(`repo onboard [${name}]: schema ready\n`);
      } catch (err) {
        // Non-fatal: schema may already be applied
        process.stderr.write(`repo onboard [${name}]: schema push warning — ${err}\n`);
      }

      // Kick off initial indexing in the background — don't block the response
      void indexCheckpointsForRepo(name, localPath, entry.dbPath);
      void indexShadowsForRepo(name, localPath, entry.dbPath);

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
      removeRepo(localPath);
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Create HTTP server and attach WebSocket server (shared port)
  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer });

  const broadcast = () => {
    const message = JSON.stringify({ type: "sessions_updated" });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  };

  // ── WebSocket change detection — poll every 2s across all known repo dbs ──

  // Per-db watermarks keyed by dbPath
  const wsWatermarks = new Map<string, { logEvent: number | null; checkpoint: number | null; shadow: number | null }>();

  const poller = setInterval(async () => {
    const repos = readConfig().repos;
    const nameByDbPath = new Map(repos.map((r) => [r.dbPath, r.name]));
    // Always include the primary db even if it isn't in config yet
    const dbPaths = [...new Set([dbPath, ...repos.map((r) => r.dbPath)])];
    let changed = false;
    await Promise.all(dbPaths.map(async (p) => {
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
          changed = true;
          const label = nameByDbPath.get(p) ?? p;
          process.stderr.write(`change poller [${label}]: change detected — broadcasting\n`);
        }
      } catch { /* non-fatal — db may not exist yet */ }
    }));
    if (changed) broadcast();
  }, 2000);

  // ── Per-repo indexer helpers ───────────────────────────────────────────────

  const CHECKPOINT_BRANCH = "entire/checkpoints/v1";

  async function ensureWorktree(localPath: string): Promise<string> {
    const worktreePath = join(localPath, ".gossamer", "checkpoints");
    mkdirSync(join(localPath, ".gossamer"), { recursive: true });
    if (!existsSync(worktreePath)) {
      try {
        execSync(`git -C ${JSON.stringify(localPath)} worktree prune`, { stdio: "pipe" });
        execSync(
          `git -C ${JSON.stringify(localPath)} worktree add ${JSON.stringify(worktreePath)} ${CHECKPOINT_BRANCH}`,
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
      const worktreePath = await ensureWorktree(localPath);
      if (!existsSync(worktreePath)) return;
      try {
        await exec(`git -C ${JSON.stringify(worktreePath)} fetch origin ${CHECKPOINT_BRANCH}`, { timeout: 10_000 });
      } catch { /* remote unavailable — index local state */ }
      try {
        await exec(`git -C ${JSON.stringify(worktreePath)} reset --hard refs/heads/${CHECKPOINT_BRANCH}`);
      } catch { /* non-fatal */ }
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

  // ── Checkpoint auto-indexer — all repos, every 30s ────────────────────────

  const runAllCheckpoints = async () => {
    const repos = readConfig().repos;
    await Promise.all(repos.map((r) => indexCheckpointsForRepo(r.name, r.localPath, r.dbPath)));
  };

  void runAllCheckpoints();
  const checkpointPoller = setInterval(runAllCheckpoints, 30_000);
  process.stderr.write(`checkpoint indexer: polling every 30s across ${readConfig().repos.length} repo(s)\n`);

  // ── Shadow branch indexer — all repos, every 5s ───────────────────────────

  const runAllShadows = async () => {
    const repos = readConfig().repos;
    await Promise.all(repos.map((r) => indexShadowsForRepo(r.name, r.localPath, r.dbPath)));
  };

  void runAllShadows();
  const shadowPoller = setInterval(runAllShadows, 5_000);
  process.stderr.write(`shadow indexer: polling every 5s across ${readConfig().repos.length} repo(s)\n`);

  // Graceful shutdown
  const shutdown = () => {
    clearInterval(poller);
    clearInterval(checkpointPoller);
    clearInterval(shadowPoller);
    httpServer.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise<void>((resolve) => {
    httpServer.listen(port, () => {
      process.stderr.write(`claude-hook-handler serve: listening on http://localhost:${port}\n`);
      resolve();
    });
  });
}
