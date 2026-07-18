<script lang="ts">
import ArrowCounterClockwiseIcon from "phosphor-svelte/lib/ArrowCounterClockwiseIcon";
import ArrowUUpLeftIcon from "phosphor-svelte/lib/ArrowUUpLeftIcon";
import CheckCircleIcon from "phosphor-svelte/lib/CheckCircleIcon";
import FloppyDiskIcon from "phosphor-svelte/lib/FloppyDiskIcon";
import WarningIcon from "phosphor-svelte/lib/WarningIcon";
import { Value } from "typebox/value";
import { authFetch } from "$lib/auth";
import ToggleSwitch from "$lib/components/ToggleSwitch.svelte";
import { Button } from "$lib/components/ui/button";
import MultiSelect from "./MultiSelect.svelte";

interface Props {
  /** Extension name for API calls. */
  extensionName: string;
  /** JSON Schema object from the backend. */
  schema: Record<string, unknown>;
  /** Initial persisted values from the backend. */
  initialValues: Record<string, unknown>;
}

let { extensionName, schema, initialValues }: Props = $props();

/** Current form values (mutable state). */
let formValues = $state<Record<string, unknown>>({});

/** Per-field validation errors. */
let fieldErrors = $state<Record<string, string>>({});

/** Global form error message. */
let formError = $state<string | null>(null);

/** Success message after save. */
let success = $state<string | null>(null);

/** Whether the form is currently submitting. */
let submitting = $state(false);

/** Timer for clearing success message. */
let successTimer: ReturnType<typeof setTimeout> | null = null;

/** The last-saved baseline for dirty detection. Updated on save. */
let savedValues = $state<Record<string, unknown>>({});

/** Whether the form has unsaved changes (differs from saved baseline). */
let dirty = $derived.by(() => {
  for (const key of propertyKeys) {
    const current = formValues[key];
    const saved = savedValues[key];
    if (Array.isArray(current) && Array.isArray(saved)) {
      if (current.length !== saved.length || current.some((v, i) => v !== saved[i])) return true;
    } else if (current !== saved) {
      return true;
    }
  }
  return false;
});

/** Whether the form values already match the schema defaults. */
let isDefaults = $derived.by(() => {
  for (const key of propertyKeys) {
    const prop = properties[key]!;
    const defaultVal = prop.default !== undefined ? prop.default : getEmptyValue(prop);
    const current = formValues[key];
    if (Array.isArray(current) && Array.isArray(defaultVal)) {
      if (current.length !== defaultVal.length || current.some((v, i) => v !== defaultVal[i])) return false;
    } else if (current !== defaultVal) {
      return false;
    }
  }
  return true;
});

/** The properties from the schema (reactive derivation). */
const properties = $derived((schema.properties ?? {}) as Record<string, Record<string, unknown>>);

/** Property keys in definition order. */
const propertyKeys = $derived(Object.keys(properties));

// Initialize form values from initialValues + schema defaults
$effect(() => {
  const vals: Record<string, unknown> = {};
  for (const key of propertyKeys) {
    const prop = properties[key]!;
    if (key in initialValues && initialValues[key] !== undefined) {
      vals[key] = initialValues[key];
    } else if (prop.default !== undefined) {
      vals[key] = prop.default;
    } else {
      vals[key] = getEmptyValue(prop);
    }
  }
  formValues = vals;
  savedValues = { ...vals };
});

/**
 * Get the appropriate empty/initial value for a property type.
 */
function getEmptyValue(prop: Record<string, unknown>): unknown {
  if (prop.type === "boolean") return false;
  if (prop.type === "number" || prop.type === "integer") return 0;
  if (prop.type === "array") return [];
  if (isEnum(prop)) {
    const options = getEnumOptions(prop);
    return options.length > 0 ? options[0] : "";
  }
  return "";
}

/**
 * Detect if a property is an enum (anyOf with const values).
 */
function isEnum(prop: Record<string, unknown>): boolean {
  const anyOf = prop.anyOf as Array<Record<string, unknown>> | undefined;
  if (!anyOf || !Array.isArray(anyOf)) return false;
  return anyOf.every((item) => "const" in item);
}

/**
 * Extract enum options from an anyOf schema.
 */
function getEnumOptions(prop: Record<string, unknown>): string[] {
  const anyOf = prop.anyOf as Array<Record<string, unknown>> | undefined;
  if (!anyOf) return [];
  return anyOf.filter((item) => "const" in item).map((item) => String(item.const));
}

/**
 * Get a display label for a schema property.
 * Uses `title` if available, otherwise the property key.
 */
