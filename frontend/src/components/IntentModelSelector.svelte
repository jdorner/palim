<script lang="ts">
import type { AvailableModel, ModelIntent } from "../../../shared/models";

interface Props {
  /** The model intent this selector controls. */
  intent: ModelIntent;
  /** Human-readable label for the intent. */
  label: string;
  /** Description shown below the label. */
  description: string;
  /** Available models to choose from. */
  models: AvailableModel[];
  /** Currently assigned model ID for this intent (null = default). */
  selectedModelId: string | null;
  /** The default/fallback model ID shown when no override is set. */
  defaultModelId: string | null;
  /** Whether the selector is disabled. */
  disabled?: boolean;
  /** Callback when the user selects a model or clears the override. */
  onchange: (intent: ModelIntent, modelId: string | null) => void;
}

let {
  intent,
  label,
  description,
  models,
  selectedModelId,
  defaultModelId,
  disabled = false,
  onchange,
}: Props = $props();

function handleChange(event: Event) {
  const target = event.target as HTMLSelectElement;
  const value = target.value;
  if (value === "") {
    onchange(intent, null);
  } else {
    onchange(intent, value);
  }
}
</script>

<div class="flex items-center justify-between rounded-md border border-border px-3 py-2">
  <div class="min-w-0 flex-1">
    <p class="text-sm font-medium">{label}</p>
    <p class="text-xs text-muted-foreground">{description}</p>
  </div>
  <select
    name="intent-{intent}"
    class="ml-3 h-8 max-w-[200px] rounded-md border border-border bg-background px-2 text-sm
      text-foreground shadow-sm transition-colors
      focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1
      disabled:cursor-not-allowed disabled:opacity-50"
    value={selectedModelId ?? ""}
    onchange={handleChange}
    {disabled}
    aria-label="Select model for {label} intent"
  >
    <option value="">Default{defaultModelId ? ` (${defaultModelId})` : ""}</option>
    {#each models as model (model.id)}
      <option value={model.id}>{model.id}</option>
    {/each}
  </select>
</div>
