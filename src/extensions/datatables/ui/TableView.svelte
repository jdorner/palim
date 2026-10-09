<script lang="ts">
/**
 * Data grid for one table: server-side paging, sorting, filtering, inline
 * editing, adding/deleting rows, truncation, and CSV/XLSX export. Refreshes
 * when the table changes elsewhere (e.g. a workflow run).
 */
import type { PalimHost } from "@ext/ui";
import {
  Badge,
  Button,
  Checkbox,
  LoadingIndicator,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@palim/ui";
import CaretDownIcon from "phosphor-svelte/lib/CaretDownIcon";
import CaretLeftIcon from "phosphor-svelte/lib/CaretLeftIcon";
import CaretRightIcon from "phosphor-svelte/lib/CaretRightIcon";
import CaretUpIcon from "phosphor-svelte/lib/CaretUpIcon";
import DownloadSimpleIcon from "phosphor-svelte/lib/DownloadSimpleIcon";
import EraserIcon from "phosphor-svelte/lib/EraserIcon";
import FileArrowUpIcon from "phosphor-svelte/lib/FileArrowUpIcon";
import FunnelIcon from "phosphor-svelte/lib/FunnelIcon";
import PencilSimpleIcon from "phosphor-svelte/lib/PencilSimpleIcon";
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
import { displayValue, errorText, INPUT_CLASS, type NavigateDirection, PAGE_ROUTE, queryParams, request } from "./api";
import CellInput from "./CellInput.svelte";

let { palim, name, canWrite }: { palim: PalimHost; name: string; canWrite: boolean } = $props();

const PAGE_SIZE = 50;
/** Fixed row height, so checking a row or editing a cell never changes it. */
const ROW_CLASS = "h-9";
const CELL_CLASS = "px-3 py-0";

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

const isNumeric = (col: ColumnDef) => col.type === "number" || col.type === "integer";

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

/**
 * Moves the cell editor after a keyboard commit: next / previous column
 * (wrapping to the adjacent row) or the same column one row up / down, within
 * the current page. Stops at the edges.
 */
function moveEdit(row: RowRecord, column: ColumnDef, direction: NavigateDirection) {
  if (!table) return;
  const columns = table.columns;
  let r = rows.findIndex((x) => x._id === row._id);
  let c = columns.findIndex((x) => x.key === column.key);
  if (direction === "up" || direction === "down") {
    r += direction === "up" ? -1 : 1;
  } else {
    const step = direction === "next" ? 1 : -1;
    c += step;
    if (c < 0 || c >= columns.length) {
      r += step;
      c = step === 1 ? 0 : columns.length - 1;
    }
  }
  const target = rows[r];
  const targetColumn = columns[c];
  if (target && targetColumn) editing = { id: target._id, key: targetColumn.key };
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

const currentPage = $derived(Math.floor(offset / PAGE_SIZE) + 1);
const totalPages = $derived(Math.max(1, Math.ceil(total / PAGE_SIZE)));

function goToPage(n: number) {
  offset = (Math.min(Math.max(n, 1), totalPages) - 1) * PAGE_SIZE;
  reload();
}
</script>

{#snippet cellValue(
  row: RowRecord,
  col: ColumnDef,
)}
  {#if row[col.key] === null || row[col.key] === undefined}
    <span class="text-muted-foreground/50">-</span>
  {:else}
    <span class="block max-w-72 truncate" title={displayValue(col, row[col.key])}
      >{displayValue(col, row[col.key])}</span
    >
  {/if}
{/snippet}

<div class="flex min-h-0 flex-1 flex-col gap-3">
  <div class="flex shrink-0 flex-wrap items-center justify-between gap-2">
    <div class="flex min-w-0 items-center gap-3">
      <Button size="sm" variant="outline" onclick={() => palim.navigate(PAGE_ROUTE)}>&laquo;&nbsp;Back</Button>
      {#if table}
        <h2 class="truncate text-lg font-semibold">{table.label}</h2>
        <code class="hidden text-xs text-muted-foreground sm:inline">{table.name}</code>
        <Badge variant="secondary">{table.rowCount.toLocaleString()} rows</Badge>
        {#if table.keyColumn}
          <Badge variant="outline" title="Key column (used by upserts)">key: {table.keyColumn}</Badge>
        {/if}
      {/if}
    </div>
    {#if canWrite}
      <Button size="sm" disabled={!table || newRow !== null} onclick={startNewRow}>
        <PlusIcon size={14} class="mr-1.5" aria-hidden="true" />Add row
      </Button>
    {/if}
  </div>
  {#if table?.description}
    <p class="shrink-0 text-sm text-muted-foreground">{table.description}</p>
  {/if}

  <div class="flex shrink-0 flex-wrap items-center gap-2">
    <Button size="sm" variant={filters.length > 0 ? "secondary" : "outline"} onclick={() => (showFilter = !showFilter)}>
      <FunnelIcon size={14} class="mr-1.5" aria-hidden="true" />Filter{filters.length > 0 ? ` (${filters.length})` : ""}
    </Button>
    <div class="relative">
      <Button size="sm" variant="outline" onclick={() => (exportOpen = !exportOpen)}>
        <DownloadSimpleIcon size={14} class="mr-1.5" aria-hidden="true" />Export
      </Button>
      {#if exportOpen}
        <div class="absolute left-0 top-10 z-20 min-w-44 rounded-md border border-border bg-background p-1 shadow-md">
          <button
            type="button"
            class="block w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
            onclick={() => exportFile("csv")}
          >
            CSV{filters.length > 0 ? " (filtered)" : ""}
          </button>
          <button
            type="button"
            class="block w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
            onclick={() => exportFile("xlsx")}
          >
            Excel (.xlsx){filters.length > 0 ? " (filtered)" : ""}
          </button>
        </div>
      {/if}
    </div>
    {#if canWrite}
      <Button
        size="sm"
        variant="outline"
        onclick={() => palim.navigate(`${PAGE_ROUTE}/import?table=${encodeURIComponent(name)}`)}
      >
        <FileArrowUpIcon size={14} class="mr-1.5" aria-hidden="true" />Import
      </Button>
      <Button
        size="sm"
        variant="outline"
        onclick={() => palim.navigate(`${PAGE_ROUTE}/t/${encodeURIComponent(name)}/schema`)}
      >
        <PencilSimpleIcon size={14} class="mr-1.5" aria-hidden="true" />Edit table
      </Button>
      <div class="ml-auto flex flex-wrap gap-1">
        {#if selected.size > 0}
          <Button size="sm" variant="destructive" onclick={deleteSelected}>
            <TrashIcon size={14} class="mr-1.5" aria-hidden="true" />Delete {selected.size}
          </Button>
        {/if}
        <Button
          size="sm"
          variant="ghost"
          class="text-destructive hover:text-destructive"
          disabled={!table?.rowCount}
          onclick={truncate}
        >
          <EraserIcon size={14} class="mr-1.5" aria-hidden="true" />Delete all rows
        </Button>
        <Button
          size="sm"
          variant="ghost"
          class="text-destructive hover:text-destructive"
          disabled={!table}
          onclick={dropTable}
        >
          <TrashIcon size={14} class="mr-1.5" aria-hidden="true" />Delete table
        </Button>
      </div>
    {/if}
  </div>

  {#if showFilter && table}
    <div class="flex shrink-0 flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 p-2">
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
          class="{INPUT_CLASS} w-56"
          aria-label="Filter value"
          placeholder={filterDraft.op === "in" ? "a, b, c" : "Value"}
          bind:value={filterDraft.value}
          onkeydown={(e) => e.key === "Enter" && addFilter()}
        >
      {/if}
      <Button size="sm" disabled={!filterDraft.column} onclick={addFilter}>Add filter</Button>
    </div>
  {/if}

  {#if filters.length > 0}
    <div class="flex shrink-0 flex-wrap gap-1.5">
      {#each filters as f, i (i)}
        <span
          class="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2.5 py-0.5 text-xs"
        >
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
            <XIcon size={12} />
          </button>
        </span>
      {/each}
    </div>
  {/if}

  {#if loading}
    <LoadingIndicator message="Loading rows..." />
  {:else if loadError}
    <p class="shrink-0 rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">{loadError}</p>
  {:else if table}
    <!-- Own scroll box (both axes) so the scrollbars stay inside the border and the header can stick. -->
    <div class="min-h-0 overflow-auto rounded-md border border-border">
      <table class="w-full whitespace-nowrap text-sm">
        <TableHeader class="sticky top-0 z-10 bg-muted">
          <TableRow class="hover:bg-transparent">
            {#if canWrite}
              <TableHead class="w-10">
                <div class="flex items-center">
                  <Checkbox aria-label="Select all" checked={allSelected} onCheckedChange={toggleAll} />
                </div>
              </TableHead>
            {/if}
            <TableHead class="text-right">
              <button
                type="button"
                class="inline-flex items-center gap-1 hover:text-foreground"
                onclick={() => toggleSort("_id")}
              >
                #
                {#if sort?.column === "_id"}
                  {#if sort.desc}
                    <CaretDownIcon size={12} />
                  {:else}
                    <CaretUpIcon size={12} />
                  {/if}
                {/if}
              </button>
            </TableHead>
            {#each table.columns as col (col.key)}
              <TableHead class={isNumeric(col) ? "text-right" : ""}>
                <button
                  type="button"
                  class="inline-flex items-center gap-1 hover:text-foreground"
                  title="{col.key} ({col.type}){col.required ? ", required" : ""}{col.unique ? ", unique" : ""}"
                  onclick={() => toggleSort(col.key)}
                >
                  {col.label}
                  {#if sort?.column === col.key}
                    {#if sort.desc}
                      <CaretDownIcon size={12} />
                    {:else}
                      <CaretUpIcon size={12} />
                    {/if}
                  {/if}
                </button>
              </TableHead>
            {/each}
          </TableRow>
        </TableHeader>
        <TableBody>
          {#if newRow}
            <TableRow class="{ROW_CLASS} bg-primary/5 hover:bg-primary/5">
              <TableCell class={CELL_CLASS} colspan={canWrite ? 2 : 1}>
                <div class="flex gap-1">
                  <Button size="xs" onclick={saveNewRow}>Save</Button>
                  <Button size="xs" variant="ghost" onclick={() => (newRow = null)}>Cancel</Button>
                </div>
              </TableCell>
              {#each table.columns as col, i (col.key)}
                <TableCell class={CELL_CLASS}>
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
                </TableCell>
              {/each}
            </TableRow>
          {/if}
          {#each rows as row (row._id)}
            <TableRow class="{ROW_CLASS} {selected.has(row._id) ? "bg-muted" : ""}">
              {#if canWrite}
                <TableCell class={CELL_CLASS}>
                  <div class="flex items-center">
                    <Checkbox
                      aria-label="Select row"
                      checked={selected.has(row._id)}
                      onCheckedChange={() => toggleRow(row._id)}
                    />
                  </div>
                </TableCell>
              {/if}
              <TableCell class="{CELL_CLASS} text-right tabular-nums text-muted-foreground">{row._id}</TableCell>
              {#each table.columns as col (col.key)}
                <TableCell
                  class="{CELL_CLASS} relative {isNumeric(col) ? "text-right tabular-nums" : ""} {canWrite
                    ? "cursor-text"
                    : ""}"
                  ondblclick={() => startEdit(row, col)}
                >
                  {#if editing?.id === row._id && editing.key === col.key}
                    <!--
                      The editor floats over the cell instead of sitting in it: an
                      input's intrinsic width would otherwise widen the column and
                      reflow the whole table. The hidden value keeps the cell's size.
                    -->
                    <span class="invisible">{@render cellValue(row, col)}</span>
                    <div class="absolute inset-y-0 left-1 right-1 z-5 flex min-w-24 items-center">
                      <CellInput
                        column={col}
                        value={row[col.key]}
                        focusOnMount
                        onCommit={(v) => saveCell(row, col, v)}
                        onCancel={() => (editing = null)}
                        onNavigate={(direction) => moveEdit(row, col, direction)}
                      />
                    </div>
                  {:else}
                    {@render cellValue(row, col)}
                  {/if}
                </TableCell>
              {/each}
            </TableRow>
          {:else}
            {#if !newRow}
              <TableRow class="hover:bg-transparent">
                <TableCell
                  class="py-8 text-center text-muted-foreground"
                  colspan={table.columns.length + (canWrite ? 2 : 1)}
                >
                  {filters.length > 0 ? "No rows match the filters." : "No rows yet."}
                </TableCell>
              </TableRow>
            {/if}
          {/each}
        </TableBody>
      </table>
    </div>

    <div class="flex shrink-0 flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
      <span>
        {#if total > 0}
          {offset + 1}–{Math.min(offset + PAGE_SIZE, total)}
          of {total.toLocaleString()}{filters.length > 0 ? " matching" : ""}
        {/if}
        {#if canWrite}
          <span class="ml-2 text-xs">Double-click a cell to edit.</span>
        {/if}
      </span>
      {#if totalPages > 1}
        <nav class="flex items-center gap-2" aria-label="Pagination">
          <Button
            size="xs"
            variant="outline"
            disabled={currentPage <= 1}
            onclick={() => goToPage(1)}
            aria-label="First page"
          >
            <CaretLeftIcon size={14} aria-hidden="true" /><CaretLeftIcon size={14} class="-ml-1.5" aria-hidden="true" />
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={currentPage <= 1}
            onclick={() => goToPage(currentPage - 1)}
            aria-label="Previous page"
          >
            <CaretLeftIcon size={14} aria-hidden="true" />
          </Button>
          <span class="text-sm text-muted-foreground">Page {currentPage} of {totalPages}</span>
          <Button
            size="xs"
            variant="outline"
            disabled={currentPage >= totalPages}
            onclick={() => goToPage(currentPage + 1)}
            aria-label="Next page"
          >
            <CaretRightIcon size={14} aria-hidden="true" />
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={currentPage >= totalPages}
            onclick={() => goToPage(totalPages)}
            aria-label="Last page"
          >
            <CaretRightIcon size={14} aria-hidden="true" />
            <CaretRightIcon size={14} class="-ml-1.5" aria-hidden="true" />
          </Button>
        </nav>
      {/if}
    </div>
  {/if}
</div>
