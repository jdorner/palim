/**
 * Wiki indexing primitives - file discovery, markdown chunking, and Orama
 * index construction/mutation.
 *
 * These functions are pure with respect to extension state: they take explicit
 * arguments (wiki directory, path prefix, logger) and operate on a passed-in
 * Orama index. The extension factory (`index.ts`) and the background indexer
 * (`indexer.ts`) compose them; tests import them directly.
 *
 * @module
 */

import { existsSync } from "node:fs";
import path from "node:path";
import type { Logger } from "@ext/types";
import { type AnySchema, create, insert, type Orama, removeMultiple, search, type Vector } from "@orama/orama";
import { nanoid } from "nanoid";
import type { EmbeddingManager } from "./embeddingManager";

// ---------------------------------------------------------------------------
// Shared type for the Orama wiki index instance
// ---------------------------------------------------------------------------

/**
 * Type alias for the wiki search index.
 *
 * The generic parameter is intentionally `any`. Orama's type system cannot
 * express this index precisely: the `embedding` field has a dynamic dimension
 * (`vector[${number}]`) resolved at runtime, and it is present only when
 * semantic search is enabled. Attempting a concrete schema type forces one of
 * two failures - Orama's `Schema<>`/`TypedDocument<>` collapse document types to
 * `never` unless the schema carries an index signature, but adding that index
 * signature makes `WhereCondition<>` recurse infinitely (TS2589). `any` is the
 * pragmatic boundary; our own code operates on the strongly-typed
 * {@link WikiDocument} shape instead.
 */
export type WikiIndex = Orama<any>;

/** Base schema fields (always present). */
const WIKI_SCHEMA_BASE = {
  id: "string" as const,
  filePath: "enum" as const,
  title: "string" as const,
  content: "string" as const,
  sectionDepth: "number" as const,
};

/**
 * Creates the Orama schema object, optionally including a vector field.
 *
 * @param dimension - Embedding vector dimension (omits vector field if null)
 * @returns The Orama schema object (with `embedding` when a dimension is given)
 */
