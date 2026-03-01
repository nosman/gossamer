import express from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import { getDb } from "./db.js";

// ─── Response types ───────────────────────────────────────────────────────────

interface SessionResponse {
  sessionId: string;
  startedAt: string;
  updatedAt: string;
  cwd: string;
  repoRoot: string | null;
  repoName: string | null;
  parentSessionId: string | null;
  gitUserName: string | null;
  gitUserEmail: string | null;
  prompt: string | null;
  summary: string | null;
  keywords: string[];
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

// ─── Mapping helpers ──────────────────────────────────────────────────────────

function mapSession(s: {
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
}): SessionResponse {
  return {
    sessionId: s.sessionId,
    startedAt: s.startedAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    cwd: s.cwd,
    repoRoot: s.repoRoot,
    repoName: s.repoName,
    parentSessionId: s.parentSessionId,
    gitUserName: s.gitUserName,
    gitUserEmail: s.gitUserEmail,
    prompt: s.prompt,
    summary: s.summary,
    keywords: s.keywords ? (JSON.parse(s.keywords) as string[]) : [],
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

export async function startServer(dbPath: string, port: number): Promise<void> {
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
      res.json(sessions.map(mapSession));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/sessions/:id
  app.get("/api/sessions/:id", async (req, res) => {
    try {
      const session = await db.session.findUnique({
        where: { sessionId: req.params.id },
      });
      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      res.json(mapSession(session));
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

  // Create HTTP server and attach WebSocket server (shared port)
  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer });

  // WebSocket change detection — poll every 2s, broadcast on new events
  let lastMaxId: number | null = null;
  const poller = setInterval(async () => {
    try {
      const latest = await db.event.findFirst({
        orderBy: { id: "desc" },
        select: { id: true },
      });
      const currentId = latest?.id ?? null;
      if (currentId !== lastMaxId) {
        lastMaxId = currentId;
        const message = JSON.stringify({ type: "sessions_updated" });
        for (const client of wss.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(message);
          }
        }
      }
    } catch {
      // Non-fatal polling error — keep running
    }
  }, 2000);

  // Graceful shutdown
  const shutdown = () => {
    clearInterval(poller);
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
