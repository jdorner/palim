<script lang="ts">
/**
 * Data grid for one table: server-side paging, sorting, filtering, inline
 * editing, adding/deleting rows, truncation, and CSV/XLSX export. Refreshes
 * when the table changes elsewhere (e.g. a workflow run).
 */
import type { PalimHost } from "@ext/ui";
import { Badge, Button, Checkbox, LoadingIndicator } from "@palim/ui";
import ArrowLeftIcon from "phosphor-svelte/lib/ArrowLeftIcon";
import CaretDownIcon from "phosphor-svelte/lib/CaretDownIcon";
import CaretUpIcon from "phosphor-svelte/lib/CaretUpIcon";
import DownloadSimpleIcon from "phosphor-svelte/lib/DownloadSimpleIcon";
import FileArrowUpIcon from "phosphor-svelte/lib/FileArrowUpIcon";
import FunnelIcon from "phosphor-svelte/lib/FunnelIcon";
import GearIcon from "phosphor-svelte/lib/GearIcon";
import PlusIcon from "phosphor-svelte/lib/PlusIcon";
import TrashIcon from "phosphor-svelte/lib/TrashIcon";
import XIcon from "phosphor-svelte/lib/XIcon";
import { onMount } from "svelte";
import {
  type ColumnDef,
  FILTER_OP_LABELS,
  FILTER_OPS,
  type Filter,
  type FilterOp,
  type RowRecord,
  TABLE_CHANGED_EVENT,
  type TableChangedEvent,
  type TableDef,
  VALUELESS_OPS,
} from "../types";
import { displayValue, errorText, INPUT_CLASS, PAGE_ROUTE, queryParams, request } from "./api";
import CellInput from "./CellInput.svelte";

let { palim, name, canWrite }: { palim: PalimHost; name: string; canWrite: boolean } = $props();

const PAGE_SIZE = 50;

let table: (TableDef & { rowCount: number }) | null = $state(null);
let rows: RowRecord[] = $state([]);
let total = $state(0);
let offset = $state(0);
let sort: { column: string; desc: boolean } | undefined = $state();
let filters: Filter[] = $state([]);
let loading = $state(true);
let loadError: string | null = $state(null);
let selected = $state(new Set<number>());
let editing: { id: number; key: string } | null = $state(null);
let newRow: Record<string, unknown> | null = $state(null);
let showFilter = $state(false);
let filterDraft: { column: string; op: FilterOp; value: string } = $state({ column: "", op: "eq", value: "" });
let exportOpen = $state(false);
/** Set while this page deletes the table, so its own change event doesn't notify twice. */
let dropping = false;

const base = $derived(`/tables/${encodeURIComponent(name)}`);
const allSelected = $derived(rows.length > 0 && rows.every((r) => selected.has(r._id)));

async function loadTable() {
  table = (await request<{ table: TableDef & { rowCount: number } }>(palim, base)).table;
}

async function loadRows() {
  const params = queryParams(filters, sort);
  params.set("limit", String(PAGE_SIZE));
  params.set("offset", String(offset));
  const result = await request<{ rows: RowRecord[]; total: number }>(palim, `${base}/rows?${params}`);
  rows = result.rows;
  total = result.total;
  if (rows.length === 0 && offset > 0 && total > 0) {
    offset = Math.max(0, Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE);
    return loadRows();
  }
  selected = new Set([...selected].filter((id) => rows.some((r) => r._id === id)));
}

async function reload(withTable = false) {
  try {
    if (withTable || !table) await loadTable();
    await loadRows();
    loadError = null;
  } catch (err) {
    loadError = errorText(err);
  } finally {
    loading = false;
  }
}

onMount(() => {
  reload(true);
  return palim.onEvent((event, data) => {
    if (event !== TABLE_CHANGED_EVENT) return;
    const change = data as TableChangedEvent;
    if (change.table !== name) return;
    if (change.deleted) {
      if (dropping) return;
      palim.notify(`Table "${name}" was deleted`, "info");
      palim.navigate(PAGE_ROUTE);
      return;
    }
    // Don't yank the grid out from under an active edit.
    if (!editing && !newRow) reload(true);
  });
});

function toggleSort(column: string) {
  if (sort?.column !== column) sort = { column, desc: false };
  else if (!sort.desc) sort = { column, desc: true };
  else sort = undefined;
  offset = 0;
  reload();
}

function addFilter() {
  if (!filterDraft.column) return;
  const f: Filter = { column: filterDraft.column, op: filterDraft.op };
  if (!VALUELESS_OPS.includes(filterDraft.op)) f.value = filterDraft.value;
  filters = [...filters, f];
  filterDraft = { ...filterDraft, value: "" };
  offset = 0;
  reload();
}

