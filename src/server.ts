import express from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import { execSync, exec as execCb } from "child_process";
import { promisify } from "util";

const exec = promisify(execCb);
import { existsSync, mkdirSync } from "fs";
import { basename, join } from "path";
import { getDb } from "./db.js";
import { indexAllCheckpointsV2, indexAllShadowBranches } from "./indexer.js";
import { setupLogContentFts, syncLogContentFts, searchLogContent } from "./search.js";

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
      const checkpoint = await db.checkpointMetadata.findUnique({
        where: { checkpointId },
        include: {
          tokenUsage: true,
          filesTouched: { include: { filePath: true } },
        },
      });
      if (!checkpoint) { res.status(404).json({ error: "Not found" }); return; }

      const sessions = await db.checkpointSessionMetadata.findMany({
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

  // Create HTTP server and attach WebSocket server (shared port)
  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer });

  // WebSocket change detection — poll every 2s, broadcast on new log events, checkpoints, or shadow sessions
  let lastMaxLogEventId: number | null = null;
  let lastMaxCheckpointId: number | null = null;
  let lastMaxShadowSessionId: number | null = null;
  const broadcast = () => {
    const message = JSON.stringify({ type: "sessions_updated" });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  };
  const poller = setInterval(async () => {
    try {
      const [latestLogEvent, latestCheckpoint, latestShadow] = await Promise.all([
        db.logEvent.findFirst({ orderBy: { id: "desc" }, select: { id: true } }),
        db.checkpointMetadata.findFirst({ orderBy: { id: "desc" }, select: { id: true } }),
        db.shadowSession.findFirst({ orderBy: { id: "desc" }, select: { id: true } }),
      ]);
      const curLogEvent   = latestLogEvent?.id   ?? null;
      const curCheckpoint = latestCheckpoint?.id ?? null;
      const curShadow     = latestShadow?.id     ?? null;
      if (curLogEvent !== lastMaxLogEventId || curCheckpoint !== lastMaxCheckpointId || curShadow !== lastMaxShadowSessionId) {
        lastMaxLogEventId   = curLogEvent;
        lastMaxCheckpointId = curCheckpoint;
        lastMaxShadowSessionId = curShadow;
        broadcast();
      }
    } catch {
      // Non-fatal polling error — keep running
    }
  }, 2000);

  // ── Checkpoint auto-indexer ───────────────────────────────────────────────

  const CHECKPOINT_BRANCH = "entire/checkpoints/v1";
  let checkpointPoller: ReturnType<typeof setInterval> | null = null;

  if (repoDir) {
    const WORKTREE_PATH = join(repoDir, ".gossamer", "checkpoints");
    mkdirSync(join(repoDir, ".gossamer"), { recursive: true });

    // Ensure worktree exists (reuse across restarts)
    if (!existsSync(WORKTREE_PATH)) {
      try {
        execSync(`git -C ${JSON.stringify(repoDir)} worktree prune`, { stdio: "pipe" });
        execSync(
          `git -C ${JSON.stringify(repoDir)} worktree add ${JSON.stringify(WORKTREE_PATH)} ${CHECKPOINT_BRANCH}`,
          { stdio: "pipe" },
        );
        process.stderr.write(`checkpoint indexer: worktree created at ${WORKTREE_PATH}\n`);
      } catch (err) {
        process.stderr.write(`checkpoint indexer: failed to create worktree — ${err}\n`);
      }
    }

    const runIndex = async () => {
      if (!existsSync(WORKTREE_PATH)) return;
      try {
        // Fetch latest from remote, fall back to local branch tip if unavailable
        try {
          await exec(`git -C ${JSON.stringify(WORKTREE_PATH)} fetch origin ${CHECKPOINT_BRANCH}`, { timeout: 10_000 });
          await exec(`git -C ${JSON.stringify(WORKTREE_PATH)} reset --hard origin/${CHECKPOINT_BRANCH}`);
        } catch {
          try {
            await exec(`git -C ${JSON.stringify(WORKTREE_PATH)} reset --hard ${CHECKPOINT_BRANCH}`);
          } catch { /* non-fatal */ }
        }
      } catch { /* non-fatal */ }
      try {
        const { checkpoints } = await indexAllCheckpointsV2(db, WORKTREE_PATH, undefined, repoDir);
        if (checkpoints > 0) {
          process.stderr.write(`checkpoint indexer: indexed ${checkpoints} checkpoints\n`);
          broadcast();
        }
      } catch { /* non-fatal */ }
    };

    void runIndex();
    checkpointPoller = setInterval(runIndex, 30_000);
    process.stderr.write(`checkpoint indexer: polling every 30s (worktree: ${WORKTREE_PATH})\n`);
  }

  // ── Shadow branch indexer ──────────────────────────────────────────────────

  let shadowPoller: ReturnType<typeof setInterval> | null = null;

  if (repoDir) {
    const runShadowIndex = async () => {
      try {
        const { sessions } = await indexAllShadowBranches(db, repoDir);
        if (sessions > 0) broadcast();
      } catch { /* non-fatal */ }
    };

    void runShadowIndex();
    shadowPoller = setInterval(runShadowIndex, 5_000);
    process.stderr.write(`shadow indexer: polling every 5s (repo: ${repoDir})\n`);
  }

  // Graceful shutdown
  const shutdown = () => {
    clearInterval(poller);
    if (checkpointPoller) clearInterval(checkpointPoller);
    if (shadowPoller) clearInterval(shadowPoller);
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
