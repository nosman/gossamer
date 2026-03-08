import express from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { getDb } from "./db.js";
import { indexAllCheckpoints, indexAllCheckpointsV2 } from "./indexer.js";
import { query } from "@anthropic-ai/claude-agent-sdk";

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
}

interface EventResponse {
  id: number;
  timestamp: string;
  event: string;
  sessionId: string;
  blocked: boolean;
  data: unknown;
  summary: string | null;
  keywords: string[];
}

interface OverviewResponse {
  sessionId: string;
  summary: string;
  keywords: string[];
  startedAt: string;
  endedAt: string;
}

// ─── Mapping helpers ──────────────────────────────────────────────────────────

function mapSummary(s: {
  intent: string;
  outcome: string;
  learningsRepo: string | null;
  learningsCode: string | null;
  learningsWorkflow: string | null;
  friction: string | null;
  openItems: string | null;
}) {
  return {
    intent: s.intent,
    outcome: s.outcome,
    repoLearnings:     s.learningsRepo     ? (JSON.parse(s.learningsRepo)     as string[]) : [],
    codeLearnings:     s.learningsCode     ? (JSON.parse(s.learningsCode)     as Array<{ path: string; finding: string }>) : [],
    workflowLearnings: s.learningsWorkflow ? (JSON.parse(s.learningsWorkflow) as string[]) : [],
    friction:          s.friction          ? (JSON.parse(s.friction)          as string[]) : [],
    openItems:         s.openItems         ? (JSON.parse(s.openItems)         as string[]) : [],
  };
}


function mapSession(
  s: {
    sessionId: string;
    startedAt: Date;
    updatedAt: Date;
    cwd: string;
    repoRoot: string | null;
    repoName: string | null;
    parentSessionId: string | null;
    gitUserName: string | null;
    gitUserEmail: string | null;
    prompt: string | null;
    summary: string | null;
    keywords: string | null;
  },
  childSessionIds: string[] = [],
  branch: string | null = null,
  intent: string | null = null,
): SessionResponse {
  return {
    sessionId: s.sessionId,
    startedAt: s.startedAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    cwd: s.cwd,
    repoRoot: s.repoRoot,
    repoName: s.repoName,
    parentSessionId: s.parentSessionId,
    childSessionIds,
    gitUserName: s.gitUserName,
    gitUserEmail: s.gitUserEmail,
    prompt: s.prompt,
    summary: s.summary,
    keywords: s.keywords ? (JSON.parse(s.keywords) as string[]) : [],
    branch,
    intent,
  };
}

function mapEvent(e: {
  id: number;
  timestamp: Date;
  event: string;
  sessionId: string;
  blocked: boolean;
  data: string;
  summary: string | null;
  keywords: string | null;
}): EventResponse {
  let parsedData: unknown;
  try {
    parsedData = JSON.parse(e.data);
  } catch {
    parsedData = e.data;
  }
  return {
    id: e.id,
    timestamp: e.timestamp.toISOString(),
    event: e.event,
    sessionId: e.sessionId,
    blocked: e.blocked,
    data: parsedData,
    summary: e.summary,
    keywords: e.keywords ? (JSON.parse(e.keywords) as string[]) : [],
  };
}

// ─── Server ───────────────────────────────────────────────────────────────────

