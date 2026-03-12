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
import { execSync } from "child_process";
import type { PrismaClient } from "../prisma/generated/client/index.js";
import { findCommitForCheckpoint } from "./gitUtils.js";
import { setupLogContentFts, syncLogContentFts } from "./search.js";

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

// ─── Git OID mapping helper ───────────────────────────────────────────────────

async function saveGitOidMapping(
  db: PrismaClient,
  checkpointId: string,
  branch: string | null | undefined,
  repoPath: string,
  existingMappings?: Map<string, string>,
): Promise<void> {
  if (!branch) return;
  try {
    const commit = await findCommitForCheckpoint(repoPath, branch, checkpointId);
    if (!commit) return;
    const existingOid = existingMappings?.get(checkpointId);
    if (existingOid === commit.hash) return; // exact (checkpointId, gitOid) pair already recorded
    // OID is new or changed (e.g. after rebase) — replace old entry if present
    if (existingOid) {
      await db.checkpointIdGitOidJoin.delete({ where: { gitOid: existingOid } }).catch(() => {});
    }
    await db.checkpointIdGitOidJoin.upsert({
      where: { gitOid: commit.hash },
      create: { gitOid: commit.hash, checkpointId },
      update: { checkpointId },
    });
    await db.checkpointMetadata.updateMany({
      where: { checkpointId },
      data: { gitUserName: commit.authorName || null, gitUserEmail: commit.authorEmail || null },
    });
    existingMappings?.set(checkpointId, commit.hash);
  } catch {
    // non-fatal — git may not be available or branch may not exist
  }
}

// ─── Single-checkpoint indexer ────────────────────────────────────────────────

/**
 * Index one checkpoint directory (the folder named by the last 10 hex chars,
 * e.g. `<root>/0c/b6cf391c40`).
 *
 * @returns Number of new messages written (already-indexed events are skipped).
 */

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
  repoPath?: string,
  mappedCheckpointIds?: Set<string>,
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

    // Look up an existing SessionLink for this transcript path.
    const transcriptVal = existsSync(transcriptFile) ? transcriptFile : null;
    const existing = transcriptVal
      ? await db.sessionLink.findFirst({
          where: { checkpointMetadataId: checkpointMeta.id, transcript: transcriptVal },
          select: { id: true, contentHash: true },
        })
      : null;

    // If the content hash hasn't changed, this session is fully indexed — skip it.
    if (existing && contentHash && existing.contentHash === contentHash) continue;

    let sessionLink: { id: number };
    if (existing) {
      // Hash changed (JSONL grew) — update the stored hash and re-index.
      sessionLink = await db.sessionLink.update({
        where: { id: existing.id },
        data: { contentHash },
        select: { id: true },
      });
    } else {
      sessionLink = await db.sessionLink.create({
        data: {
          checkpointMetadataId: checkpointMeta.id,
          metadata:   existsSync(metadataFile)   ? metadataFile   : null,
          transcript: transcriptVal,
          context:    existsSync(contextFile)    ? contextFile    : null,
          contentHash,
          prompt:     existsSync(promptFile)     ? promptFile     : null,
        },
        select: { id: true },
      });
    }

    if (transcriptVal) {
      await indexFullJsonl(db, transcriptVal, sessionLink.id);
    }

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

  if (repoPath && !mappedCheckpointIds?.has(checkpointId)) {
    await saveGitOidMapping(db, checkpointId, meta.branch, repoPath);
  }
}

// ─── Full JSONL log indexer ───────────────────────────────────────────────────

/**
 * Parse a full.jsonl transcript file and write normalized rows to the LogEvent
 * family of tables.  Already-indexed events (matched by uuid or messageId) are
 * skipped so this function is safe to call multiple times on the same file.
 *
 * @param sessionLinkId  Optional FK into SessionLink so events can be traced
 *                       back to the checkpoint/session that produced them.
 */
