/**
 * Dynamic LLM model discovery and selection.
 *
 * A {@link ModelProvider} reads model capabilities (context window, vision
 * support) from the backend. Two topologies are supported, which differ only
 * in the endpoint URL (both return the same response shape):
 *
 * | Topology   | Kind           | Capabilities endpoint            |
 * |------------|----------------|----------------------------------|
 * | llama-swap | `"llama-swap"` | `GET /upstream/<model>/models`   |
 * | direct     | `"llamacpp"`   | `GET /v1/models`                 |
 *
 * {@link detectAndSetProvider} picks the kind at boot from the `/v1/models`
 * response (`owned_by` field).
 *
 * @module
 */

import type { Model } from "@mariozechner/pi-ai";
import type { ModelIntent } from "@shared/models";
import createLogger from "logging";
import { API_BASE_URL } from "./config";
import { appConfig } from "./db";

const logger = createLogger("Models");

/** Default context window when the endpoint doesn't report one. */
const DEFAULT_CONTEXT_WINDOW = 128000;

/** Default max output tokens. */
const DEFAULT_MAX_TOKENS = 32000;

/** Null capabilities returned when an endpoint is unreachable or returns an error. */
const NULL_CAPABILITIES: ModelCapabilities = { contextWindow: null, vision: null };

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

/** Model capabilities resolved by a provider. */
export interface ModelCapabilities {
  /** Context window size in tokens, or null if unknown. */
  contextWindow: number | null;
  /** Whether the model supports vision/image input, or null if unknown. */
  vision: boolean | null;
}

/**
 * Backend topology the capabilities are read from:
 * - `"llama-swap"`: through the llama-swap proxy, `GET /upstream/<model>/models`
 * - `"llamacpp"`: directly from llama.cpp, `GET /v1/models`
 */
export type ModelProviderKind = "llama-swap" | "llamacpp";

/** Resolves model capabilities (context window, vision) from the LLM backend. */
export interface ModelProvider {
  /** Which backend topology this provider talks to (also used for logging). */
  readonly name: ModelProviderKind;

