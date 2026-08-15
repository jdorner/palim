<!--
  Schema-driven configuration form for custom workflow step types.

  Renders form fields automatically from a JSON Schema (derived from the
  extension's TypeBox handler schema). Supports text, number, boolean, enum,
  textarea, multiselect, tags, and password field types.

  Field descriptions are shown via an (i) icon with a CSS tooltip on hover.
  String fields support template autocomplete when autocomplete context is provided.
-->
<script lang="ts">
import { Tooltip } from "bits-ui";
import InfoIcon from "phosphor-svelte/lib/InfoIcon";
import ToggleSwitch from "$lib/components/ToggleSwitch.svelte";
import { buildInitialValues, getEnumOptions, getInputType, getLabel, getProperties } from "$lib/schemaForm";
import type { OutputSchemas } from "$lib/templateScope";
import MultiSelect from "./MultiSelect.svelte";
import TemplateAutocomplete from "./TemplateAutocomplete.svelte";

interface Props {
  /** JSON Schema describing the step configuration fields. */
  schema: Record<string, unknown>;
  /** Current configuration values. */
  values: Record<string, unknown>;
  /** Callback fired when any field value changes. Receives the full updated values object. */
  onchange?: (values: Record<string, unknown>) => void;
  /** When true, all fields are rendered as read-only. */
  readonly?: boolean;
  /** Workflow steps for template autocomplete scope (optional). */
  steps?: Array<{ slug: string; [key: string]: unknown }>;
  /** Index of the current step being edited (zero-based, for autocomplete scope). */
  currentStepIndex?: number;
  /** Prefetched secret keys for template autocomplete. */
  secretKeys?: string[];
  /** Resolved output schemas for deep property autocomplete. */
  outputSchemas?: OutputSchemas;
  /** Per-field available items for multiselect rendering (key = property name, value = options). */
  itemOptions?: Record<string, string[]>;
  /** Validation errors keyed by config field name (e.g. "url", "timeout"). */
  fieldErrors?: Map<string, string>;
}

let {
  schema,
  values,
  onchange,
  readonly: isReadonly,
  steps,
  currentStepIndex,
  secretKeys,
  outputSchemas,
  itemOptions,
  fieldErrors,
}: Props = $props();

/** Whether template autocomplete is available (all required context provided). */
let autocompleteEnabled = $derived(steps !== undefined && currentStepIndex !== undefined && secretKeys !== undefined);

/** Internal form state derived from props + schema defaults. */
let formValues = $state<Record<string, unknown>>({});

/** Schema properties and keys (reactive). */
let properties = $derived(getProperties(schema));
let propertyKeys = $derived(Object.keys(properties));

/** Element refs for text/textarea fields (keyed by property name). */
let fieldRefs = $state<Record<string, HTMLTextAreaElement | HTMLInputElement | null>>({});

/** Sync internal state when external values or schema change. */
$effect(() => {
  formValues = buildInitialValues(schema, values);
});

/**
 * Update a single field and notify the parent.
 */
function updateValue(key: string, value: unknown) {
  if (isReadonly) return;
  formValues = { ...formValues, [key]: value };
  onchange?.(formValues);
}
</script>

{#snippet infoTip(description: string)}
  <Tooltip.Root delayDuration={0}>
    <Tooltip.Trigger
      class="inline-flex items-center pointer-events-auto cursor-help text-muted-foreground/60 hover:text-muted-foreground"
    >
      <InfoIcon class="w-4 h-4" />
    </Tooltip.Trigger>
    <Tooltip.Portal>
      <Tooltip.Content
        class="z-50 max-w-64 rounded-md border border-border px-3 py-2 text-xs text-foreground shadow-md"
        style="background: hsl(var(--popover));"
        sideOffset={4}
        side="top"
      >
        {description}
      </Tooltip.Content>
    </Tooltip.Portal>
  </Tooltip.Root>
{/snippet}

{#snippet fieldLabel(key: string, label: string, description: string | null)}
  <span class="inline-flex items-center gap-1">
    <label class="text-xs font-medium text-muted-foreground" for="step-config-{key}">{label}</label>
    {#if description}
      {@render infoTip(description)}
    {/if}
  </span>
{/snippet}

{#snippet fieldError(key: string)}
  {#if fieldErrors?.get(key)}
    <span class="text-xs text-destructive">{fieldErrors.get(key)}</span>
  {/if}
{/snippet}

<fieldset disabled={isReadonly} class="space-y-3" style={isReadonly ? "opacity: 0.8;" : ""}>
  {#each propertyKeys as key (key)}
    {@const prop = properties[key]!}
    {@const inputType = getInputType(prop)}
    {@const label = getLabel(key, prop)}
    {@const description = typeof prop.description === "string" ? prop.description : null}

    <div class="space-y-1">
      {#if inputType === "boolean"}
        <div class="flex items-center gap-2">
          <ToggleSwitch
            id="step-config-{key}"
            checked={!!formValues[key]}
            onChange={(v) => updateValue(key, v)}
            aria-label={label}
          />
          <span class="inline-flex items-center gap-1">
            <label class="text-xs font-medium" for="step-config-{key}">{label}</label>
            {#if description}
              {@render infoTip(description)}
            {/if}
          </span>
        </div>
      {:else if inputType === "enum"}
        {@render fieldLabel(key, label, description)}
        <select
          id="step-config-{key}"
          class="block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
          value={String(formValues[key] ?? "")}
          onchange={(e) => updateValue(key, e.currentTarget.value)}
        >
          {#each getEnumOptions(prop) as option (option)}
            <option value={option}>{option}</option>
          {/each}
        </select>
      {:else if inputType === "multiselect"}
        {@render fieldLabel(key, label, description)}
        <MultiSelect
          id="step-config-{key}"
          items={prop.availableItems as string[]}
          selected={Array.isArray(formValues[key]) ? formValues[key] as string[] : []}
          placeholder="Select items..."
          onchange={(val) => updateValue(key, val)}
        />
      {:else if inputType === "tags" && itemOptions?.[key]}
        {@render fieldLabel(key, label, description)}
        <MultiSelect
          id="step-config-{key}"
          items={itemOptions[key]!}
          selected={Array.isArray(formValues[key]) ? formValues[key] as string[] : []}
          placeholder="Select items..."
          onchange={(val) => updateValue(key, val)}
        />
      {:else if inputType === "tags"}
        {@render fieldLabel(key, label, description)}
        <input
          id="step-config-{key}"
          type="text"
          class="block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
          value={Array.isArray(formValues[key]) ? (formValues[key] as string[]).join(", ") : ""}
          placeholder="value1, value2, ..."
          oninput={(e) => {
            const raw = e.currentTarget.value;
            const items = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
            updateValue(key, items);
          }}
        >
      {:else if inputType === "number"}
        {@render fieldLabel(key, label, description)}
        <input
          id="step-config-{key}"
          type="number"
          class="block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
          value={formValues[key] as number}
          min={prop.minimum as number | undefined}
          max={prop.maximum as number | undefined}
          step={prop.multipleOf as number | undefined ?? "any"}
          oninput={(e) => updateValue(key, Number(e.currentTarget.value))}
        >
      {:else if inputType === "password"}
        {@render fieldLabel(key, label, description)}
        <input
          id="step-config-{key}"
          type="password"
          class="block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
          value={String(formValues[key] ?? "")}
          minlength={prop.minLength as number | undefined}
          maxlength={prop.maxLength as number | undefined}
          oninput={(e) => updateValue(key, e.currentTarget.value)}
        >
      {:else if inputType === "textarea"}
        {@render fieldLabel(key, label, description)}
        <textarea
          id="step-config-{key}"
          bind:this={fieldRefs[key]}
          class="block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring resize-y min-h-20"
          minlength={prop.minLength as number | undefined}
          maxlength={prop.maxLength as number | undefined}
          rows={4}
          value={String(formValues[key] ?? "")}
          oninput={(e) => updateValue(key, (e.target as HTMLTextAreaElement).value)}
        ></textarea>
        {#if autocompleteEnabled}
          <TemplateAutocomplete
            targetElement={fieldRefs[key] ?? null}
            steps={steps ?? []}
            currentStepIndex={currentStepIndex ?? 0}
            secretKeys={secretKeys ?? []}
            {outputSchemas}
            onChange={(newValue) => updateValue(key, newValue)}
          />
        {/if}
      {:else if inputType === "text"}
        {@render fieldLabel(key, label, description)}
        <input
          id="step-config-{key}"
          bind:this={fieldRefs[key]}
          type="text"
          class="block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
          value={String(formValues[key] ?? "")}
          minlength={prop.minLength as number | undefined}
          maxlength={prop.maxLength as number | undefined}
          oninput={(e) => updateValue(key, (e.target as HTMLInputElement).value)}
        >
        {#if autocompleteEnabled}
          <TemplateAutocomplete
            targetElement={fieldRefs[key] ?? null}
            steps={steps ?? []}
            currentStepIndex={currentStepIndex ?? 0}
            secretKeys={secretKeys ?? []}
            {outputSchemas}
            onChange={(newValue) => updateValue(key, newValue)}
          />
        {/if}
      {:else}
        {@render fieldLabel(key, label, description)}
        <p class="text-xs text-muted-foreground italic">Complex field — use "Edit as JSON" to configure.</p>
      {/if}
      {@render fieldError(key)}
    </div>
  {/each}

  {#if propertyKeys.length === 0}
    <p class="text-xs text-muted-foreground italic">No configuration fields defined for this step type.</p>
  {/if}
</fieldset>