export async function indexFullJsonl(
  db: PrismaClient,
  transcriptPath: string,
  sessionLinkId?: number,
  shadowSessionId?: number,
): Promise<{ events: number }> {
  const content = readFileSync(transcriptPath, "utf8");
  return indexFullJsonlContent(db, content, sessionLinkId, shadowSessionId);
}

export async function indexFullJsonlContent(
  db: PrismaClient,
  content: string,
  sessionLinkId?: number,
  shadowSessionId?: number,
): Promise<{ events: number }> {
  const events = parseFullJsonl(content);

  // Pre-load known uuids / messageIds to skip duplicates without per-row queries.
  const [existingUuids, existingMessageIds] = await Promise.all([
    db.logEvent.findMany({ where: { uuid: { not: null } }, select: { uuid: true } })
      .then((rows) => new Set(rows.map((r) => r.uuid as string))),
    db.logEvent.findMany({ where: { messageId: { not: null } }, select: { messageId: true } })
      .then((rows) => new Set(rows.map((r) => r.messageId as string))),
  ]);

  let count = 0;

  for (const event of events) {
    // Deduplication: skip if this event was already indexed.
    if (event.uuid && existingUuids.has(event.uuid)) continue;
    if (event.messageId && existingMessageIds.has(event.messageId)) continue;

    const msg = event.message as Record<string, unknown> | undefined;

    const logEvent = await db.logEvent.create({
      data: {
        uuid:            event.uuid            ?? null,
        messageId:       event.messageId       ?? null,
        sessionId:       event.sessionId       ?? null,
        parentUuid:      event.parentUuid      ?? null,
        type:            event.type,
        timestamp:       event.timestamp ? new Date(event.timestamp) : null,
        cwd:             event.cwd             ?? null,
        gitBranch:       event.gitBranch       ?? null,
        version:         event.version         ?? null,
        slug:            event.slug            ?? null,
        isSidechain:     event.isSidechain     ?? null,
        userType:        event.userType        ?? null,
        toolUseId:       event.toolUseID       ?? null,
        parentToolUseId: event.parentToolUseID ?? null,
        requestId:       (event.requestId as string | undefined) ?? null,
        data:            JSON.stringify(event),
        sessionLinkId:   sessionLinkId         ?? null,
        shadowSessionId: shadowSessionId       ?? null,
      },
      select: { id: true },
    });

    // ── user / assistant: parse message content blocks ──────────────────────
    if ((event.type === "user" || event.type === "assistant") && msg) {
      const role = (msg.role as string | undefined) ?? event.type;
      const rawContent = msg.content;
      const contentArray: Record<string, unknown>[] =
        Array.isArray(rawContent)
          ? (rawContent as Record<string, unknown>[])
          : typeof rawContent === "string"
          ? [{ type: "text", text: rawContent }]
          : [];

      for (let i = 0; i < contentArray.length; i++) {
        const c = contentArray[i];
        const cType = (c.type as string | undefined) ?? "text";

        // Stringify tool_result content if it's not already a string.
        let toolResultContent: string | null = null;
        if (cType === "tool_result") {
          toolResultContent =
            typeof c.content === "string"
              ? c.content
              : c.content != null
              ? JSON.stringify(c.content)
              : null;
        }

        await db.logContent.create({
          data: {
            logEventId:        logEvent.id,
            role,
            contentIndex:      i,
            contentType:       cType,
            text:              (c.text as string | undefined)         ?? null,
            thinking:          (c.thinking as string | undefined)     ?? null,
            toolUseId:         (c.id as string | undefined)           // tool_use block
                            ?? (c.tool_use_id as string | undefined)  // tool_result block
                            ?? null,
            toolName:          (c.name as string | undefined)         ?? null,
            toolInput:         c.input != null ? JSON.stringify(c.input) : null,
            toolResultContent,
            isError:           (c.is_error as boolean | undefined)    ?? null,
          },
        });
      }

      // ── assistant: token usage ────────────────────────────────────────────
      if (event.type === "assistant") {
        const u = msg.usage as Record<string, unknown> | undefined;
        if (u) {
          await db.logUsage.create({
            data: {
              logEventId:               logEvent.id,
              model:                    (msg.model as string | undefined)       ?? null,
              stopReason:               (msg.stop_reason as string | undefined) ?? null,
              inputTokens:              Number(u.input_tokens               ?? 0),
              cacheCreationInputTokens: Number(u.cache_creation_input_tokens ?? 0),
              cacheReadInputTokens:     Number(u.cache_read_input_tokens     ?? 0),
              outputTokens:             Number(u.output_tokens               ?? 0),
            },
          });
        }
      }
    }

    // ── progress: hook_progress data ─────────────────────────────────────────
    if (event.type === "progress") {
      const d = event.data as Record<string, unknown> | undefined;
      await db.logHookProgress.create({
        data: {
          logEventId: logEvent.id,
          type:       (d?.type      as string | undefined) ?? null,
          hookEvent:  (d?.hookEvent as string | undefined) ?? null,
          hookName:   (d?.hookName  as string | undefined) ?? null,
          command:    (d?.command   as string | undefined) ?? null,
        },
      });
    }

    // ── system events ─────────────────────────────────────────────────────────
    if (event.type === "system") {
      const e = event as Record<string, unknown>;
      await db.logSystemEvent.create({
        data: {
          logEventId:            logEvent.id,
          subtype:               (e.subtype               as string  | undefined) ?? null,
          hookCount:             (e.hookCount              as number  | undefined) ?? null,
          stopReason:            (e.stopReason             as string  | undefined) ?? null,
          preventedContinuation: (e.preventedContinuation  as boolean | undefined) ?? null,
          level:                 (e.level                 as string  | undefined) ?? null,
          durationMs:            (e.durationMs             as number  | undefined) ?? null,
        },
      });
    }

    // Mark as seen so a duplicate later in the same file is also skipped.
    if (event.uuid)      existingUuids.add(event.uuid);
    if (event.messageId) existingMessageIds.add(event.messageId);

    count++;
  }

  return { events: count };
}

