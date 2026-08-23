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

import path from "node:path";
import type { Extension, ExtensionContext, ExtensionManifest, Logger } from "@ext/types";
import { Type } from "@sinclair/typebox";
import { FileWatcher } from "@src/utils/fileWatcher";
import { EmbeddingCache } from "./embeddingCache";
import { EmbeddingManager } from "./embeddingManager";
import { EmbeddingService } from "./embeddings";
import { WikiIndexer } from "./indexer";
import { buildWikiIndex, embedAndReinsert, indexFile, removeFileChunks, type WikiIndex } from "./indexing";
import { createWikiRoutes } from "./routes";

export type { WikiDocument, WikiIndex } from "./indexing";
// Re-export the indexing primitives so existing consumers (tests, sibling
// modules) can keep importing them from the extension entry point.
export { chunkMarkdown, createWikiIndex, listMarkdownFiles } from "./indexing";

// ---------------------------------------------------------------------------
// Embedding manager construction
// ---------------------------------------------------------------------------

/**
 * Initializes the embedding manager if semantic search is enabled.
 *
 * @param ctx - Extension context providing logger, database, and config access
 * @param maxEmbeddingChars - Maximum characters per chunk for embedding
 * @returns The embedding manager instance, or null if disabled
 */
async function createEmbeddingManager(
  ctx: ExtensionContext,
  maxEmbeddingChars: number,
): Promise<EmbeddingManager | null> {
  // biome-ignore lint/style/noRestrictedImports: Extension needs core config/models for embedding init
  const { API_BASE_URL } = await import("@src/config");
  // biome-ignore lint/style/noRestrictedImports: Extension needs core config/models for embedding init
  const { getModelForIntent } = await import("@src/models");

  const embeddingService = new EmbeddingService(
    ctx.log,
    API_BASE_URL,
    async () => {
      const resolved = await getModelForIntent("embedding");
      return resolved.modelId;
    },
    maxEmbeddingChars,
  );

  const dimension = await embeddingService.initialize();

  if (dimension) {
    const cache = new EmbeddingCache(ctx.db, ctx.log);
    const embeddingManager = new EmbeddingManager(embeddingService, cache, ctx.log);
    ctx.log.info(`[wiki] Semantic search enabled: dimension=${dimension}`);
    return embeddingManager;
  }

  return null;
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

/** Runtime shape of a `settings:changed` event as observed by the wiki extension. */
interface WikiSettingsChangedEvent {
  /** Present when an extension's own settings changed (e.g. "wiki"). Absent for global model-intent changes. */
  extensionName?: string;
  /** Model intent affected by a global model-selection change. */
  intent?: string;
  /** The newly selected model ID (for model-intent changes). */
  modelId?: string;
}

/**
 * Creates a fresh Wiki extension instance.
 *
 * @returns An {@link Extension} object ready to be loaded by the registry
 */
export function createExtension(): Extension {
  let wikiDir: string;
  let wikiSubdir: string;
  let wikiIndex: WikiIndex | null = null;
  let logger: Logger;
  let watcher: FileWatcher;
  let embeddingManager: EmbeddingManager | null = null;

  // Indexer reads/writes the mutable state above via accessors so it stays
  // correct across settings-driven directory and index swaps.
  let indexer: WikiIndexer;

  return {
    manifest,

    async initialize(ctx: ExtensionContext) {
      logger = ctx.log;
      logger.info("Wiki extension initializing - scanning markdown files...");

      wikiSubdir = ctx.config.get<string>("WIKI_PATH", manifest.settingsSchema.properties.wikiPath.default);
      wikiDir = path.join(ctx.paths.work, wikiSubdir);

      const enableSemantic = ctx.config.get<boolean>(
        "ENABLE_SEMANTIC_SEARCH",
        manifest.settingsSchema.properties.enableSemanticSearch.default,
      );
      const maxEmbeddingChars = ctx.config.get<number>(
        "MAX_EMBEDDING_CHARS",
        manifest.settingsSchema.properties.maxEmbeddingChars.default,
      );

      // Initialize embedding infrastructure if semantic search is enabled
      if (enableSemantic) {
        embeddingManager = await createEmbeddingManager(ctx, maxEmbeddingChars);
      }

      // Build the fulltext index (always synchronous/blocking)
      const dimension = embeddingManager?.getDimension();
      wikiIndex = await buildWikiIndex(wikiDir, wikiSubdir, ctx.log, dimension);
      logger.info("Wiki search index built.");

      indexer = new WikiIndexer(
        {
          getIndex: () => wikiIndex,
          setIndex: (index) => {
            wikiIndex = index;
          },
          getWikiDir: () => wikiDir,
          getWikiSubdir: () => wikiSubdir,
          getEmbeddingManager: () => embeddingManager,
        },
        logger,
      );

      // Initial background embedding pass (non-blocking)
      if (embeddingManager) {
        indexer.run();
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
          await embedAndReinsert(wikiIndex, embeddingManager, chunks, path.join(wikiSubdir, relative));
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
          await embedAndReinsert(wikiIndex, embeddingManager, chunks, storedPath);
        }
      });

      watcher.on("delete", async (filePath) => {
        if (!wikiIndex || !isMarkdown(filePath)) return;
        const relative = toRelative(filePath);
        const storedPath = path.join(wikiSubdir, relative);
        removeFileChunks(wikiIndex, storedPath);
      });
      await watcher.start();

      /**
       * Handles wiki-owned settings changes: wiki directory relocation and the
       * semantic-search toggle. Rebuilds the index when the effective directory
       * or embedding configuration changes.
       */
      const handleWikiSettingsChanged = async (): Promise<void> => {
        wikiSubdir = ctx.config.get<string>("WIKI_PATH", manifest.settingsSchema.properties.wikiPath.default);
        const newWikiDir = path.join(ctx.paths.work, wikiSubdir);
        const newEnableSemantic = ctx.config.get<boolean>(
          "ENABLE_SEMANTIC_SEARCH",
          manifest.settingsSchema.properties.enableSemanticSearch.default,
        );
        let rebuildIndex = false;

        // If semantic search was toggled off, disable the embedding manager
        if (!newEnableSemantic && embeddingManager) {
          embeddingManager.setVectorReady(false);
          embeddingManager = null;
          wikiIndex = await buildWikiIndex(wikiDir, wikiSubdir, ctx.log, null);
          logger.info("[wiki] Semantic search disabled - rebuilt fulltext-only index");
          return;
        }

        if (newEnableSemantic && !embeddingManager) {
          embeddingManager = await createEmbeddingManager(ctx, maxEmbeddingChars);
          rebuildIndex = true;
        }

        if (wikiDir !== newWikiDir) {
          wikiDir = newWikiDir;
          rebuildIndex = true;
          logger.info(`[wiki] Index rebuilt for new wiki directory: ${wikiDir}`);
        }

        if (rebuildIndex) {
          const newDimension = embeddingManager?.getDimension() ?? null;
          wikiIndex = await buildWikiIndex(wikiDir, wikiSubdir, ctx.log, newDimension);
          logger.info("[wiki] Index fully rebuilt due to configuration change");
          if (embeddingManager) {
            indexer.run();
          }
        }
      };

      // Single `settings:changed` handler covering both wiki-owned settings and
      // global embedding-model changes (the latter arrive without extensionName).
      ctx.events.on("settings:changed", async (event) => {
        const values = event as unknown as WikiSettingsChangedEvent;

        if (values.extensionName) {
          // Wiki's own settings changed (path, semantic toggle, etc.).
          if (values.extensionName === manifest.name) {
            await handleWikiSettingsChanged();
          }
          return;
        }

        // Global model-selection change: re-index only when the embedding model changed.
        if (values.intent !== "embedding") return;
        logger.info(`[wiki] Embedding model changed to "${values.modelId}" - triggering re-index`);
        indexer.run();
      });

      // -- REST routes --------------------------------------------------------

      const routes = createWikiRoutes(
        {
          getIndex: () => wikiIndex,
          getWikiDir: () => wikiDir,
          getEmbeddingManager: () => embeddingManager,
          getSimilarityThreshold: () =>
            ctx.config.get<number>(
              "SIMILARITY_THRESHOLD",
              manifest.settingsSchema.properties.similarityThreshold.default,
            ),
          triggerReindex: () => indexer.run(),
        },
        logger,
      );
      // POST /ext/wiki/search - body-based search (TypeBox validated)
      ctx.routes.register("POST", "/search", routes.searchPost.bind(routes));
      // GET /ext/wiki/search - query-parameter search (bookmarkable URL)
      ctx.routes.register("GET", "/search", routes.searchGet.bind(routes));
      ctx.routes.register("GET", "/docs", routes.docs.bind(routes));
      ctx.routes.register("GET", "/stats", routes.stats.bind(routes));

      ctx.events.on("before_agent_start", (event) => {
        if (ctx.config.get("INJECT_PROMPT")) {
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
