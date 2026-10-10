<script lang="ts">
/**
 * Create or edit a table definition. In edit mode, renamed keys are sent as
 * renames (values move with them), removed columns lose their data, and type
 * changes that cannot convert existing values show a conflict list with the
 * option to clear the failing values.
 */
import type { PalimHost } from "@ext/ui";
import { Button, Card, CardContent, CardHeader, LoadingIndicator } from "@palim/ui";
import { onMount } from "svelte";
import { type RowError, slugify, type TableDef } from "../types";
import {
  ApiError,
  type EditableColumn,
  errorText,
  INPUT_CLASS,
  nextUid,
  PAGE_ROUTE,
  request,
  toColumnDefs,
  toEditable,
} from "./api";
import ColumnEditor from "./ColumnEditor.svelte";

let { palim, name }: { palim: PalimHost; name?: string } = $props();
const i18n = palim.i18n;

const editing = $derived(Boolean(name));

let loading = $state(false);
let saving = $state(false);
let tableName = $state("");
let nameTouched = $state(false);
let label = $state("");
let description = $state("");
let columns: EditableColumn[] = $state([{ uid: nextUid(), key: "name", label: "Name", type: "text", autoKey: true }]);
let keyColumn = $state("");
let original: TableDef | null = $state(null);
let error: string | null = $state(null);
let conflicts: { message: string; rows: RowError[]; count: number } | null = $state(null);

onMount(async () => {
  if (!name) return;
  loading = true;
  try {
    const { table } = await request<{ table: TableDef }>(palim, `/tables/${encodeURIComponent(name)}`);
    original = table;
    tableName = table.name;
    label = table.label;
    description = table.description ?? "";
    columns = toEditable(table.columns, true);
    keyColumn = table.keyColumn ?? "";
  } catch (err) {
    error = errorText(err);
  } finally {
    loading = false;
  }
});

function onLabelInput(value: string) {
  label = value;
  if (!editing && !nameTouched) tableName = slugify(value).replace(/^[^a-z]+/, "");
}

const back = () => palim.navigate(name ? `${PAGE_ROUTE}/t/${encodeURIComponent(name)}` : PAGE_ROUTE);

async function save(force = false) {
  error = null;
  conflicts = null;
  const defs = toColumnDefs(columns);
  if (editing && original && !force) {
    const kept = new Set(columns.map((c) => c.originalKey).filter(Boolean));
    const dropped = original.columns.filter((c) => !kept.has(c.key)).map((c) => c.label);
    if (
      dropped.length > 0 &&
      !(await palim.confirm({
        title: i18n.current.t("form.removeColumnsTitle"),
        message: i18n.current.t("form.removeColumnsMessage", { columns: dropped.join(", ") }),
        confirmLabel: i18n.current.t("form.remove"),
        destructive: true,
      }))
    ) {
      return;
    }
  }
  saving = true;
  try {
    if (editing && name) {
      const renames: Record<string, string> = {};
      for (const c of columns) if (c.originalKey && c.originalKey !== c.key) renames[c.originalKey] = c.key;
      const result = await request<{ rowsRewritten: number; valuesCleared: number }>(
        palim,
        `/tables/${encodeURIComponent(name)}`,
        {
          method: "PUT",
          body: { label, description, columns: defs, renames, keyColumn: keyColumn || null, force },
        },
      );
      palim.notify(
        result.valuesCleared > 0
          ? i18n.current.t("form.savedCleared", { rows: result.rowsRewritten, cleared: result.valuesCleared })
          : i18n.current.t("form.saved", { rows: result.rowsRewritten }),
        "success",
      );
      back();
    } else {
      await request(palim, "/tables", {
        method: "POST",
        body: { name: tableName, label, description, columns: defs, keyColumn: keyColumn || undefined },
      });
      palim.notify(i18n.current.t("form.created", { label: label || tableName }), "success");
      palim.navigate(`${PAGE_ROUTE}/t/${encodeURIComponent(tableName)}`);
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 409 && err.rows.length > 0) {
      conflicts = { message: err.message, rows: err.rows, count: err.count };
    } else {
      error = errorText(err);
    }
  } finally {
    saving = false;
  }
}
</script>