// ─── V2 full-tree indexer ─────────────────────────────────────────────────────

export async function indexAllCheckpointsV2(
  db: PrismaClient,
  rootDir: string,
  onProgress?: (checkpointId: string) => void,
  repoPath?: string,
): Promise<{ checkpoints: number }> {
  let totalCheckpoints = 0;

  // Pre-fetch all checkpoint IDs that already have a git OID mapping so we
  // can skip the per-checkpoint DB read inside saveGitOidMapping.
  let mappedCheckpointIds: Set<string> | undefined;
  if (repoPath) {
    const rows = await db.checkpointIdGitOidJoin.findMany({ select: { checkpointId: true } });
    mappedCheckpointIds = new Set(rows.map((r) => r.checkpointId));
  }

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
        await indexCheckpointV2(db, checkpointDir, checkpointId, repoPath, mappedCheckpointIds);
        mappedCheckpointIds?.add(checkpointId); // keep set current for this pass
        totalCheckpoints++;
        onProgress?.(checkpointId);
      } catch (err) {
        process.stderr.write(`indexer-v2: skipping ${checkpointId}: ${err}\n`);
      }
    }
  }

  // Sync FTS index with any new LogContent rows added during this pass
  await setupLogContentFts(db);
  await syncLogContentFts(db);

  return { checkpoints: totalCheckpoints };
}

// ─── Full-tree indexer ───────────────────────────────────────────────────────

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
  onProgress?: (checkpointId: string) => void,
  repoPath?: string,
): Promise<{ checkpoints: number }> {
  const result = await indexAllCheckpointsV2(db, rootDir, onProgress, repoPath);
  return { checkpoints: result.checkpoints };
}

// ─── Shadow branch indexer ────────────────────────────────────────────────────
//
// Shadow branches (entire/<commit>-<hash>) hold in-progress sessions that
// haven't been committed to entire/checkpoints/v1 yet. Each branch contains:
//
//   .entire/metadata/<session-id>/full.jsonl   — live transcript
//   .entire/metadata/<session-id>/prompt.txt   — initial user prompt
//
// We read these directly from git (git ls-tree + git cat-file blob) so we
// don't need a worktree checkout. Change detection is via the git blob SHA.

