<!--
  Schema-driven configuration form for custom workflow step types.

  Renders form fields automatically from a JSON Schema (derived from the
  extension's TypeBox handler schema). Supports text, number, boolean, enum,
  textarea, multiselect, tags, and password field types, plus complex fields:
  number and string lists, key/value records, nested objects, discriminated
  unions, and lists and records of objects (rendering this form recursively;
  list items can be reordered with up/down buttons).
  Loose unions (e.g. `string | object`) are edited as text; a structured value
  in such a field falls back to the JSON view.

  Field descriptions are shown via an (i) icon with a CSS tooltip on hover.
  String fields support template autocomplete when autocomplete context is provided.
-->
<script lang="ts">
import ArrowDownIcon from "phosphor-svelte/lib/ArrowDownIcon";
import ArrowUpIcon from "phosphor-svelte/lib/ArrowUpIcon";
import PlusIcon from "phosphor-svelte/lib/PlusIcon";
import TrashIcon from "phosphor-svelte/lib/TrashIcon";
import { untrack } from "svelte";
import ToggleSwitch from "$lib/components/ToggleSwitch.svelte";
import { t, tx } from "$lib/i18n.svelte";
import { type CoreKey, translateCore } from "$lib/i18nCore";
import {
  applyFormEdit,
  buildInitialValues,
  getAvailableItems,
  getEnumOptions,
  getFormSchema,
  getInputType,
  getLabel,
  getProperties,
  getRecordValueSchema,
  hasNonTextValue,
  moveItem,
  parseTagList,
  type SchemaProperty,
} from "$lib/schemaForm";
import type { OutputSchemas, SlugEdge } from "$lib/templateScope";
import ExpandButton from "./ExpandButton.svelte";
import ExpandedTextEditor from "./ExpandedTextEditor.svelte";
import InfoTip from "./InfoTip.svelte";
import KeyValueEditor from "./KeyValueEditor.svelte";
import MultiSelect from "./MultiSelect.svelte";
import ObjectRecordEditor from "./ObjectRecordEditor.svelte";
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
   * Dotted path of this form's values within the step config (e.g.
   * `variables.2.`), so template fields know their position (`variables.2.value`)
   * as the backend validator names it. Nested forms extend it.
   */
  pathPrefix?: string;
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
  pathPrefix = "",
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

/** The text field open in the large editor dialog, if any. */
let expanded = $state<{
  title: string;
  get: () => string;
  set: (value: string) => void;
  maxlength?: number;
  fieldPath?: string;
} | null>(null);

/** Step index the large editor was last reset for (not reactive). */
let expandedStepIndex = untrack(() => currentStepIndex);

// Close the large editor when the form switches to another step. The effect
// can re-run on every edit (the index arrives through spread template props),
// so it compares against the last index instead of resetting unconditionally.
$effect(() => {
  const stepIndex = currentStepIndex;
  if (stepIndex === expandedStepIndex) return;
  expandedStepIndex = stepIndex;
  expanded = null;
});

/**
 * Open a text field in the large editor dialog.
 *
 * @param title - Dialog title (the field label)
 * @param get - Reads the current text
 * @param set - Writes edited text
 * @param maxlength - Optional length limit
 * @param fieldPath - Dotted path of the field within the step config (template scope)
 */
