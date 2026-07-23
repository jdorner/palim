/**
 * Wiki extension - a personal knowledge base for LLMs.
 *
 * Maintains structured, interlinked wiki pages in the agent's working directory.
 * On initialization it scans all `data/wiki/*.md` files, chunks them by heading
 * hierarchy, and indexes them into an in-memory Orama full-text search index
 * so the agent can quickly locate relevant content before answering questions.
 *
 * When semantic search is enabled and an embedding model is configured, the
 * extension also generates vector embeddings for each chunk and supports
 * hybrid search (combining BM25 keyword matching with vector similarity).
 *
 * Also exposes a `POST /ext/wiki/search` route for searching the wiki by text.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import type { Extension, ExtensionContext, ExtensionManifest, Logger } from "@ext/types";
import { create, insert, type Orama, removeMultiple, search } from "@orama/orama";
import { Type } from "@sinclair/typebox";
import { FileWatcher } from "@src/utils/fileWatcher";
import { nanoid } from "nanoid";
import { EmbeddingCache } from "./embeddingCache";
import { EmbeddingManager } from "./embeddingManager";
import { EmbeddingService } from "./embeddings";
import { createWikiRoutes } from "./routes";

// ---------------------------------------------------------------------------
// Shared type for the Orama wiki index instance
// ---------------------------------------------------------------------------

/** Type alias for the wiki search index (uses `any` to support dynamic vector field). */
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
 * Creates the Orama schema, optionally including a vector field.
 *
 * @param dimension - Embedding vector dimension (omits vector field if null)
 * @returns The Orama schema object
 */