function gitExec(args: string, cwd: string): string {
  return execSync(`git ${args}`, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function getShadowBranches(repoPath: string): string[] {
  try {
    return gitExec("branch", repoPath)
      .split("\n")
      .map((l) => l.trim().replace(/^\* /, ""))
      .filter((b) => b.startsWith("entire/") && !b.startsWith("entire/checkpoints"));
  } catch { return []; }
}

function getShadowSessions(repoPath: string, branch: string): { sessionId: string; blobSha: string }[] {
  try {
    const output = gitExec(`ls-tree -r ${branch} -- .entire/metadata/`, repoPath);
    const sessions = new Map<string, string>();
    for (const line of output.split("\n")) {
      const m = line.match(/^100644 blob ([0-9a-f]+)\s+\.entire\/metadata\/([^/]+)\/full\.jsonl$/);
      if (m) sessions.set(m[2], m[1]);
    }
    return [...sessions.entries()].map(([sessionId, blobSha]) => ({ sessionId, blobSha }));
  } catch { return []; }
}

function readBlobContent(repoPath: string, blobSha: string): string {
  return gitExec(`cat-file blob ${blobSha}`, repoPath);
}

function readPromptFromBranch(repoPath: string, branch: string, sessionId: string): string | null {
  try {
    return gitExec(`show ${branch}:.entire/metadata/${sessionId}/prompt.txt`, repoPath).trim();
  } catch { return null; }
}

/**
 * Index all sessions from all local shadow branches (entire/<x>-<y>).
 * Reads transcripts directly from git — no worktree required.
 * Returns the number of sessions that had new or updated content.
 */
export async function indexAllShadowBranches(
  db: PrismaClient,
  repoPath: string,
): Promise<{ sessions: number }> {
  const branches = getShadowBranches(repoPath);
  let totalSessions = 0;

  for (const branch of branches) {
    const sessions = getShadowSessions(repoPath, branch);

    for (const { sessionId, blobSha } of sessions) {
      // Skip if this exact blob SHA has already been indexed for this session.
      // (Same session appears in multiple shadow branches as its transcript grows;
      //  each branch may have a different SHA even for the same underlying content.)
      const existing = await db.shadowSession.findUnique({ where: { sessionId } });
      const seenShas: string[] = existing ? (JSON.parse(existing.seenBlobShas) as string[]) : [];
      if (seenShas.includes(blobSha)) continue;

      const fullJsonlContent = readBlobContent(repoPath, blobSha);
      const events = parseFullJsonl(fullJsonlContent);

      // Extract session metadata from the first event that carries it.
      const firstMeta = events.find((e) => e.sessionId || e.cwd || e.gitBranch);
      const cwd       = firstMeta?.cwd       ?? null;
      const gitBranch = firstMeta?.gitBranch ?? null;
      const createdAt = firstMeta?.timestamp ? new Date(firstMeta.timestamp) : null;
      const prompt    = readPromptFromBranch(repoPath, branch, sessionId);
      const newSeenShas = JSON.stringify([...seenShas, blobSha]);

      const shadowSession = await db.shadowSession.upsert({
        where:  { sessionId },
        create: { sessionId, branch, seenBlobShas: newSeenShas, prompt, cwd, gitBranch, createdAt },
        update: { branch, seenBlobShas: newSeenShas, prompt, cwd, gitBranch, createdAt },
      });

      const { events: newEvents } = await indexFullJsonlContent(db, fullJsonlContent, undefined, shadowSession.id);

      process.stderr.write(`shadow indexer: indexed session ${sessionId.slice(0, 8)} (+${newEvents} events) from ${branch}\n`);
      totalSessions++;
    }
  }

  if (totalSessions > 0) {
    await setupLogContentFts(db);
    await syncLogContentFts(db);
  }

  return { sessions: totalSessions };
}
