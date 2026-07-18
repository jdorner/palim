<script lang="ts">
import ArrowsClockwiseIcon from "phosphor-svelte/lib/ArrowsClockwiseIcon";
import { authFetch } from "$lib/auth";
import ToggleSwitch from "$lib/components/ToggleSwitch.svelte";
import { Badge } from "$lib/components/ui/badge";
import { modelStore } from "$lib/modelStore.svelte";
import type { AvailableModel } from "../../../shared/types";

interface Props {
  /** Bindable status message emitted by the selector (success or error text). */
  statusMessage?: string | null;
  /** Bindable variant for the status message. */
  statusVariant?: "success" | "error" | "info" | "accent";
}

let { statusMessage = $bindable(null), statusVariant = $bindable("info") }: Props = $props();

let models = $state<AvailableModel[]>([]);
let selectedModelId = $state<string | null>(null);
let reasoning = $state(false);
let loading = $state(true);
let saving = $state(false);
let error = $state<string | null>(null);
let successTimer: ReturnType<typeof setTimeout> | null = null;

let selectedModel = $derived(models.find((m) => m.id === selectedModelId));

/** Formats a token count as a human-readable string (e.g. 128000 -> "128k"). */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return String(n);
}

/** Fetches the list of available models and current selection from the backend. */
async function fetchModels() {
  loading = true;
  error = null;
  try {
    const [modelsRes, selectedRes] = await Promise.all([authFetch("/api/models"), authFetch("/api/models/selected")]);

    if (!modelsRes.ok) throw new Error(`Failed to load models: HTTP ${modelsRes.status}`);
    if (!selectedRes.ok) throw new Error(`Failed to load selection: HTTP ${selectedRes.status}`);

    models = await modelsRes.json();
    const selected = await selectedRes.json();
    selectedModelId = selected.modelId;
    reasoning = selected.reasoning ?? false;
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load models";
    statusMessage = error;
    statusVariant = "error";
  } finally {
    loading = false;
  }
}

/** Persists the current model + reasoning selection to the backend. */
async function saveSelection(modelId: string, reasoningValue: boolean) {
  if (saving) return;

  saving = true;
  error = null;
  statusMessage = null;

  try {
    const res = await authFetch("/api/models/selected", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId, reasoning: reasoningValue }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    statusMessage = "Model settings saved";
    statusVariant = "success";
    modelStore.selectedModelId = modelId;
    if (successTimer) clearTimeout(successTimer);
    successTimer = setTimeout(() => (statusMessage = null), 3000);
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to save model settings";
    statusMessage = error;
    statusVariant = "error";
  } finally {
    saving = false;
  }
}

/** Handles dropdown change. */
async function onModelChange(event: Event) {
  const target = event.target as HTMLSelectElement;
  const modelId = target.value;
  if (!modelId || modelId === selectedModelId) return;

  const previousId = selectedModelId;
  selectedModelId = modelId;

  await saveSelection(modelId, reasoning);

  // Revert on error
  if (error) selectedModelId = previousId;
}

/** Handles reasoning toggle. */
async function onReasoningToggle() {
  const previous = reasoning;
  reasoning = !reasoning;

  if (selectedModelId) {
    await saveSelection(selectedModelId, reasoning);
    // Revert on error
    if (error) reasoning = previous;
  }
}

$effect(() => {
  fetchModels();
});
</script>

<div class="space-y-2">
  <div class="flex items-center gap-3">
    <select
      name="model"
      class="flex-1 h-9 rounded-md border border-border bg-background px-3 text-sm
        text-foreground shadow-sm transition-colors
        focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1
        disabled:cursor-not-allowed disabled:opacity-50"
      value={selectedModelId ?? ""}
      onchange={onModelChange}
      disabled={loading || saving || models.length === 0}
      aria-label="Select LLM model"
    >
      {#if !selectedModelId}
        <option value="" disabled>Select a model...</option>
      {/if}
      {#each models as model (model.id)}
        <option value={model.id}>{model.id}</option>
      {/each}
    </select>

    <button
      type="button"
      class="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
      onclick={fetchModels}
      disabled={loading}
      aria-label="Refresh model list"
    >
      <ArrowsClockwiseIcon class="w-4 h-4 {loading ? 'animate-spin' : ''}" aria-hidden="true" />
    </button>
  </div>

  {#if selectedModel}
    <div class="flex flex-wrap items-center gap-1.5">
      {#if selectedModel.contextWindow}
        <Badge variant="outline" class="text-xs font-normal">ctx {formatTokens(selectedModel.contextWindow)}</Badge>
      {/if}
      {#if selectedModel.vision}
        <Badge variant="outline" class="text-xs font-normal">vision</Badge>
      {/if}
    </div>

    <div class="flex items-center justify-between rounded-md border border-border px-3 py-2">
      <div>
        <p class="text-sm font-medium">Reasoning</p>
        <p class="text-xs text-muted-foreground">
          Enable extended thinking to let the model reason step-by-step before responding
        </p>
      </div>
      <ToggleSwitch
        checked={reasoning}
        onChange={() => onReasoningToggle()}
        aria-label="Toggle reasoning mode"
        disabled={saving || !selectedModelId}
      />
    </div>
  {/if}
</div>
