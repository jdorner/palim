/**
 * LLM model types shared between backend and frontend.
 *
 * @module
 */

/** Well-known task categories that can each be assigned a different model. */
export type ModelIntent = "chat" | "vision" | "embedding";

/** All valid model intent values. */
export const MODEL_INTENTS: readonly ModelIntent[] = ["chat", "vision", "embedding"] as const;

/** An available LLM model from the OpenAI-compatible endpoint. */
export interface AvailableModel {
  /** Model identifier (e.g. "Meta-Llama-3.1-8B-Instruct-Q4_K_M"). */
  id: string;
  /** Owner or provider string from the API. */
  owned_by?: string;
  /** Context window size in tokens. */
  contextWindow: number;
  /** Whether the server supports image/vision input. */
  vision: boolean;
}

/** Response shape for the selected model endpoint. */
export interface SelectedModelResponse {
  /** The currently selected model ID, or null if none is set. */
  modelId: string | null;
  /** Whether reasoning mode is enabled for the selected model. */
  reasoning: boolean;
  /** Context window size of the selected model (in tokens), or null if unknown. */
  contextWindow: number | null;
  /** Per-intent model assignments (null = inherits from default). */
  intents?: Record<ModelIntent, string | null>;
}
