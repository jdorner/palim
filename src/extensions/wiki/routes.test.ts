/**
 * Tests for wiki REST routes (`POST /search`, `GET /search`, `GET /docs`, `GET /stats`).
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "elysia";
import createLogger from "logging";
import { createWikiIndex } from "./index";
import { createWikiRoutes } from "./routes";

const logger = createLogger("test:wiki");
const TEST_TMP_BASE = join(import.meta.dir, ".test-tmp");

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(TEST_TMP_BASE, `wiki-routes-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpDir, "data", "wiki"), { recursive: true });
});
afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});
afterAll(() => {
  if (existsSync(TEST_TMP_BASE)) rmSync(TEST_TMP_BASE, { recursive: true, force: true });
});

// Helpers

function wikiFile(name: string, content: string): void {
  writeFileSync(join(tmpDir, "data", "wiki", `${name}.md`), content);
}

function postCtx(body?: unknown): Context {
  return {
    request: new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }),
    query: {},
  } as unknown as Context;
}

function getCtx(params: Record<string, string | string[]> = {}): Context {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) {
      for (const item of v) search.append(k, item);
    } else if (v !== undefined) {
      search.set(k, String(v));
    }
  }
  return { request: new Request(`http://localhost/test?${search}`), query: params } as unknown as Context;
}

/** Build wiki index + routes for the current tmpDir. */
async function build() {
  const wikiDir = join(tmpDir, "data", "wiki");
  const index = await createWikiIndex(wikiDir, logger);
  return createWikiRoutes({ getIndex: () => index, getWikiDir: () => wikiDir }, logger);
}

// Types for Orama search responses
interface SearchResults {
  query: string;
  results: { hits: { id: string }[]; count: number; elapsed: { raw: number } };
}
interface ErrorResponse {
  error: string;
}

/** Parse JSON Response body. */
async function body<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T;
}

// ---------------------------------------------------------------------------
// createWikiIndex
// ---------------------------------------------------------------------------

