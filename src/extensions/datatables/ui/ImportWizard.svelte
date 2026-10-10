<script lang="ts">
/**
 * Imports a CSV/XLSX file into a new table (schema derived from the file and
 * editable before creation) or into an existing table (append or replace,
 * with a file-column → table-column mapping).
 */
import type { PalimHost } from "@ext/ui";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  Checkbox,
  LoadingIndicator,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@palim/ui";
import { onMount } from "svelte";
import { type ImportPreview, type ImportResult, slugify, type TableSummary } from "../types";
import { type EditableColumn, errorText, INPUT_CLASS, PAGE_ROUTE, request, toColumnDefs, toEditable } from "./api";
import ColumnEditor from "./ColumnEditor.svelte";

let { palim, initialTable = "" }: { palim: PalimHost; initialTable?: string } = $props();
const i18n = palim.i18n;

let tables: TableSummary[] = $state([]);
let file: File | null = $state(null);
let headerRow = $state(true);
let sheet = $state("");
let preview: ImportPreview | null = $state(null);
let previewing = $state(false);
let importing = $state(false);
let error: string | null = $state(null);
let result: ImportResult | null = $state(null);

// Target
let target = $state(initialTable); // "" = new table
let mode: "append" | "replace" = $state("append");
// New table
let tableName = $state("");
let label = $state("");
let columns: EditableColumn[] = $state([]);
let keyColumn = $state("");
// Existing table: column key -> header index
let mapping: Record<string, number | null> = $state({});

const targetTable = $derived(tables.find((t) => t.name === target));

onMount(async () => {
  try {
    tables = (await request<{ tables: TableSummary[] }>(palim, "/tables")).tables;
  } catch (err) {
    error = errorText(err);
  }
});

function defaultMapping(headers: string[], table: TableSummary): Record<string, number | null> {
  const norm = (s: string) => s.trim().toLowerCase();
  const result: Record<string, number | null> = {};
  for (const col of table.columns) {
    const index = headers.findIndex(
      (h) => norm(h) === norm(col.label) || norm(h) === col.key || slugify(h) === col.key,
    );
    result[col.key] = index === -1 ? null : index;
  }
  return result;
}

$effect(() => {
  if (preview && targetTable) mapping = defaultMapping(preview.headers, targetTable);
});

async function loadPreview() {
  if (!file) return;
  previewing = true;
  error = null;
  result = null;
  try {
    const form = new FormData();
    form.set("file", file);
    form.set("headerRow", String(headerRow));
    if (sheet) form.set("sheet", sheet);
    const p = await request<ImportPreview>(palim, "/import/preview", { method: "POST", body: form });
    preview = p;
    sheet = p.sheet;
    columns = toEditable(p.columns, false);
    keyColumn = "";
  } catch (err) {
    preview = null;
    error = errorText(err);
  } finally {
    previewing = false;
  }
}

function onFile(e: Event) {
  file = (e.currentTarget as HTMLInputElement).files?.[0] ?? null;
  sheet = "";
  if (file && !tableName) {
    const base = file.name.replace(/\.[^.]+$/, "");
    tableName = slugify(base).replace(/^[^a-z]+/, "") || "imported";
    label = base;
  }
  loadPreview();
}

async function runImport() {
  if (!file || !preview) return;
  importing = true;
  error = null;
  try {
    let options: Record<string, unknown>;
    if (target) {
      const m = Object.fromEntries(Object.entries(mapping).filter(([, v]) => v !== null));
      if (Object.keys(m).length === 0) throw new Error(i18n.current.t("import.mapAtLeastOne"));
      if (mode === "replace") {
        const ok = await palim.confirm({
          title: i18n.current.t("import.replaceTitle"),
          message: i18n.current.t("import.replaceMessage", {
            count: targetTable?.rowCount ?? 0,
            label: targetTable?.label,
          }),
          confirmLabel: i18n.current.t("import.replace"),
          destructive: true,
        });
        if (!ok) return;
      }
      options = { mode, table: target, mapping: m };
    } else {
      options = {
        mode: "create",
        table: tableName,
        label,
        columns: toColumnDefs(columns),
        keyColumn: keyColumn || undefined,
        mapping: Object.fromEntries(columns.filter((c) => c.source != null).map((c) => [c.key.trim(), c.source])),
      };
    }
    options.headerRow = headerRow;
    if (preview.sheets.length > 1) options.sheet = sheet;
    const form = new FormData();
    form.set("file", file);
    form.set("options", JSON.stringify(options));
    result = await request<ImportResult>(palim, "/import", { method: "POST", body: form });
    palim.notify(i18n.current.t("import.imported", { count: result.inserted }), "success");
  } catch (err) {
    error = errorText(err);
  } finally {
    importing = false;
  }
}

