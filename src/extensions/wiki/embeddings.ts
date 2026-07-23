/**
 * Embedding generation service for the wiki extension.
 *
 * Calls the local LLM's OpenAI-compatible `/v1/embeddings` endpoint to generate
 * text embeddings for wiki chunks and search queries. Handles truncation,
 * dimension auto-detection, and graceful unavailability.
 *
 * @module
 */

import type { Logger } from "logging";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Response shape from the OpenAI-compatible embeddings endpoint. */
interface EmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage?: { prompt_tokens: number; total_tokens: number };
}

/** Function signature for resolving the embedding model ID. */
export type ModelResolver = () => Promise<string>;

// ---------------------------------------------------------------------------
// EmbeddingService
// ---------------------------------------------------------------------------

/**
 * Service for generating text embeddings via the local LLM endpoint.
 *
 * Accepts a model resolver function and base URL to avoid direct imports
 * from core internals, keeping the extension boundary clean.
 *
 * The model ID is re-resolved on each request so that changes made via
 * the web UI (model selection) take effect immediately for query embeddings.
 */
export class EmbeddingService {
  private modelId: string | null = null;
  private dimension: number | null = null;
  private available = false;
  private readonly maxChars: number;
  private readonly log: Logger;
  private readonly baseUrl: string;
  private readonly resolveModel: ModelResolver;

  /**
   * @param log - Logger instance for diagnostics
   * @param baseUrl - OpenAI-compatible API base URL (e.g. "http://localhost:11434/v1")
   * @param resolveModel - Function that resolves the embedding model ID
   * @param maxChars - Maximum character length for input text before truncation (default: 2048)
   */
  constructor(log: Logger, baseUrl: string, resolveModel: ModelResolver, maxChars = 2048) {
    this.log = log;
    this.baseUrl = baseUrl;
    this.resolveModel = resolveModel;
    this.maxChars = maxChars;
  }

  /**
   * Initializes the embedding service by resolving the model and detecting
   * the embedding dimension via a test call.
   *
   * If the model cannot be resolved or the endpoint is unreachable, the service
   * marks itself as unavailable and logs a warning.
   *
   * @returns The detected embedding dimension, or null if unavailable
   */
  async initialize(): Promise<number | null> {
    try {
      this.modelId = await this.resolveModel();
    } catch {
      this.log.info("[wiki/embeddings] No embedding model configured - semantic search unavailable");
      this.available = false;
      return null;
    }

    // Detect dimension with a test embedding
    const testEmbedding = await this.generateEmbedding("dimension probe");
    if (!testEmbedding) {
      this.log.warn("[wiki/embeddings] Embedding endpoint unreachable - semantic search unavailable");
      this.available = false;
      return null;
    }

    this.dimension = testEmbedding.length;
    this.available = true;
    this.log.info(`[wiki/embeddings] Initialized: model=${this.modelId}, dimension=${this.dimension}`);
    return this.dimension;
  }

  /**
   * Returns whether the embedding service is available and ready to generate embeddings.
   */
  isAvailable(): boolean {
    return this.available;
  }

  /**
   * Returns the detected embedding dimension, or null if not yet initialized.
   */
  getDimension(): number | null {
    return this.dimension;
  }

  /**
   * Returns the last-known embedding model ID, or null if not yet initialized.
   * Note: the actual model used per-request may differ if the user changed
   * the selection via the UI. Use this for cache key purposes only.
   */
  getModelId(): string | null {
    return this.modelId;
  }

  /**
   * Forces re-resolution of the model ID from the configured resolver.
   * Call this before batch operations (like re-indexing) to ensure the
   * service uses the latest model selection.
   *
   * @returns The newly resolved model ID
   */
  async refreshModel(): Promise<string | null> {
    try {
      const resolved = await this.resolveModel();
      if (resolved !== this.modelId) {
        this.log.info(`[wiki/embeddings] Model refreshed: ${this.modelId} -> ${resolved}`);
        this.modelId = resolved;
      }
      return resolved;
    } catch {
      return this.modelId;
    }
  }

