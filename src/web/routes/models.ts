/**
 * Model management routes - list available models and get/set the selected model.
 *
 * Handles:
 * - `GET  /api/models`
 * - `GET  /api/models/selected`
 * - `PUT  /api/models/selected`
 * - `GET  /api/models/intents`
 * - `PUT  /api/models/intents/:intent`
 * - `DELETE /api/models/intents/:intent`
 */

import { Type } from "@sinclair/typebox";
import { appConfig } from "@src/db";
import { fetchAvailableModels, getCachedModels, getModelProvider, MODEL_INTENTS, type ModelIntent } from "@src/models";
import { mainLogger as log } from "@src/utils/logger";
import { Elysia } from "elysia";

/**
 * Returns the per-intent model assignments from app_config.
 *
 * @returns A record mapping each intent to its assigned model ID (or null if unset)
 */
function getIntentAssignments(): Record<ModelIntent, string | null> {
  return {
    chat: null,
    vision: appConfig.get("selected_model:vision") ?? null,
    embedding: appConfig.get("selected_model:embedding") ?? null,
  };
}

/**
 * Creates the model management route group.
 *
 * @returns Elysia plugin with model routes
 */
export function modelRoutes() {
  return new Elysia()
    .get("/api/models", async ({ status }) => {
      try {
        const models = await fetchAvailableModels();
        return status(200, models);
      } catch (error) {
        // Fall back to cached models if the endpoint is unreachable
        const cached = getCachedModels();
        if (cached.length > 0) {
          log.warn("Model endpoint unreachable, returning cached models", { error });
          return status(200, cached);
        }
        const errMsg = error instanceof Error ? error.message : String(error);
        log.error(`Failed to fetch models: ${errMsg}`);
        return status(502, { error: "LLM endpoint unreachable and no cached models available" });
      }
    })
    .get("/api/models/selected", async ({ status }) => {
      try {
        const modelId = appConfig.get("selected_model") || process.env.OPENAI_DEFAULT_MODEL || null;
        const reasoning = appConfig.get("model_reasoning") === "true";

        // Resolve context window for the selected model
        let contextWindow: number | null = null;
        if (modelId) {
          const provider = getModelProvider();
          const caps = await provider.fetchCapabilities(modelId);
          contextWindow = caps.contextWindow;
        }

        const intents = getIntentAssignments();

        return status(200, { modelId, reasoning, contextWindow, intents });
      } catch (error) {
        log.error("Failed to read selected model", { error });
        return status(500, { error: "Failed to read selected model" });
      }
    })
    .put(
      "/api/models/selected",
      ({ body, status }) => {
        try {
          const { modelId, reasoning } = body;

          // Validate that the requested model is actually available
          const availableModels = getCachedModels();
          if (!availableModels.some((m) => m.id === modelId)) {
            log.warn(`Rejected invalid model ID "${modelId}" - not in available models`);
            return status(400, { error: `Model "${modelId}" is not available` });
          }

          appConfig.set("selected_model", modelId);
          if (reasoning !== undefined) {
            appConfig.set("model_reasoning", String(reasoning));
          }

          log.info(`Selected model updated to "${modelId}", reasoning=${reasoning ?? "unchanged"}`);
          return status(200, { modelId, reasoning: reasoning ?? false });
        } catch (error) {
          log.error("Failed to update selected model", { error });
          return status(500, { error: "Failed to update selected model" });
        }
      },
      {
        body: Type.Object({
          modelId: Type.String({ minLength: 1, description: "The model ID to select" }),
          reasoning: Type.Optional(Type.Boolean({ description: "Whether reasoning mode is enabled" })),
        }),
      },
    )
    .get("/api/models/intents", ({ status }) => {
      try {
        return status(200, getIntentAssignments());
      } catch (error) {
        log.error("Failed to read intent assignments", { error });
        return status(500, { error: "Failed to read intent assignments" });
      }
    })
    .put(
      "/api/models/intents/:intent",
      ({ params, body, status }) => {
        try {
          const { intent } = params;

          if (!MODEL_INTENTS.includes(intent as ModelIntent)) {
            return status(400, { error: `Invalid intent "${intent}". Valid intents: ${MODEL_INTENTS.join(", ")}` });
          }

          const { modelId } = body;

          // For chat intent, update the main selected_model key
          if (intent === "chat") {
            appConfig.set("selected_model", modelId);
            log.info(`Intent "chat" model updated to "${modelId}"`);
            return status(200, { intent, modelId });
          }

          // For non-embedding intents, validate the model exists in the available list
          if (intent !== "embedding") {
            const availableModels = getCachedModels();
            if (!availableModels.some((m) => m.id === modelId)) {
              return status(400, { error: `Model "${modelId}" is not available` });
            }
          }

          appConfig.set(`selected_model:${intent}`, modelId);
          log.info(`Intent "${intent}" model updated to "${modelId}"`);
          return status(200, { intent, modelId });
        } catch (error) {
          log.error("Failed to update intent model", { error });
          return status(500, { error: "Failed to update intent model" });
        }
      },
      {
        params: Type.Object({ intent: Type.String() }),
        body: Type.Object({
          modelId: Type.String({ minLength: 1, description: "The model ID to assign to this intent" }),
        }),
      },
    )
    .delete(
      "/api/models/intents/:intent",
      ({ params, status }) => {
        try {
          const { intent } = params;

          if (!MODEL_INTENTS.includes(intent as ModelIntent)) {
            return status(400, { error: `Invalid intent "${intent}". Valid intents: ${MODEL_INTENTS.join(", ")}` });
          }

          // Deleting chat intent is a no-op (it always uses the default)
          if (intent === "chat") {
            return status(200, { intent, modelId: null });
          }

          appConfig.remove(`selected_model:${intent}`);
          log.info(`Intent "${intent}" model override cleared`);
          return status(200, { intent, modelId: null });
        } catch (error) {
          log.error("Failed to clear intent model", { error });
          return status(500, { error: "Failed to clear intent model" });
        }
      },
      {
        params: Type.Object({ intent: Type.String() }),
      },
    );
}
