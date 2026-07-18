/**
 * Dynamic LLM model discovery and selection.
 *
 * Uses a strategy pattern ({@link ModelProvider}) to support different backends
 * for retrieving model capabilities (context window, vision support).
 *
 * Two providers cover the topology:
 *
 * | Proxy        | Provider                   |
 * |--------------|----------------------------|
 * | llama-swap   | {@link LlamaSwapProvider}  |
 * | direct       | {@link LlamaCppProvider}   |
 *
 * Both are instances of {@link ConfigurableModelProvider} composed from a URL
 * builder and a response parser.
 *
 * The correct provider is selected automatically by {@link detectAndSetProvider}
 * based on the `/v1/models` response (`owned_by` field).
 *
 * @module
 */

import type { Model } from "@mariozechner/pi-ai";
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

/**
 * In-memory cache for model capabilities to avoid repeated network requests.
 * Keyed by model ID. Cleared when the provider changes.
 */
const capabilitiesCache = new Map<string, ModelCapabilities>();

// ---------------------------------------------------------------------------
// Provider strategy interface
// ---------------------------------------------------------------------------

/** Model capabilities resolved by a provider. */
export interface ModelCapabilities {
  /** Context window size in tokens, or null if unknown. */
  contextWindow: number | null;
  /** Whether the model supports vision/image input, or null if unknown. */
  vision: boolean | null;
}

/**
 * Strategy interface for resolving model capabilities from an LLM backend.
 *
 * Implementations fetch metadata (context window, modalities) from
 * provider-specific endpoints.
 */
export interface ModelProvider {
  /** Human-readable name for logging. */
  readonly name: string;

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
// URL builders
// ---------------------------------------------------------------------------

/** Builds the URL for a given model and base URL. */
type UrlBuilder = (baseUrl: string, modelId: string) => string;

/** Response parser that extracts capabilities from a fetched JSON body. */
type ResponseParser = (body: unknown, modelId: string) => ModelCapabilities;

/** llama-swap proxy: `GET /upstream/<model>/models` */
const buildLlamaSwapUrl: UrlBuilder = (baseUrl, modelId) => `${baseUrl}/upstream/${modelId}/models`;

/** Direct llama.cpp: `GET /v1/models` */
const buildLlamaCppUrl: UrlBuilder = (baseUrl) => `${baseUrl}/v1/models`;

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

/**
 * Parses the models response.
 * Extracts `meta.n_ctx` from `data[]` and checks `capabilities` for `"multimodal"`.
 *
 * @param body - The parsed JSON response
 * @param modelId - The model ID to look up (falls back to first entry)
 * @returns Extracted capabilities
 */
const parseModelsResponse: ResponseParser = (body, modelId) => {
  const response = body as ModelsResponse;

  const dataEntry = response.data?.find((d) => d.id === modelId) ?? response.data?.[0];
  const contextWindow = dataEntry?.meta?.n_ctx ?? null;

  const modelInfo = response.models?.find((m) => m.model === modelId || m.name === modelId) ?? response.models?.[0];
  const capabilities = modelInfo?.capabilities ?? [];
  const vision = capabilities.includes("multimodal");

  return { contextWindow, vision };
};

// ---------------------------------------------------------------------------
// Configurable provider (single implementation for both strategies)
// ---------------------------------------------------------------------------

/**
 * A model provider composed from a URL builder and a response parser.
 *
 * This single class backs both provider variants by parameterizing the two
 * axes of variation: how to build the endpoint URL and how to parse the response.
 */
class ConfigurableModelProvider implements ModelProvider {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly buildUrl: UrlBuilder;
  private readonly parseResponse: ResponseParser;

  /**
   * @param name - Human-readable provider name for logging
   * @param buildUrl - Function that constructs the endpoint URL
   * @param parseResponse - Function that extracts capabilities from the response
   * @param apiBaseUrl - The OpenAI-compatible base URL (e.g. `http://localhost:11434/v1`)
   */
  constructor(name: string, buildUrl: UrlBuilder, parseResponse: ResponseParser, apiBaseUrl: string) {
    this.name = name;
    this.buildUrl = buildUrl;
    this.parseResponse = parseResponse;
    this.baseUrl = apiBaseUrl.replace(/\/v1\/?$/, "");
  }

  /**
   * Fetches and parses model capabilities from the configured endpoint.
   * Results are cached per model ID to avoid redundant network requests.
   *
   * @param modelId - The model identifier
   * @returns Extracted capabilities, or nulls if the endpoint is unavailable
   */
  async fetchCapabilities(modelId: string): Promise<ModelCapabilities> {
    const cached = capabilitiesCache.get(modelId);
    if (cached) return cached;

    try {
      const url = this.buildUrl(this.baseUrl, modelId);
      const res = await fetch(url);
      if (!res.ok) return NULL_CAPABILITIES;

      const body = await res.json();
      const result = this.parseResponse(body, modelId);
      capabilitiesCache.set(modelId, result);
      return result;
    } catch {
      return NULL_CAPABILITIES;
    }
  }
}

// ---------------------------------------------------------------------------
// Provider classes
// ---------------------------------------------------------------------------

/**
 * Resolves model capabilities via `GET /upstream/<model>/models` (through llama-swap).
 * Extracts `meta.n_ctx` and `capabilities` from the response.
 */
export class LlamaSwapProvider extends ConfigurableModelProvider {
  constructor(apiBaseUrl: string) {
    super("llama-swap", buildLlamaSwapUrl, parseModelsResponse, apiBaseUrl);
  }
}

/**
 * Resolves model capabilities via `GET /v1/models` directly from llama.cpp.
 * Extracts `meta.n_ctx` and `capabilities` from the response.
 */
export class LlamaCppProvider extends ConfigurableModelProvider {
  constructor(apiBaseUrl: string) {
    super("llamacpp", buildLlamaCppUrl, parseModelsResponse, apiBaseUrl);
  }
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
 * Detects the correct provider strategy by inspecting the `/v1/models` response.
 *
 * Detection logic:
 * If any entry has `owned_by === "llama-swap"`, a proxy is present and
 * {@link LlamaSwapProvider} is used. Otherwise {@link LlamaCppProvider} is used.
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

  const provider: ModelProvider = isLlamaSwap
    ? new LlamaSwapProvider(effectiveBaseUrl)
    : new LlamaCppProvider(effectiveBaseUrl);

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
 * Initially unset - call {@link detectAndSetProvider} during boot to auto-detect,
 * or {@link setModelProvider} to set manually.
 * Falls back to {@link LlamaCppProvider} if never configured.
 */
let activeProvider: ModelProvider = new LlamaCppProvider(API_BASE_URL);

/**
 * Replaces the active model provider strategy.
 * Clears the capabilities cache since the new provider may resolve differently.
 *
 * @param provider - The new provider to use for capability resolution
 */
export function setModelProvider(provider: ModelProvider): void {
  logger.info(`Switching model provider to "${provider.name}"`);
  activeProvider = provider;
  capabilitiesCache.clear();
}

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

/** Well-known task categories that can each be assigned a different model. */
export type ModelIntent = "chat" | "vision" | "embedding";

/** All valid model intent values. */
export const MODEL_INTENTS: readonly ModelIntent[] = ["chat", "vision", "embedding"] as const;

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
