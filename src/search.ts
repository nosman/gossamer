import type { PrismaClient } from "../prisma/generated/client/index.js";

// ─── Setup ────────────────────────────────────────────────────────────────────

/**
 * Create the FTS5 virtual table if it doesn't exist.
 * The rowid of LogContentFts equals LogContent.id so results can be joined back.
 * Metadata columns (contentType, logEventId, sessionId, timestamp, toolName) are
 * stored but not indexed (UNINDEXED) — they're used for filtering and display.
 */
export async function setupLogContentFts(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(`
    CREATE VIRTUAL TABLE IF NOT EXISTS LogContentFts USING fts5(
      text,
      thinking,
      toolResultContent,
      toolInput,
      contentType   UNINDEXED,
      logEventId    UNINDEXED,
      sessionId     UNINDEXED,
      timestamp     UNINDEXED,
      toolName      UNINDEXED
    )
  `);
}

// ─── Sync ─────────────────────────────────────────────────────────────────────

/**
 * Insert any LogContent rows not yet present in the FTS index.
 * Safe to call repeatedly — already-indexed rows are skipped via rowid check.
 * Returns the number of rows inserted.
 */
export async function syncLogContentFts(db: PrismaClient): Promise<number> {
  return db.$executeRawUnsafe(`
    INSERT INTO LogContentFts(
      rowid, text, thinking, toolResultContent, toolInput,
      contentType, logEventId, sessionId, timestamp, toolName
    )
    SELECT
      lc.id,
      COALESCE(lc.text,              ''),
      COALESCE(lc.thinking,          ''),
      COALESCE(lc.toolResultContent, ''),
      COALESCE(lc.toolInput,         ''),
      lc.contentType,
      lc.logEventId,
      COALESCE(le.sessionId,  ''),
      COALESCE(le.timestamp,  ''),
      COALESCE(lc.toolName,   '')
    FROM LogContent lc
    LEFT JOIN LogEvent le ON le.id = lc.logEventId
    WHERE lc.id NOT IN (SELECT rowid FROM LogContentFts)
  `);
}

/**
 * Drop and rebuild the FTS index from scratch.
 * Use this after bulk imports when incremental sync is too slow.
 */
export async function rebuildLogContentFts(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(`DELETE FROM LogContentFts`);
  await syncLogContentFts(db);
}

// ─── Search ───────────────────────────────────────────────────────────────────

export interface LogContentSearchResult {
  logContentId: number;
  logEventId: number;
  sessionId: string;
  timestamp: string | null;
  contentType: string;
  toolName: string | null;
  /** "user" | "assistant" — which side of the conversation this content came from. */
  logEventType: string;
  gitUserName: string | null;
  gitUserEmail: string | null;
  /** FTS5 snippet with «match» markers around matched terms. */
  snippet: string;
  /** BM25 rank (more negative = better match). */
  rank: number;
}

/**
 * Full-text search across LogContent fields (text, thinking, toolResultContent,
 * toolInput).  Accepts standard FTS5 MATCH syntax:
 *   - bare word:   foo
 *   - phrase:      "foo bar"
 *   - prefix:      foo*
 *   - column:      text:foo
 *   - boolean:     foo AND bar, foo OR bar, foo NOT bar
 *
 * Results are ordered by BM25 relevance (best first).
 */
export async function searchLogContent(
  db: PrismaClient,
  query: string,
  limit = 50,
): Promise<LogContentSearchResult[]> {
  type Row = {
    logContentId: number | bigint;
    logEventId: number | bigint;
    sessionId: string;
    timestamp: string | null;
    contentType: string;
    toolName: string | null;
    logEventType: string;
    gitUserName: string | null;
    gitUserEmail: string | null;
    snippet: string;
    rank: number;
  };

  // Run FTS match in a subquery first, then join for extra metadata.
  const rows = await db.$queryRawUnsafe<Row[]>(`
    SELECT
      fts.logContentId,
      fts.logEventId,
      fts.sessionId,
      fts.timestamp,
      fts.contentType,
      fts.toolName,
      fts.snippet,
      fts.rank,
      le.type   AS logEventType,
      s.gitUserName,
      s.gitUserEmail
    FROM (
      SELECT
        rowid                                              AS logContentId,
        logEventId,
        sessionId,
        timestamp,
        contentType,
        toolName,
        snippet(LogContentFts, -1, '«', '»', '…', 24)   AS snippet,
        rank
      FROM LogContentFts
      WHERE LogContentFts MATCH ?
      ORDER BY rank
      LIMIT ?
    ) fts
    JOIN LogEvent le ON le.id = fts.logEventId
    LEFT JOIN Session s ON s.sessionId = fts.sessionId
  `, query, limit);

  return rows.map((r) => ({
    logContentId:  Number(r.logContentId),
    logEventId:    Number(r.logEventId),
    sessionId:     r.sessionId,
    timestamp:     r.timestamp,
    contentType:   r.contentType,
    toolName:      r.toolName || null,
    logEventType:  r.logEventType,
    gitUserName:   r.gitUserName || null,
    gitUserEmail:  r.gitUserEmail || null,
    snippet:       r.snippet,
    rank:          r.rank,
  }));
}
