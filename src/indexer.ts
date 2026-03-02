/**
 * Entire CLI checkpoint indexer.
 *
 * Reads the shard-tree produced by `entire commit` on the `entire/checkpoints/v1`
 * branch and writes Checkpoint / CheckpointSession / CheckpointMessage records
 * into the SQLite database.
 *
 * Directory layout expected under the root:
 *   <root>/<shard2>/<id10>/metadata.json
 *   <root>/<shard2>/<id10>/0/metadata.json
 *   <root>/<shard2>/<id10>/0/full.jsonl
 *   <root>/<shard2>/<id10>/1/metadata.json    (if multiple sessions)
 *   <root>/<shard2>/<id10>/1/full.jsonl
 *   ...
 */

import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import type { PrismaClient } from "../prisma/generated/client/index.js";

// ─── Raw shapes from the checkpoint files ─────────────────────────────────────

interface RootMeta {
  cli_version?: string;
  checkpoint_id?: string;
  strategy?: string;
  branch?: string;
  files_touched?: string[];
  token_usage?: Record<string, unknown>;
}

interface SummaryLearnings {
  repo?: string[];
  code?: Array<{ path: string; finding: string }>;
  workflow?: string[];
}

interface SessionSummary {
  intent?: string;
  outcome?: string;
  learnings?: SummaryLearnings;
  friction?: string[];
  open_items?: string[];
}

interface SessionMeta {
  session_id: string;
  checkpoint_id?: string;
  cli_version?: string;
  strategy?: string;
  created_at?: string;
  branch?: string;
  turn_id?: string;
  agent?: string;
  token_usage?: Record<string, unknown>;
  initial_attribution?: Record<string, unknown>;
  files_touched?: string[];
  summary?: SessionSummary;
  checkpoint_transcript_start?: number;
  transcript_lines_at_start?: number;
}

