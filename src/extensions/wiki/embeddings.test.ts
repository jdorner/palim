/**
 * Tests for the wiki embedding service.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import createLogger from "logging";
import { EmbeddingService } from "./embeddings";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const log = createLogger("test:wiki-embeddings");

/** Creates a mock fetch that returns embeddings of the specified dimension. */
function mockFetch(dimension: number, statusCode = 200) {
  const fn = async (_url: string | URL | Request, init?: RequestInit) => {
    if (statusCode !== 200) {
      return new Response(null, { status: statusCode });
    }

    const body = JSON.parse((init?.body as string) ?? "{}");
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    const data = inputs.map((_: unknown, i: number) => ({
      embedding: Array.from({ length: dimension }, () => Math.random()),
      index: i,
    }));

    return new Response(JSON.stringify({ data, model: "test-model" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  fn.preconnect = () => {};
  return fn as unknown as typeof globalThis.fetch;
}

/** Creates a mock fetch that fails with a network error. */
function mockFetchError() {
  const fn = async () => {
    throw new Error("Connection refused");
  };
  fn.preconnect = () => {};
  return fn as unknown as typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EmbeddingService", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  // Restore fetch after each test
  function restoreFetch() {
    globalThis.fetch = originalFetch;
  }

  describe("initialize", () => {
    test("detects dimension from test embedding", async () => {
      globalThis.fetch = mockFetch(768);
      const service = new EmbeddingService(log, "http://localhost:11434/v1", async () => "test-model");

      const dimension = await service.initialize();
      restoreFetch();

      expect(dimension).toBe(768);
      expect(service.getDimension()).toBe(768);
      expect(service.isAvailable()).toBe(true);
      expect(service.getModelId()).toBe("test-model");
    });

    test("returns null when model resolver throws", async () => {
      const service = new EmbeddingService(log, "http://localhost:11434/v1", async () => {
        throw new Error("No models available");
      });

      const dimension = await service.initialize();
      restoreFetch();

      expect(dimension).toBeNull();
      expect(service.isAvailable()).toBe(false);
    });

    test("returns null when endpoint is unreachable", async () => {
      globalThis.fetch = mockFetchError();
      const service = new EmbeddingService(log, "http://localhost:11434/v1", async () => "test-model");

      const dimension = await service.initialize();
      restoreFetch();

      expect(dimension).toBeNull();
      expect(service.isAvailable()).toBe(false);
    });

    test("returns null when endpoint returns non-200", async () => {
      globalThis.fetch = mockFetch(768, 500);
      const service = new EmbeddingService(log, "http://localhost:11434/v1", async () => "test-model");

      const dimension = await service.initialize();
      restoreFetch();

      expect(dimension).toBeNull();
      expect(service.isAvailable()).toBe(false);
    });
  });

  describe("generateEmbedding", () => {
    test("returns embedding vector for valid text", async () => {
      globalThis.fetch = mockFetch(384);
      const service = new EmbeddingService(log, "http://localhost:11434/v1", async () => "test-model");
      await service.initialize();

      const result = await service.generateEmbedding("hello world");
      restoreFetch();

      expect(result).not.toBeNull();
      expect(result).toHaveLength(384);
    });

    test("throws on empty text", async () => {
      globalThis.fetch = mockFetch(384);
      const service = new EmbeddingService(log, "http://localhost:11434/v1", async () => "test-model");
      await service.initialize();
      restoreFetch();

      expect(() => service.generateEmbedding("")).toThrow("Cannot generate embedding for empty text");
      expect(() => service.generateEmbedding("   ")).toThrow("Cannot generate embedding for empty text");
    });

    test("returns null when endpoint fails", async () => {
      globalThis.fetch = mockFetch(384);
      const service = new EmbeddingService(log, "http://localhost:11434/v1", async () => "test-model");
      await service.initialize();

      // Switch to failing fetch after initialization
      globalThis.fetch = mockFetch(384, 500);
      const result = await service.generateEmbedding("hello world");
      restoreFetch();

      expect(result).toBeNull();
    });

    test("truncates text exceeding maxChars", async () => {
      let capturedBody = "";
      const fn = async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = (init?.body as string) ?? "";
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }], model: "test-model" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };
      fn.preconnect = () => {};
      globalThis.fetch = fn as unknown as typeof globalThis.fetch;

      const service = new EmbeddingService(log, "http://localhost:11434/v1", async () => "test-model", 10);
      await service.initialize();

      await service.generateEmbedding("a".repeat(100));
      restoreFetch();

      const parsed = JSON.parse(capturedBody);
      expect(parsed.input.length).toBe(10);
    });
  });

  describe("generateEmbeddings", () => {
    test("returns embeddings for multiple texts in order", async () => {
      globalThis.fetch = mockFetch(512);
      const service = new EmbeddingService(log, "http://localhost:11434/v1", async () => "test-model");
      await service.initialize();

      const results = await service.generateEmbeddings(["hello", "world", "test"]);
      restoreFetch();

      expect(results).not.toBeNull();
      expect(results).toHaveLength(3);
      for (const emb of results!) {
        expect(emb).toHaveLength(512);
      }
    });

    test("returns empty array for empty input", async () => {
      globalThis.fetch = mockFetch(512);
      const service = new EmbeddingService(log, "http://localhost:11434/v1", async () => "test-model");
      await service.initialize();

      const results = await service.generateEmbeddings([]);
      restoreFetch();

      expect(results).toEqual([]);
    });

    test("throws on empty text in batch", async () => {
      globalThis.fetch = mockFetch(512);
      const service = new EmbeddingService(log, "http://localhost:11434/v1", async () => "test-model");
      await service.initialize();
      restoreFetch();

      expect(() => service.generateEmbeddings(["hello", "", "world"])).toThrow(
        "Cannot generate embedding for empty text",
      );
    });

    test("returns null when endpoint fails", async () => {
      globalThis.fetch = mockFetch(512);
      const service = new EmbeddingService(log, "http://localhost:11434/v1", async () => "test-model");
      await service.initialize();

      globalThis.fetch = mockFetchError();
      const results = await service.generateEmbeddings(["hello", "world"]);
      restoreFetch();

      expect(results).toBeNull();
    });
  });
});
