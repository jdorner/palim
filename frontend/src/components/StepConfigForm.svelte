<!--
  Schema-driven configuration form for custom workflow step types.

  Renders form fields automatically from a JSON Schema (derived from the
  extension's TypeBox handler schema). Supports text, number, boolean, enum,
  textarea, multiselect, tags, and password field types, plus complex fields:
  number lists, key/value records, nested objects and lists of objects (the
  latter two render this form recursively).

  Field descriptions are shown via an (i) icon with a CSS tooltip on hover.
  String fields support template autocomplete when autocomplete context is provided.
-->
<script lang="ts">
import { Tooltip } from "bits-ui";
import InfoIcon from "phosphor-svelte/lib/InfoIcon";
import PlusIcon from "phosphor-svelte/lib/PlusIcon";
import TrashIcon from "phosphor-svelte/lib/TrashIcon";
import ToggleSwitch from "$lib/components/ToggleSwitch.svelte";
import { t, tx } from "$lib/i18n.svelte";
import { type CoreKey, translateCore } from "$lib/i18nCore";
import {
  buildInitialValues,
  getAvailableItems,
  getEnumOptions,
  getInputType,
  getLabel,
  getProperties,
  getRecordValueSchema,
  type SchemaProperty,
} from "$lib/schemaForm";
import type { OutputSchemas, SlugEdge } from "$lib/templateScope";
import KeyValueEditor from "./KeyValueEditor.svelte";
import MultiSelect from "./MultiSelect.svelte";
import StepConfigForm from "./StepConfigForm.svelte";
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
  /** Prefetched variable keys for template autocomplete. */
  variableKeys?: string[];
  /** Resolved output schemas for deep property autocomplete. */
  outputSchemas?: OutputSchemas;
  /** DAG edges in slug space, for correct preceding-step (result) precedence */
  edges?: SlugEdge[];
  /** Per-field available items for multiselect rendering (key = property name, value = options). */
  itemOptions?: Record<string, string[]>;
  /** Validation errors keyed by config field name (e.g. "url", "timeout"). */
  fieldErrors?: Map<string, string>;
  /** Prefix for element ids (nested forms use a distinct prefix to keep ids unique). */
  idPrefix?: string;
  /**
   * Translates field titles and descriptions through a catalog:
   * `<prefix>.<field>.title` / `<prefix>.<field>.description`, falling back to
   * the schema text. With `extension` the extension's catalog is used,
   * otherwise the core catalog (built-in step types). Nested forms extend the
   * prefix with the field name.
   */
  i18nScope?: { extension?: string; prefix: string };
}

let {
  schema,
  values,
  onchange,
  readonly: isReadonly,
  steps,
  currentStepIndex,
  secretKeys,
  variableKeys,
  outputSchemas,
  edges,
  itemOptions,
  fieldErrors,
  idPrefix = "step-config-",
  i18nScope,
}: Props = $props();

/**
 * Field label, translated through the extension catalog when scoped.
 *
 * @param key - Property name
 * @param prop - Property schema
 * @returns The label
 */
function fieldTitle(key: string, prop: SchemaProperty): string {
  const fallback = getLabel(key, prop);
  return i18nScope ? scoped(`${i18nScope.prefix}.${key}.title`, fallback) : fallback;
}

/**
 * Looks up a key in the scope's catalog.
 *
 * @param key - Full catalog key
 * @param fallback - Schema text
 * @returns The translation, or the fallback
 */
function scoped(key: string, fallback: string): string {
  if (i18nScope?.extension) return tx(i18nScope.extension, key, fallback);
  return translateCore(key as CoreKey, { default: fallback });
}

/**
 * Field description, translated through the extension catalog when scoped.
 *
 * @param key - Property name
 * @param prop - Property schema
 * @returns The description, or null when the schema has none
 */
function fieldDescription(key: string, prop: SchemaProperty): string | null {
  if (typeof prop.description !== "string") return null;
  return i18nScope ? scoped(`${i18nScope.prefix}.${key}.description`, prop.description) : prop.description;
}

