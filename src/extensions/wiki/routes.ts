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
import type { WikiIndex } from "./index";
import { listMarkdownFiles } from "./index";

/** TypeBox schema for wiki POST search body. */
const SearchPayloadSchema = Type.Object(
  {
    /** Search query string (required, must be non-empty after trimming). */
    query: Type.String({ minLength: 1 }),
    /** Maximum number of results to return (default 5, clamped to [1, 50]). */
    limit: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

/** TypeBox schema for wiki search responses. */
interface SearchResponse {
  /** Echoed query string */
  query: string;
  /** Orama search results */
  results: unknown;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/** Accessor that returns the current wiki index and directory (supports hot-swap on settings change). */
export interface WikiState {
  /** Returns the current Orama wiki index (or null if unavailable). */
  getIndex(): WikiIndex | null;
  /** Returns the current absolute wiki directory path. */
  getWikiDir(): string;
}

/**
 * Creates route handler functions that resolve index and directory
 * via a {@link WikiState} accessor, allowing the underlying state
 * to be swapped at runtime (e.g. on settings change).
 */
export function createWikiRoutes(state: WikiState, log: Logger | undefined): WikiRouteSet {
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

        // Limit defaults to 5, clamped to [1, 50]
        const limit = Math.min(Math.max(body.limit ?? 5, 1), 50);

        const results = await search(index, {
          term: query,
          properties: ["title", "content"],
          limit,
        });

        return Response.json({ query, results } as SearchResponse);
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

      try {
        const searchTerm = query.trim();
        const results = await search(index, {
          term: searchTerm,
          properties: ["title", "content"],
          limit,
        });

        return Response.json({ query: searchTerm, results } as SearchResponse);
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

      const files = await listMarkdownFiles(state.getWikiDir());
      const docCount = count(index);
      return Response.json({ files: files.length, documents: docCount });
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