const back = () => palim.navigate(initialTable ? `${PAGE_ROUTE}/t/${encodeURIComponent(initialTable)}` : PAGE_ROUTE);
</script>

<div class="flex items-center gap-3">
  <Button size="sm" variant="outline" onclick={back}>&laquo;&nbsp;{$i18n.t("back")}</Button>
  <h2 class="text-lg font-semibold">{$i18n.t("import.title")}</h2>
</div>

{#if result}
  <Card>
    <CardContent class="space-y-3 pt-4 text-sm">
      <p>
        {$i18n.t("import.resultImported", { count: result.inserted })}
        <code>{result.table}</code>.
        {#if result.skippedCount > 0}
          <span class="text-destructive">{$i18n.t("import.skipped", { count: result.skippedCount })}</span>
        {/if}
      </p>
      {#if result.skipped.length > 0}
        <ul class="max-h-48 list-inside list-disc overflow-auto text-xs text-muted-foreground">
          {#each result.skipped as row (row.index)}
            <li>{$i18n.t("import.dataRow", { index: row.index + 1, errors: row.errors.join("; ") })}</li>
          {/each}
          {#if result.skippedCount > result.skipped.length}
            <li>{$i18n.t("form.andMore", { count: result.skippedCount - result.skipped.length })}</li>
          {/if}
        </ul>
      {/if}
      <div class="flex gap-2">
        <Button
          size="sm"
          onclick={() => result && palim.navigate(`${PAGE_ROUTE}/t/${encodeURIComponent(result.table)}`)}
        >
          {$i18n.t("import.openTable")}
        </Button>
        <Button size="sm" variant="outline" onclick={() => (result = null)}>{$i18n.t("import.another")}</Button>
      </div>
    </CardContent>
  </Card>
{:else}
  <Card>
    <CardHeader class="pb-2"><span class="text-sm font-medium">{$i18n.t("import.stepFile")}</span></CardHeader>
    <CardContent class="flex flex-wrap items-center gap-4">
      <input
        type="file"
        accept=".csv,.tsv,.txt,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        class="text-sm file:mr-3 file:h-9 file:cursor-pointer file:rounded-md file:border file:border-input file:bg-background file:px-3 file:text-sm file:font-medium hover:file:bg-accent"
        onchange={onFile}
      >
      <div class="flex h-9 items-center gap-2">
        <Checkbox
          id="dt-header-row"
          checked={headerRow}
          onCheckedChange={(v) => {
            headerRow = v === true;
            loadPreview();
          }}
        />
        <label for="dt-header-row" class="text-sm">{$i18n.t("import.headerRow")}</label>
      </div>
      {#if preview && preview.sheets.length > 1}
        <label class="flex items-center gap-2 text-sm">
          {$i18n.t("import.sheet")}
          <select class="{INPUT_CLASS} w-auto" bind:value={sheet} onchange={loadPreview}>
            {#each preview.sheets as s (s)}
              <option value={s}>{s}</option>
            {/each}
          </select>
        </label>
      {/if}
    </CardContent>
  </Card>

  {#if previewing}
    <LoadingIndicator message={$i18n.t("import.reading")} />
  {:else if preview}
    <Card>
      <CardHeader class="pb-2">
        <span class="text-sm font-medium">{$i18n.t("import.preview")}</span>
        <span class="text-xs text-muted-foreground">
          {$i18n.t(preview.sampleRows.length < preview.totalRows ? "import.previewShowing" : "import.previewStats", {
            rows: $i18n.format.number(preview.totalRows),
            columns: preview.headers.length,
            shown: preview.sampleRows.length,
          })}
        </span>
      </CardHeader>
      <CardContent>
        <div class="max-h-72 overflow-auto rounded-md border border-border">
          <table class="w-full whitespace-nowrap text-sm">
            <TableHeader class="sticky top-0 z-10 bg-muted">
              <TableRow class="hover:bg-transparent">
                {#each preview.headers as h, i (i)}
                  <TableHead>{h}</TableHead>
                {/each}
              </TableRow>
            </TableHeader>
            <TableBody>
              {#each preview.sampleRows.slice(0, 20) as row, r (r)}
                <TableRow class="h-9">
                  {#each row as cell, c (c)}
                    <TableCell class="px-3 py-0"><span class="block max-w-56 truncate">{cell}</span></TableCell>
                  {/each}
                </TableRow>
              {/each}
            </TableBody>
          </table>
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader class="pb-2"><span class="text-sm font-medium">{$i18n.t("import.stepTarget")}</span></CardHeader>
      <CardContent class="space-y-3">
        <div class="flex flex-wrap items-end gap-3">
          <label class="space-y-1 text-xs font-medium text-muted-foreground">
            <span class="block">{$i18n.t("import.into")}</span>
            <select class="{INPUT_CLASS} w-64" bind:value={target}>
              <option value="">{$i18n.t("import.newTable")}</option>
              {#each tables as t (t.name)}
                <option value={t.name}>{t.label} ({t.name})</option>
              {/each}
            </select>
          </label>
          {#if target}
            <label class="space-y-1 text-xs font-medium text-muted-foreground">
              <span class="block">{$i18n.t("import.mode")}</span>
              <select class="{INPUT_CLASS} w-48" bind:value={mode}>
                <option value="append">{$i18n.t("import.append")}</option>
                <option value="replace">{$i18n.t("import.replaceAll")}</option>
              </select>
            </label>
          {:else}
            <label class="space-y-1 text-xs font-medium text-muted-foreground">
              <span class="block">{$i18n.t("form.label")}</span>
              <input class="{INPUT_CLASS} w-56" bind:value={label}>
            </label>
            <label class="space-y-1 text-xs font-medium text-muted-foreground">
              <span class="block">{$i18n.t("form.name")}</span>
              <input class="{INPUT_CLASS} w-48 font-mono" bind:value={tableName}>
            </label>
          {/if}
        </div>

        {#if target && targetTable}
          <div class="rounded-md border border-border">
            <Table>
              <TableHeader class="bg-muted/30">
                <TableRow class="hover:bg-transparent">
                  <TableHead>{$i18n.t("import.tableColumn")}</TableHead>
                  <TableHead>{$i18n.t("import.fileColumn")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {#each targetTable.columns as col (col.key)}
                  <TableRow>
                    <TableCell class="py-2">
                      {col.label}
                      <span class="text-xs text-muted-foreground"
                        >({$i18n.t(`columnTypes.${col.type}`, { default: col.type })}{col.required
                          ? $i18n.t("import.required")
                          : ""})</span
                      >
                    </TableCell>
                    <TableCell class="py-2">
                      <select
                        class={INPUT_CLASS}
                        aria-label={$i18n.t("import.fileColumnFor", { label: col.label })}
                        value={mapping[col.key] ?? ""}
                        onchange={(e) =>
                          (mapping[col.key] = e.currentTarget.value === "" ? null : Number(e.currentTarget.value))}
                      >
                        <option value="">{$i18n.t("import.skip")}</option>
                        {#each preview.headers as h, i (i)}
                          <option value={i}>{h}</option>
                        {/each}
                      </select>
                    </TableCell>
                  </TableRow>
                {/each}
              </TableBody>
            </Table>
          </div>
        {:else if !target}
          <p class="text-xs text-muted-foreground">
            {$i18n.t("import.derivedHint")}
          </p>
          <ColumnEditor bind:columns bind:keyColumn headers={preview.headers} />
        {/if}
      </CardContent>
    </Card>

    {#if error}
      <p class="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">{error}</p>
    {/if}
    <div class="flex gap-2">
      <Button size="sm" disabled={importing || (!target && !tableName)} onclick={runImport}>
        {importing ? $i18n.t("import.importing") : $i18n.t("import.importRows", { count: preview.totalRows })}
      </Button>
      <Button size="sm" variant="outline" onclick={back}>{$i18n.t("common.cancel")}</Button>
    </div>
  {:else if error}
    <p class="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">{error}</p>
  {/if}
{/if}
