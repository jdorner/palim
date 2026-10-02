<!--
  Row-based editor for record/map fields (e.g. HTTP headers).

  Keeps a local list of key/value rows so that rows with an empty or duplicate
  key can exist while the user is typing. Only rows with a non-empty key are
  emitted (later duplicates win). String values support template autocomplete
  when autocomplete context is provided.
-->
<script lang="ts">
import PlusIcon from "phosphor-svelte/lib/PlusIcon";
import TrashIcon from "phosphor-svelte/lib/TrashIcon";
import ToggleSwitch from "$lib/components/ToggleSwitch.svelte";
import type { SchemaProperty } from "$lib/schemaForm";
import type { OutputSchemas, SlugEdge } from "$lib/templateScope";
import TemplateAutocomplete from "./TemplateAutocomplete.svelte";

interface Props {
  /** Element id applied to the "add" button (target of the field label). */
  id: string;
  /** Schema of each value in the record. */
  valueSchema: SchemaProperty;
  /** Current record value. */
  value: Record<string, unknown> | undefined;
  /** Callback fired with the updated record. */
  onchange: (value: Record<string, unknown>) => void;
  /** When true, template autocomplete is attached to string value inputs. */
  autocompleteEnabled?: boolean;
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
}

let {
  id,
  valueSchema,
  value,
  onchange,
  autocompleteEnabled = false,
  steps,
  currentStepIndex,
  secretKeys,
  variableKeys,
  outputSchemas,
  edges,
}: Props = $props();

interface Row {
  key: string;
  value: unknown;
}

let rows = $state<Row[]>([]);
let valueRefs = $state<Array<HTMLInputElement | null>>([]);

/** Serialized form of the last record emitted, to skip re-syncing our own changes. */
let lastEmitted: string | undefined;

let isNumber = $derived(valueSchema.type === "number" || valueSchema.type === "integer");
let isBoolean = $derived(valueSchema.type === "boolean");

/** Sync rows from the external value unless it is the value we just emitted. */
$effect(() => {
  const serialized = JSON.stringify(value ?? {});
  if (serialized === lastEmitted) return;
  rows = Object.entries(value ?? {}).map(([k, v]) => ({ key: k, value: v }));
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

function emptyValue(): unknown {
  if (isBoolean) return false;
  if (isNumber) return 0;
  return "";
}

function addRow() {
  rows = [...rows, { key: "", value: emptyValue() }];
}

function removeRow(index: number) {
  rows = rows.filter((_, i) => i !== index);
  emit();
}

function setKey(index: number, key: string) {
  rows[index]!.key = key;
  emit();
}

function setValue(index: number, val: unknown) {
  rows[index]!.value = val;
  emit();
}
</script>

<div class="space-y-1.5">
  {#each rows as row, i (i)}
    <div class="flex items-center gap-1.5">
      <input
        type="text"
        autocomplete="off"
        placeholder="Key"
        aria-label="Key"
        class="block w-2/5 min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
        value={row.key}
        oninput={(e) => setKey(i, e.currentTarget.value)}
      >
      {#if isBoolean}
        <div class="flex-1">
          <ToggleSwitch checked={!!row.value} onChange={(v) => setValue(i, v)} aria-label="Value" />
        </div>
      {:else if isNumber}
        <input
          type="number"
          placeholder="Value"
          aria-label="Value"
          class="block flex-1 min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
          value={row.value as number}
          step="any"
          oninput={(e) => setValue(i, Number(e.currentTarget.value))}
        >
      {:else}
        <input
          type="text"
          autocomplete="off"
          placeholder="Value"
          aria-label="Value"
          bind:this={valueRefs[i]}
          class="block flex-1 min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
          value={String(row.value ?? "")}
          oninput={(e) => setValue(i, e.currentTarget.value)}
        >
        {#if autocompleteEnabled}
          <TemplateAutocomplete
            targetElement={valueRefs[i] ?? null}
            steps={steps ?? []}
            currentStepIndex={currentStepIndex ?? 0}
            secretKeys={secretKeys ?? []}
            variableKeys={variableKeys ?? []}
            {outputSchemas}
            {edges}
            onChange={(newValue) => setValue(i, newValue)}
          />
        {/if}
      {/if}
      <button
        type="button"
        class="shrink-0 rounded p-1 text-muted-foreground hover:text-destructive hover:bg-muted"
        aria-label="Remove entry"
        onclick={() => removeRow(i)}
      >
        <TrashIcon class="w-3.5 h-3.5" aria-hidden="true" />
      </button>
    </div>
  {/each}
  <button
    {id}
    type="button"
    class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
    onclick={addRow}
  >
    <PlusIcon class="w-3.5 h-3.5" aria-hidden="true" />
    Add entry
  </button>
</div>
