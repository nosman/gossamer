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
  checkpoints_count?: number;
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
  checkpoints_count?: number;
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

// ─── V2 helpers ───────────────────────────────────────────────────────────────

async function upsertFilePath(db: PrismaClient, path: string): Promise<number> {
  const existing = await db.filePath.findUnique({ where: { path }, select: { id: true } });
  if (existing) return existing.id;
  const created = await db.filePath.create({ data: { path } });
  return created.id;
}

async function createTokenUsage(db: PrismaClient, tu: Record<string, unknown>): Promise<number> {
  const row = await db.tokenUsage.create({
    data: {
      inputTokens:         Number(tu.input_tokens          ?? 0),
      cacheCreationTokens: Number(tu.cache_creation_tokens ?? 0),
      cacheReadTokens:     Number(tu.cache_read_tokens     ?? 0),
      outputTokens:        Number(tu.output_tokens         ?? 0),
      apiCallCount:        Number(tu.api_call_count        ?? 0),
    },
  });
  return row.id;
}

// ─── V2 single-checkpoint indexer ────────────────────────────────────────────

/**
 * Index one checkpoint directory using the new normalized schema.
 *
 * Reads:
 *   <checkpointDir>/metadata.json             → CheckpointMetadata
 *   <checkpointDir>/<n>/metadata.json         → CheckpointSessionMetadata
 *   <checkpointDir>/<n>/content_hash.txt      → SessionLink.contentHash (actual hash)
 *   <checkpointDir>/<n>/{full.jsonl,context.md,prompt.txt} → SessionLink paths
 */