function removeFilter(index: number) {
  filters = filters.filter((_, i) => i !== index);
  offset = 0;
  reload();
}

const columnLabel = (key: string) =>
  table?.columns.find((c) => c.key === key)?.label ??
  { _id: "ID", _createdAt: "Created", _updatedAt: "Updated" }[key] ??
  key;

async function saveCell(row: RowRecord, column: ColumnDef, value: unknown) {
  editing = null;
  const current = row[column.key];
  if ((current ?? null) === (value ?? null) || displayValue(column, current) === value) return;
  try {
    const { row: updated } = await request<{ row: RowRecord }>(palim, `${base}/rows/${row._id}`, {
      method: "PUT",
      body: { values: { [column.key]: value } },
    });
    rows = rows.map((r) => (r._id === updated._id ? updated : r));
  } catch (err) {
    palim.notify(errorText(err), "error");
  }
}

function startEdit(row: RowRecord, column: ColumnDef) {
  if (canWrite) editing = { id: row._id, key: column.key };
}

function startNewRow() {
  if (!table) return;
  newRow = Object.fromEntries(table.columns.map((c) => [c.key, c.default ?? null]));
}

async function saveNewRow() {
  if (!newRow) return;
  try {
    await request(palim, `${base}/rows`, { method: "POST", body: { rows: [newRow] } });
    newRow = null;
    palim.notify("Row added", "success");
    await reload(true);
  } catch (err) {
    palim.notify(errorText(err), "error");
  }
}

function toggleAll() {
  selected = allSelected ? new Set() : new Set(rows.map((r) => r._id));
}

function toggleRow(id: number) {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected = next;
}

async function deleteSelected() {
  const ids = [...selected];
  const ok = await palim.confirm({
    title: "Delete rows?",
    message: `${ids.length} row(s) will be deleted.`,
    confirmLabel: "Delete",
    destructive: true,
  });
  if (!ok) return;
  try {
    const { deleted } = await request<{ deleted: number }>(palim, `${base}/rows/delete`, {
      method: "POST",
      body: { ids },
    });
    selected = new Set();
    palim.notify(`${deleted} row(s) deleted`, "success");
    await reload(true);
  } catch (err) {
    palim.notify(errorText(err), "error");
  }
}

async function truncate() {
  const ok = await palim.confirm({
    title: "Delete all rows?",
    message: `All ${table?.rowCount ?? ""} rows of "${table?.label}" will be deleted. The columns are kept.`,
    confirmLabel: "Delete all",
    destructive: true,
  });
  if (!ok) return;
  try {
    const { deleted } = await request<{ deleted: number }>(palim, `${base}/truncate`, { method: "POST" });
    palim.notify(`${deleted} row(s) deleted`, "success");
    offset = 0;
    await reload(true);
  } catch (err) {
    palim.notify(errorText(err), "error");
  }
}

async function dropTable() {
  const ok = await palim.confirm({
    title: "Delete table?",
    message: `"${table?.label}" and all ${table?.rowCount ?? ""} rows will be deleted permanently. Workflows using it will fail.`,
    confirmLabel: "Delete table",
    destructive: true,
  });
  if (!ok) return;
  dropping = true;
  try {
    await request(palim, base, { method: "DELETE" });
    palim.notify(`Table "${table?.label ?? name}" deleted`, "success");
    palim.navigate(PAGE_ROUTE);
  } catch (err) {
    dropping = false;
    palim.notify(errorText(err), "error");
  }
}