<div class="flex items-center gap-3">
  <Button size="sm" variant="outline" onclick={back}>&laquo;&nbsp;{$i18n.t("back")}</Button>
  <h2 class="truncate text-lg font-semibold">
    {editing ? $i18n.t("form.editTitle", { label: original?.label ?? name }) : $i18n.t("form.newTitle")}
  </h2>
</div>

{#if loading}
  <LoadingIndicator message={$i18n.t("form.loading")} />
{:else}
  <Card>
    <CardHeader class="pb-2">
      <span class="text-sm font-medium">{$i18n.t("form.general")}</span>
    </CardHeader>
    <CardContent class="grid gap-3 sm:grid-cols-2">
      <div class="space-y-1">
        <label for="dt-label" class="text-xs font-medium text-muted-foreground">{$i18n.t("form.label")}</label>
        <input id="dt-label" class={INPUT_CLASS} value={label} oninput={(e) => onLabelInput(e.currentTarget.value)}>
      </div>
      <div class="space-y-1">
        <label for="dt-name" class="text-xs font-medium text-muted-foreground">
          {$i18n.t("form.name")} <span class="font-normal">{$i18n.t("form.nameHint")}</span>
        </label>
        <input
          id="dt-name"
          class="{INPUT_CLASS} font-mono"
          value={tableName}
          disabled={editing}
          placeholder="my_table"
          oninput={(e) => {
            tableName = e.currentTarget.value;
            nameTouched = true;
          }}
        >
      </div>
      <div class="space-y-1 sm:col-span-2">
        <label for="dt-desc" class="text-xs font-medium text-muted-foreground">{$i18n.t("form.description")}</label>
        <textarea id="dt-desc" class={INPUT_CLASS} rows="2" bind:value={description}></textarea>
      </div>
    </CardContent>
  </Card>

  <Card>
    <CardHeader class="pb-2">
      <span class="text-sm font-medium">{$i18n.t("form.columns")}</span>
      <span class="text-xs text-muted-foreground">
        {$i18n.t("form.columnsHintBefore")}<code>{"{{ steps.x.result.first.key }}"}</code>
        {$i18n.t("form.columnsHintAfter")}
      </span>
    </CardHeader>
    <CardContent class="space-y-2">
      <ColumnEditor bind:columns bind:keyColumn />
    </CardContent>
  </Card>

  {#if conflicts}
    <div class="space-y-2 rounded-md border border-destructive/40 p-3 text-sm">
      <p class="font-medium text-destructive">{conflicts.message}</p>
      <ul class="max-h-48 list-inside list-disc overflow-auto text-xs text-muted-foreground">
        {#each conflicts.rows as row (row.index)}
          <li>{$i18n.t("form.conflictRow", { index: row.index, errors: row.errors.join("; ") })}</li>
        {/each}
        {#if conflicts.count > conflicts.rows.length}
          <li>{$i18n.t("form.andMore", { count: conflicts.count - conflicts.rows.length })}</li>
        {/if}
      </ul>
      <Button size="sm" variant="destructive" disabled={saving} onclick={() => save(true)}>
        {$i18n.t("form.saveAnyway")}
      </Button>
    </div>
  {/if}
  {#if error}
    <p class="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">{error}</p>
  {/if}

  <div class="flex flex-wrap items-center gap-2">
    <Button size="sm" disabled={saving || (!editing && !tableName)} onclick={() => save()}>
      {saving ? $i18n.t("common.saving") : editing ? $i18n.t("common.save") : $i18n.t("form.createTable")}
    </Button>
    <Button size="sm" variant="outline" onclick={back}>{$i18n.t("common.cancel")}</Button>
  </div>
{/if}
