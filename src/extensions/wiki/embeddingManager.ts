/**
 * Coordinates embedding generation, caching, and Orama vector index operations.
 *
 * The EmbeddingManager ties together the {@link EmbeddingService} (API calls),
 * {@link EmbeddingCache} (SQLite persistence), and Orama index updates into
 * a single interface used by the wiki extension during indexing and search.
 *
 * @module
 */

import type { Logger } from "logging";
import type { EmbeddingCache } from "./embeddingCache";
import { computeContentHash } from "./embeddingCache";
import type { EmbeddingService } from "./embeddings";
import type { WikiDocument } from "./index";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A wiki chunk with its computed embedding attached. */
export interface EmbeddedChunk {
  /** The original wiki document chunk. */
  chunk: WikiDocument;
  /** The embedding vector (or null if generation failed). */
  embedding: number[] | null;
}

// ---------------------------------------------------------------------------
// EmbeddingManager
// ---------------------------------------------------------------------------

/**
 * Coordinates embedding generation, caching, and index population.
 *
 * Provides high-level methods for embedding wiki chunks (with cache lookups)
 * and embedding search queries.
 */
export class EmbeddingManager {
  private readonly service: EmbeddingService;
  private readonly cache: EmbeddingCache;
  private readonly log: Logger;
  private vectorReady = false;
  private indexedModelId: string | null = null;

  /**
   * @param service - The embedding generation service
   * @param cache - The SQLite embedding cache
   * @param log - Logger for diagnostics
   */
  constructor(service: EmbeddingService, cache: EmbeddingCache, log: Logger) {
    this.service = service;
    this.cache = cache;
    this.log = log;
  }

  /**
   * Returns whether the embedding service is available (model configured, endpoint reachable).
   */
  isServiceAvailable(): boolean {
    return this.service.isAvailable();
  }

  /**
   * Forces the embedding service to re-resolve the model ID from the configured resolver.
   * Call before re-indexing to ensure the latest model selection is used.
   */
  async refreshModel(): Promise<void> {
    await this.service.refreshModel();
  }

  /**
   * Returns whether the vector index has been populated with embeddings.
   */
  isVectorReady(): boolean {
    return this.vectorReady;
  }

  /**
   * Marks the vector index as ready (all embeddings loaded).
   * Also records the model ID used so we can detect drift later.
   */
  setVectorReady(ready: boolean): void {
    this.vectorReady = ready;
    if (ready) {
      this.indexedModelId = this.service.getModelId();
    }
  }

  /**
   * Returns the detected embedding dimension, or null if unavailable.
   */
  getDimension(): number | null {
    return this.service.getDimension();
  }

  /**
   * Returns the active embedding model ID, or null if unavailable.
   */
  getModelId(): string | null {
    return this.service.getModelId();
  }

  /**
   * Returns the model ID that was used to build the current vector index.
   * This may differ from `getModelId()` if the user changed models via the UI.
   */
  getIndexedModelId(): string | null {
    return this.indexedModelId;
  }

  /**
   * Checks whether the currently resolved model differs from the model
   * used to generate the indexed embeddings.
   *
   * @returns true if a re-index is needed due to model change
   */
  hasModelChanged(): boolean {
    const current = this.service.getModelId();
    return !!current && !!this.indexedModelId && current !== this.indexedModelId;
  }

  /**
   * Updates the indexed model ID after a successful re-index.
   */
  setIndexedModelId(modelId: string): void {
    this.indexedModelId = modelId;
  }

  /**
   * Generates embeddings for an array of wiki chunks.
   *
   * For each chunk, first checks the SQLite cache. On cache miss,
   * generates a new embedding via the service and stores it in cache.
   *
   * @param chunks - Array of wiki document chunks to embed
   * @returns Array of chunks with their embeddings attached
   */
  async embedChunks(chunks: WikiDocument[]): Promise<EmbeddedChunk[]> {
    if (!this.service.isAvailable()) {
      return chunks.map((chunk) => ({ chunk, embedding: null }));
    }

    const modelId = this.service.getModelId()!;
    const dimension = this.service.getDimension()!;
    const results: EmbeddedChunk[] = [];
    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];

    // Phase 1: Check cache for each chunk
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const text = `${chunk.title}\n${chunk.content}`;
      const hash = computeContentHash(text);
      const cached = this.cache.getCachedEmbedding(hash, modelId);

      if (cached) {
        results.push({ chunk, embedding: cached.embedding });
      } else {
        results.push({ chunk, embedding: null }); // placeholder
        uncachedIndices.push(i);
        uncachedTexts.push(text);
      }
    }

    // Phase 2: Batch-generate uncached embeddings
    if (uncachedTexts.length > 0) {
      const embeddings = await this.service.generateEmbeddings(uncachedTexts);

      if (embeddings) {
        for (let j = 0; j < uncachedIndices.length; j++) {
          const idx = uncachedIndices[j]!;
          const embedding = embeddings[j]!;
          const chunk = chunks[idx]!;
          const text = `${chunk.title}\n${chunk.content}`;
          const hash = computeContentHash(text);

          // Store in cache
          this.cache.setCachedEmbedding(hash, embedding, modelId, dimension);
          // Update result
          results[idx] = { chunk, embedding };
        }
      } else {
        this.log.warn(`[wiki/embeddingManager] Failed to generate embeddings for ${uncachedTexts.length} chunks`);
      }
    }

    return results;
  }

  /**
   * Generates an embedding for a search query.
   *
   * Query embeddings are not cached since they are typically unique.
   *
   * @param text - The search query text
   * @returns The embedding vector, or null if generation failed
   */
  async embedQuery(text: string): Promise<number[] | null> {
    if (!this.service.isAvailable()) return null;
    return this.service.generateEmbedding(text);
  }

  /**
   * Returns the number of cached embedding entries.
   */
  getCacheCount(): number {
    return this.cache.count();
  }

  /**
   * Purges stale cache entries that don't match the current model.
   *
   * @returns Number of entries removed
   */
  purgeStaleCache(): number {
    const modelId = this.service.getModelId();
    if (!modelId) return 0;
    return this.cache.purgeStaleEntries(modelId);
  }
}
