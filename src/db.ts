import { PrismaClient } from "../prisma/generated/client/index.js";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { mkdirSync } from "fs";
import { resolve, dirname } from "path";

// ─── Shared state types ───────────────────────────────────────────────────────

export interface SessionRecord {
  sessionId: string;
  startedAt: string;  // ISO string
  updatedAt: string;  // ISO string
  cwd: string;
  repoRoot?: string;
  repoName?: string;
  parentSessionId?: string;
  gitUserName?: string;
  gitUserEmail?: string;
  prompt?: string;
  summary?: string;
  keywords?: string[];
}

export interface PendingToolUseRecord {
  tool_use_id: string;
  tool_name: string;
  tool_input?: unknown;
  startedAt: string; // pre-formatted display string from fmt()
}

export interface State {
  sessions: Record<string, SessionRecord>;
  // Maps agent_id → parent session_id so we can link child SessionStart events
  agentParents: Record<string, string>;
  // Maps tool_use_id → stashed PreToolUse data, cleared on PostToolUse
  pendingToolUses: Record<string, PendingToolUseRecord>;
}

// ─── Singleton DB cache ───────────────────────────────────────────────────────

const dbCache = new Map<string, PrismaClient>();

/**
 * Open (or return cached) a PrismaClient backed by a better-sqlite3 file at `dbPath`.
 * Runs PRAGMA journal_mode=WAL for safe concurrent writes.
 */
export async function getDb(dbPath: string): Promise<PrismaClient> {
  const abs = resolve(dbPath);
  const cached = dbCache.get(abs);
  if (cached) return cached;

  mkdirSync(dirname(abs), { recursive: true });

  const adapter = new PrismaBetterSqlite3({ url: `file:${abs}` });
  const db = new PrismaClient({ adapter } as ConstructorParameters<typeof PrismaClient>[0]);

  try {
    await db.$queryRawUnsafe("PRAGMA journal_mode=WAL");
  } catch {
    // Non-fatal — WAL mode is a performance hint
  }

  dbCache.set(abs, db);
  return db;
}

// ─── State read/write ─────────────────────────────────────────────────────────

/** Read all session state tables and assemble an in-memory State object. */
export async function readStateFromDb(db: PrismaClient): Promise<State> {
  const [sessions, agentParents, pendingToolUses] = await Promise.all([
    db.session.findMany(),
    db.agentParent.findMany(),
    db.pendingToolUse.findMany(),
  ]);

  const sessionMap: Record<string, SessionRecord> = {};
  for (const s of sessions) {
    sessionMap[s.sessionId] = {
      sessionId: s.sessionId,
      startedAt: s.startedAt instanceof Date ? s.startedAt.toISOString() : String(s.startedAt),
      updatedAt: s.updatedAt instanceof Date ? s.updatedAt.toISOString() : String(s.updatedAt),
      cwd: s.cwd,
      repoRoot: s.repoRoot ?? undefined,
      repoName: s.repoName ?? undefined,
      parentSessionId: s.parentSessionId ?? undefined,
      gitUserName: s.gitUserName ?? undefined,
      gitUserEmail: s.gitUserEmail ?? undefined,
      prompt: s.prompt ?? undefined,
      summary: s.summary ?? undefined,
      keywords: s.keywords ? (JSON.parse(s.keywords) as string[]) : undefined,
    };
  }

  const agentParentMap: Record<string, string> = {};
  for (const ap of agentParents) {
    agentParentMap[ap.agentId] = ap.parentSessionId;
  }

  const pendingMap: Record<string, PendingToolUseRecord> = {};
  for (const p of pendingToolUses) {
    pendingMap[p.toolUseId] = {
      tool_use_id: p.toolUseId,
      tool_name: p.toolName,
      tool_input: p.toolInput ? (JSON.parse(p.toolInput) as unknown) : undefined,
      startedAt: p.startedAt,
    };
  }

  return { sessions: sessionMap, agentParents: agentParentMap, pendingToolUses: pendingMap };
}

/** Persist in-memory State to the database. Uses upsert for sessions; replaces agent/pending tables. */
export async function writeStateToDb(db: PrismaClient, state: State): Promise<void> {
  // Upsert each session
  await Promise.all(
    Object.values(state.sessions).map((s) =>
      db.session.upsert({
        where: { sessionId: s.sessionId },
        create: {
          sessionId: s.sessionId,
          startedAt: new Date(s.startedAt),
          updatedAt: new Date(s.updatedAt),
          cwd: s.cwd,
          repoRoot: s.repoRoot ?? null,
          repoName: s.repoName ?? null,
          parentSessionId: s.parentSessionId ?? null,
          gitUserName: s.gitUserName ?? null,
          gitUserEmail: s.gitUserEmail ?? null,
          prompt: s.prompt ?? null,
          summary: s.summary ?? null,
          keywords: s.keywords ? JSON.stringify(s.keywords) : null,
        },
        update: {
          updatedAt: new Date(s.updatedAt),
          cwd: s.cwd,
          repoRoot: s.repoRoot ?? null,
          repoName: s.repoName ?? null,
          parentSessionId: s.parentSessionId ?? null,
          gitUserName: s.gitUserName ?? null,
          gitUserEmail: s.gitUserEmail ?? null,
          prompt: s.prompt ?? null,
          summary: s.summary ?? null,
          keywords: s.keywords ? JSON.stringify(s.keywords) : null,
        },
      })
    )
  );

  // Replace agentParents wholesale
  await db.agentParent.deleteMany();
  const agentEntries = Object.entries(state.agentParents);
  if (agentEntries.length > 0) {
    await db.agentParent.createMany({
      data: agentEntries.map(([agentId, parentSessionId]) => ({ agentId, parentSessionId })),
    });
  }

  // Replace pendingToolUses wholesale
  await db.pendingToolUse.deleteMany();
  const pendingEntries = Object.values(state.pendingToolUses);
  if (pendingEntries.length > 0) {
    await db.pendingToolUse.createMany({
      data: pendingEntries.map((p) => ({
        toolUseId: p.tool_use_id,
        toolName: p.tool_name,
        toolInput: p.tool_input !== undefined ? JSON.stringify(p.tool_input) : null,
        startedAt: p.startedAt,
      })),
    });
  }
}