function openExpanded(
  title: string,
  get: () => string,
  set: (value: string) => void,
  maxlength?: number,
  fieldPath?: string,
) {
  expanded = { title, get, set, maxlength, fieldPath };
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

{#snippet fieldLabel(
  key: string,
  label: string,
  description: string | null,
)}
  <span class="inline-flex items-center gap-1">
    <label class="text-xs font-medium text-muted-foreground" for="{idPrefix}{key}">{label}</label>
    {#if description}
      <InfoTip text={description} />
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
      {#if hasNonTextValue(prop, formValues[key])}
        <!-- A loose union holding a structured value: text inputs would lose it. -->
        {@render fieldLabel(key, label, description)}
        <p class="text-xs text-muted-foreground italic">{t("schemaForm.complexField")}</p>
      {:else if inputType === "boolean" && !requiredKeys.has(key) && prop.default === undefined}
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
              <InfoTip text={description} />
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
          bind:this={fieldRefs[key]}
          type="text"
          autocomplete="off"
          class="block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
          value={Array.isArray(formValues[key]) ? (formValues[key] as string[]).join(", ") : ""}
          placeholder={t("condition.valuesPlaceholder")}
          oninput={(e) => updateValue(key, parseTagList(e.currentTarget.value))}
        >
        {#if autocompleteEnabled && prop.template !== false}
          <TemplateAutocomplete
            targetElement={fieldRefs[key] ?? null}
            fieldPath="{pathPrefix}{key}"
            steps={steps ?? []}
            currentStepIndex={currentStepIndex ?? 0}
            secretKeys={secretKeys ?? []}
            variableKeys={variableKeys ?? []}
            {outputSchemas}
            {edges}
            onChange={(newValue) => updateValue(key, parseTagList(newValue))}
          />
        {/if}
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
        <div class="flex items-center justify-between">
          {@render fieldLabel(key, label, description)}
          <ExpandButton
            {label}
            onclick={() =>
              openExpanded(
                label,
                () => String(formValues[key] ?? ""),
                (v) => updateValue(key, v),
                prop.maxLength as number | undefined,
                `${pathPrefix}${key}`,
              )}
          />
        </div>
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
        {#if autocompleteEnabled && prop.template !== false}
          <TemplateAutocomplete
            targetElement={fieldRefs[key] ?? null}
            fieldPath="{pathPrefix}{key}"
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
        {#if autocompleteEnabled && prop.template !== false}
          <TemplateAutocomplete
            targetElement={fieldRefs[key] ?? null}
            fieldPath="{pathPrefix}{key}"
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
        {#if autocompleteEnabled && prop.template !== false}
          <TemplateAutocomplete
            targetElement={fieldRefs[key] ?? null}
            fieldPath="{pathPrefix}{key}"
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
      {:else if inputType === "stringlist"}
        {@render fieldLabel(key, label, description)}
        <div class="space-y-1.5">
          {#each listValue(key) as item, i (i)}
            <div class="flex items-start gap-1.5">
              <textarea
                bind:this={fieldRefs[`${key}[${i}]`]}
                aria-label="{label} {i + 1}"
                class="block flex-1 min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-xs font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring resize-y"
                rows={2}
                value={String(item ?? "")}
                oninput={(e) =>
                  updateValue(
                    key,
                    listValue(key).map((v, j) => (j === i ? e.currentTarget.value : v)),
                  )}
              ></textarea>
              <div class="flex shrink-0 flex-col">
                <ExpandButton
                  label="{label} {i + 1}"
                  onclick={() =>
                    openExpanded(
                      `${label} ${i + 1}`,
                      () => String(listValue(key)[i] ?? ""),
                      (v) =>
                        updateValue(
                          key,
                          listValue(key).map((item, j) => (j === i ? v : item)),
                        ),
                      undefined,
                      `${pathPrefix}${key}.${i}`,
                    )}
                />
                <button
                  type="button"
                  class="rounded p-1 text-muted-foreground hover:text-destructive hover:bg-muted"
                  aria-label={t("schemaForm.removeItem", { index: i + 1 })}
                  onclick={() =>
                    updateValue(
                      key,
                      listValue(key).filter((_, j) => j !== i),
                    )}
                >
                  <TrashIcon class="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </div>
            </div>
            {#if autocompleteEnabled && prop.template !== false}
              <TemplateAutocomplete
                targetElement={fieldRefs[`${key}[${i}]`] ?? null}
                fieldPath="{pathPrefix}{key}.{i}"
                steps={steps ?? []}
                currentStepIndex={currentStepIndex ?? 0}
                secretKeys={secretKeys ?? []}
                variableKeys={variableKeys ?? []}
                {outputSchemas}
                {edges}
                onChange={(newValue) =>
                  updateValue(
                    key,
                    listValue(key).map((v, j) => (j === i ? newValue : v)),
                  )}
              />
            {/if}
          {/each}
          <button
            id="{idPrefix}{key}"
            type="button"
            class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onclick={() => updateValue(key, [...listValue(key), ""])}
          >
            <PlusIcon class="w-3.5 h-3.5" aria-hidden="true" />
            {t("schemaForm.addItem")}
          </button>
        </div>
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
      {:else if inputType === "objectrecord"}
        {@render fieldLabel(key, label, description)}
        <ObjectRecordEditor
          id="{idPrefix}{key}"
          valueSchema={getRecordValueSchema(prop)!}
          value={formValues[key] as Record<string, unknown> | undefined}
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
      {:else if inputType === "object" || inputType === "variant"}
        {@render fieldLabel(key, label, description)}
        <div class="rounded-md border border-border bg-muted/40 p-2">
          <StepConfigForm
            schema={getFormSchema(prop, formValues[key])}
            values={(formValues[key] ?? {}) as Record<string, unknown>}
            onchange={(val) => updateValue(key, applyFormEdit(prop, formValues[key], val))}
            readonly={isReadonly}
            {steps}
            {currentStepIndex}
            {secretKeys}
            {variableKeys}
            {outputSchemas}
            {edges}
            fieldErrors={nestedErrors(`${key}.`)}
            idPrefix="{idPrefix}{key}-"
            pathPrefix="{pathPrefix}{key}."
            i18nScope={nestedScope(key)}
          />
        </div>
      {:else if inputType === "objectlist"}
        {@render fieldLabel(key, label, description)}
        {@const itemSchema = prop.items as SchemaProperty}
        <div class="space-y-2">
          {#each listValue(key) as item, i (i)}
            {@const count = listValue(key).length}
            <div class="relative rounded-md border border-border bg-muted/40 p-2 pr-8">
              <div class="absolute top-1.5 right-1.5 flex flex-col">
                <button
                  type="button"
                  class="rounded p-1 text-muted-foreground hover:text-destructive hover:bg-muted"
                  aria-label={t("schemaForm.removeItem", { index: i + 1 })}
                  onclick={() =>
                    updateValue(
                      key,
                      listValue(key).filter((_, j) => j !== i),
                    )}
                >
                  <TrashIcon class="w-3.5 h-3.5" aria-hidden="true" />
                </button>
                {#if count > 1}
                  <button
                    type="button"
                    class="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40 disabled:pointer-events-none"
                    disabled={isReadonly || i === 0}
                    aria-label={t("schemaForm.moveItemUp", { index: i + 1 })}
                    title={t("schemaForm.moveItemUp", { index: i + 1 })}
                    onclick={() => updateValue(key, moveItem(listValue(key), i, i - 1))}
                  >
                    <ArrowUpIcon class="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    class="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40 disabled:pointer-events-none"
                    disabled={isReadonly || i === count - 1}
                    aria-label={t("schemaForm.moveItemDown", { index: i + 1 })}
                    title={t("schemaForm.moveItemDown", { index: i + 1 })}
                    onclick={() => updateValue(key, moveItem(listValue(key), i, i + 1))}
                  >
                    <ArrowDownIcon class="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                {/if}
              </div>
              <StepConfigForm
                schema={getFormSchema(itemSchema, item)}
                values={(item ?? {}) as Record<string, unknown>}
                onchange={(val) =>
                  updateValue(
                    key,
                    listValue(key).map((v, j) => (j === i ? applyFormEdit(itemSchema, v, val) : v)),
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
                pathPrefix="{pathPrefix}{key}.{i}."
                i18nScope={nestedScope(key)}
              />
            </div>
          {/each}
          <button
            id="{idPrefix}{key}"
            type="button"
            class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onclick={() =>
              updateValue(key, [...listValue(key), buildInitialValues(getFormSchema(itemSchema, undefined))])}
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

{#if expanded}
  <ExpandedTextEditor
    title={expanded.title}
    value={expanded.get()}
    oninput={expanded.set}
    onClose={() => (expanded = null)}
    maxlength={expanded.maxlength}
    readonly={isReadonly}
    template={autocompleteEnabled
      ? {
          steps: steps ?? [],
          currentStepIndex: currentStepIndex ?? 0,
          secretKeys: secretKeys ?? [],
          variableKeys: variableKeys ?? [],
          outputSchemas,
          edges,
          fieldPath: expanded.fieldPath,
        }
      : undefined}
  />
{/if}