  /**
   * Re-probes the embedding dimension by generating a test embedding with the
   * current model. Call this after {@link refreshModel} when the model may have
   * changed to detect a new vector dimension.
   *
   * @returns The newly detected dimension, or null if the probe failed
   */
  async reprobeDimension(): Promise<number | null> {
    const testEmbedding = await this.generateEmbedding("dimension probe");
    if (!testEmbedding) {
      this.log.warn("[wiki/embeddings] Dimension reprobe failed - endpoint unreachable");
      return null;
    }
    const newDimension = testEmbedding.length;
    if (newDimension !== this.dimension) {
      this.log.info(`[wiki/embeddings] Dimension changed: ${this.dimension} -> ${newDimension}`);
      this.dimension = newDimension;
    }
    return newDimension;
  }

  /**
   * Resolves the current model ID, updating the stored value.
   * Falls back to the last-known model if resolution fails.
   *
   * @returns The resolved model ID
   */
  private async currentModelId(): Promise<string> {
    try {
      const resolved = await this.resolveModel();
      if (resolved !== this.modelId) {
        this.log.info(`[wiki/embeddings] Model changed: ${this.modelId} -> ${resolved}`);
        this.modelId = resolved;
      }
      return resolved;
    } catch {
      // Fall back to last-known model if resolver fails transiently
      return this.modelId ?? "";
    }
  }

  /**
   * Generates an embedding vector for a single text string.
   *
   * The model ID is re-resolved on each call to pick up changes from the UI.
   * Input text is truncated to `maxChars` before sending to the endpoint.
   *
   * @param text - The text to embed (must be non-empty after trimming)
   * @returns The embedding vector, or null if the request failed
   * @throws Error if text is empty or whitespace-only
   */
  async generateEmbedding(text: string): Promise<number[] | null> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("Cannot generate embedding for empty text");
    }

    const truncated = this.truncate(trimmed);
    const model = await this.currentModelId();

    try {
      const res = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: truncated,
          model,
        }),
      });

      if (!res.ok) {
        this.log.warn(`[wiki/embeddings] Embedding request failed: HTTP ${res.status}`);
        return null;
      }

      const body = (await res.json()) as EmbeddingResponse;
      return body.data[0]?.embedding ?? null;
    } catch (err) {
      this.log.warn("[wiki/embeddings] Embedding request error:", (err as Error).message);
      return null;
    }
  }

  /**
   * Generates embeddings for multiple text strings in a single batch request.
   *
   * The model ID is re-resolved on each call to pick up changes from the UI.
   * Each input text is truncated to `maxChars` before sending.
   *
   * @param texts - Array of text strings to embed (each must be non-empty)
   * @returns Array of embedding vectors in the same order as input, or null if the request failed
   * @throws Error if any text is empty or whitespace-only
   */
  async generateEmbeddings(texts: string[]): Promise<number[][] | null> {
    if (texts.length === 0) return [];

    const truncated = texts.map((t) => {
      const trimmed = t.trim();
      if (!trimmed) {
        throw new Error("Cannot generate embedding for empty text");
      }
      return this.truncate(trimmed);
    });

    const model = await this.currentModelId();

    try {
      const res = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: truncated,
          model,
        }),
      });

      if (!res.ok) {
        this.log.warn(`[wiki/embeddings] Batch embedding request failed: HTTP ${res.status}`);
        return null;
      }

      const body = (await res.json()) as EmbeddingResponse;
      // Sort by index to ensure order matches input
      const sorted = body.data.sort((a, b) => a.index - b.index);
      return sorted.map((d) => d.embedding);
    } catch (err) {
      this.log.warn("[wiki/embeddings] Batch embedding request error:", (err as Error).message);
      return null;
    }
  }

  /**
   * Truncates text to the configured maximum character length.
   *
   * @param text - Input text (already trimmed)
   * @returns Truncated text
   */
  private truncate(text: string): string {
    if (text.length <= this.maxChars) return text;
    return text.slice(0, this.maxChars);
  }
}
