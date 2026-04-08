import { PrismaClient } from "../prisma/generated/client/index.js";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { mkdirSync } from "fs";
import { resolve, dirname } from "path";

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

/**
 * Remove a cached PrismaClient so the next `getDb()` call creates a fresh one.
 * Useful when the underlying .db file was deleted and recreated.
 */
export function evictDb(dbPath: string): void {
  const abs = resolve(dbPath);
  const cached = dbCache.get(abs);
  if (cached) {
    cached.$disconnect().catch(() => {});
    dbCache.delete(abs);
  }
}
