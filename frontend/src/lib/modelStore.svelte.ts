/**
 * Reactive model store that provides the currently selected model's
 * context window size to any component that needs it.
 *
 * Fetches on init and exposes a refresh method.
 */

import type { ModelIntent, SelectedModelResponse } from "../../../shared/models";
import { authFetch } from "./auth";

/**
 * Reactive model state exposed as a Svelte 5 class with `$state` fields.
 * Provides the selected model's context window for token usage percentage calculations.
 */
class ModelStore {
  /** Currently selected model ID. */
  selectedModelId = $state<string | null>(null);
  /** Context window of the currently selected model (in tokens), or null if unknown. */
  contextWindow = $state<number | null>(null);
  /** Per-intent model assignments (null = inherits from default). */
  intents = $state<Record<ModelIntent, string | null>>({ chat: null, vision: null, embedding: null });
  /** Whether the store has completed its initial fetch. */
  loaded = $state(false);

  /**
   * Fetches the selected model info (including context window) from the backend.
   * Fails silently - context window display is non-critical.
   */
  async refresh(): Promise<void> {
    try {
      const res = await authFetch("/api/models/selected");
      if (res.ok) {
        const data = (await res.json()) as SelectedModelResponse;
        this.selectedModelId = data.modelId;
        this.contextWindow = data.contextWindow;
        this.intents = data.intents ?? { chat: null, vision: null, embedding: null };
      }
    } catch {
      // Non-critical - silently ignore
    } finally {
      this.loaded = true;
    }
  }

  /**
   * Assigns a model to a specific intent.
   *
   * @param intent - The intent to configure
   * @param modelId - The model ID to assign
   * @returns Whether the operation succeeded
   */
  async setIntentModel(intent: ModelIntent, modelId: string): Promise<boolean> {
    try {
      const res = await authFetch(`/api/models/intents/${intent}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId }),
      });
      if (res.ok) {
        this.intents = { ...this.intents, [intent]: modelId };
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Clears the model override for a specific intent (reverts to default).
   *
   * @param intent - The intent to clear
   * @returns Whether the operation succeeded
   */
  async clearIntentModel(intent: ModelIntent): Promise<boolean> {
    try {
      const res = await authFetch(`/api/models/intents/${intent}`, {
        method: "DELETE",
      });
      if (res.ok) {
        this.intents = { ...this.intents, [intent]: null };
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }
}

/** Singleton model store instance. */
export const modelStore = new ModelStore();
