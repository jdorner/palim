/**
 * Background embedding orchestration for the wiki extension.
 *
 * The {@link WikiIndexer} owns the non-blocking pass that walks every wiki file,
 * generates embeddings, and re-inserts chunks into the Orama index. It reads and
 * writes the live extension state (current index, directory, embedding manager)
 * through an injected {@link WikiIndexerState} accessor so that concurrent
 * settings changes remain safe and the index reference can be swapped when the
 * embedding dimension changes.
 *
 * @module
 */

import path from "node:path";
import type { Logger } from "@ext/types";
import { insert } from "@orama/orama";
import type { EmbeddingManager } from "./embeddingManager";
import { buildWikiIndex, chunkMarkdown, listMarkdownFiles, removeFileChunks, type WikiIndex } from "./indexing";

/**
 * Mutable extension state the indexer reads and updates.
 *
 * Backed by the extension factory's closure variables; getters always return
 * the current value and {@link setIndex} lets the indexer swap the live index
 * after a dimension-driven rebuild.
 */
export interface WikiIndexerState {
  /** Returns the current Orama wiki index (or null before the first build). */
  getIndex(): WikiIndex | null;
  /** Replaces the live index reference (used after a dimension change rebuild). */
  setIndex(index: WikiIndex): void;
  /** Returns the current absolute wiki directory path. */
  getWikiDir(): string;
  /** Returns the current stored-path prefix (workDir-relative wiki subdir). */
  getWikiSubdir(): string;
  /** Returns the current embedding manager (or null if semantic search is disabled). */
  getEmbeddingManager(): EmbeddingManager | null;
}

/**
 * Coordinates the background embedding pass over all wiki files.
 */
export class WikiIndexer {
  private readonly state: WikiIndexerState;
  private readonly log: Logger;

  /**
   * @param state - Accessor for the live extension state
   * @param log - Logger for diagnostics
   */
  constructor(state: WikiIndexerState, log: Logger) {
    this.state = state;
    this.log = log;
  }

  /**
   * Runs a background embedding pass over all wiki files (fire-and-forget).
   *
   * Removes existing chunks from the Orama index and re-inserts them with
   * embeddings. Called at startup and whenever the embedding model changes.
   *
   * If the embedding dimension has changed (e.g. switching from a 768-dim model
   * to a 1024-dim model), the Orama index is rebuilt with the new dimension
   * before inserting embeddings to avoid vector size mismatch errors.
   */
  run(): void {
    const mgr = this.state.getEmbeddingManager();
    const index = this.state.getIndex();
    if (!mgr || !index) return;

    // Snapshot the manager reference so the async body stays safe even if the
    // embedding manager is set to null by a concurrent settings change.
    mgr.setVectorReady(false);

    void this.execute(mgr);
  }

  /**
   * Performs the embedding pass. Extracted from {@link run} so the public
   * method stays synchronous (fire-and-forget) while the work is awaited here.
   *
   * @param mgr - The embedding manager snapshot captured by {@link run}
   */
  private async execute(mgr: EmbeddingManager): Promise<void> {
    try {
      // Force model re-resolution so cache lookups use the current model.
      await mgr.refreshModel();

      // Only reprobe dimension if the model actually changed since last index build.
      if (mgr.hasModelChanged()) {
        const prevDimension = mgr.getDimension();
        const newDimension = await mgr.reprobeDimension();
        if (newDimension && newDimension !== prevDimension) {
          // Rebuild the Orama index with the new vector dimension.
          const rebuilt = await buildWikiIndex(
            this.state.getWikiDir(),
            this.state.getWikiSubdir(),
            this.log,
            newDimension,
          );
          this.state.setIndex(rebuilt);
        }
      }

      // Use the (possibly rebuilt) index for insertions.
      const bgIndex = this.state.getIndex();
      if (!bgIndex) return;

      const wikiDir = this.state.getWikiDir();
      const wikiSubdir = this.state.getWikiSubdir();
      const files = await listMarkdownFiles(wikiDir);
      let totalEmbedded = 0;

      for (const relativePath of files) {
        const filePath = path.join(wikiDir, relativePath);
        const storedPath = path.join(wikiSubdir, relativePath);
        try {
          const raw = await Bun.file(filePath).text();
          const chunks = chunkMarkdown(storedPath, raw);
          const embedded = await mgr.embedChunks(chunks);

          // Remove existing text-only documents for this file.
          removeFileChunks(bgIndex, storedPath);

          // Re-insert all chunks with embeddings.
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
          this.log.warn(`[wiki] Background embed skipping ${relativePath}:`, (err as Error).message);
        }
      }

      mgr.setVectorReady(true);
      this.log.info(`[wiki] Background embedding complete: ${totalEmbedded} chunks embedded`);
    } catch (err: unknown) {
      this.log.warn("[wiki] Background embedding pass failed:", (err as Error).message);
    }
  }
}
