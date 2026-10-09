<script lang="ts">
/** Lists all data tables as cards. */
import type { PalimHost } from "@ext/ui";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, LoadingIndicator } from "@palim/ui";
import FileArrowUpIcon from "phosphor-svelte/lib/FileArrowUpIcon";
import PlusIcon from "phosphor-svelte/lib/PlusIcon";
import { onMount } from "svelte";
import { TABLE_CHANGED_EVENT, type TableSummary } from "../types";
import { errorText, PAGE_ROUTE, request } from "./api";

let { palim, canWrite }: { palim: PalimHost; canWrite: boolean } = $props();

let tables: TableSummary[] = $state([]);
let loading = $state(true);
let loadError: string | null = $state(null);

async function load() {
  try {
    tables = (await request<{ tables: TableSummary[] }>(palim, "/tables")).tables;
    loadError = null;
  } catch (err) {
    loadError = errorText(err);
  } finally {
    loading = false;
  }
}

onMount(() => {
  load();
  return palim.onEvent((event) => {
    if (event === TABLE_CHANGED_EVENT) load();
  });
});

const open = (name: string) => palim.navigate(`${PAGE_ROUTE}/t/${encodeURIComponent(name)}`);
</script>

<div class="flex flex-wrap items-center gap-2">
  {#if canWrite}
    <Button size="sm" onclick={() => palim.navigate(`${PAGE_ROUTE}/new`)}>
      <PlusIcon size={14} class="mr-1.5" aria-hidden="true" />New Table
    </Button>
    <Button size="sm" variant="outline" onclick={() => palim.navigate(`${PAGE_ROUTE}/import`)}>
      <FileArrowUpIcon size={14} class="mr-1.5" aria-hidden="true" />Import File
    </Button>
  {/if}
</div>

{#if loading}
  <LoadingIndicator message="Loading tables..." />
{:else if loadError}
  <p class="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">{loadError}</p>
{:else if tables.length === 0}
  <div class="py-12 text-center text-sm text-muted-foreground">
    <p>No data tables yet.</p>
    {#if canWrite}
      <p class="mt-1">Create one by hand, or import a CSV or Excel file to derive its columns.</p>
    {/if}
  </div>
{:else}
  <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
    {#each tables as table (table.id)}
      <button type="button" class="text-left" onclick={() => open(table.name)}>
        <Card class="h-full transition-colors hover:border-primary/60">
          <CardHeader class="pb-2">
            <CardTitle class="flex items-center justify-between gap-2 text-base">
              <span class="truncate">{table.label}</span>
              <Badge variant="secondary">{table.rowCount.toLocaleString()} rows</Badge>
            </CardTitle>
            <CardDescription class="font-mono text-xs">{table.name}</CardDescription>
          </CardHeader>
          <CardContent class="space-y-2 text-xs text-muted-foreground">
            {#if table.description}
              <p class="line-clamp-2">{table.description}</p>
            {/if}
            <p class="truncate">{table.columns.length} columns: {table.columns.map((c) => c.label).join(", ")}</p>
            <p>Updated {new Date(table.updatedAt).toLocaleString()}</p>
          </CardContent>
        </Card>
      </button>
    {/each}
  </div>
{/if}
