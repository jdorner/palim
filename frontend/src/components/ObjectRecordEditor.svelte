<!--
  Editor for record/map fields whose values are objects (or discriminated
  unions of objects), e.g. a map of question ID -> question definition.

  Each entry is a card with a key input and a nested StepConfigForm for the
  value. Like KeyValueEditor, it keeps a local list of rows so that entries
  with an empty or duplicate key can exist while the user is typing; only rows
  with a non-empty key are emitted (later duplicates win).
-->
<script lang="ts">
import PlusIcon from "phosphor-svelte/lib/PlusIcon";
import TrashIcon from "phosphor-svelte/lib/TrashIcon";
import { t } from "$lib/i18n.svelte";
import { applyFormEdit, buildInitialValues, getFormSchema, type SchemaProperty } from "$lib/schemaForm";
import type { OutputSchemas, SlugEdge } from "$lib/templateScope";
import StepConfigForm from "./StepConfigForm.svelte";

interface Props {
  /** Element id applied to the "add" button (target of the field label). */
  id: string;
  /** Schema of each value in the record (object or discriminated union). */
  valueSchema: SchemaProperty;
  /** Current record value. */
  value: Record<string, unknown> | undefined;
  /** Callback fired with the updated record. */
  onchange: (value: Record<string, unknown>) => void;
  /** When true, all fields are rendered as read-only. */
  readonly?: boolean;
  /** Workflow steps for template autocomplete scope. */
  steps?: Array<{ slug: string; [key: string]: unknown }>;
  /** Index of the current step being edited. */
  currentStepIndex?: number;
  /** Prefetched secret keys for template autocomplete. */
  secretKeys?: string[];
  /** Prefetched variable keys for template autocomplete. */
  variableKeys?: string[];
  /** Resolved output schemas for deep property autocomplete. */
  outputSchemas?: OutputSchemas;
  /** DAG edges in slug space. */
  edges?: SlugEdge[];
  /** Validation errors relative to the record (e.g. "<key>.field"). */
  fieldErrors?: Map<string, string>;
  /** Prefix for element ids of the nested forms. */
  idPrefix: string;
  /** Catalog scope for the nested forms (see StepConfigForm). */
  i18nScope?: { extension?: string; prefix: string };
}

let {
  id,
  valueSchema,
  value,
  onchange,
  readonly: isReadonly,
  steps,
  currentStepIndex,
  secretKeys,
  variableKeys,
  outputSchemas,
  edges,
  fieldErrors,
  idPrefix,
  i18nScope,
}: Props = $props();

interface Row {
  key: string;
  value: Record<string, unknown>;
}

let rows = $state<Row[]>([]);

/** Serialized form of the last record emitted, to skip re-syncing our own changes. */
let lastEmitted: string | undefined;

/** Sync rows from the external value unless it is the value we just emitted. */
$effect(() => {
  const serialized = JSON.stringify(value ?? {});
  if (serialized === lastEmitted) return;
  rows = Object.entries(value ?? {}).map(([k, v]) => ({ key: k, value: (v ?? {}) as Record<string, unknown> }));
  lastEmitted = serialized;
});

/** Build the record from the rows and notify the parent. */
function emit() {
  const record: Record<string, unknown> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key) record[key] = row.value;
  }
  lastEmitted = JSON.stringify(record);
  onchange(record);
}

function addRow() {
  rows = [...rows, { key: "", value: buildInitialValues(getFormSchema(valueSchema, undefined)) }];
}

function removeRow(index: number) {
  rows = rows.filter((_, i) => i !== index);
  emit();
}

function setKey(index: number, key: string) {
  rows[index]!.key = key;
  emit();
}

function setValue(index: number, next: Record<string, unknown>) {
  rows[index]!.value = applyFormEdit(valueSchema, rows[index]!.value, next);
  emit();
}

/**
 * Collect field errors of one entry, re-keyed relative to the entry.
 *
 * @param key - The entry key
 * @returns Errors for the nested form, or undefined when there are none
 */
function entryErrors(key: string): Map<string, string> | undefined {
  if (!fieldErrors || !key) return undefined;
  const prefix = `${key}.`;
  const m = new Map<string, string>();
  for (const [k, v] of fieldErrors) {
    if (k.startsWith(prefix)) m.set(k.slice(prefix.length), v);
  }
  return m.size > 0 ? m : undefined;
}
</script>

<div class="space-y-2">
  {#each rows as row, i (i)}
    <div class="rounded-md border border-border bg-muted/40 p-2 space-y-2">
      <div class="flex items-center gap-1.5">
        <input
          type="text"
          autocomplete="off"
          placeholder={t("kv.key")}
          aria-label={t("kv.key")}
          class="block flex-1 min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-ring"
          value={row.key}
          oninput={(e) => setKey(i, e.currentTarget.value)}
        >
        <button
          type="button"
          class="shrink-0 rounded p-1 text-muted-foreground hover:text-destructive hover:bg-muted"
          aria-label={t("kv.removeEntry")}
          onclick={() => removeRow(i)}
        >
          <TrashIcon class="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </div>
      <StepConfigForm
        schema={getFormSchema(valueSchema, row.value)}
        values={row.value}
        onchange={(val) => setValue(i, val)}
        readonly={isReadonly}
        {steps}
        {currentStepIndex}
        {secretKeys}
        {variableKeys}
        {outputSchemas}
        {edges}
        fieldErrors={entryErrors(row.key.trim())}
        idPrefix="{idPrefix}{i}-"
        {i18nScope}
      />
    </div>
  {/each}
  <button
    {id}
    type="button"
    class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
    onclick={addRow}
  >
    <PlusIcon class="w-3.5 h-3.5" aria-hidden="true" />
    {t("kv.addEntry")}
  </button>
</div>