export async function indexCheckpointV2(
  db: PrismaClient,
  checkpointDir: string,
  checkpointId: string,
): Promise<void> {
  const metaPath = join(checkpointDir, "metadata.json");
  if (!existsSync(metaPath)) throw new Error(`No metadata.json at ${checkpointDir}`);

  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as RootMeta;

  // Upsert CheckpointMetadata — create TokenUsage only on first insert
  let checkpointMeta = await db.checkpointMetadata.findUnique({
    where: { checkpointId },
    select: { id: true },
  });

  if (!checkpointMeta) {
    let tokenUsageId: number | null = null;
    if (meta.token_usage) tokenUsageId = await createTokenUsage(db, meta.token_usage);
    checkpointMeta = await db.checkpointMetadata.create({
      data: {
        checkpointId,
        cliVersion:       meta.cli_version       ?? null,
        branch:           meta.branch            ?? null,
        strategy:         meta.strategy          ?? null,
        checkpointsCount: meta.checkpoints_count ?? 0,
        tokenUsageId,
      },
      select: { id: true },
    });
  } else {
    await db.checkpointMetadata.update({
      where: { checkpointId },
      data: {
        cliVersion:       meta.cli_version       ?? null,
        branch:           meta.branch            ?? null,
        strategy:         meta.strategy          ?? null,
        checkpointsCount: meta.checkpoints_count ?? 0,
      },
    });
  }

  // files_touched → FilePath + join table
  for (const filePath of meta.files_touched ?? []) {
    const filePathId = await upsertFilePath(db, filePath);
    await db.checkpointMetadataFilePath.upsert({
      where: { checkpointMetadataId_filePathId: { checkpointMetadataId: checkpointMeta.id, filePathId } },
      create: { checkpointMetadataId: checkpointMeta.id, filePathId },
      update: {},
    });
  }

  // Session sub-directories: 0/, 1/, …
  const sessionDirs = readdirSync(checkpointDir)
    .filter((e) => /^\d+$/.test(e) && statSync(join(checkpointDir, e)).isDirectory())
    .sort((a, b) => parseInt(a) - parseInt(b));

  for (const sessionDir of sessionDirs) {
    const sessionPath    = join(checkpointDir, sessionDir);
    const metadataFile   = join(sessionPath, "metadata.json");
    const transcriptFile = join(sessionPath, "full.jsonl");
    const contextFile    = join(sessionPath, "context.md");
    const hashFile       = join(sessionPath, "content_hash.txt");
    const promptFile     = join(sessionPath, "prompt.txt");

    // Read actual hash content (not the file path)
    const contentHash = existsSync(hashFile) ? readFileSync(hashFile, "utf8").trim() : null;

    await db.sessionLink.create({
      data: {
        checkpointMetadataId: checkpointMeta.id,
        metadata:   existsSync(metadataFile)   ? metadataFile   : null,
        transcript: existsSync(transcriptFile) ? transcriptFile : null,
        context:    existsSync(contextFile)    ? contextFile    : null,
        contentHash,
        prompt:     existsSync(promptFile)     ? promptFile     : null,
      },
    });

    if (!existsSync(metadataFile)) continue;

    const sessionMeta = JSON.parse(readFileSync(metadataFile, "utf8")) as SessionMeta;
    const { session_id: sessionId } = sessionMeta;
    if (!sessionId) continue;

    // CheckpointSessionMetadata — create or update
    let sessionRecord = await db.checkpointSessionMetadata.findUnique({
      where: { checkpointId_sessionId: { checkpointId, sessionId } },
      select: { id: true },
    });

    if (!sessionRecord) {
      let sessionTokenUsageId: number | null = null;
      if (sessionMeta.token_usage) {
        sessionTokenUsageId = await createTokenUsage(db, sessionMeta.token_usage);
      }
      sessionRecord = await db.checkpointSessionMetadata.create({
        data: {
          checkpointId,
          sessionId,
          cliVersion:       sessionMeta.cli_version       ?? null,
          strategy:         sessionMeta.strategy          ?? null,
          createdAt:        sessionMeta.created_at ? new Date(sessionMeta.created_at) : null,
          branch:           sessionMeta.branch            ?? null,
          checkpointsCount: sessionMeta.checkpoints_count ?? 0,
          agent:            sessionMeta.agent             ?? null,
          turnId:           sessionMeta.turn_id           ?? null,
          tokenUsageId:     sessionTokenUsageId,
        },
        select: { id: true },
      });
    } else {
      await db.checkpointSessionMetadata.update({
        where: { checkpointId_sessionId: { checkpointId, sessionId } },
        data: {
          cliVersion: sessionMeta.cli_version ?? null,
          strategy:   sessionMeta.strategy    ?? null,
          createdAt:  sessionMeta.created_at ? new Date(sessionMeta.created_at) : null,
          branch:     sessionMeta.branch      ?? null,
          agent:      sessionMeta.agent       ?? null,
          turnId:     sessionMeta.turn_id     ?? null,
        },
      });
    }

    // files_touched for session
    for (const filePath of sessionMeta.files_touched ?? []) {
      const filePathId = await upsertFilePath(db, filePath);
      await db.checkpointSessionMetadataFilePath.upsert({
        where: {
          checkpointSessionMetadataId_filePathId: {
            checkpointSessionMetadataId: sessionRecord.id,
            filePathId,
          },
        },
        create: { checkpointSessionMetadataId: sessionRecord.id, filePathId },
        update: {},
      });
    }

    // initial_attribution
    if (sessionMeta.initial_attribution) {
      const ia = sessionMeta.initial_attribution as Record<string, unknown>;
      const iaData = {
        calculatedAt:    ia.calculated_at ? new Date(ia.calculated_at as string) : null,
        agentLines:      Number(ia.agent_lines      ?? 0),
        humanAdded:      Number(ia.human_added      ?? 0),
        humanModified:   Number(ia.human_modified   ?? 0),
        humanRemoved:    Number(ia.human_removed    ?? 0),
        totalCommitted:  Number(ia.total_committed  ?? 0),
        agentPercentage: Number(ia.agent_percentage ?? 0),
      };
      await db.initialAttribution.upsert({
        where:  { checkpointSessionMetadataId: sessionRecord.id },
        create: { checkpointSessionMetadataId: sessionRecord.id, ...iaData },
        update: iaData,
      });
    }

    // summary
    if (sessionMeta.summary) {
      const sm = sessionMeta.summary;
      const summaryRecord = await db.checkpointSessionSummary.upsert({
        where:  { checkpointSessionMetadataId: sessionRecord.id },
        create: { checkpointSessionMetadataId: sessionRecord.id, intent: sm.intent ?? "", outcome: sm.outcome ?? "" },
        update: { intent: sm.intent ?? "", outcome: sm.outcome ?? "" },
        select: { id: true },
      });

      // Recreate child arrays on every index pass (preserve status/subSessionId on OpenItem)
      await Promise.all([
        db.frictionItem.deleteMany( { where: { checkpointSessionSummaryId: summaryRecord.id } }),
        db.repoLearning.deleteMany( { where: { checkpointSessionMetadataId: summaryRecord.id } }),
        db.codeLearning.deleteMany( { where: { checkpointSessionMetadataId: summaryRecord.id } }),
        db.workflowItem.deleteMany( { where: { checkpointSessionMetadataId: summaryRecord.id } }),
      ]);

      const creates: Promise<unknown>[] = [];

      if (sm.open_items?.length) {
        // Look up prior statuses for this session so they survive new checkpoints being indexed.
        // Fetch ALL non-open prior items (not just exact matches) so we can fuzzy-match rephrased items.
        const priorItems = await db.openItem.findMany({
          where: {
            checkpointSessionSummary: {
              checkpointSessionMetadata: { sessionId },
            },
            status: { notIn: ["open"] },
          },
          select: { text: true, status: true, subSessionId: true },
          distinct: ["text"],
          orderBy: { id: "desc" },
        });

        // Build a map for exact matches and a list for fuzzy fallback
        const priorByText = new Map(priorItems.map((p) => [p.text, p]));

        // Jaccard similarity on word tokens (case-insensitive, punctuation-stripped)
        function tokenize(s: string): Set<string> {
          return new Set(s.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter(Boolean));
        }
        function jaccardSimilarity(a: string, b: string): number {
          const ta = tokenize(a);
          const tb = tokenize(b);
          let intersection = 0;
          for (const w of ta) if (tb.has(w)) intersection++;
          const union = ta.size + tb.size - intersection;
          return union === 0 ? 0 : intersection / union;
        }

        function findBestPrior(text: string) {
          // Exact match first
          if (priorByText.has(text)) return priorByText.get(text);
          // Fuzzy fallback: best Jaccard match above 0.5 threshold
          let best: { text: string; status: string; subSessionId: string | null } | undefined;
          let bestScore = 0.5; // minimum threshold
          for (const prior of priorItems) {
            const score = jaccardSimilarity(text, prior.text);
            if (score > bestScore) { bestScore = score; best = prior; }
          }
          return best;
        }

        creates.push(...sm.open_items.map((text) => {
          const prior = findBestPrior(text);
          return db.openItem.upsert({
            where: { checkpointSessionSummaryId_text: { checkpointSessionSummaryId: summaryRecord.id, text } },
            create: {
              checkpointSessionSummaryId: summaryRecord.id,
              text,
              status: prior?.status ?? "open",
              subSessionId: prior?.subSessionId ?? null,
            },
            update: {},
          });
        }));
        // Remove open items that no longer appear in the source
        creates.push(
          db.openItem.deleteMany({
            where: { checkpointSessionSummaryId: summaryRecord.id, text: { notIn: sm.open_items } },
          })
        );
      } else {
        creates.push(db.openItem.deleteMany({ where: { checkpointSessionSummaryId: summaryRecord.id } }));
      }
      if (sm.friction?.length) {
        creates.push(db.frictionItem.createMany({
          data: sm.friction.map((text) => ({ checkpointSessionSummaryId: summaryRecord.id, text })),
        }));
      }
      if (sm.learnings?.repo?.length) {
        creates.push(db.repoLearning.createMany({
          data: sm.learnings.repo.map((text) => ({ checkpointSessionMetadataId: summaryRecord.id, text })),
        }));
      }
      if (sm.learnings?.code?.length) {
        creates.push(db.codeLearning.createMany({
          data: sm.learnings.code.map(({ path, finding }) => ({
            checkpointSessionMetadataId: summaryRecord.id,
            path,
            finding,
          })),
        }));
      }
      if (sm.learnings?.workflow?.length) {
        creates.push(db.workflowItem.createMany({
          data: sm.learnings.workflow.map((text) => ({ checkpointSessionMetadataId: summaryRecord.id, text })),
        }));
      }

      await Promise.all(creates);
    }
  }
}

// ─── V2 full-tree indexer ─────────────────────────────────────────────────────

export async function indexAllCheckpointsV2(
  db: PrismaClient,
  rootDir: string,
  onProgress?: (checkpointId: string) => void,
): Promise<{ checkpoints: number }> {
  let totalCheckpoints = 0;

  const shards = readdirSync(rootDir)
    .filter((e) => /^[0-9a-f]{2}$/i.test(e) && statSync(join(rootDir, e)).isDirectory());

  for (const shard of shards) {
    const shardPath = join(rootDir, shard);
    const ids = readdirSync(shardPath)
      .filter((e) => /^[0-9a-f]{10}$/i.test(e) && statSync(join(shardPath, e)).isDirectory());

    for (const rest of ids) {
      const checkpointId  = shard + rest;
      const checkpointDir = join(shardPath, rest);
      try {
        await indexCheckpointV2(db, checkpointDir, checkpointId);
        totalCheckpoints++;
        onProgress?.(checkpointId);
      } catch (err) {
        process.stderr.write(`indexer-v2: skipping ${checkpointId}: ${err}\n`);
      }
    }
  }

  return { checkpoints: totalCheckpoints };
}

// ─── Full-tree indexer (V1 / old schema) ─────────────────────────────────────

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
