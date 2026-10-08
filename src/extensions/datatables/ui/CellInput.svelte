<script lang="ts">
/**
 * Type-aware input for a single cell. Emits raw values; the server coerces
 * them to the column type. Enter commits, Escape cancels.
 */
import { onMount } from "svelte";
import type { ColumnDef } from "../types";

let {
  column,
  value,
  onCommit,
  onCancel,
  focusOnMount = false,
  commitOnBlur = true,
}: {
  column: ColumnDef;
  value: unknown;
  onCommit: (value: unknown) => void;
  onCancel?: () => void;
  focusOnMount?: boolean;
  commitOnBlur?: boolean;
} = $props();

const CLASS =
  "w-full min-w-24 rounded border border-input bg-background px-1.5 py-0.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring";

/** ISO date-time → `datetime-local` value (local time). */
function toLocalInput(iso: unknown): string {
  if (typeof iso !== "string" || !iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function initial(): string {
  if (value === null || value === undefined) return "";
  if (column.type === "datetime") return toLocalInput(value);
  if (column.type === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

let draft = $state(initial());
let el: HTMLInputElement | HTMLSelectElement | undefined = $state();
let done = false;

onMount(() => {
  if (focusOnMount) el?.focus();
});

function commit() {
  if (done) return;
  done = true;
  if (draft === "") return onCommit(null);
  if (column.type === "datetime") {
    const d = new Date(draft);
    return onCommit(Number.isNaN(d.getTime()) ? draft : d.toISOString());
  }
  onCommit(draft);
}

function onkeydown(e: KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
    commit();
  } else if (e.key === "Escape") {
    e.preventDefault();
    done = true;
    onCancel?.();
  }
}

/** Keeps the parent informed without committing (used by the new-row form). */
function oninput() {
  if (!commitOnBlur) onCommit(draft === "" ? null : column.type === "datetime" ? new Date(draft).toISOString() : draft);
}

const onblur = () => {
  if (commitOnBlur) commit();
};
</script>

{#if column.type === "boolean"}
  <select
    bind:this={el}
    class={CLASS}
    aria-label={column.label}
    bind:value={draft}
    onchange={() => (commitOnBlur ? commit() : oninput())}
    {onkeydown}
    {onblur}
  >
    <option value=""></option>
    <option value="true">✓ true</option>
    <option value="false">✗ false</option>
  </select>
{:else}
  <input
    bind:this={el}
    class="{CLASS} {column.type === "number" || column.type === "integer" ? "text-right tabular-nums" : ""}"
    aria-label={column.label}
    type={column.type === "date" ? "date" : column.type === "datetime" ? "datetime-local" : "text"}
    inputmode={column.type === "integer" ? "numeric" : column.type === "number" ? "decimal" : undefined}
    bind:value={draft}
    {oninput}
    {onkeydown}
    {onblur}
  >
{/if}