async function exportFile(format: "csv" | "xlsx") {
  exportOpen = false;
  const params = queryParams(filters, sort);
  params.set("format", format);
  try {
    const res = await palim.fetch(`${base}/export?${params}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? `HTTP ${res.status}`);
    const disposition = res.headers.get("content-disposition") ?? "";
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `${name}.${format}`;
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    palim.notify(`Export failed: ${errorText(err)}`, "error");
  }
}

function page(delta: number) {
  offset = Math.max(0, offset + delta * PAGE_SIZE);
  reload();
}
</script>

<div class="flex flex-wrap items-center gap-2">
  <Button size="xs" variant="ghost" onclick={() => palim.navigate(PAGE_ROUTE)}>
    <ArrowLeftIcon size={12} class="mr-1" aria-hidden="true" />Tables
  </Button>
  {#if table}
    <h2 class="text-sm font-semibold">{table.label}</h2>
    <code class="text-xs text-muted-foreground">{table.name}</code>
    <Badge variant="secondary">{table.rowCount.toLocaleString()} rows</Badge>
    {#if table.keyColumn}
      <Badge variant="outline" title="Key column (used by upserts)">key: {table.keyColumn}</Badge>
    {/if}
  {/if}
</div>
{#if table?.description}
  <p class="text-xs text-muted-foreground">{table.description}</p>
{/if}

<div class="flex flex-wrap items-center gap-2">
  {#if canWrite}
    <Button size="xs" disabled={!table || newRow !== null} onclick={startNewRow}>
      <PlusIcon size={12} class="mr-1" aria-hidden="true" />Add row
    </Button>
  {/if}
  <Button size="xs" variant={filters.length > 0 ? "secondary" : "outline"} onclick={() => (showFilter = !showFilter)}>
    <FunnelIcon size={12} class="mr-1" aria-hidden="true" />Filter{filters.length > 0 ? ` (${filters.length})` : ""}
  </Button>
  <div class="relative">
    <Button size="xs" variant="outline" onclick={() => (exportOpen = !exportOpen)}>
      <DownloadSimpleIcon size={12} class="mr-1" aria-hidden="true" />Export
    </Button>
    {#if exportOpen}
      <div class="absolute left-0 top-7 z-20 min-w-40 rounded-md border border-border bg-background p-1 shadow-md">
        <button
          type="button"
          class="block w-full rounded px-2 py-1 text-left text-xs hover:bg-accent"
          onclick={() => exportFile("csv")}
        >
          CSV{filters.length > 0 ? " (filtered)" : ""}
        </button>
        <button
          type="button"
          class="block w-full rounded px-2 py-1 text-left text-xs hover:bg-accent"
          onclick={() => exportFile("xlsx")}
        >
          Excel (.xlsx){filters.length > 0 ? " (filtered)" : ""}
        </button>
      </div>
    {/if}
  </div>
  {#if canWrite}
    <Button
      size="xs"
      variant="outline"
      onclick={() => palim.navigate(`${PAGE_ROUTE}/import?table=${encodeURIComponent(name)}`)}
    >
      <FileArrowUpIcon size={12} class="mr-1" aria-hidden="true" />Import
    </Button>
    <Button
      size="xs"
      variant="outline"
      onclick={() => palim.navigate(`${PAGE_ROUTE}/t/${encodeURIComponent(name)}/schema`)}
    >
      <GearIcon size={12} class="mr-1" aria-hidden="true" />Columns
    </Button>
    <div class="ml-auto flex gap-2">
      {#if selected.size > 0}
        <Button size="xs" variant="destructive" onclick={deleteSelected}>
          <TrashIcon size={12} class="mr-1" aria-hidden="true" />Delete {selected.size}
        </Button>
      {/if}
      <Button size="xs" variant="ghost" class="text-destructive" disabled={!table?.rowCount} onclick={truncate}>
        Delete all rows
      </Button>
      <Button size="xs" variant="ghost" class="text-destructive" disabled={!table} onclick={dropTable}>
        Delete table
      </Button>
    </div>
  {/if}
</div>

{#if showFilter && table}
  <div class="flex flex-wrap items-end gap-2 rounded-md border border-border p-2">
    <select class="{INPUT_CLASS} w-auto" aria-label="Filter column" bind:value={filterDraft.column}>
      <option value="" disabled>Column…</option>
      {#each table.columns as col (col.key)}
        <option value={col.key}>{col.label}</option>
      {/each}
      <option value="_id">ID</option>
      <option value="_createdAt">Created</option>
      <option value="_updatedAt">Updated</option>
    </select>
    <select class="{INPUT_CLASS} w-auto" aria-label="Filter operator" bind:value={filterDraft.op}>
      {#each FILTER_OPS as op (op)}
        <option value={op}>{FILTER_OP_LABELS[op]}</option>
      {/each}
    </select>
    {#if !VALUELESS_OPS.includes(filterDraft.op)}
      <input
        class="{INPUT_CLASS} w-48"
        aria-label="Filter value"
        placeholder={filterDraft.op === "in" ? "a, b, c" : "Value"}
        bind:value={filterDraft.value}
        onkeydown={(e) => e.key === "Enter" && addFilter()}
      >
    {/if}
    <Button size="xs" disabled={!filterDraft.column} onclick={addFilter}>Add</Button>
  </div>
{/if}

{#if filters.length > 0}
  <div class="flex flex-wrap gap-1.5">
    {#each filters as f, i (i)}
      <span class="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs">
        <span class="font-medium">{columnLabel(f.column)}</span>
        <span class="text-muted-foreground">{FILTER_OP_LABELS[f.op]}</span>
        {#if f.value !== undefined}
          <span>{String(f.value)}</span>
        {/if}
        <button
          type="button"
          class="text-muted-foreground hover:text-foreground"
          aria-label="Remove filter"
          onclick={() => removeFilter(i)}
        >
          <XIcon size={10} />
        </button>
      </span>
    {/each}
  </div>
{/if}

{#if loading}
  <LoadingIndicator message="Loading rows..." />
{:else if loadError}
  <p class="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">{loadError}</p>
{:else if table}
  <div class="overflow-auto rounded-md border border-border">
    <table class="w-full whitespace-nowrap text-xs">
      <thead class="sticky top-0 z-10 bg-muted text-muted-foreground">
        <tr>
          {#if canWrite}
            <th class="w-8 px-2 py-1.5">
              <Checkbox aria-label="Select all" checked={allSelected} onCheckedChange={toggleAll} />
            </th>
          {/if}
          <th class="px-2 py-1.5 text-right font-medium">
            <button type="button" class="inline-flex items-center gap-0.5" onclick={() => toggleSort("_id")}>
              #
              {#if sort?.column === "_id"}
                {#if sort.desc}
                  <CaretDownIcon size={10} />
                {:else}
                  <CaretUpIcon size={10} />
                {/if}
              {/if}
            </button>
          </th>
          {#each table.columns as col (col.key)}
            <th
              class="px-2 py-1.5 font-medium {col.type === "number" || col.type === "integer"
                ? "text-right"
                : "text-left"}"
            >
              <button
                type="button"
                class="inline-flex items-center gap-0.5 hover:text-foreground"
                title="{col.key} ({col.type}){col.required ? ", required" : ""}{col.unique ? ", unique" : ""}"
                onclick={() => toggleSort(col.key)}
              >
                {col.label}
                {#if sort?.column === col.key}
                  {#if sort.desc}
                    <CaretDownIcon size={10} />
                  {:else}
                    <CaretUpIcon size={10} />
                  {/if}
                {/if}
              </button>
            </th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#if newRow}
          <tr class="border-t border-border bg-primary/5">
            <td class="px-2 py-1" colspan={canWrite ? 2 : 1}>
              <div class="flex gap-1">
                <Button size="xs" onclick={saveNewRow}>Save</Button>
                <Button size="xs" variant="ghost" onclick={() => (newRow = null)}>Cancel</Button>
              </div>
            </td>
            {#each table.columns as col, i (col.key)}
              <td class="px-1 py-1">
                <CellInput
                  column={col}
                  value={newRow[col.key]}
                  focusOnMount={i === 0}
                  commitOnBlur={false}
                  onCommit={(v) => {
                    if (newRow) newRow[col.key] = v;
                  }}
                  onCancel={() => (newRow = null)}
                />
              </td>
            {/each}
          </tr>
        {/if}
        {#each rows as row (row._id)}
          <tr class="border-t border-border hover:bg-muted/30 {selected.has(row._id) ? "bg-primary/5" : ""}">
            {#if canWrite}
              <td class="px-2 py-1">
                <Checkbox
                  aria-label="Select row"
                  checked={selected.has(row._id)}
                  onCheckedChange={() => toggleRow(row._id)}
                />
              </td>
            {/if}
            <td class="px-2 py-1 text-right tabular-nums text-muted-foreground">{row._id}</td>
            {#each table.columns as col (col.key)}
              {@const numeric = col.type === "number" || col.type === "integer"}
              <td
                class="max-w-72 px-2 py-1 {numeric ? "text-right tabular-nums" : ""} {canWrite ? "cursor-text" : ""}"
                ondblclick={() => startEdit(row, col)}
              >
                {#if editing?.id === row._id && editing.key === col.key}
                  <CellInput
                    column={col}
                    value={row[col.key]}
                    focusOnMount
                    onCommit={(v) => saveCell(row, col, v)}
                    onCancel={() => (editing = null)}
                  />
                {:else if row[col.key] === null || row[col.key] === undefined}
                  <span class="text-muted-foreground/50">-</span>
                {:else}
                  <span class="block truncate" title={displayValue(col, row[col.key])}
                    >{displayValue(col, row[col.key])}</span
                  >
                {/if}
              </td>
            {/each}
          </tr>
        {:else}
          {#if !newRow}
            <tr>
              <td
                class="px-2 py-8 text-center text-muted-foreground"
                colspan={table.columns.length + (canWrite ? 2 : 1)}
              >
                {filters.length > 0 ? "No rows match the filters." : "No rows yet."}
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  </div>

  <div class="flex items-center justify-between text-xs text-muted-foreground">
    <span>
      {#if total > 0}
        {offset + 1}–{Math.min(offset + PAGE_SIZE, total)}
        of {total.toLocaleString()}{filters.length > 0 ? " matching" : ""}
      {/if}
      {#if canWrite}
        <span class="ml-2">Double-click a cell to edit.</span>
      {/if}
    </span>
    <div class="flex gap-1">
      <Button size="xs" variant="outline" disabled={offset === 0} onclick={() => page(-1)}>Previous</Button>
      <Button size="xs" variant="outline" disabled={offset + PAGE_SIZE >= total} onclick={() => page(1)}>Next</Button>
    </div>
  </div>
{/if}
