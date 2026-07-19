/**
 * SQLite-backed embedding cache for the wiki extension.
 *
 * Stores generated embeddings keyed by content hash to avoid
 * re-generating embeddings for unchanged wiki content across restarts.
 * Cache entries are invalidated when the embedding model changes.
 *
 * @module
 */

import { eq, ne } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { Logger } from "logging";
import { wikiEmbeddings } from "./schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A cached embedding entry. */
export interface CachedEmbedding {
  /** The embedding vector. */
  embedding: number[];
  /** Model ID that generated this embedding. */
  model: string;
  /** Vector dimension. */
  dimension: number;
}

// ---------------------------------------------------------------------------
// EmbeddingCache
// ---------------------------------------------------------------------------

/**
 * SQLite-backed cache for wiki chunk embeddings.
 *
 * Keyed by SHA-256 content hash. Entries are only valid when the model ID
 * matches the currently configured embedding model.
 */
export class EmbeddingCache {
  private readonly db: BunSQLiteDatabase<Record<string, unknown>>;
  private readonly log: Logger;

  /**
   * @param db - Drizzle database instance
   * @param log - Logger for diagnostics
   */
  constructor(db: BunSQLiteDatabase<Record<string, unknown>>, log: Logger) {
    this.db = db;
    this.log = log;
  }

  /**
   * Retrieves a cached embedding for a given content hash and model.
   *
   * Returns null if no cache entry exists or if the stored model ID
   * differs from the requested model (cache invalidation).
   *
   * @param contentHash - SHA-256 hash of the chunk text
   * @param model - Expected model ID (must match stored entry)
   * @returns The cached embedding, or null on miss/mismatch
   */
  getCachedEmbedding(contentHash: string, model: string): CachedEmbedding | null {
    const rows = this.db.select().from(wikiEmbeddings).where(eq(wikiEmbeddings.contentHash, contentHash)).all();

    const row = rows[0];
    if (!row) return null;

    // Invalidate if model changed
    if (row.model !== model) return null;

    try {
      const embedding = JSON.parse(row.embedding) as number[];
      return { embedding, model: row.model, dimension: row.dimension };
    } catch {
      this.log.warn(`[wiki/cache] Corrupt cache entry for hash ${contentHash}, ignoring`);
      return null;
    }
  }

  /**
   * Stores an embedding in the cache, upserting on content hash conflict.
   *
   * @param contentHash - SHA-256 hash of the chunk text
   * @param embedding - The embedding vector to cache
   * @param model - Model ID that generated this embedding
   * @param dimension - Vector dimension
   */
  setCachedEmbedding(contentHash: string, embedding: number[], model: string, dimension: number): void {
    const now = Date.now();
    this.db
      .insert(wikiEmbeddings)
      .values({
        contentHash,
        embedding: JSON.stringify(embedding),
        model,
        dimension,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: wikiEmbeddings.contentHash,
        set: {
          embedding: JSON.stringify(embedding),
          model,
          dimension,
          createdAt: now,
        },
      })
      .run();
  }

  /**
   * Removes all cache entries that don't match the given model ID.
   * Used to clean up stale entries after a model change.
   *
   * @param currentModel - The currently active model ID
   * @returns Number of entries removed
   */
  purgeStaleEntries(currentModel: string): number {
    // Count stale entries before deletion (drizzle .run() returns void)
    const staleRows = this.db.select().from(wikiEmbeddings).where(ne(wikiEmbeddings.model, currentModel)).all();
    const count = staleRows.length;

    if (count > 0) {
      this.db.delete(wikiEmbeddings).where(ne(wikiEmbeddings.model, currentModel)).run();
    }

    return count;
  }

  /**
   * Returns the total number of cached entries.
   */
  count(): number {
    const rows = this.db.select().from(wikiEmbeddings).all();
    return rows.length;
  }

  /**
   * Clears all cached embeddings.
   */
  clear(): void {
    this.db.delete(wikiEmbeddings).run();
  }
}

/**
 * Computes a SHA-256 hash of the given text for use as a cache key.
 *
 * @param text - Input text to hash
 * @returns Hex-encoded SHA-256 hash
 */
export function computeContentHash(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return hasher.digest("hex");
}