  /**
   * Resolves capabilities for a given model.
   *
   * @param modelId - The model identifier
   * @returns Resolved capabilities, or defaults if the endpoint is unavailable
   */
  fetchCapabilities(modelId: string): Promise<ModelCapabilities>;
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

/** Shape of a model entry in the `data` array from the models endpoint. */
interface ModelsDataEntry {
  id: string;
  aliases?: string[];
  tags?: string[];
  object?: string;
  created?: number;
  owned_by?: string;
  meta?: {
    vocab_type?: number;
    n_vocab?: number;
    n_ctx?: number;
    n_ctx_train?: number;
    n_embd?: number;
    n_params?: number;
    size?: number;
  };
}

/** Shape of a model entry in the `models` array from the models endpoint. */
interface ModelsInfoEntry {
  name: string;
  model: string;
  capabilities?: string[];
}

/** Full response shape from the models endpoint. */
interface ModelsResponse {
  models?: ModelsInfoEntry[];
  object?: string;
  data?: ModelsDataEntry[];
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Parses a models response (same shape from llama-swap and llama.cpp).
 * Extracts `meta.n_ctx` from `data[]` and checks `capabilities` for `"multimodal"`.
 *
 * @param response - The parsed JSON response
 * @param modelId - The model ID to look up (falls back to first entry)
 * @returns Extracted capabilities
 */
function parseModelsResponse(response: ModelsResponse, modelId: string): ModelCapabilities {
  const dataEntry = response.data?.find((d) => d.id === modelId) ?? response.data?.[0];
  const contextWindow = dataEntry?.meta?.n_ctx ?? null;

  const modelInfo = response.models?.find((m) => m.model === modelId || m.name === modelId) ?? response.models?.[0];
  const capabilities = modelInfo?.capabilities ?? [];
  const vision = capabilities.includes("multimodal");

  return { contextWindow, vision };
}

/**
 * Creates a provider that reads model capabilities from the given backend.
 *
 * Successful lookups are cached per provider instance, keyed by model ID, so a
 * newly detected provider starts with an empty cache. Failed lookups are not
 * cached.
 *
 * @param kind - Backend topology (see {@link ModelProviderKind})
 * @param apiBaseUrl - The OpenAI-compatible base URL (e.g. `http://localhost:11434/v1`)
 * @returns The provider
 */
export function createModelProvider(kind: ModelProviderKind, apiBaseUrl: string): ModelProvider {
  const baseUrl = apiBaseUrl.replace(/\/v1\/?$/, "");
  const cache = new Map<string, ModelCapabilities>();

  return {
    name: kind,
    async fetchCapabilities(modelId: string): Promise<ModelCapabilities> {
      const cached = cache.get(modelId);
      if (cached) return cached;

      const url = kind === "llama-swap" ? `${baseUrl}/upstream/${modelId}/models` : `${baseUrl}/v1/models`;
      try {
        const res = await fetch(url);
        if (!res.ok) return NULL_CAPABILITIES;

        const result = parseModelsResponse((await res.json()) as ModelsResponse, modelId);
        cache.set(modelId, result);
        return result;
      } catch {
        return NULL_CAPABILITIES;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Auto-detection
// ---------------------------------------------------------------------------

/** Shape of a single entry from the OpenAI `/v1/models` response. */
interface OpenAIModelEntry {
  id: string;
  object: string;
  created?: number;
  owned_by?: string;
  meta?: ModelsDataEntry["meta"];
}

/** Shape of the OpenAI `/v1/models` list response. */
interface OpenAIModelsResponse {
  object: string;
  data: OpenAIModelEntry[];
  models?: ModelsInfoEntry[];
}

/**
 * Detects the backend topology by inspecting the `/v1/models` response.
 *
 * Detection logic:
 * If any entry has `owned_by === "llama-swap"`, a proxy is present and the
 * `"llama-swap"` provider is used. Otherwise the `"llamacpp"` provider is used.
 *
 * Sets the active provider and returns it.
 *
 * @param apiBaseUrl - Override the base URL (defaults to the configured API_BASE_URL)
 * @returns The detected and activated provider
 * @throws If the models list endpoint is unreachable
 */
export async function detectAndSetProvider(apiBaseUrl?: string): Promise<ModelProvider> {
  const effectiveBaseUrl = apiBaseUrl ?? API_BASE_URL;
  const url = `${effectiveBaseUrl}/models`;

  logger.debug(`Detecting provider topology from ${url}`);

  const modelsRes = await fetch(url).catch((err) => {
    throw new Error(`Error when trying to connect to ${url}: ${(err as Error).message}`);
  });
  if (!modelsRes.ok) {
    throw new Error(
      `Failed to fetch models for detection: ${url} returned HTTP ${modelsRes.status} ${modelsRes.statusText}`,
    );
  }

  const body = (await modelsRes.json()) as OpenAIModelsResponse;
  const entries = body.data ?? [];

  const isLlamaSwap = entries.some((entry) => entry.owned_by === "llama-swap");

  const provider = createModelProvider(isLlamaSwap ? "llama-swap" : "llamacpp", effectiveBaseUrl);

  logger.info(`Detected provider: "${provider.name}"`);

  activeProvider = provider;
  return provider;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Enriched model metadata combining the model list with server properties. */
export interface ModelMetadata {
  /** Model identifier. */
  id: string;
  /** Owner string from the API. */
  owned_by?: string;
  /** Context window size in tokens (from server props). */
  contextWindow: number | null;
  /** Whether the server supports image/vision input. */
  vision: boolean | null;
}

/**
 * Cached enriched model metadata.
 * Refreshed on each call to {@link fetchAvailableModels}.
 */
let cachedModels: ModelMetadata[] = [];

/**
 * The active model provider used for resolving capabilities.
 * Defaults to the direct `"llamacpp"` provider; {@link detectAndSetProvider}
 * replaces it during boot.
 */
let activeProvider: ModelProvider = createModelProvider("llamacpp", API_BASE_URL);

/**
 * Returns the currently active model provider.
 *
 * @returns The active provider instance
 */
export function getModelProvider(): ModelProvider {
  return activeProvider;
}

/**
 * Fetches the list of available models from the OpenAI-compatible endpoint.
 *
 * @returns Array of enriched model metadata
 * @throws If the models list endpoint is unreachable
 */
export async function fetchAvailableModels(): Promise<ModelMetadata[]> {
  const url = `${API_BASE_URL}/models`;
  logger.debug(`Fetching models from ${url}`);

  const modelsRes = await fetch(url);

  if (!modelsRes.ok) {
    throw new Error(`Failed to fetch models: HTTP ${modelsRes.status} ${modelsRes.statusText}`);
  }

  const body = (await modelsRes.json()) as OpenAIModelsResponse;
  const entries = body.data ?? [];

  cachedModels = entries.map((entry) => ({
    id: entry.id,
    owned_by: entry.owned_by,
    contextWindow: null,
    vision: null,
  }));

  logger.info(`Discovered ${cachedModels.length} model(s)`);
  return cachedModels;
}

/**
 * Returns the cached list of available models without making a network request.
 *
 * @returns The last fetched model list (empty if never fetched)
 */
export function getCachedModels(): ModelMetadata[] {
  return cachedModels;
}

/**
 * Builds a pi-ai {@link Model} object for the given model ID.
 * Uses the active {@link ModelProvider} to resolve context window and vision support.
 *
 * @param modelId - The model identifier (as returned by the endpoint)
 * @param reasoning - Whether to enable reasoning mode for this model
 * @returns A Model configured for the OpenAI-completions API
 */
export async function buildModelConfig(modelId: string, reasoning = false): Promise<Model<"openai-completions">> {
  const capabilities = await activeProvider.fetchCapabilities(modelId);

  const contextWindow = capabilities.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const vision = capabilities.vision ?? false;

  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: "openai",
    baseUrl: API_BASE_URL,
    reasoning,
    input: vision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: DEFAULT_MAX_TOKENS,
    compat: {
      supportsDeveloperRole: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Model Intent Resolution
// ---------------------------------------------------------------------------

/** Result of resolving a model for a given intent. */
export interface ResolvedModel {
  /** The resolved model identifier. */
  modelId: string;
  /** The full model configuration ready for use with the agent. */
  model: Model<"openai-completions">;
}

/**
 * Resolves a model for the given intent.
 *
 * Resolution order:
 * 1. Intent-specific override from `app_config` (`selected_model:<intent>`)
 * 2. Global default model (`selected_model` key or `OPENAI_DEFAULT_MODEL` env var)
 * 3. First available model from the endpoint
 *
 * The `chat` intent always uses the global default directly (no namespaced key).
 *
 * @param intent - The model intent to resolve
 * @returns The resolved model ID and full model configuration
 * @throws If no model can be resolved (no override, no default, no available models)
 */
export async function getModelForIntent(intent: ModelIntent): Promise<ResolvedModel> {
  let modelId: string | undefined;

  // For non-chat intents, check for an intent-specific override
  if (intent !== "chat") {
    modelId = appConfig.get(`selected_model:${intent}`);
  }

  // Fall back to the global default model
  if (!modelId) {
    modelId = appConfig.get("selected_model") || process.env.OPENAI_DEFAULT_MODEL;
  }

  // Last resort: use the first available model
  if (!modelId) {
    const models = await fetchAvailableModels();
    const firstModel = models?.[0];
    if (!firstModel) {
      throw new Error("No models available from LLM endpoint");
    }
    modelId = firstModel.id;
    logger.info(`No model configured for intent "${intent}", using first available: ${modelId}`);
  }

  const model = await buildModelConfig(modelId);

  // Check if the resolved model supports the requested intent
  if (intent === "vision" && !model.input.includes("image")) {
    throw new Error(`Model ${modelId} does not support image input, but intent "${intent}" requires it`);
  }

  return { modelId, model };
}