/**
 * Scope for a nested form below a field.
 *
 * @param key - Property name
 * @returns The nested scope, or undefined when unscoped
 */
function nestedScope(key: string): Props["i18nScope"] {
  return i18nScope ? { ...i18nScope, prefix: `${i18nScope.prefix}.${key}` } : undefined;
}

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

/** Names of required fields (from the schema's `required` list). */
let requiredKeys = $derived(new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []));

/**
 * Update a single field and notify the parent.
 *
 * Emptying an optional field without a default (empty string or empty list)
 * removes the key instead of persisting an empty placeholder.
 */
function updateValue(key: string, value: unknown) {
  if (isReadonly) return;
  const isEmpty = value === "" || (Array.isArray(value) && value.length === 0);
  if (isEmpty && !requiredKeys.has(key) && properties[key]?.default === undefined) {
    clearValue(key);
    return;
  }
  formValues = { ...formValues, [key]: value };
  onchange?.(formValues);
}

/**
 * Remove a field from the values and notify the parent. The form then falls
 * back to the schema default (if any) on the next sync.
 */
function clearValue(key: string) {
  if (isReadonly) return;
  const { [key]: _, ...rest } = formValues;
  formValues = rest;
  onchange?.(formValues);
}

/**
 * Collect field errors below a nested path, re-keyed relative to that path.
 *
 * @param prefix - Path prefix including the trailing separator (e.g. "headers." or "items[0].")
 * @returns Errors for the nested form, or undefined when there are none
 */
function nestedErrors(prefix: string): Map<string, string> | undefined {
  if (!fieldErrors) return undefined;
  const m = new Map<string, string>();
  for (const [k, v] of fieldErrors) {
    if (k.startsWith(prefix)) m.set(k.slice(prefix.length), v);
  }
  return m.size > 0 ? m : undefined;
}

/** Current array value of a list field (empty when unset). */
function listValue(key: string): unknown[] {
  const v = formValues[key];
  return Array.isArray(v) ? v : [];
}

/** Parse a comma-separated number list, dropping tokens that are not numbers. */
function parseNumberList(raw: string): number[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(Number)
    .filter((n) => Number.isFinite(n));
}
</script>

{#snippet infoTip(
  description: string,
)}
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