function createWikiSchema(dimension: number | null) {
  if (dimension) {
    return { ...WIKI_SCHEMA_BASE, embedding: `vector[${dimension}]` as Vector };
  }
  return { ...WIKI_SCHEMA_BASE };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single indexed wiki chunk. */
export interface WikiDocument {
  /** Unique identifier */
  id: string;
  /** Relative path to the wiki markdown file */
  filePath: string;
  /** Chunk title (derived from heading) */
  title: string;
  /** Full chunk text (heading + content) */
  content: string;
  /** Markdown heading level this chunk starts at (1-6) */
  sectionDepth: number;
}

// ---------------------------------------------------------------------------
// File scanning & chunking
// ---------------------------------------------------------------------------

/**
 * Recursively lists all `.md` files under a directory.
 *
 * @param dir - Absolute directory path to scan
 * @returns Array of file paths relative to `dir`
 */
export async function listMarkdownFiles(dir: string): Promise<string[]> {
  const pattern = `${dir}/**/*.md`;
  try {
    const globber = new Bun.Glob(pattern);
    const results: string[] = [];
    for await (const entry of globber.scan({ absolute: true })) {
      results.push(entry);
    }
    return results.map((f) => f.replace(`${dir}/`, ""));
  } catch (_err: unknown) {
    // Directory doesn't exist or no files match - return empty array
    return [];
  }
}

/**
 * Splits a markdown file into semantic chunks at heading boundaries.
 *
 * Each chunk consists of a heading (### Level, #### etc.) and its following content
 * until the next heading of equal or greater depth. The first heading in each chunk
 * is stored as `title`; sub-headings remain as inline content within `content`.
 *
 * @param fileName - Relative path of the file (used for `filePath` metadata)
 * @param content  - Raw markdown file content
 * @returns Array of WikiDocument chunks
 */
export function chunkMarkdown(fileName: string, content: string): WikiDocument[] {
  const lines = content.split("\n");
  const chunks: WikiDocument[] = [];
  let currentTitle = "";
  let currentDepth = 7; // Higher than any real heading
  let currentContent = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    const match = line.match(/^(#{1,6})\s+(.+)/);

    if (match) {
      const depth = match[1]!.length;
      const title = (match[2] ?? "").trim();

      // Only finalize the previous chunk when we're starting a new sibling or ancestor heading
      // Sub-headings (deeper level) are absorbed into their parent - no push here
      if (depth <= currentDepth) {
        if (currentContent.trim()) {
          chunks.push({
            id: nanoid(),
            filePath: fileName,
            title: currentTitle,
            content: currentContent.trim(),
            sectionDepth: currentDepth,
          });
        }
        currentTitle = title;
        currentDepth = depth;
        currentContent = `${line}\n`;
      } else {
        // Sub-heading of a previous level - append to current chunk's content
        currentContent += `${line}\n`;
      }
    } else {
      currentContent += `${line}\n`;
    }
  }

  // Push the final chunk
  if (currentContent.trim()) {
    chunks.push({
      id: nanoid(),
      filePath: fileName,
      title: currentTitle,
      content: currentContent.trim(),
      sectionDepth: currentDepth,
    });
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Index building & incremental updates
// ---------------------------------------------------------------------------

/**
 * Scans all wiki markdown files and indexes them into Orama.
 *
 * @param wikiDir - Absolute path to the wiki directory
 * @param pathPrefix - Prefix prepended to file paths stored in the index (e.g. "data/wiki")
 * @param log - Logger instance
 * @param dimension - Embedding vector dimension (omits vector field if null)
 * @returns The created Orama index instance
 */
export async function buildWikiIndex(
  wikiDir: string,
  pathPrefix: string,
  log: Logger,
  dimension: number | null = null,
): Promise<WikiIndex> {
  // The schema is built dynamically (with or without the vector field), so its
  // literal type cannot be inferred statically. Cast the single boundary here to
  // the declared WikiOramaSchema; all downstream index operations stay typed.
  // createWikiSchema returns a widened object literal; assert it as Orama's
  // AnySchema (not `any`) so create() type-checks, then narrow the result.
  const schema = createWikiSchema(dimension) as AnySchema;
  const index = create({ schema }) as WikiIndex;

  if (!existsSync(wikiDir)) {
    log.error(`[wiki] Wiki directory does not exist: ${wikiDir}`);
    return index;
  }

  const files = await listMarkdownFiles(wikiDir);

  for (const relativePath of files) {
    await indexFile(index, wikiDir, pathPrefix, relativePath, log);
  }

  return index;
}

/**
 * Builds a wiki index from all markdown files in the wiki directory.
 * Thin alias around {@link buildWikiIndex} for tests and external consumers.
 *
 * @param wikiDir - Absolute path to the wiki directory
 * @param pathPrefix - Prefix for stored file paths (defaults to empty string)
 * @param log - Logger instance
 * @param dimension - Embedding vector dimension (omits vector field if null)
 * @returns The created Orama wiki index
 */
export async function createWikiIndex(
  wikiDir: string,
  pathPrefix = "",
  log: Logger,
  dimension: number | null = null,
): Promise<WikiIndex> {
  return buildWikiIndex(wikiDir, pathPrefix, log, dimension);
}

/**
 * Removes all indexed chunks belonging to a specific file from the Orama index.
 * Uses a `where` filter on the `filePath` enum field to locate matching document IDs.
 *
 * @param index - The Orama wiki index
 * @param storedPath - The file path as stored in the index (workDir-relative)
 */
export function removeFileChunks(index: WikiIndex, storedPath: string): void {
  const results = search(index, {
    term: "",
    where: { filePath: { eq: storedPath } },
    limit: 10000,
  });
  // search() is synchronous for in-memory indexes but typed as Results | Promise<Results>
  const resolved = results as Awaited<typeof results>;
  const ids = resolved.hits.map((hit) => hit.id);
  if (ids.length > 0) {
    removeMultiple(index, ids);
  }
}

/**
 * Indexes a single file into the Orama index.
 * Reads the file, chunks it, and inserts all chunks.
 * Optionally attaches pre-computed embeddings to each chunk.
 *
 * @param index - The Orama wiki index
 * @param wikiDir - Absolute path to the wiki directory
 * @param pathPrefix - Prefix prepended to file paths stored in the index (e.g. "data/wiki")
 * @param relativePath - Relative path of the file to index (relative to wikiDir)
 * @param log - Logger instance
 * @param embeddings - Optional map of chunk ID to embedding vector
 * @returns The chunks parsed from the file (empty when the file is unreadable)
 */
export async function indexFile(
  index: WikiIndex,
  wikiDir: string,
  pathPrefix: string,
  relativePath: string,
  log: Logger,
  embeddings?: Map<string, number[]>,
): Promise<WikiDocument[]> {
  const filePath = path.join(wikiDir, relativePath);
  const storedPath = path.join(pathPrefix, relativePath);
  try {
    const raw = await Bun.file(filePath).text();
    const chunks = chunkMarkdown(storedPath, raw);

    for (const chunk of chunks) {
      const embeddingVec = embeddings?.get(chunk.id);
      if (embeddingVec) {
        insert(index, { ...chunk, embedding: embeddingVec });
      } else {
        insert(index, chunk);
      }
    }

    return chunks;
  } catch (err: unknown) {
    log.warn(`[wiki] Skipping unreadable file ${relativePath}:`, (err as Error).message);
    return [];
  }
}

/**
 * Re-embeds a file's chunks and replaces its documents in the index with
 * embedding-bearing versions.
 *
 * Existing documents for the file are removed first, then each chunk is
 * re-inserted with its embedding when available (falling back to a text-only
 * insert when embedding generation failed for that chunk).
 *
 * @param index - The Orama wiki index
 * @param mgr - The embedding manager (caller ensures the service is available)
 * @param chunks - The freshly parsed chunks for the file
 * @param storedPath - The workDir-relative stored path used to locate existing docs
 */
export async function embedAndReinsert(
  index: WikiIndex,
  mgr: EmbeddingManager,
  chunks: WikiDocument[],
  storedPath: string,
): Promise<void> {
  const embedded = await mgr.embedChunks(chunks);
  removeFileChunks(index, storedPath);
  for (const { chunk, embedding } of embedded) {
    if (embedding) {
      insert(index, { ...chunk, embedding });
    } else {
      insert(index, chunk);
    }
  }
}