function getLabel(key: string, prop: Record<string, unknown>): string {
  return typeof prop.title === "string" ? prop.title : key;
}

/**
 * Determine the input type for a property.
 */
function getInputType(
  prop: Record<string, unknown>,
): "text" | "textarea" | "number" | "boolean" | "enum" | "password" | "multiselect" | "unsupported" {
  if (prop.sensitive === true) return "password";
  if (prop.type === "array" && Array.isArray(prop.availableItems)) return "multiselect";
  if (isEnum(prop)) return "enum";
  if (prop.type === "boolean") return "boolean";
  if (prop.type === "number" || prop.type === "integer") return "number";
  if (prop.type === "string" && prop.multiline === true) return "textarea";
  if (prop.type === "string") return "text";
  return "unsupported";
}

/**
 * Validate the current form values against the schema using TypeBox 1.x.
 * TypeBox 1.x supports validating raw (deserialized) JSON Schema objects.
 */
function validate(): boolean {
  fieldErrors = {};
  const errors = [...Value.Errors(schema, formValues)];
  if (errors.length === 0) return true;

  for (const err of errors) {
    // Path is like "/maxPayloadSize" — extract the key
    const key = err.instancePath.replace(/^\//, "").split("/")[0];
    if (key && !fieldErrors[key]) {
      fieldErrors[key] = err.message;
    }
  }
  return false;
}

/**
 * Handle form submission.
 */
async function handleSubmit() {
  formError = null;
  success = null;

  if (!validate()) return;

  submitting = true;
  try {
    const res = await authFetch(`/api/extensions/${extensionName}/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formValues),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      formError = data.error ?? `HTTP ${res.status}`;
      return;
    }

    success = "Settings saved";
    savedValues = { ...formValues };
    if (successTimer) clearTimeout(successTimer);
    successTimer = setTimeout(() => (success = null), 3000);
  } catch (err) {
    formError = err instanceof Error ? err.message : "Failed to save settings";
  } finally {
    submitting = false;
  }
}

/**
 * Handle value changes and re-validate.
 */
function updateValue(key: string, value: unknown) {
  formValues = { ...formValues, [key]: value };
  // Clear field error on change
  if (fieldErrors[key]) {
    const { [key]: _, ...rest } = fieldErrors;
    fieldErrors = rest;
  }
}

/**
 * Reset all form values to the schema-defined defaults.
 */
function resetToDefaults() {
  const vals: Record<string, unknown> = {};
  for (const key of propertyKeys) {
    const prop = properties[key]!;
    if (prop.default !== undefined) {
      vals[key] = prop.default;
    } else {
      vals[key] = getEmptyValue(prop);
    }
  }
  formValues = vals;
  fieldErrors = {};
  formError = null;
  success = null;
}

/**
 * Revert form values to the last saved state.
 */
function undoChanges() {
  formValues = { ...savedValues };
  fieldErrors = {};
  formError = null;
  success = null;
}

/** Reference to the form element for scoping keyboard shortcuts. */
let formEl = $state<HTMLFormElement | null>(null);

/** Handle Ctrl+Enter and Ctrl+S to save. */
function handleKeydown(event: KeyboardEvent) {
  if (!formEl?.contains(document.activeElement)) return;
  if ((event.ctrlKey || event.metaKey) && (event.key === "Enter" || event.key === "s")) {
    event.preventDefault();
    handleSubmit();
  }
}
</script>

<svelte:window onkeydown={handleKeydown} />

<form bind:this={formEl} class="space-y-4" onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
  {#each propertyKeys as key (key)}
    {@const prop = properties[key]!}
    {@const inputType = getInputType(prop)}
    {@const label = getLabel(key, prop)}
    {@const description = typeof prop.description === "string" ? prop.description : null}
    {@const error = fieldErrors[key]}

    <div class="space-y-1">
      {#if inputType === "boolean"}
        <div>
          <label class="text-sm font-medium" for="settings-{key}">{label}</label>
        </div>
        <ToggleSwitch
          id="settings-{key}"
          checked={!!formValues[key]}
          onChange={(v) => updateValue(key, v)}
          aria-label={label}
        />
        {#if description}
          <p class="text-xs text-muted-foreground">{description}</p>
        {/if}
      {:else if inputType === "enum"}
        <label class="text-sm font-medium" for="settings-{key}">{label}</label>
        <select
          id="settings-{key}"
          class="block w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          value={String(formValues[key] ?? "")}
          onchange={(e) => updateValue(key, e.currentTarget.value)}
        >
          {#each getEnumOptions(prop) as option (option)}
            <option value={option}>{option}</option>
          {/each}
        </select>
        {#if description}
          <p class="text-xs text-muted-foreground">{description}</p>
        {/if}
      {:else if inputType === "multiselect"}
        <label class="text-sm font-medium" for="settings-{key}">{label}</label>
        <MultiSelect
          id="settings-{key}"
          items={prop.availableItems as string[]}
          selected={Array.isArray(formValues[key]) ? formValues[key] as string[] : []}
          placeholder="Select items..."
          onchange={(val) => updateValue(key, val)}
        />
        {#if description}
          <p class="text-xs text-muted-foreground">{description}</p>
        {/if}
      {:else if inputType === "number"}
        <label class="text-sm font-medium" for="settings-{key}">{label}</label>
        <input
          id="settings-{key}"
          type="number"
          class="block w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring
            {error ? 'border-destructive' : ''}"
          value={formValues[key] as number}
          min={prop.minimum as number | undefined}
          max={prop.maximum as number | undefined}
          oninput={(e) => updateValue(key, Number(e.currentTarget.value))}
        >
        {#if description}
          <p class="text-xs text-muted-foreground">{description}</p>
        {/if}
      {:else if inputType === "password"}
        <label class="text-sm font-medium" for="settings-{key}">{label}</label>
        <input
          id="settings-{key}"
          type="password"
          class="block w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring
            {error ? 'border-destructive' : ''}"
          value={String(formValues[key] ?? "")}
          minlength={prop.minLength as number | undefined}
          maxlength={prop.maxLength as number | undefined}
          oninput={(e) => updateValue(key, e.currentTarget.value)}
        >
        {#if description}
          <p class="text-xs text-muted-foreground">{description}</p>
        {/if}
      {:else if inputType === "textarea"}
        <label class="text-sm font-medium" for="settings-{key}">{label}</label>
        <textarea
          id="settings-{key}"
          class="block w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-mono leading-relaxed focus:outline-none focus:ring-1 focus:ring-ring resize-y min-h-32
            {error ? 'border-destructive' : ''}"
          minlength={prop.minLength as number | undefined}
          maxlength={prop.maxLength as number | undefined}
          rows={8}
          value={String(formValues[key] ?? "")}
          oninput={(e) => updateValue(key, e.currentTarget.value)}
        ></textarea>
        {#if description}
          <p class="text-xs text-muted-foreground">{description}</p>
        {/if}
      {:else if inputType === "text"}
        <label class="text-sm font-medium" for="settings-{key}">{label}</label>
        <input
          id="settings-{key}"
          type="text"
          class="block w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring
            {error ? 'border-destructive' : ''}"
          value={String(formValues[key] ?? "")}
          minlength={prop.minLength as number | undefined}
          maxlength={prop.maxLength as number | undefined}
          oninput={(e) => updateValue(key, e.currentTarget.value)}
        >
        {#if description}
          <p class="text-xs text-muted-foreground">{description}</p>
        {/if}
      {:else}
        <span class="text-sm font-medium text-muted-foreground">{label}</span>
        <p class="text-xs text-muted-foreground italic">This setting type is not configurable via the UI.</p>
      {/if}

      {#if error}
        <p class="text-xs text-destructive">{error}</p>
      {/if}
    </div>
  {/each}

  {#if formError}
    <div class="flex items-center gap-2 text-sm text-destructive">
      <WarningIcon class="w-4 h-4 shrink-0" aria-hidden="true" />
      <span>{formError}</span>
    </div>
  {/if}

  {#if success}
    <div class="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
      <CheckCircleIcon class="w-4 h-4 shrink-0" aria-hidden="true" />
      <span>{success}</span>
    </div>
  {/if}

  <div class="flex items-center gap-2 pt-2">
    <Button type="submit" disabled={submitting} size="sm" class="gap-1.5">
      <FloppyDiskIcon class="w-4 h-4" aria-hidden="true" />
      {submitting ? "Saving..." : "Save Settings"}
    </Button>
    <Button type="button" variant="outline" size="sm" class="gap-1.5" disabled={!dirty} onclick={undoChanges}>
      <ArrowUUpLeftIcon class="w-4 h-4" aria-hidden="true" />
      Undo
    </Button>
    <Button type="button" variant="outline" size="sm" class="gap-1.5" disabled={isDefaults} onclick={resetToDefaults}>
      <ArrowCounterClockwiseIcon class="w-4 h-4" aria-hidden="true" />
      Reset to Default
    </Button>
  </div>
</form>
