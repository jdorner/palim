<script lang="ts">
/**
 * Type-aware input for a single cell. Emits raw values; the server coerces
 * them to the column type. Enter commits, Escape cancels, and with `onNavigate`
 * Tab / Shift+Tab commit and move to the next / previous cell, Arrow Up / Down
 * to the cell above / below (not in date and boolean inputs, which use the
 * arrow keys themselves).
 */
import { onMount } from "svelte";
import type { ColumnDef } from "../types";
import type { NavigateDirection } from "./api";

let {
  column,
  value,
  onCommit,
  onCancel,
  focusOnMount = false,
  commitOnBlur = true,
  onNavigate,
}: {
  column: ColumnDef;
  value: unknown;
  onCommit: (value: unknown) => void;
  onCancel?: () => void;
  focusOnMount?: boolean;
  commitOnBlur?: boolean;
  /** Called after a navigation commit with the cell to move to. */
  onNavigate?: (direction: NavigateDirection) => void;
} = $props();

/** Fits inside the grid's fixed row height (h-9), so editing never grows the row. */
const CLASS =
  "block h-7 w-full min-w-24 rounded-md border border-input bg-background px-2 py-0 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

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

/** Column types whose inputs use Arrow Up / Down themselves (date segments, select options). */
const OWN_ARROW_KEYS = new Set<ColumnDef["type"]>(["date", "datetime", "boolean"]);

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
  } else if (e.key === "Tab" && onNavigate) {
    e.preventDefault();
    commit();
    onNavigate(e.shiftKey ? "previous" : "next");
  } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && onNavigate && !OWN_ARROW_KEYS.has(column.type)) {
    e.preventDefault();
    commit();
    onNavigate(e.key === "ArrowUp" ? "up" : "down");
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
