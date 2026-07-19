/**
 * Integration tests for wiki semantic search.
 *
 * Tests the full flow from file indexing through embedding generation
 * to hybrid search, using mock embeddings.
 */

import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create, insert, search } from "@orama/orama";
import { drizzle } from "drizzle-orm/bun-sqlite";
import createLogger from "logging";
import { EmbeddingCache } from "./embeddingCache";
import { EmbeddingManager } from "./embeddingManager";
import { EmbeddingService } from "./embeddings";
import { chunkMarkdown, createWikiIndex } from "./index";

const logger = createLogger("test:wiki-integration");
const TEST_TMP_BASE = join(import.meta.dir, ".test-tmp-integration");

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(TEST_TMP_BASE, `wiki-int-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});
afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});
afterAll(() => {
  if (existsSync(TEST_TMP_BASE)) rmSync(TEST_TMP_BASE, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA journal_mode = WAL");
  const db = drizzle(sqlite);
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

/** Creates a mock fetch that generates deterministic embeddings based on text content. */
function mockDeterministicFetch(dimension: number) {
  const fn = async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? "{}");
    const inputs = Array.isArray(body.input) ? body.input : [body.input];

    // Generate deterministic embeddings based on text hash
    const data = inputs.map((text: string, i: number) => {
      const embedding = Array.from({ length: dimension }, (_, j) => {
        // Create a simple hash-based vector from the text
        let hash = 0;
        for (let k = 0; k < text.length; k++) {
          hash = (hash * 31 + text.charCodeAt(k) + j) % 1000;
        }
        return hash / 1000;
      });
      return { embedding, index: i };
    });

    return new Response(JSON.stringify({ data, model: "test-embed-model" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  fn.preconnect = () => {};
  return fn as unknown as typeof globalThis.fetch;
}

function wikiFile(name: string, content: string): void {
  writeFileSync(join(tmpDir, `${name}.md`), content);
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("Wiki semantic search integration", () => {
  test("indexes markdown files with embeddings via EmbeddingManager", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockDeterministicFetch(8);

    try {
      const service = new EmbeddingService(logger, "http://localhost:11434/v1", async () => "test-embed-model", 2048);
      await service.initialize();

      const db = createTestDb();
      const cache = new EmbeddingCache(db, logger);
      const manager = new EmbeddingManager(service, cache, logger);

      // Create some wiki content
      const content1 = "## Backup Configuration\n\nHow to set up automated backups for your database.";
      const content2 = "## Network Troubleshooting\n\nSteps to diagnose network connectivity issues.";

      const chunks1 = chunkMarkdown("backup.md", content1);
      const chunks2 = chunkMarkdown("network.md", content2);

      // Embed chunks
      const embedded1 = await manager.embedChunks(chunks1);
      const embedded2 = await manager.embedChunks(chunks2);

      // All chunks should have embeddings
      for (const { embedding } of embedded1) {
        expect(embedding).not.toBeNull();
        expect(embedding).toHaveLength(8);
      }
      for (const { embedding } of embedded2) {
        expect(embedding).not.toBeNull();
        expect(embedding).toHaveLength(8);
      }

      // Cache should be populated
      expect(cache.count()).toBe(chunks1.length + chunks2.length);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("cache prevents re-embedding unchanged content", async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    const fn = async (_url: string | URL | Request, init?: RequestInit) => {
      callCount++;
      const body = JSON.parse((init?.body as string) ?? "{}");
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      const data = inputs.map((_: string, i: number) => ({
        embedding: Array.from({ length: 4 }, () => Math.random()),
        index: i,
      }));
      return new Response(JSON.stringify({ data, model: "test-model" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    fn.preconnect = () => {};
    globalThis.fetch = fn as unknown as typeof globalThis.fetch;

    try {
      const service = new EmbeddingService(logger, "http://localhost:11434/v1", async () => "test-model", 2048);
      await service.initialize();

      const db = createTestDb();
      const cache = new EmbeddingCache(db, logger);
      const manager = new EmbeddingManager(service, cache, logger);

      const content = "## Test\n\nSame content both times.";
      const chunks = chunkMarkdown("test.md", content);

      // First call - should hit the API
      const beforeCount = callCount;
      await manager.embedChunks(chunks);
      const apiCallsFirstTime = callCount - beforeCount;

      // Second call with same content - should use cache (no additional API calls)
      const beforeSecondCount = callCount;
      const result = await manager.embedChunks(chunks);
      const apiCallsSecondTime = callCount - beforeSecondCount;

      expect(apiCallsFirstTime).toBeGreaterThan(0);
      expect(apiCallsSecondTime).toBe(0);
      expect(result[0]!.embedding).not.toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("graceful degradation when embedding service is unavailable", async () => {
    // Service that fails to initialize
    const service = new EmbeddingService(logger, "http://localhost:99999/v1", async () => {
      throw new Error("No model");
    });
    await service.initialize();

    expect(service.isAvailable()).toBe(false);

    // Creating an index without embeddings should still work
    wikiFile("test", "# Hello\n\nWorld.");
    const index = await createWikiIndex(tmpDir, logger, "");
    const results = await search(index, { term: "World", properties: ["title", "content"] });
    expect(results.hits.length).toBeGreaterThanOrEqual(1);
  });

  test("Orama hybrid search with vector field works end-to-end", async () => {
    // Create an Orama index with vector support directly
    const dimension = 4;
    const index = create({
      schema: {
        id: "string",
        title: "string",
        content: "string",
        embedding: `vector[${dimension}]`,
      },
    } as any);

    // Insert documents with embeddings
    insert(index, {
      id: "1",
      title: "Backup Guide",
      content: "How to configure automated backups",
      embedding: [0.9, 0.1, 0.2, 0.3],
    });
    insert(index, {
      id: "2",
      title: "Network Setup",
      content: "Configure network interfaces and routing",
      embedding: [0.1, 0.9, 0.2, 0.3],
    });
    insert(index, {
      id: "3",
      title: "Database Maintenance",
      content: "Regular database maintenance and optimization",
      embedding: [0.8, 0.2, 0.3, 0.4],
    });

    // Vector search should find documents similar to query vector
    const vectorResults = await search(index, {
      mode: "vector",
      vector: { value: [0.85, 0.15, 0.2, 0.35], property: "embedding" },
      similarity: 0.5,
      limit: 3,
    } as any);
    expect(vectorResults.hits.length).toBeGreaterThanOrEqual(1);

    // Hybrid search combines text + vector
    const hybridResults = await search(index, {
      term: "backup",
      mode: "hybrid",
      vector: { value: [0.85, 0.15, 0.2, 0.35], property: "embedding" },
      properties: ["title", "content"],
      similarity: 0.5,
      limit: 3,
    } as any);
    expect(hybridResults.hits.length).toBeGreaterThanOrEqual(1);

    // Fulltext-only still works
    const fulltextResults = await search(index, {
      term: "network",
      properties: ["title", "content"],
      limit: 3,
    } as any);
    expect(fulltextResults.hits.length).toBeGreaterThanOrEqual(1);
  });

  test("file changes trigger re-embedding via cache", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockDeterministicFetch(4);

    try {
      const service = new EmbeddingService(logger, "http://localhost:11434/v1", async () => "test-model", 2048);
      await service.initialize();

      const db = createTestDb();
      const cache = new EmbeddingCache(db, logger);
      const manager = new EmbeddingManager(service, cache, logger);

      // Original content
      const originalContent = "## Original\n\nOriginal content here.";
      const originalChunks = chunkMarkdown("file.md", originalContent);
      const originalEmbedded = await manager.embedChunks(originalChunks);
      const originalEmbedding = originalEmbedded[0]!.embedding!;

      // Modified content (different text should produce different embedding)
      const modifiedContent = "## Modified\n\nCompletely different content now.";
      const modifiedChunks = chunkMarkdown("file.md", modifiedContent);
      const modifiedEmbedded = await manager.embedChunks(modifiedChunks);
      const modifiedEmbedding = modifiedEmbedded[0]!.embedding!;

      // Embeddings should be different (different content hashes)
      expect(modifiedEmbedding).not.toEqual(originalEmbedding);

      // Cache should have entries for both versions
      expect(cache.count()).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Model change re-indexing
// ---------------------------------------------------------------------------

describe("Model change re-indexing", () => {
  test("hasModelChanged() detects when service model drifts from indexed model", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockDeterministicFetch(4);

    try {
      let currentModel = "model-a";
      const service = new EmbeddingService(logger, "http://localhost:11434/v1", async () => currentModel, 2048);
      await service.initialize();

      const db = createTestDb();
      const cache = new EmbeddingCache(db, logger);
      const manager = new EmbeddingManager(service, cache, logger);

      // Simulate initial indexing complete
      const chunks = chunkMarkdown("test.md", "## Test\n\nContent.");
      await manager.embedChunks(chunks);
      manager.setVectorReady(true);

      // At this point, indexedModelId === "model-a", service reports "model-a"
      expect(manager.hasModelChanged()).toBe(false);
      expect(manager.isVectorReady()).toBe(true);

      // Simulate user changing the model via UI (next resolve returns different model)
      currentModel = "model-b";
      // Force the service to re-resolve by calling generateEmbedding (which calls currentModelId())
      await service.generateEmbedding("trigger resolve");

      // Now service reports "model-b" but indexed model is still "model-a"
      expect(manager.hasModelChanged()).toBe(true);

      // Simulate re-index: setVectorReady(false), re-embed, then setVectorReady(true)
      manager.setVectorReady(false);
      expect(manager.isVectorReady()).toBe(false);

      await manager.embedChunks(chunks);
      manager.setVectorReady(true);

      // After re-index, indexedModelId should now be "model-b"
      expect(manager.getIndexedModelId()).toBe("model-b");
      expect(manager.hasModelChanged()).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("cache misses on model change forces re-embedding", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCallCount = 0;
    const fn = async (_url: string | URL | Request, init?: RequestInit) => {
      fetchCallCount++;
      const body = JSON.parse((init?.body as string) ?? "{}");
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      const data = inputs.map((_: string, i: number) => ({
        embedding: Array.from({ length: 4 }, (__, j) => (fetchCallCount + i + j) / 100),
        index: i,
      }));
      return new Response(JSON.stringify({ data, model: body.model }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    fn.preconnect = () => {};
    globalThis.fetch = fn as unknown as typeof globalThis.fetch;

    try {
      let currentModel = "model-v1";
      const service = new EmbeddingService(logger, "http://localhost:11434/v1", async () => currentModel, 2048);
      await service.initialize();

      const db = createTestDb();
      const cache = new EmbeddingCache(db, logger);
      const manager = new EmbeddingManager(service, cache, logger);

      const chunks = chunkMarkdown("doc.md", "## Info\n\nSome important information.");

      // First embed with model-v1
      const callsBefore = fetchCallCount;
      await manager.embedChunks(chunks);
      const callsAfterFirst = fetchCallCount;
      expect(callsAfterFirst - callsBefore).toBeGreaterThan(0);

      // Second embed with same model - should hit cache (no new API calls)
      await manager.embedChunks(chunks);
      expect(fetchCallCount - callsAfterFirst).toBe(0);

      // Switch model
      currentModel = "model-v2";
      await service.generateEmbedding("force model resolve");

      // Third embed with new model - cache miss (different model), must call API again
      const callsBeforeReembed = fetchCallCount;
      await manager.embedChunks(chunks);
      expect(fetchCallCount - callsBeforeReembed).toBeGreaterThan(0);

      // Cache entry was upserted (same content hash, new model)
      expect(cache.count()).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("refreshModel() is required before embedChunks to pick up model change", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCallCount = 0;
    const fn = async (_url: string | URL | Request, init?: RequestInit) => {
      fetchCallCount++;
      const body = JSON.parse((init?.body as string) ?? "{}");
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      const data = inputs.map((_: string, i: number) => ({
        embedding: Array.from({ length: 4 }, (__, j) => (fetchCallCount + i + j) / 100),
        index: i,
      }));
      return new Response(JSON.stringify({ data, model: body.model }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    fn.preconnect = () => {};
    globalThis.fetch = fn as unknown as typeof globalThis.fetch;

    try {
      let currentModel = "model-old";
      const service = new EmbeddingService(logger, "http://localhost:11434/v1", async () => currentModel, 2048);
      await service.initialize();

      const db = createTestDb();
      const cache = new EmbeddingCache(db, logger);
      const manager = new EmbeddingManager(service, cache, logger);

      const chunks = chunkMarkdown("doc.md", "## Page\n\nContent to embed.");

      // Initial embedding with model-old
      await manager.embedChunks(chunks);
      const callsAfterInit = fetchCallCount;

      // Switch model externally (simulates user changing via UI)
      currentModel = "model-new";

      // WITHOUT refreshModel: embedChunks still sees old model ID, gets cache hit, no API call
      await manager.embedChunks(chunks);
      expect(fetchCallCount).toBe(callsAfterInit); // no new calls

      // WITH refreshModel: service picks up the new model, cache misses, forces re-embed
      await manager.refreshModel();
      const callsBeforeReembed = fetchCallCount;
      await manager.embedChunks(chunks);
      expect(fetchCallCount - callsBeforeReembed).toBeGreaterThan(0); // new API calls made
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
