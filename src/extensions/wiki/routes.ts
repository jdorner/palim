/**
 * Wiki REST route handlers - built around a given Orama search index
 * and an extension's work directory.
 */

import { formatValidationErrors } from "@ext/sdk";
import { count, search } from "@orama/orama";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "elysia";
import type { Logger } from "logging";
import type { EmbeddingManager } from "./embeddingManager";
import type { WikiIndex } from "./index";
import { listMarkdownFiles } from "./index";

/** TypeBox schema for wiki POST search body. */
const SearchPayloadSchema = Type.Object(
  {
    /** Search query string (required, must be non-empty after trimming). */
    query: Type.String({ minLength: 1 }),
    /** Maximum number of results to return (default 5, clamped to [1, 50]). */
    limit: Type.Optional(Type.Number()),
    /** Search mode: "fulltext", "vector", or "hybrid". Defaults to hybrid when vectors are available. */
    mode: Type.Optional(Type.Union([Type.Literal("fulltext"), Type.Literal("vector"), Type.Literal("hybrid")])),
    /** Minimum similarity threshold for vector matches (0-1). */
    similarity: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

/** TypeBox schema for wiki search responses. */
interface SearchResponse {
  /** Echoed query string */
  query: string;
  /** Orama search results */
  results: unknown;
  /** Actual search mode used */
  mode: "fulltext" | "vector" | "hybrid";
  /** Whether vector search is available */
  vectorAvailable: boolean;
  /** Optional warning message (e.g. on fallback) */
  warning?: string;
}

/** Valid search mode values. */
type SearchMode = "fulltext" | "vector" | "hybrid";

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/** Accessor that returns the current wiki index and directory (supports hot-swap on settings change). */
export interface WikiState {
  /** Returns the current Orama wiki index (or null if unavailable). */
  getIndex(): WikiIndex | null;
  /** Returns the current absolute wiki directory path. */
  getWikiDir(): string;
  /** Returns the current embedding manager (or null if semantic search is disabled). */
  getEmbeddingManager(): EmbeddingManager | null;
  /** Returns the configured similarity threshold. */
  getSimilarityThreshold(): number;
  /** Triggers a background re-index of embeddings (called when model drift is detected). */
  triggerReindex(): void;
}

/**
 * Creates route handler functions that resolve index and directory
 * via a {@link WikiState} accessor, allowing the underlying state
 * to be swapped at runtime (e.g. on settings change).
 */
export function createWikiRoutes(state: WikiState, log: Logger | undefined): WikiRouteSet {
  /**
   * Executes a search with the given parameters, handling mode selection and fallback.
   */
  async function executeSearch(
    index: WikiIndex,
    query: string,
    limit: number,
    requestedMode: SearchMode | undefined,
    requestedSimilarity: number | undefined,
  ): Promise<Response> {
    const manager = state.getEmbeddingManager();
    let vectorAvailable = manager?.isVectorReady() ?? false;
    const similarity = requestedSimilarity ?? state.getSimilarityThreshold();

    // If the embedding model changed since indexing, vectors are stale
    if (vectorAvailable && manager?.hasModelChanged()) {
      vectorAvailable = false;
      manager.setVectorReady(false);
      log?.info("[wiki] Embedding model changed - vector index stale, falling back to fulltext until re-indexed");
      state.triggerReindex();
    }

    // Resolve effective mode
    let effectiveMode: SearchMode;
    let warning: string | undefined;

    if (!requestedMode) {
      effectiveMode = vectorAvailable ? "hybrid" : "fulltext";
    } else if (requestedMode === "vector" && !vectorAvailable) {
      return Response.json(
        { error: "Vector search unavailable - no embedding model configured or embeddings not yet loaded" },
        { status: 422 },
      );
    } else if (requestedMode === "hybrid" && !vectorAvailable) {
      effectiveMode = "fulltext";
      warning = "Hybrid search unavailable - falling back to fulltext. Embeddings not yet loaded.";
    } else {
      effectiveMode = requestedMode;
    }

    // Execute search based on mode
    let results: unknown;

    if (effectiveMode === "fulltext") {
      results = await search(index, {
        term: query,
        properties: ["title", "content"],
        limit,
      });
    } else if (effectiveMode === "vector") {
      const queryEmbedding = await manager!.embedQuery(query);
      if (!queryEmbedding) {
        // Fallback to fulltext if query embedding fails
        effectiveMode = "fulltext";
        warning = "Query embedding generation failed - falling back to fulltext.";
        results = await search(index, {
          term: query,
          properties: ["title", "content"],
          limit,
        });
      } else {
        results = await search(index, {
          mode: "vector",
          vector: { value: queryEmbedding, property: "embedding" },
          similarity,
          limit,
        });
      }
    } else {
      // hybrid
      const queryEmbedding = await manager!.embedQuery(query);
      if (!queryEmbedding) {
        effectiveMode = "fulltext";
        warning = "Query embedding generation failed - falling back to fulltext.";
        results = await search(index, {
          term: query,
          properties: ["title", "content"],
          limit,
        });
      } else {
        results = await search(index, {
          term: query,
          mode: "hybrid",
          vector: { value: queryEmbedding, property: "embedding" },
          properties: ["title", "content"],
          similarity,
          limit,
        });
      }
    }

    const response: SearchResponse = { query, results, mode: effectiveMode, vectorAvailable };
    if (warning) response.warning = warning;
    return Response.json(response);
  }

  return {
    searchPost: async (ctx: Context) => {
      const index = state.getIndex();
      if (!index || !log) {
        return Response.json({ error: "Wiki index not available" }, { status: 503 });
      }

      let bodyRaw: unknown;
      try {
        bodyRaw = await ctx.request.json();
      } catch (parseErr) {
        log.error("Invalid JSON in wiki search request:", parseErr);
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }

      try {
        // Validate request body
        if (!Value.Check(SearchPayloadSchema, bodyRaw as Record<string, unknown>)) {
          const errorMsg = formatValidationErrors(SearchPayloadSchema, bodyRaw as Record<string, unknown>);
          log.error("Invalid search payload", { error: errorMsg });
          return Response.json({ error: `Validation failed: ${errorMsg}` }, { status: 400 });
        }

        const body = bodyRaw as Static<typeof SearchPayloadSchema>;
        const query = body.query.trim();
        const limit = Math.min(Math.max(body.limit ?? 5, 1), 50);

        return await executeSearch(index, query, limit, body.mode, body.similarity);
      } catch (err) {
        log.error("Wiki search failed:", err);
        return Response.json({ error: "Search failed" }, { status: 500 });
      }
    },

    searchGet: async (ctx: Context) => {
      const index = state.getIndex();
      if (!index || !log) {
        return Response.json({ error: "Wiki index not available" }, { status: 503 });
      }

      const url = new URL(ctx.request.url);
      const query = url.searchParams.get("q") ?? url.searchParams.get("query");
      if (!query) {
        return Response.json({ error: "Missing query parameter" }, { status: 400 });
      }

      const rawLimit = url.searchParams.get("limit");
      const limitVal = rawLimit ? Number(rawLimit) : 5;
      const limit = Math.min(Math.max(Number.isNaN(limitVal) ? 5 : limitVal, 1), 50);

      const mode = url.searchParams.get("mode") as SearchMode | null;
      const rawSimilarity = url.searchParams.get("similarity");
      const similarity = rawSimilarity ? Number(rawSimilarity) : undefined;

      try {
        const searchTerm = query.trim();
        return await executeSearch(index, searchTerm, limit, mode ?? undefined, similarity);
      } catch (err) {
        log.error("Wiki search failed:", err);
        return Response.json({ error: "Search failed" }, { status: 500 });
      }
    },

    docs: async () => {
      const index = state.getIndex();
      if (!index) {
        return Response.json({ error: "Wiki index not available" }, { status: 503 });
      }

      const files = await listMarkdownFiles(state.getWikiDir());
      return Response.json({ files });
    },

    stats: async () => {
      const index = state.getIndex();
      if (!index) {
        return Response.json({ error: "Wiki index not available" }, { status: 503 });
      }

      const manager = state.getEmbeddingManager();
      const files = await listMarkdownFiles(state.getWikiDir());
      const docCount = count(index);

      return Response.json({
        files: files.length,
        documents: docCount,
        vector: {
          available: manager?.isVectorReady() ?? false,
          dimension: manager?.getDimension() ?? null,
          cachedEmbeddings: manager?.getCacheCount() ?? 0,
          model: manager?.getModelId() ?? null,
        },
      });
    },
  };
}

/** Route handler functions produced by {@link createWikiRoutes}. */
export interface WikiRouteSet {
  /** POST /ext/wiki/search - body-based search (Elysia Context). */
  searchPost(ctx: Context): Promise<Response>;
  /** GET /ext/wiki/search - query-parameter search (Elysia Context). */
  searchGet(ctx: Context): Promise<Response>;
  /** GET /ext/wiki/docs - list indexed wiki file paths */
  docs(): Promise<Response>;
  /** GET /ext/wiki/stats - return index statistics */
  stats(): Promise<Response>;
}
