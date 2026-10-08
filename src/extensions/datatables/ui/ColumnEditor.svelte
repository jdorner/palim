<script lang="ts">
/**
 * Editable column list: label, key, type, flags, default, key column, order.
 * With `headers`, each column also picks its source column from an imported file.
 */
import { Button, Checkbox } from "@palim/ui";
import ArrowDownIcon from "phosphor-svelte/lib/ArrowDownIcon";
import ArrowUpIcon from "phosphor-svelte/lib/ArrowUpIcon";
import PlusIcon from "phosphor-svelte/lib/PlusIcon";
import TrashIcon from "phosphor-svelte/lib/TrashIcon";
import { COLUMN_TYPE_LABELS, COLUMN_TYPES, MAX_COLUMNS, slugify } from "../types";
import { type EditableColumn, INPUT_CLASS, nextUid } from "./api";

let {
  columns = $bindable(),
  keyColumn = $bindable(),
  headers,
}: {
  columns: EditableColumn[];
  keyColumn: string;
  /** File headers (import mode): adds a "Source" column. */
  headers?: string[];
} = $props();

const keyOf = (label: string, index: number) => {
  const base = slugify(label);
  return /^[a-z]/.test(base) ? base : base ? `c_${base}` : `column_${index + 1}`;
};

function setLabel(col: EditableColumn, index: number, label: string) {
  const wasKey = keyColumn === col.key;
  col.label = label;
  if (col.autoKey) {
    col.key = keyOf(label, index);
    if (wasKey) keyColumn = col.key;
  }
}

function setKey(col: EditableColumn, key: string) {
  const wasKey = keyColumn === col.key;
  col.key = key;
  col.autoKey = false;
  if (wasKey) keyColumn = key;
}

function add() {
  const index = columns.length;
  columns.push({ uid: nextUid(), key: `column_${index + 1}`, label: "", type: "text", autoKey: true, source: null });
}

function remove(index: number) {
  const [removed] = columns.splice(index, 1);
  if (removed && removed.key === keyColumn) keyColumn = "";
}

function move(index: number, delta: number) {
  const target = index + delta;
  if (target < 0 || target >= columns.length) return;
  const [col] = columns.splice(index, 1);
  if (col) columns.splice(target, 0, col);
}

const duplicateKeys = $derived(new Set(columns.map((c) => c.key).filter((key, i, all) => all.indexOf(key) !== i)));
</script>

<div class="overflow-x-auto rounded-md border border-border">
  <table class="w-full text-sm">
    <thead class="bg-muted/50 text-xs text-muted-foreground">
      <tr>
        {#if headers}
          <th class="px-2 py-1.5 text-left font-medium">Source</th>
        {/if}
        <th class="px-2 py-1.5 text-left font-medium">Label</th>
        <th class="px-2 py-1.5 text-left font-medium">Key</th>
        <th class="px-2 py-1.5 text-left font-medium">Type</th>
        <th class="px-2 py-1.5 font-medium" title="Value required">Req.</th>
        <th class="px-2 py-1.5 font-medium" title="Values must be unique">Uniq.</th>
        <th class="px-2 py-1.5 font-medium" title="Identifies a row for upserts">Key</th>
        <th class="px-2 py-1.5 text-left font-medium">Default</th>
        <th class="px-2 py-1.5"></th>
      </tr>
    </thead>
    <tbody>
      {#each columns as col, i (col.uid)}
        <tr class="border-t border-border align-middle">
          {#if headers}
            <td class="px-2 py-1">
              <select
                class={INPUT_CLASS}
                aria-label="Source column"
                value={col.source ?? ""}
                onchange={(e) => (col.source = e.currentTarget.value === "" ? null : Number(e.currentTarget.value))}
              >
                <option value="">(empty)</option>
                {#each headers as header, h (h)}
                  <option value={h}>{header}</option>
                {/each}
              </select>
            </td>
          {/if}
          <td class="px-2 py-1">
            <input
              class={INPUT_CLASS}
              aria-label="Column label"
              placeholder="Label"
              value={col.label}
              oninput={(e) => setLabel(col, i, e.currentTarget.value)}
            >
          </td>
          <td class="px-2 py-1">
            <input
              class="{INPUT_CLASS} font-mono {duplicateKeys.has(col.key) || !/^[a-z][a-z0-9_]*$/.test(col.key)
                ? "border-destructive"
                : ""}"
              aria-label="Column key"
              value={col.key}
              title={col.originalKey && col.originalKey !== col.key ? `Renamed from ${col.originalKey}` : undefined}
              oninput={(e) => setKey(col, e.currentTarget.value)}
            >
          </td>
          <td class="px-2 py-1">
            <select class={INPUT_CLASS} aria-label="Column type" bind:value={col.type}>
              {#each COLUMN_TYPES as type (type)}
                <option value={type}>{COLUMN_TYPE_LABELS[type]}</option>
              {/each}
            </select>
          </td>
          <td class="px-2 py-1 text-center">
            <Checkbox
              aria-label="Required"
              checked={col.required === true || keyColumn === col.key}
              disabled={keyColumn === col.key}
              onCheckedChange={(v) => (col.required = v === true)}
            />
          </td>
          <td class="px-2 py-1 text-center">
            <Checkbox
              aria-label="Unique"
              checked={col.unique === true || keyColumn === col.key}
              disabled={keyColumn === col.key}
              onCheckedChange={(v) => (col.unique = v === true)}
            />
          </td>
          <td class="px-2 py-1 text-center">
            <input
              type="radio"
              name="key-column"
              aria-label="Key column"
              checked={keyColumn === col.key}
              onclick={() => (keyColumn = keyColumn === col.key ? "" : col.key)}
            >
          </td>
          <td class="px-2 py-1">
            <input
              class={INPUT_CLASS}
              aria-label="Default value"
              placeholder={col.type === "boolean" ? "true / false" : ""}
              value={col.default === undefined || col.default === null ? "" : String(col.default)}
              oninput={(e) => (col.default = e.currentTarget.value === "" ? undefined : e.currentTarget.value)}
            >
          </td>
          <td class="whitespace-nowrap px-1 py-1 text-right">
            <button
              type="button"
              class="rounded p-1 text-muted-foreground hover:bg-accent disabled:opacity-30"
              aria-label="Move up"
              disabled={i === 0}
              onclick={() => move(i, -1)}
            >
              <ArrowUpIcon size={14} />
            </button>
            <button
              type="button"
              class="rounded p-1 text-muted-foreground hover:bg-accent disabled:opacity-30"
              aria-label="Move down"
              disabled={i === columns.length - 1}
              onclick={() => move(i, 1)}
            >
              <ArrowDownIcon size={14} />
            </button>
            <button
              type="button"
              class="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              aria-label="Remove column"
              onclick={() => remove(i)}
            >
              <TrashIcon size={14} />
            </button>
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>
<div class="flex items-center justify-between">
  <Button size="xs" variant="outline" disabled={columns.length >= MAX_COLUMNS} onclick={add}>
    <PlusIcon size={12} class="mr-1" aria-hidden="true" />Add column
  </Button>
  {#if duplicateKeys.size > 0}
    <span class="text-xs text-destructive">Duplicate keys: {[...duplicateKeys].join(", ")}</span>
  {/if}
</div>
