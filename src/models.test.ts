/**
 * Tests for model provider auto-detection and capability fetching.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { detectAndSetProvider, getModelProvider, LlamaCppProvider, LlamaSwapProvider } from "./models";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

/** Route handler map keyed by pathname. */
let routes: Map<string, (req: Request) => Response>;

beforeEach(() => {
  routes = new Map();

  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const handler = routes.get(url.pathname);
      if (handler) return handler(req);
      return new Response("Not Found", { status: 404 });
    },
  });

  baseUrl = `http://localhost:${server.port}`;
});

afterEach(() => {
  server.stop(true);
});

// ---------------------------------------------------------------------------
// LlamaSwapProvider
// ---------------------------------------------------------------------------

describe("LlamaSwapProvider", () => {
  test("extracts context window and vision from upstream models endpoint", async () => {
    routes.set("/upstream/test-model/models", () =>
      Response.json({
        models: [
          {
            name: "TestModel.gguf",
            model: "TestModel.gguf",
            capabilities: ["completion", "multimodal"],
          },
        ],
        data: [
          {
            id: "TestModel.gguf",
            object: "model",
            meta: { n_ctx: 131072, n_ctx_train: 131072, n_embd: 2048 },
          },
        ],
      }),
    );

    const provider = new LlamaSwapProvider(`${baseUrl}/v1`);
    const caps = await provider.fetchCapabilities("test-model");

    expect(caps.contextWindow).toBe(131072);
    expect(caps.vision).toBe(true);
  });

  test("returns vision false when capabilities lack multimodal", async () => {
    routes.set("/upstream/text-model/models", () =>
      Response.json({
        models: [{ name: "TextOnly.gguf", model: "TextOnly.gguf", capabilities: ["completion"] }],
        data: [{ id: "TextOnly.gguf", object: "model", meta: { n_ctx: 8192 } }],
      }),
    );

    const provider = new LlamaSwapProvider(`${baseUrl}/v1`);
    const caps = await provider.fetchCapabilities("text-model");

    expect(caps.contextWindow).toBe(8192);
    expect(caps.vision).toBe(false);
  });

  test("returns nulls when endpoint returns 404", async () => {
    const provider = new LlamaSwapProvider(`${baseUrl}/v1`);
    const caps = await provider.fetchCapabilities("missing-model");

    expect(caps.contextWindow).toBeNull();
    expect(caps.vision).toBeNull();
  });

  test("returns nulls when endpoint is unreachable", async () => {
    const provider = new LlamaSwapProvider("http://localhost:1/v1");
    const caps = await provider.fetchCapabilities("any");

    expect(caps.contextWindow).toBeNull();
    expect(caps.vision).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// LlamaCppProvider
// ---------------------------------------------------------------------------

describe("LlamaCppProvider", () => {
  test("extracts capabilities from /v1/models response by model ID", async () => {
    routes.set("/v1/models", () =>
      Response.json({
        models: [
          { name: "ModelA.gguf", model: "ModelA.gguf", capabilities: ["completion"] },
          { name: "ModelB.gguf", model: "ModelB.gguf", capabilities: ["completion", "multimodal"] },
        ],
        data: [
          { id: "ModelA.gguf", object: "model", meta: { n_ctx: 4096 } },
          { id: "ModelB.gguf", object: "model", meta: { n_ctx: 262144 } },
        ],
      }),
    );

    const provider = new LlamaCppProvider(`${baseUrl}/v1`);

    const capsA = await provider.fetchCapabilities("ModelA.gguf");
    expect(capsA.contextWindow).toBe(4096);
    expect(capsA.vision).toBe(false);

    const capsB = await provider.fetchCapabilities("ModelB.gguf");
    expect(capsB.contextWindow).toBe(262144);
    expect(capsB.vision).toBe(true);
  });

  test("falls back to first entry when model ID not found", async () => {
    routes.set("/v1/models", () =>
      Response.json({
        models: [{ name: "Only.gguf", model: "Only.gguf", capabilities: ["completion", "multimodal"] }],
        data: [{ id: "Only.gguf", object: "model", meta: { n_ctx: 65536 } }],
      }),
    );

    const provider = new LlamaCppProvider(`${baseUrl}/v1`);
    const caps = await provider.fetchCapabilities("nonexistent");

    expect(caps.contextWindow).toBe(65536);
    expect(caps.vision).toBe(true);
  });

  test("returns nulls when endpoint fails", async () => {
    routes.set("/v1/models", () => new Response("Internal Error", { status: 500 }));

    const provider = new LlamaCppProvider(`${baseUrl}/v1`);
    const caps = await provider.fetchCapabilities("any");

    expect(caps.contextWindow).toBeNull();
    expect(caps.vision).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectAndSetProvider
// ---------------------------------------------------------------------------

describe("detectAndSetProvider", () => {
  test("detects llama-swap -> LlamaSwapProvider", async () => {
    routes.set("/v1/models", () =>
      Response.json({
        object: "list",
        data: [{ id: "q3.6-moe", object: "model", owned_by: "llama-swap" }],
      }),
    );

    const provider = await detectAndSetProvider(`${baseUrl}/v1`);

    expect(provider.name).toBe("llama-swap");
    expect(getModelProvider().name).toBe("llama-swap");
  });

  test("detects direct llama.cpp -> LlamaCppProvider", async () => {
    routes.set("/v1/models", () =>
      Response.json({
        object: "list",
        data: [{ id: "direct-model", object: "model", owned_by: "llamacpp", meta: { n_ctx: 131072 } }],
      }),
    );

    const provider = await detectAndSetProvider(`${baseUrl}/v1`);

    expect(provider.name).toBe("llamacpp");
    expect(getModelProvider().name).toBe("llamacpp");
  });

  test("throws when models endpoint is unreachable", async () => {
    expect(detectAndSetProvider("http://localhost:1/v1")).rejects.toThrow();
  });

  test("throws when models endpoint returns error status", async () => {
    routes.set("/v1/models", () => new Response("Service Unavailable", { status: 503 }));

    expect(detectAndSetProvider(`${baseUrl}/v1`)).rejects.toThrow("Failed to fetch models for detection");
  });

  test("falls back to LlamaCppProvider when no models returned", async () => {
    routes.set("/v1/models", () =>
      Response.json({
        object: "list",
        data: [],
      }),
    );

    const provider = await detectAndSetProvider(`${baseUrl}/v1`);

    expect(provider.name).toBe("llamacpp");
  });
});

// ---------------------------------------------------------------------------
// getModelForIntent
// ---------------------------------------------------------------------------

import { appConfig, getDb } from "@src/db";
import { getModelForIntent, MODEL_INTENTS } from "./models";

describe("getModelForIntent", () => {
  beforeEach(() => {
    // Ensure DB is initialized (migrations run on first call)
    getDb();

    // Set up a mock endpoint so buildModelConfig can resolve capabilities
    routes.set("/v1/models", () =>
      Response.json({
        data: [
          { id: "default-model", object: "model", meta: { n_ctx: 8192 } },
          { id: "vision-model", object: "model", meta: { n_ctx: 16384 } },
          { id: "embed-model", object: "model", meta: { n_ctx: 2048 } },
        ],
        models: [
          { name: "default-model", model: "default-model", capabilities: ["completion"] },
          { name: "vision-model", model: "vision-model", capabilities: ["completion", "multimodal"] },
          { name: "embed-model", model: "embed-model", capabilities: ["completion"] },
        ],
      }),
    );

    // Detect provider so buildModelConfig uses our mock server
    return detectAndSetProvider(`${baseUrl}/v1`).then(() => {
      // Set up a default model
      appConfig.set("selected_model", "default-model");
      // Clear any intent overrides
      appConfig.remove("selected_model:vision");
      appConfig.remove("selected_model:embedding");
    });
  });

  test("chat intent returns the default model", async () => {
    const result = await getModelForIntent("chat");

    expect(result.modelId).toBe("default-model");
    expect(result.model.id).toBe("default-model");
    expect(result.model.api).toBe("openai-completions");
  });

  test("vision intent with override returns the vision model", async () => {
    appConfig.set("selected_model:vision", "vision-model");

    const result = await getModelForIntent("vision");

    expect(result.modelId).toBe("vision-model");
    expect(result.model.id).toBe("vision-model");
  });

  test("vision intent without override falls back to default model", async () => {
    expect(async () => await getModelForIntent("vision")).toThrow();
  });

  test("embedding intent with override returns the embedding model", async () => {
    appConfig.set("selected_model:embedding", "embed-model");

    const result = await getModelForIntent("embedding");

    expect(result.modelId).toBe("embed-model");
    expect(result.model.id).toBe("embed-model");
  });

  test("embedding intent without override falls back to default model", async () => {
    const result = await getModelForIntent("embedding");

    expect(result.modelId).toBe("default-model");
    expect(result.model.id).toBe("default-model");
  });

  test("MODEL_INTENTS contains all valid intents", () => {
    expect(MODEL_INTENTS).toContain("chat");
    expect(MODEL_INTENTS).toContain("vision");
    expect(MODEL_INTENTS).toContain("embedding");
    expect(MODEL_INTENTS.length).toBe(3);
  });
});