function createWikiSchema(dimension: number | null) {
  if (dimension) {
    return { ...WIKI_SCHEMA_BASE, embedding: `vector[${dimension}]` };
  }
  return { ...WIKI_SCHEMA_BASE };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
async function listMarkdownFiles(dir: string): Promise<string[]> {
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
function chunkMarkdown(fileName: string, content: string): WikiDocument[] {
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

export { chunkMarkdown, listMarkdownFiles };

/**
 * Builds a wiki index from all markdown files in the wiki directory.
 * Used by tests and external consumers.
 *
 * @param wikiDir - Absolute path to the wiki directory
 * @param log - Logger instance
 * @param pathPrefix - Prefix for stored file paths (defaults to empty string)
 * @param dimension - Embedding vector dimension (omits vector field if null)
 * @returns The created Orama wiki index
 */
export async function createWikiIndex(
  wikiDir: string,
  log: Logger,
  pathPrefix = "",
  dimension: number | null = null,
): Promise<WikiIndex> {
  return buildWikiIndex(wikiDir, pathPrefix, log, dimension);
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
async function buildWikiIndex(
  wikiDir: string,
  pathPrefix: string,
  log: Logger,
  dimension: number | null = null,
): Promise<WikiIndex> {
  const schema = createWikiSchema(dimension);
  const index = create({ schema } as any);

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
 * Removes all indexed chunks belonging to a specific file from the Orama index.
 * Uses a `where` filter on the `filePath` enum field to locate matching document IDs.
 *
 * @param index - The Orama wiki index
 * @param storedPath - The file path as stored in the index (workDir-relative)
 */
function removeFileChunks(index: WikiIndex, storedPath: string): void {
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
 */
async function indexFile(
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

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

const WIKI_PROMPT = `
# Rules

* **CRITICAL** Immediately execute \`skill read wiki\` before sending any response.
* **NEVER claim information doesn't exist without first checking the wiki index and relevant pages.**
* Before answering any question about system state, goals, tasks, user info, or knowledge:
  1. Always execute skill read wiki as the very first action in any new conversation, regardless of what the user asks
  2. Never skip this step, even for simple questions that don't seem to require wiki knowledge
  3. Synthesize answers based on actual wiki content`;

const manifest = {
  name: "wiki",
  version: "1.1.0",
  description: "Agent skill for reading and writing wiki pages",
  settingsSchema: Type.Object({
    injectPrompt: Type.Boolean({
      title: "Inject instructions into system prompt",
      description: "Add instructions to read the wiki at the start of a conversation",
      default: true,
    }),
    wikiPath: Type.String({
      title: "Wiki directory",
      description: "Subdirectory of WORK_DIR where the wiki is located",
      default: "data/wiki",
    }),
    enableSemanticSearch: Type.Boolean({
      title: "Enable semantic search",
      description: "Generate embeddings for wiki chunks to enable hybrid (keyword + semantic) search",
      default: true,
    }),
    similarityThreshold: Type.Number({
      title: "Similarity threshold",
      description: "Minimum cosine similarity for vector search results (0-1)",
      default: 0.8,
      minimum: 0,
      maximum: 1,
    }),
    maxEmbeddingChars: Type.Number({
      title: "Max embedding characters",
      description: "Maximum characters per chunk sent to the embedding model",
      default: 2048,
      minimum: 128,
      maximum: 8192,
    }),
  }),
} satisfies ExtensionManifest;

/**
 * Creates a fresh Wiki extension instance.
 *
 * @returns An {@link Extension} object ready to be loaded by the registry
 */
export function createExtension(): Extension {
  let wikiDir: string;
  let wikiIndex: WikiIndex | null = null;
  let logger: Logger;
  let watcher: FileWatcher;
  let embeddingManager: EmbeddingManager | null = null;

  return {
    manifest,

    async initialize(ctx: ExtensionContext) {
      logger = ctx.log;
      logger.info("Wiki extension initializing - scanning markdown files...");

      let wikiSubdir = ctx.getConfig<string>("WIKI_PATH", "data/wiki");
      wikiDir = path.join(ctx.workDir, wikiSubdir);

      const enableSemantic = ctx.getConfig<boolean>("ENABLE_SEMANTIC_SEARCH", true);
      const maxEmbeddingChars = ctx.getConfig<number>("MAX_EMBEDDING_CHARS", 2048);

      // Initialize embedding infrastructure if semantic search is enabled
      let dimension: number | null = null;
      if (enableSemantic) {
        // biome-ignore lint/style/noRestrictedImports: Extension needs core config/models for embedding init
        const { API_BASE_URL } = await import("@src/config");
        // biome-ignore lint/style/noRestrictedImports: Extension needs core config/models for embedding init
        const { getModelForIntent } = await import("@src/models");

        const embeddingService = new EmbeddingService(
          logger,
          API_BASE_URL,
          async () => {
            const resolved = await getModelForIntent("embedding");
            return resolved.modelId;
          },
          maxEmbeddingChars,
        );

        dimension = await embeddingService.initialize();

        if (dimension) {
          const db = ctx.getDatabase();
          const cache = new EmbeddingCache(db, logger);
          embeddingManager = new EmbeddingManager(embeddingService, cache, logger);
          logger.info(`[wiki] Semantic search enabled: dimension=${dimension}`);
        }
      }

      // Build the fulltext index (always synchronous/blocking)
      wikiIndex = await buildWikiIndex(wikiDir, wikiSubdir, ctx.log, dimension);
      logger.info("Wiki search index built.");

      /**
       * Runs a background embedding pass over all wiki files.
       * Removes existing chunks from the Orama index and re-inserts them with embeddings.
       * Called at startup and when the embedding model changes.
       *
       * If the embedding dimension has changed (e.g. switching from a 768-dim model
       * to a 1024-dim model), the Orama index is rebuilt with the new dimension
       * before inserting embeddings to avoid vector size mismatch errors.
       */
      function runBackgroundEmbedding(): void {
        if (!embeddingManager || !wikiIndex) return;
        const bgManager = embeddingManager;
        const bgWikiDir = wikiDir;
        const bgSubdir = wikiSubdir;

        bgManager.setVectorReady(false);

        (async () => {
          try {
            // Force model re-resolution so cache lookups use the current model
            await bgManager.refreshModel();

            // Re-probe dimension - if the model changed, the vector size may differ
            const newDimension = await bgManager.reprobeDimension();
            if (newDimension && newDimension !== dimension) {
              dimension = newDimension;
              // Rebuild the Orama index with the new vector dimension
              wikiIndex = await buildWikiIndex(bgWikiDir, bgSubdir, logger, newDimension);
            }

            // Use the (possibly rebuilt) index for insertions
            const bgIndex = wikiIndex!;
            const files = await listMarkdownFiles(bgWikiDir);
            let totalEmbedded = 0;

            for (const relativePath of files) {
              const filePath = path.join(bgWikiDir, relativePath);
              const storedPath = path.join(bgSubdir, relativePath);
              try {
                const raw = await Bun.file(filePath).text();
                const chunks = chunkMarkdown(storedPath, raw);
                const embedded = await bgManager.embedChunks(chunks);

                // Remove existing text-only documents for this file
                removeFileChunks(bgIndex, storedPath);

                // Re-insert all chunks with embeddings
                for (let i = 0; i < chunks.length; i++) {
                  const chunk = chunks[i]!;
                  const emb = embedded[i]?.embedding;
                  if (emb) {
                    insert(bgIndex, { ...chunk, embedding: emb });
                    totalEmbedded++;
                  } else {
                    insert(bgIndex, chunk);
                  }
                }
              } catch (err: unknown) {
                logger.warn(`[wiki] Background embed skipping ${relativePath}:`, (err as Error).message);
              }
            }

            bgManager.setVectorReady(true);
            logger.info(`[wiki] Background embedding complete: ${totalEmbedded} chunks embedded`);
          } catch (err: unknown) {
            logger.warn("[wiki] Background embedding pass failed:", (err as Error).message);
          }
        })();
      }

      // Initial background embedding pass (non-blocking)
      if (embeddingManager) {
        runBackgroundEmbedding();
      }

      // Watch wiki directory for changes and update index incrementally
      watcher = new FileWatcher(wikiDir, { recursive: true });

      /** Converts an absolute file path from the watcher to a wikiDir-relative path. */
      const toRelative = (absPath: string): string => {
        return absPath.replace(`${wikiDir}/`, "");
      };

      /** Returns true if the path points to a markdown file. */
      const isMarkdown = (filePath: string): boolean => filePath.endsWith(".md");

      watcher.on("new", async (filePath) => {
        if (!wikiIndex || !isMarkdown(filePath)) return;
        const relative = toRelative(filePath);
        const chunks = await indexFile(wikiIndex, wikiDir, wikiSubdir, relative, logger);

        // Generate embeddings for new chunks if available
        if (embeddingManager?.isServiceAvailable() && chunks.length > 0) {
          const embedded = await embeddingManager.embedChunks(chunks);
          const storedPath = path.join(wikiSubdir, relative);
          removeFileChunks(wikiIndex, storedPath);
          for (const { chunk, embedding } of embedded) {
            if (embedding) {
              insert(wikiIndex, { ...chunk, embedding });
            } else {
              insert(wikiIndex, chunk);
            }
          }
        }
      });

      watcher.on("change", async (filePath) => {
        if (!wikiIndex || !isMarkdown(filePath)) return;
        const relative = toRelative(filePath);
        const storedPath = path.join(wikiSubdir, relative);
        removeFileChunks(wikiIndex, storedPath);

        const chunks = await indexFile(wikiIndex, wikiDir, wikiSubdir, relative, logger);

        // Re-embed changed chunks if available
        if (embeddingManager?.isServiceAvailable() && chunks.length > 0) {
          const embedded = await embeddingManager.embedChunks(chunks);
          removeFileChunks(wikiIndex, storedPath);
          for (const { chunk, embedding } of embedded) {
            if (embedding) {
              insert(wikiIndex, { ...chunk, embedding });
            } else {
              insert(wikiIndex, chunk);
            }
          }
        }
      });

      watcher.on("delete", async (filePath) => {
        if (!wikiIndex || !isMarkdown(filePath)) return;
        const relative = toRelative(filePath);
        const storedPath = path.join(wikiSubdir, relative);
        removeFileChunks(wikiIndex, storedPath);
      });
      await watcher.start();

      ctx.on("settings:changed", async (_event) => {
        wikiSubdir = ctx.getConfig<string>("WIKI_PATH", "data/wiki");
        const newWikiDir = path.join(ctx.workDir, wikiSubdir);
        const newEnableSemantic = ctx.getConfig<boolean>("ENABLE_SEMANTIC_SEARCH", true);

        // If semantic search was toggled off, disable the embedding manager
        if (!newEnableSemantic && embeddingManager) {
          embeddingManager.setVectorReady(false);
          embeddingManager = null;
          dimension = null;
          wikiIndex = await buildWikiIndex(wikiDir, wikiSubdir, ctx.log, null);
          logger.info("[wiki] Semantic search disabled - rebuilt fulltext-only index");
          return;
        }

        if (wikiDir !== newWikiDir) {
          wikiDir = newWikiDir;
          wikiIndex = await buildWikiIndex(wikiDir, wikiSubdir, ctx.log, dimension);
          logger.info(`[wiki] Index rebuilt for new wiki directory: ${wikiDir}`);
        }
      });

      // Listen for model intent changes (emitted by model routes without extensionName scope)
      ctx.on("settings:changed", (event) => {
        const values = event as unknown as { intent?: string; modelId?: string; extensionName?: string };
        // Skip wiki's own settings changes (those have extensionName === "wiki")
        if (values.extensionName) return;
        if (values.intent !== "embedding") return;

        logger.info(`[wiki] Embedding model changed to "${values.modelId}" - triggering re-index`);
        runBackgroundEmbedding();
      });
      // -- REST routes --------------------------------------------------------

      const routes = createWikiRoutes(
        {
          getIndex: () => wikiIndex,
          getWikiDir: () => wikiDir,
          getEmbeddingManager: () => embeddingManager,
          getSimilarityThreshold: () => ctx.getConfig<number>("SIMILARITY_THRESHOLD", 0.7),
          triggerReindex: () => runBackgroundEmbedding(),
        },
        logger,
      );
      // POST /ext/wiki/search - body-based search (TypeBox validated)
      ctx.registerRoute("POST", "/search", routes.searchPost.bind(routes));
      // GET /ext/wiki/search - query-parameter search (bookmarkable URL)
      ctx.registerRoute("GET", "/search", routes.searchGet.bind(routes));
      ctx.registerRoute("GET", "/docs", routes.docs.bind(routes));
      ctx.registerRoute("GET", "/stats", routes.stats.bind(routes));

      ctx.on("before_agent_start", (event) => {
        if (ctx.getConfig("INJECT_PROMPT")) {
          event.systemPrompt += `\n\n${WIKI_PROMPT}`;
        }
      });
    },

    async shutdown() {
      wikiIndex = null;
      embeddingManager = null;
      if (watcher) {
        watcher.close();
      }
    },
  };
}

export default createExtension();