// A single line from full.jsonl — fields vary by type
export interface FullJsonlEvent {
  uuid?: string;
  messageId?: string;      // used by "file-history-snapshot" instead of uuid
  sessionId?: string;
  parentUuid?: string;
  type: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  slug?: string;
  version?: string;
  planContent?: string;
  toolUseID?: string;
  parentToolUseID?: string;
  isSidechain?: boolean;
  userType?: string;
  message?: unknown;
  data?: unknown;
  [key: string]: unknown;
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Parse a full.jsonl string into an array of event objects.
 * Malformed lines are silently skipped.
 */
export function parseFullJsonl(content: string): FullJsonlEvent[] {
  const out: FullJsonlEvent[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as FullJsonlEvent);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

/** Return the unique key for an event, preferring uuid then messageId. */
function eventKey(e: FullJsonlEvent): string | null {
  return e.uuid ?? e.messageId ?? null;
}

// ─── Single-checkpoint indexer ────────────────────────────────────────────────

/**
 * Index one checkpoint directory (the folder named by the last 10 hex chars,
 * e.g. `<root>/0c/b6cf391c40`).
 *
 * @returns Number of new messages written (already-indexed events are skipped).
 */
export async function indexCheckpoint(
  db: PrismaClient,
  checkpointDir: string,
  checkpointId: string,
): Promise<number> {
  const metaPath = join(checkpointDir, "metadata.json");
  if (!existsSync(metaPath)) {
    throw new Error(`No metadata.json found at ${checkpointDir}`);
  }

  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as RootMeta;

  // Upsert root Checkpoint record
  await db.checkpoint.upsert({
    where: { checkpointId },
    create: {
      checkpointId,
      cliVersion: meta.cli_version ?? null,
      branch: meta.branch ?? null,
      strategy: meta.strategy ?? null,
      filesTouched: meta.files_touched ? JSON.stringify(meta.files_touched) : null,
      tokenUsage: meta.token_usage ? JSON.stringify(meta.token_usage) : null,
    },
    update: {
      cliVersion: meta.cli_version ?? null,
      branch: meta.branch ?? null,
      strategy: meta.strategy ?? null,
      filesTouched: meta.files_touched ? JSON.stringify(meta.files_touched) : null,
      tokenUsage: meta.token_usage ? JSON.stringify(meta.token_usage) : null,
    },
  });

  // Find session sub-directories (0/, 1/, 2/, …)
  const sessionDirs = readdirSync(checkpointDir)
    .filter((e) => /^\d+$/.test(e) && statSync(join(checkpointDir, e)).isDirectory())
    .sort((a, b) => parseInt(a) - parseInt(b));

  let totalNew = 0;

  for (const sessionDir of sessionDirs) {
    const sessionIndex = parseInt(sessionDir, 10);
    const sessionPath = join(checkpointDir, sessionDir);
    const sessionMetaPath = join(sessionPath, "metadata.json");
    if (!existsSync(sessionMetaPath)) continue;

    const sessionMeta = JSON.parse(readFileSync(sessionMetaPath, "utf8")) as SessionMeta;
    const { session_id: sessionId } = sessionMeta;
    if (!sessionId) continue;

    // Upsert CheckpointSession
    const sessionData = {
      checkpointId,
      sessionIndex,
      turnId: sessionMeta.turn_id ?? null,
      agent: sessionMeta.agent ?? null,
      createdAt: sessionMeta.created_at ? new Date(sessionMeta.created_at) : null,
      filesTouched: sessionMeta.files_touched ? JSON.stringify(sessionMeta.files_touched) : null,
      tokenUsage: sessionMeta.token_usage ? JSON.stringify(sessionMeta.token_usage) : null,
      initialAttribution: sessionMeta.initial_attribution
        ? JSON.stringify(sessionMeta.initial_attribution)
        : null,
      checkpointTranscriptStart: sessionMeta.checkpoint_transcript_start ?? null,
      transcriptLinesAtStart: sessionMeta.transcript_lines_at_start ?? null,
    };
    await db.checkpointSession.upsert({
      where: { sessionId },
      create: { sessionId, ...sessionData },
      update: sessionData,
    });

    // Record the checkpoint→session link (idempotent)
    await db.checkpointSessionLink.upsert({
      where: { checkpointId_sessionId: { checkpointId, sessionId } },
      create: { checkpointId, sessionId },
      update: {},
    });

    // Upsert CheckpointSummary if present
    if (sessionMeta.summary) {
      const sm = sessionMeta.summary;
      const summaryData = {
        intent: sm.intent ?? "",
        outcome: sm.outcome ?? "",
        learningsRepo: sm.learnings?.repo ? JSON.stringify(sm.learnings.repo) : null,
        learningsCode: sm.learnings?.code ? JSON.stringify(sm.learnings.code) : null,
        learningsWorkflow: sm.learnings?.workflow ? JSON.stringify(sm.learnings.workflow) : null,
        friction: sm.friction ? JSON.stringify(sm.friction) : null,
        openItems: sm.open_items ? JSON.stringify(sm.open_items) : null,
      };
      await db.checkpointSummary.upsert({
        where: { sessionId },
        create: { sessionId, ...summaryData },
        update: summaryData,
      });
    }

    // Parse and index full.jsonl
    const fullPath = join(sessionPath, "full.jsonl");
    if (!existsSync(fullPath)) continue;

    const events = parseFullJsonl(readFileSync(fullPath, "utf8"));

    for (const event of events) {
      const key = eventKey(event);
      if (!key) continue; // can't upsert without a unique key

      // Skip if already indexed
      const exists = await db.checkpointMessage.findUnique({
        where: { uuid: key },
        select: { id: true },
      });
      if (exists) continue;

      await db.checkpointMessage.create({
        data: {
          uuid: key,
          sessionId,
          parentUuid: event.parentUuid ?? null,
          type: event.type,
          timestamp: event.timestamp ? new Date(event.timestamp) : null,
          cwd: event.cwd ?? null,
          gitBranch: event.gitBranch ?? null,
          slug: event.slug ?? null,
          version: event.version ?? null,
          planContent: event.planContent ?? null,
          toolUseId: event.toolUseID ?? null,
          parentToolUseId: event.parentToolUseID ?? null,
          data: JSON.stringify(event),
        },
      });
      totalNew++;
    }
  }

  return totalNew;
}

// ─── Full-tree indexer ────────────────────────────────────────────────────────

/**
 * Walk a checkpoints root directory and index every checkpoint found.
 *
 * The root must have the shard structure:
 *   <root>/<2-hex-chars>/<10-hex-chars>/
 *
 * @param onProgress  Optional callback called after each checkpoint.
 */
export async function indexAllCheckpoints(
  db: PrismaClient,
  rootDir: string,
  onProgress?: (checkpointId: string, newMessages: number) => void,
): Promise<{ checkpoints: number; newMessages: number }> {
  let totalCheckpoints = 0;
  let totalNew = 0;

  const shards = readdirSync(rootDir)
    .filter((e) => /^[0-9a-f]{2}$/i.test(e) && statSync(join(rootDir, e)).isDirectory());

  for (const shard of shards) {
    const shardPath = join(rootDir, shard);
    const ids = readdirSync(shardPath)
      .filter((e) => /^[0-9a-f]{10}$/i.test(e) && statSync(join(shardPath, e)).isDirectory());

    for (const rest of ids) {
      const checkpointId = shard + rest;
      const checkpointDir = join(shardPath, rest);
      try {
        const n = await indexCheckpoint(db, checkpointDir, checkpointId);
        totalNew += n;
        totalCheckpoints++;
        onProgress?.(checkpointId, n);
      } catch (err) {
        process.stderr.write(`indexer: skipping ${checkpointId}: ${err}\n`);
      }
    }
  }

  return { checkpoints: totalCheckpoints, newMessages: totalNew };
}