{#snippet fieldLabel(
  key: string,
  label: string,
  description: string | null,
)}
  <span class="inline-flex items-center gap-1">
    <label class="text-xs font-medium text-muted-foreground" for="{idPrefix}{key}">{label}</label>
    {#if description}
      {@render infoTip(description)}
    {/if}
  </span>
{/snippet}

{#snippet fieldError(
  key: string,
)}
  {#if fieldErrors?.get(key)}
    <span class="text-xs text-destructive">{fieldErrors.get(key)}</span>
  {/if}
{/snippet}

<fieldset disabled={isReadonly} class="space-y-3" style={isReadonly ? "opacity: 0.8;" : ""}>
  {#each propertyKeys as key (key)}
    {@const prop = properties[key]!}
    {@const inputType = getInputType(prop)}
    {@const label = fieldTitle(key, prop)}
    {@const description = fieldDescription(key, prop)}

    <div class="space-y-1">
      {#if inputType === "boolean" && !requiredKeys.has(key) && prop.default === undefined}
        <!-- Optional boolean without a default has three states: unset, true, false.
             A toggle cannot express "unset", so render a select instead. -->
        {@render fieldLabel(key, label, description)}
        <select
          id="{idPrefix}{key}"
          class="block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
          value={formValues[key] === undefined ? "" : String(formValues[key])}
          onchange={(e) => {
            const v = e.currentTarget.value;
            if (v === "") clearValue(key);
            else updateValue(key, v === "true");
          }}
        >
          <option value="">{t("schemaForm.anyNotSet")}</option>
          <option value="true">{t("schemaForm.yes")}</option>
          <option value="false">{t("schemaForm.no")}</option>
        </select>
      {:else if inputType === "boolean"}
        <div class="flex items-center gap-2">
          <ToggleSwitch
            id="{idPrefix}{key}"
            checked={!!formValues[key]}
            onChange={(v) => updateValue(key, v)}
            aria-label={label}
          />
          <span class="inline-flex items-center gap-1">
            <label class="text-xs font-medium" for="{idPrefix}{key}">{label}</label>
            {#if description}
              {@render infoTip(description)}
            {/if}
          </span>
        </div>
      {:else if inputType === "enum"}
        {@render fieldLabel(key, label, description)}
        <select
          id="{idPrefix}{key}"
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
        {@const itemLabels = (prop.itemLabels ?? undefined) as Record<string, string> | undefined}
        <MultiSelect
          size="xs"
          id="{idPrefix}{key}"
          items={prop.availableItems as string[]}
          selected={Array.isArray(formValues[key]) ? (formValues[key] as string[]) : []}
          placeholder={t("schemaForm.selectItems")}
          allowCustom={prop.allowCustomItems === true}
          labelFor={itemLabels ? (item) => itemLabels[item] : undefined}
          onchange={(val) => updateValue(key, val)}
        />
      {:else if inputType === "tags" && itemOptions?.[key]}
        {@render fieldLabel(key, label, description)}
        <MultiSelect
          size="xs"
          id="{idPrefix}{key}"
          items={itemOptions[key]!}
          selected={Array.isArray(formValues[key]) ? (formValues[key] as string[]) : []}
          placeholder={t("schemaForm.selectItems")}
          onchange={(val) => updateValue(key, val)}
        />
      {:else if inputType === "tags"}
        {@render fieldLabel(key, label, description)}
        <input
          id="{idPrefix}{key}"
          type="text"
          class="block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
          value={Array.isArray(formValues[key]) ? (formValues[key] as string[]).join(", ") : ""}
          placeholder={t("condition.valuesPlaceholder")}
          oninput={(e) => {
            const raw = e.currentTarget.value;
            const items = raw
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            updateValue(key, items);
          }}
        >
      {:else if inputType === "number"}
        {@render fieldLabel(key, label, description)}
        <input
          id="{idPrefix}{key}"
          type="number"
          class="block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
          value={formValues[key] as number}
          min={prop.minimum as number | undefined}
          max={prop.maximum as number | undefined}
          step={(prop.multipleOf as number | undefined) ?? "any"}
          oninput={(e) => {
            // An empty input is not 0: it is committed as "unset" on change
            // (blur/Enter), so a field with a default does not snap back mid-edit.
            if (e.currentTarget.value !== "") updateValue(key, Number(e.currentTarget.value));
          }}
          onchange={(e) => {
            if (e.currentTarget.value === "") clearValue(key);
          }}
        >
      {:else if inputType === "password"}
        {@render fieldLabel(key, label, description)}
        <input
          id="{idPrefix}{key}"
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
          id="{idPrefix}{key}"
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
            variableKeys={variableKeys ?? []}
            {outputSchemas}
            {edges}
            onChange={(newValue) => updateValue(key, newValue)}
          />
        {/if}
      {:else if inputType === "select"}
        {@render fieldLabel(key, label, description)}
        <input
          id="{idPrefix}{key}"
          bind:this={fieldRefs[key]}
          type="text"
          list="{idPrefix}{key}-options"
          autocomplete="off"
          class="block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
          value={String(formValues[key] ?? "")}
          minlength={prop.minLength as number | undefined}
          maxlength={prop.maxLength as number | undefined}
          oninput={(e) => updateValue(key, (e.target as HTMLInputElement).value)}
        >
        <datalist id="{idPrefix}{key}-options">
          {#each getAvailableItems(prop) as option (option)}
            <option value={option}></option>
          {/each}
        </datalist>
        {#if autocompleteEnabled}
          <TemplateAutocomplete
            targetElement={fieldRefs[key] ?? null}
            steps={steps ?? []}
            currentStepIndex={currentStepIndex ?? 0}
            secretKeys={secretKeys ?? []}
            variableKeys={variableKeys ?? []}
            {outputSchemas}
            {edges}
            onChange={(newValue) => updateValue(key, newValue)}
          />
        {/if}
      {:else if inputType === "text"}
        {@render fieldLabel(key, label, description)}
        <input
          id="{idPrefix}{key}"
          bind:this={fieldRefs[key]}
          type="text"
          autocomplete="off"
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
            variableKeys={variableKeys ?? []}
            {outputSchemas}
            {edges}
            onChange={(newValue) => updateValue(key, newValue)}
          />
        {/if}
      {:else if inputType === "numberlist"}
        {@render fieldLabel(key, label, description)}
        <input
          id="{idPrefix}{key}"
          type="text"
          inputmode="numeric"
          autocomplete="off"
          class="block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
          value={listValue(key).join(", ")}
          placeholder="200, 201, ..."
          oninput={(e) => updateValue(key, parseNumberList(e.currentTarget.value))}
        >
      {:else if inputType === "keyvalue"}
        {@render fieldLabel(key, label, description)}
        <KeyValueEditor
          id="{idPrefix}{key}"
          valueSchema={getRecordValueSchema(prop)!}
          value={formValues[key] as Record<string, unknown> | undefined}
          onchange={(val) => updateValue(key, val)}
          {autocompleteEnabled}
          {steps}
          {currentStepIndex}
          {secretKeys}
          {variableKeys}
          {outputSchemas}
          {edges}
        />
      {:else if inputType === "object"}
        {@render fieldLabel(key, label, description)}
        <div class="rounded-md border border-border bg-muted/40 p-2">
          <StepConfigForm
            schema={prop}
            values={(formValues[key] ?? {}) as Record<string, unknown>}
            onchange={(val) => updateValue(key, val)}
            readonly={isReadonly}
            {steps}
            {currentStepIndex}
            {secretKeys}
            {variableKeys}
            {outputSchemas}
            {edges}
            fieldErrors={nestedErrors(`${key}.`)}
            idPrefix="{idPrefix}{key}-"
            i18nScope={nestedScope(key)}
          />
        </div>
      {:else if inputType === "objectlist"}
        {@render fieldLabel(key, label, description)}
        {@const itemSchema = prop.items as SchemaProperty}
        <div class="space-y-2">
          {#each listValue(key) as item, i (i)}
            <div class="relative rounded-md border border-border bg-muted/40 p-2 pr-8">
              <button
                type="button"
                class="absolute top-1.5 right-1.5 rounded p-1 text-muted-foreground hover:text-destructive hover:bg-muted"
                aria-label={t("schemaForm.removeItem", { index: i + 1 })}
                onclick={() =>
                  updateValue(
                    key,
                    listValue(key).filter((_, j) => j !== i),
                  )}
              >
                <TrashIcon class="w-3.5 h-3.5" aria-hidden="true" />
              </button>
              <StepConfigForm
                schema={itemSchema}
                values={(item ?? {}) as Record<string, unknown>}
                onchange={(val) =>
                  updateValue(
                    key,
                    listValue(key).map((v, j) => (j === i ? val : v)),
                  )}
                readonly={isReadonly}
                {steps}
                {currentStepIndex}
                {secretKeys}
                {variableKeys}
                {outputSchemas}
                {edges}
                fieldErrors={nestedErrors(`${key}[${i}].`)}
                idPrefix="{idPrefix}{key}-{i}-"
                i18nScope={nestedScope(key)}
              />
            </div>
          {/each}
          <button
            id="{idPrefix}{key}"
            type="button"
            class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onclick={() => updateValue(key, [...listValue(key), buildInitialValues(itemSchema)])}
          >
            <PlusIcon class="w-3.5 h-3.5" aria-hidden="true" />
            {t("schemaForm.addItem")}
          </button>
        </div>
      {:else}
        {@render fieldLabel(key, label, description)}
        <p class="text-xs text-muted-foreground italic">{t("schemaForm.complexField")}</p>
      {/if}
      {@render fieldError(key)}
    </div>
  {/each}

  {#if propertyKeys.length === 0}
    <p class="text-xs text-muted-foreground italic">{t("schemaForm.noFields")}</p>
  {/if}
</fieldset>