export async function startServer(dbPath: string, port: number, repoDir?: string): Promise<void> {
  // Strip CLAUDECODE so spawned sessions are not blocked by nested-session detection
  delete process.env.CLAUDECODE;

  const db = await getDb(dbPath);

  const app = express();
  app.use(cors());
  app.use(express.json());

  // GET /api/sessions
  app.get("/api/sessions", async (_req, res) => {
    try {
      const sessions = await db.session.findMany({
        orderBy: { updatedAt: "desc" },
      });
      const sessionIds = sessions.map((s) => s.sessionId);

      // Fetch latest branch and intent per session from CheckpointSessionMetadata
      const sessionMetas = await db.checkpointSessionMetadata.findMany({
        where: { sessionId: { in: sessionIds } },
        select: { sessionId: true, branch: true, createdAt: true, summary: { select: { intent: true } } },
        orderBy: { createdAt: "desc" },
      });
      const branchMap = new Map<string, string | null>();
      const intentMap = new Map<string, string | null>();
      for (const m of sessionMetas) {
        if (!branchMap.has(m.sessionId)) branchMap.set(m.sessionId, m.branch);
        if (!intentMap.has(m.sessionId)) intentMap.set(m.sessionId, m.summary?.intent ?? null);
      }

      // Build parent → children map in memory
      const childMap = new Map<string, string[]>();
      for (const s of sessions) {
        if (s.parentSessionId) {
          const arr = childMap.get(s.parentSessionId) ?? [];
          arr.push(s.sessionId);
          childMap.set(s.parentSessionId, arr);
        }
      }
      res.json(sessions.map((s) => mapSession(s, childMap.get(s.sessionId) ?? [], branchMap.get(s.sessionId) ?? null, intentMap.get(s.sessionId) ?? null)));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/sessions/:id
  app.get("/api/sessions/:id", async (req, res) => {
    try {
      const [session, children, latestMeta] = await Promise.all([
        db.session.findUnique({ where: { sessionId: req.params.id } }),
        db.session.findMany({
          where: { parentSessionId: req.params.id },
          select: { sessionId: true },
        }),
        db.checkpointSessionMetadata.findFirst({
          where: { sessionId: req.params.id },
          select: { branch: true, summary: { select: { intent: true } } },
          orderBy: { createdAt: "desc" },
        }),
      ]);
      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      res.json(mapSession(session, children.map((c) => c.sessionId), latestMeta?.branch ?? null, latestMeta?.summary?.intent ?? null));
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

  // GET /api/sessions/:id/events
  app.get("/api/sessions/:id/events", async (req, res) => {
    try {
      const events = await db.event.findMany({
        where: { sessionId: req.params.id },
        orderBy: { timestamp: "asc" },
      });
      res.json(events.map(mapEvent));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/checkpoints
  app.get("/api/checkpoints", async (_req, res) => {
    try {
      const checkpoints = await db.checkpoint.findMany({
        include: {
          sessions: {
            select: { sessionId: true, summary: true },
            orderBy: { sessionIndex: "asc" },
          },
        },
        orderBy: { indexedAt: "desc" },
      });
      res.json(checkpoints.map((c) => {
        const firstSummary = c.sessions.find((s) => s.summary)?.summary ?? null;
        return {
          checkpointId: c.checkpointId,
          branch: c.branch,
          cliVersion: c.cliVersion,
          strategy: c.strategy,
          filesTouched: c.filesTouched ? (JSON.parse(c.filesTouched) as string[]) : [],
          tokenUsage: c.tokenUsage ? (JSON.parse(c.tokenUsage) as Record<string, unknown>) : null,
          indexedAt: c.indexedAt.toISOString(),
          sessionCount: c.sessions.length,
          summary: firstSummary ? mapSummary(firstSummary) : null,
        };
      }));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/checkpoints/:id
  app.get("/api/checkpoints/:id", async (req, res) => {
    try {
      const checkpoint = await db.checkpoint.findUnique({
        where: { checkpointId: req.params.id },
        include: {
          sessions: {
            include: { summary: true },
            orderBy: { sessionIndex: "asc" },
          },
        },
      });
      if (!checkpoint) { res.status(404).json({ error: "Not found" }); return; }
      res.json({
        checkpointId: checkpoint.checkpointId,
        branch: checkpoint.branch,
        cliVersion: checkpoint.cliVersion,
        strategy: checkpoint.strategy,
        filesTouched: checkpoint.filesTouched ? (JSON.parse(checkpoint.filesTouched) as string[]) : [],
        tokenUsage: checkpoint.tokenUsage ? (JSON.parse(checkpoint.tokenUsage) as Record<string, unknown>) : null,
        indexedAt: checkpoint.indexedAt.toISOString(),
        sessionCount: checkpoint.sessions.length,
        summary: checkpoint.sessions.find((s) => s.summary)?.summary
          ? mapSummary(checkpoint.sessions.find((s) => s.summary)!.summary!)
          : null,
        sessions: checkpoint.sessions.map((s) => ({
          sessionId: s.sessionId,
          sessionIndex: s.sessionIndex,
          agent: s.agent,
          createdAt: s.createdAt?.toISOString() ?? null,
          filesTouched: s.filesTouched ? (JSON.parse(s.filesTouched) as string[]) : [],
          tokenUsage: s.tokenUsage ? (JSON.parse(s.tokenUsage) as Record<string, unknown>) : null,
          summary: s.summary ? mapSummary(s.summary) : null,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/sessions/:sessionId/checkpoints
  app.get("/api/sessions/:sessionId/checkpoints", async (req, res) => {
    try {
      const links = await db.checkpointSessionLink.findMany({
        where: { sessionId: req.params.sessionId },
        select: { checkpointId: true },
      });
      if (links.length === 0) { res.json([]); return; }
      const checkpointIds = links.map((l) => l.checkpointId);
      const checkpoints = await db.checkpoint.findMany({
        where: { checkpointId: { in: checkpointIds } },
        include: {
          sessions: {
            where: { sessionId: req.params.sessionId },
            include: { summary: true },
          },
        },
        orderBy: { indexedAt: "asc" },
      });
      res.json(checkpoints.map((c) => {
        const session = c.sessions[0] ?? null;
        return {
          checkpointId: c.checkpointId,
          branch: c.branch,
          cliVersion: c.cliVersion,
          filesTouched: c.filesTouched ? (JSON.parse(c.filesTouched) as string[]) : [],
          tokenUsage: c.tokenUsage ? (() => { const t = JSON.parse(c.tokenUsage) as Record<string, unknown>; return { inputTokens: t.input_tokens, cacheCreationTokens: t.cache_creation_tokens, cacheReadTokens: t.cache_read_tokens, outputTokens: t.output_tokens, apiCallCount: t.api_call_count }; })() : null,
          createdAt: session?.createdAt?.toISOString() ?? null,
          summary: session?.summary ? mapSummary(session.summary) : null,
        };
      }));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/checkpoints/:id/messages
  app.get("/api/checkpoints/:id/messages", async (req, res) => {
    try {
      const sessions = await db.checkpointSession.findMany({
        where: { checkpointId: req.params.id },
        select: { sessionId: true },
      });
      const sessionIds = sessions.map((s) => s.sessionId);
      if (sessionIds.length === 0) { res.json([]); return; }
      const messages = await db.checkpointMessage.findMany({
        where: { sessionId: { in: sessionIds } },
        orderBy: { timestamp: "asc" },
      });
      res.json(messages.map((m) => ({
        id: m.id,
        uuid: m.uuid,
        sessionId: m.sessionId,
        parentUuid: m.parentUuid,
        type: m.type,
        timestamp: m.timestamp?.toISOString() ?? null,
        gitBranch: m.gitBranch,
        slug: m.slug,
        planContent: m.planContent,
        toolUseId: m.toolUseId,
        parentToolUseId: m.parentToolUseId,
        data: JSON.parse(m.data) as unknown,
      })));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── V2 helpers ─────────────────────────────────────────────────────────────

  type V2Session = {
    summary: {
      intent: string; outcome: string;
      openItems: { text: string }[];
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
      openItems:         summary.openItems.map((r) => r.text),
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

  // POST /api/sessions/spawn
  app.post("/api/sessions/spawn", async (req, res) => {
    const { prompt, cwd } = req.body as { prompt?: string; cwd?: string };
    if (!prompt || typeof prompt !== "string") {
      res.status(400).json({ error: "prompt is required" });
      return;
    }
    try {
      const gen = query({
        prompt,
        options: {
          cwd: cwd ?? undefined,
          permissionMode: "acceptEdits",
          settingSources: ["user", "project"],
        },
      });

      // Wait for the first system event to get the session ID, then respond
      const first = await gen.next();
      const sessionId: string | null =
        first.value && typeof first.value === "object" &&
        (first.value as { type?: string; subtype?: string; session_id?: string }).type === "system" &&
        (first.value as { session_id?: string }).session_id
          ? (first.value as { session_id: string }).session_id
          : null;

      // Continue running in background
      (async () => {
        try {
          for await (const _ of gen) { /* hook handler captures everything */ }
          console.log("[spawn] query finished, sessionId:", sessionId);
        } catch (err) {
          console.error("[spawn] error:", err);
        }
      })().catch((err) => console.error("[spawn] outer error:", err));

      res.json({ started: true, sessionId });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Create HTTP server and attach WebSocket server (shared port)
  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer });

  // WebSocket change detection — poll every 2s, broadcast on new events or checkpoints
  let lastMaxEventId: number | null = null;
  let lastMaxCheckpointId: number | null = null;
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
      const [latestEvent, latestCheckpoint] = await Promise.all([
        db.event.findFirst({ orderBy: { id: "desc" }, select: { id: true } }),
        db.checkpointMetadata.findFirst({ orderBy: { id: "desc" }, select: { id: true } }),
      ]);
      const currentEventId = latestEvent?.id ?? null;
      const currentCheckpointId = latestCheckpoint?.id ?? null;
      if (currentEventId !== lastMaxEventId || currentCheckpointId !== lastMaxCheckpointId) {
        lastMaxEventId = currentEventId;
        lastMaxCheckpointId = currentCheckpointId;
        broadcast();
      }
    } catch {
      // Non-fatal polling error — keep running
    }
  }, 2000);

  // ── Checkpoint auto-indexer ───────────────────────────────────────────────

  const WORKTREE_PATH = "/tmp/gossamer-checkpoints";
  const CHECKPOINT_BRANCH = "entire/checkpoints/v1";
  let checkpointPoller: ReturnType<typeof setInterval> | null = null;

  if (repoDir) {
    // Ensure worktree exists (reuse across restarts)
    if (!existsSync(WORKTREE_PATH)) {
      try {
        // Prune stale worktree registration first, then re-add
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
        // Pull latest commits into the worktree working tree
        execSync(`git -C ${JSON.stringify(WORKTREE_PATH)} reset --hard HEAD`, { stdio: "pipe" });
      } catch { /* non-fatal */ }
      try {
        const { newMessages } = await indexAllCheckpoints(db, WORKTREE_PATH);
        if (newMessages > 0) {
          process.stderr.write(`checkpoint indexer: +${newMessages} new messages\n`);
          broadcast();
        }
      } catch { /* non-fatal */ }
      try {
        const { checkpoints } = await indexAllCheckpointsV2(db, WORKTREE_PATH);
        if (checkpoints > 0) {
          process.stderr.write(`checkpoint indexer v2: indexed ${checkpoints} checkpoints\n`);
          broadcast();
        }
      } catch { /* non-fatal */ }
    };

    void runIndex();
    checkpointPoller = setInterval(runIndex, 30_000);
    process.stderr.write(`checkpoint indexer: polling every 30s (worktree: ${WORKTREE_PATH})\n`);
  }

  // Graceful shutdown
  const shutdown = () => {
    clearInterval(poller);
    if (checkpointPoller) clearInterval(checkpointPoller);
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
