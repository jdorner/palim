/**
 * Tests for the wiki embedding cache.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import createLogger from "logging";
import { computeContentHash, EmbeddingCache } from "./embeddingCache";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const log = createLogger("test:wiki-cache");

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA journal_mode = WAL");
  const db = drizzle(sqlite);

  // Create the table manually for in-memory tests
  sqlite.run(`
    CREATE TABLE IF NOT EXISTS ext_wiki_embeddings (
      content_hash TEXT PRIMARY KEY NOT NULL,
      embedding TEXT NOT NULL,
      model TEXT NOT NULL,
      dimension INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  return db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EmbeddingCache", () => {
  let cache: EmbeddingCache;

  beforeEach(() => {
    const db = createTestDb();
    cache = new EmbeddingCache(db, log);
  });

  describe("getCachedEmbedding", () => {
    test("returns null for missing entry", () => {
      const result = cache.getCachedEmbedding("nonexistent-hash", "model-a");
      expect(result).toBeNull();
    });

    test("returns cached embedding for matching hash and model", () => {
      const embedding = [0.1, 0.2, 0.3];
      cache.setCachedEmbedding("hash-1", embedding, "model-a", 3);

      const result = cache.getCachedEmbedding("hash-1", "model-a");
      expect(result).not.toBeNull();
      expect(result!.embedding).toEqual(embedding);
      expect(result!.model).toBe("model-a");
      expect(result!.dimension).toBe(3);
    });

    test("returns null when model ID does not match (cache invalidation)", () => {
      const embedding = [0.1, 0.2, 0.3];
      cache.setCachedEmbedding("hash-1", embedding, "model-a", 3);

      const result = cache.getCachedEmbedding("hash-1", "model-b");
      expect(result).toBeNull();
    });
  });

  describe("setCachedEmbedding", () => {
    test("stores embedding and retrieves it", () => {
      const embedding = [0.5, 0.6, 0.7, 0.8];
      cache.setCachedEmbedding("hash-2", embedding, "model-x", 4);

      const result = cache.getCachedEmbedding("hash-2", "model-x");
      expect(result).not.toBeNull();
      expect(result!.embedding).toEqual(embedding);
    });

    test("upserts on conflict (same hash, different model)", () => {
      cache.setCachedEmbedding("hash-3", [0.1, 0.2], "old-model", 2);
      cache.setCachedEmbedding("hash-3", [0.3, 0.4, 0.5], "new-model", 3);

      // Old model should miss
      expect(cache.getCachedEmbedding("hash-3", "old-model")).toBeNull();
      // New model should hit
      const result = cache.getCachedEmbedding("hash-3", "new-model");
      expect(result).not.toBeNull();
      expect(result!.embedding).toEqual([0.3, 0.4, 0.5]);
      expect(result!.dimension).toBe(3);
    });
  });

  describe("purgeStaleEntries", () => {
    test("removes entries with a different model ID", () => {
      cache.setCachedEmbedding("hash-a", [0.1], "old-model", 1);
      cache.setCachedEmbedding("hash-b", [0.2], "old-model", 1);
      cache.setCachedEmbedding("hash-c", [0.3], "current-model", 1);

      const removed = cache.purgeStaleEntries("current-model");
      expect(removed).toBe(2);

      // Current model entries survive
      expect(cache.getCachedEmbedding("hash-c", "current-model")).not.toBeNull();
      // Old entries gone
      expect(cache.count()).toBe(1);
    });

    test("removes nothing when all entries match current model", () => {
      cache.setCachedEmbedding("hash-a", [0.1], "model-a", 1);
      cache.setCachedEmbedding("hash-b", [0.2], "model-a", 1);

      const removed = cache.purgeStaleEntries("model-a");
      expect(removed).toBe(0);
      expect(cache.count()).toBe(2);
    });
  });

  describe("count", () => {
    test("returns 0 for empty cache", () => {
      expect(cache.count()).toBe(0);
    });

    test("returns correct count after insertions", () => {
      cache.setCachedEmbedding("h1", [0.1], "m", 1);
      cache.setCachedEmbedding("h2", [0.2], "m", 1);
      cache.setCachedEmbedding("h3", [0.3], "m", 1);
      expect(cache.count()).toBe(3);
    });
  });

  describe("clear", () => {
    test("removes all entries", () => {
      cache.setCachedEmbedding("h1", [0.1], "m", 1);
      cache.setCachedEmbedding("h2", [0.2], "m", 1);
      cache.clear();
      expect(cache.count()).toBe(0);
    });
  });
});

describe("computeContentHash", () => {
  test("produces consistent hash for same input", () => {
    const hash1 = computeContentHash("hello world");
    const hash2 = computeContentHash("hello world");
    expect(hash1).toBe(hash2);
  });

  test("produces different hashes for different input", () => {
    const hash1 = computeContentHash("hello");
    const hash2 = computeContentHash("world");
    expect(hash1).not.toBe(hash2);
  });

  test("returns 64-character hex string (SHA-256)", () => {
    const hash = computeContentHash("test");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });
});
