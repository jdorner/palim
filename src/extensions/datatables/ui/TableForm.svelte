<script lang="ts">
/**
 * Create or edit a table definition. In edit mode, renamed keys are sent as
 * renames (values move with them), removed columns lose their data, and type
 * changes that cannot convert existing values show a conflict list with the
 * option to clear the failing values.
 */
import type { PalimHost } from "@ext/ui";
import { Button, Card, CardContent, CardHeader, LoadingIndicator } from "@palim/ui";
import ArrowLeftIcon from "phosphor-svelte/lib/ArrowLeftIcon";
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
        title: "Remove columns?",
        message: `The values of ${dropped.join(", ")} will be deleted from every row.`,
        confirmLabel: "Remove",
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
      const cleared = result.valuesCleared > 0 ? `, ${result.valuesCleared} values cleared` : "";
      palim.notify(`Table saved (${result.rowsRewritten} rows updated${cleared})`, "success");
      back();
    } else {
      await request(palim, "/tables", {
        method: "POST",
        body: { name: tableName, label, description, columns: defs, keyColumn: keyColumn || undefined },
      });
      palim.notify(`Table "${label || tableName}" created`, "success");
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

<div class="flex items-center gap-2">
  <Button size="xs" variant="ghost" onclick={back}>
    <ArrowLeftIcon size={12} class="mr-1" aria-hidden="true" />Back
  </Button>
  <h2 class="text-sm font-semibold">{editing ? `Edit table: ${original?.label ?? name}` : "New table"}</h2>
</div>

{#if loading}
  <LoadingIndicator message="Loading table..." />
{:else}
  <Card>
    <CardHeader class="pb-2">
      <span class="text-sm font-medium">General</span>
    </CardHeader>
    <CardContent class="grid gap-3 sm:grid-cols-2">
      <div class="space-y-1">
        <label for="dt-label" class="text-xs font-medium text-muted-foreground">Label</label>
        <input id="dt-label" class={INPUT_CLASS} value={label} oninput={(e) => onLabelInput(e.currentTarget.value)}>
      </div>
      <div class="space-y-1">
        <label for="dt-name" class="text-xs font-medium text-muted-foreground">
          Name <span class="font-normal">(used in workflows and the agent command)</span>
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
        <label for="dt-desc" class="text-xs font-medium text-muted-foreground">Description</label>
        <textarea id="dt-desc" class={INPUT_CLASS} rows="2" bind:value={description}></textarea>
      </div>
    </CardContent>
  </Card>

  <Card>
    <CardHeader class="pb-2">
      <span class="text-sm font-medium">Columns</span>
      <span class="text-xs text-muted-foreground">
        Keys are used in workflow templates (<code>{"{{ steps.x.result.first.key }}"}</code>). Renaming a key keeps its
        values; changing a type converts existing values.
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
          <li>Row #{row.index}: {row.errors.join("; ")}</li>
        {/each}
        {#if conflicts.count > conflicts.rows.length}
          <li>… and {conflicts.count - conflicts.rows.length} more</li>
        {/if}
      </ul>
      <Button size="xs" variant="destructive" disabled={saving} onclick={() => save(true)}>
        Save anyway and clear failing values
      </Button>
    </div>
  {/if}
  {#if error}
    <p class="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">{error}</p>
  {/if}

  <div class="flex flex-wrap items-center gap-2">
    <Button size="sm" disabled={saving || (!editing && !tableName)} onclick={() => save()}>
      {saving ? "Saving..." : editing ? "Save" : "Create table"}
    </Button>
    <Button size="sm" variant="outline" onclick={back}>Cancel</Button>
  </div>
{/if}