describe("createWikiIndex", () => {
  test("indexes files from wiki directory", async () => {
    wikiFile("one", "# Alpha\n\nFirst wiki page content.");
    wikiFile("two", "# Beta\n\nSecond wiki page content.");
    const routes = await build();
    expect((await routes.searchPost(postCtx({ query: "wiki" }))).status).toBe(200);
  });

  test("handles empty wiki directory", async () => {
    const routes = await build();
    expect((await routes.searchPost(postCtx({ query: "something" }))).status).toBe(200);
  });

  test("handles wiki directory that does not exist", async () => {
    const index = await createWikiIndex(join(tmpDir, "nonexistent"), logger);
    expect(index).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// POST /search (body-based)
// ---------------------------------------------------------------------------

describe("POST /search", () => {
  beforeEach(() => {
    wikiFile("intro", "# Getting Started\n\nWelcome to the wiki.");
    wikiFile("config", "# Configuration\n\nSet up .env.local.");
    wikiFile("troubleshooting", "# Troubleshooting\n\nCommon issues.\n\n## Build failures\n\nTry `bun install`.");
  });

  test("returns error when index is null", async () => {
    const routes = createWikiRoutes({ getIndex: () => null, getWikiDir: () => tmpDir }, logger);
    const data = await body<ErrorResponse>(await routes.searchPost(postCtx({ query: "test" })));
    expect(data.error).toBe("Wiki index not available");
  });

  test("returns error when no query is provided", async () => {
    const routes = await build();
    const res = await routes.searchPost(postCtx({ query: "" }));
    expect(res.status).toBe(400);
  });

  test("searches wiki content by keyword", async () => {
    const routes = await build();
    const data = await body<SearchResults>(await routes.searchPost(postCtx({ query: "environment" })));
    expect(data.query).toBe("environment");
  });

  test("limits result count to specified limit", async () => {
    for (let i = 1; i <= 50; i++) wikiFile(`many${i}`, `# File ${i}\n\nContains the word the in this text.`);
    const routes = await build();
    const data = await body<SearchResults>(await routes.searchPost(postCtx({ query: "the", limit: 2 })));
    expect(data.results.hits.length).toBeLessThanOrEqual(2);
  });

  test("clamps limit to max 50", async () => {
    for (let i = 1; i <= 60; i++) wikiFile(`big${i}`, `# File ${i}\n\nHas the word the inside.`);
    const routes = await build();
    const data = await body<SearchResults>(await routes.searchPost(postCtx({ query: "the", limit: 999 })));
    expect(data.results.hits.length).toBeLessThanOrEqual(50);
  });

  test("clamps limit to min 1", async () => {
    wikiFile("one-hit", "# Single\n\nJust one the hit here.");
    const routes = await build();
    const data = await body<SearchResults>(await routes.searchPost(postCtx({ query: "the", limit: 0 })));
    expect(data.results.hits.length).toBeGreaterThanOrEqual(1);
  });

  test("searches across multiple wiki pages and finds relevant results", async () => {
    const routes = await build();
    const data = await body<SearchResults>(await routes.searchPost(postCtx({ query: "troubleshooting" })));
    expect(data.results.hits.length).toBeGreaterThanOrEqual(1);
  });

  test("searches content within sub-headings", async () => {
    wikiFile("deep", "# Wiki\n\nMain intro.\n\n## Build failures\n\nRun `bun install` to fix.");
    const routes = await build();
    const data = await body<SearchResults>(await routes.searchPost(postCtx({ query: "bun install" })));
    expect(data.results.hits.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// GET /search (query parameters)
// ---------------------------------------------------------------------------

describe("GET /search", () => {
  beforeEach(() => {
    wikiFile("troubleshooting", "# Troubleshooting\n\nCommon issues.\n\n## Build failures\n\nTry `bun install`.");
  });

  test("returns error when index is null", async () => {
    const routes = createWikiRoutes({ getIndex: () => null, getWikiDir: () => tmpDir }, logger);
    const data = await body<ErrorResponse>(await routes.searchGet(getCtx({ q: "test" })));
    expect(data.error).toBe("Wiki index not available");
  });

  test("returns error when no query param is provided", async () => {
    const routes = await build();
    const res = await routes.searchGet(getCtx({}));
    expect(res.status).toBe(400);
  });

  test("uses default limit of 5 when no limit param", async () => {
    for (let i = 1; i <= 60; i++) wikiFile(`big${i}`, `# File ${i}\n\nHas the word the inside.`);
    const routes = await build();
    const data = await body<SearchResults>(await routes.searchGet(getCtx({ q: "the" })));
    expect(data.results.hits.length).toBeLessThanOrEqual(5);
  });

  test("respects limit param in query", async () => {
    for (let i = 1; i <= 60; i++) wikiFile(`big${i}`, `# File ${i}\n\nContains the word the inside.`);
    const routes = await build();
    const data = await body<SearchResults>(await routes.searchGet(getCtx({ q: "the", limit: "10" })));
    expect(data.results.hits.length).toBeLessThanOrEqual(10);
  });

  test("clamps out-of-range limit values (like POST)", async () => {
    for (let i = 1; i <= 60; i++) wikiFile(`big${i}`, `# File ${i}\n\nHas the word the inside.`);
    const routes = await build();

    let data = await body<SearchResults>(await routes.searchGet(getCtx({ q: "the", limit: "999" })));
    expect(data.results.hits.length).toBeLessThanOrEqual(50); // 999 → ≤ 50

    data = await body<SearchResults>(await routes.searchGet(getCtx({ q: "the", limit: "0" })));
    expect(data.results.hits.length).toBeGreaterThanOrEqual(1); // 0 → ≥ 1
  });

  test("searches content across multiple wiki pages", async () => {
    const routes = await build();
    const data = await body<SearchResults>(await routes.searchGet(getCtx({ q: "troubleshooting" })));
    expect(data.results.hits.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// GET /docs
// ---------------------------------------------------------------------------

describe("GET /docs", () => {
  test("returns error when index is null", async () => {
    const routes = createWikiRoutes({ getIndex: () => null, getWikiDir: () => tmpDir }, logger);
    const data = await body<ErrorResponse>(await routes.docs());
    expect(data.error).toBe("Wiki index not available");
  });

  test("lists all indexed wiki files", async () => {
    wikiFile("one", "# One\n\nContent.");
    wikiFile("two", "# Two\n\nMore content.");
    const routes = await build();
    const data = await body<{ files: string[] }>(await routes.docs());
    expect(data.files.length).toBeGreaterThanOrEqual(2);
  });

  test("lists files from a real wiki (includes .md extension)", async () => {
    wikiFile("one", "# One\n\nContent.");
    const routes = await build();
    const data = await body<{ files: string[] }>(await routes.docs());
    for (const f of data.files) expect(f.endsWith(".md")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /stats
// ---------------------------------------------------------------------------

describe("GET /stats", () => {
  test("returns error when index is null", async () => {
    const routes = createWikiRoutes({ getIndex: () => null, getWikiDir: () => tmpDir }, logger);
    const data = await body<ErrorResponse>(await routes.stats());
    expect(data.error).toBe("Wiki index not available");
  });

  test("returns file count and document count", async () => {
    wikiFile("one", "# One\n\nA.");
    wikiFile("two", "# Two\n\nB.\n\n### Sub\n\nSub content.");
    const routes = await build();
    const data = await body<{ files: number; documents: number }>(await routes.stats());
    expect(data.files).toBeGreaterThanOrEqual(2);
    expect(data.documents).toBeGreaterThanOrEqual(1);
  });

  test("returns zero documents for empty wiki", async () => {
    const routes = await build();
    const data = await body<{ files: number; documents: number }>(await routes.stats());
    expect(data.files).toBe(0);
  });
});
