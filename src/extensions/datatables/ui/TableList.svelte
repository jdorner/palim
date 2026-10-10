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
const i18n = palim.i18n;

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
      <PlusIcon size={14} class="mr-1.5" aria-hidden="true" />{$i18n.t("list.newTable")}
    </Button>
    <Button size="sm" variant="outline" onclick={() => palim.navigate(`${PAGE_ROUTE}/import`)}>
      <FileArrowUpIcon size={14} class="mr-1.5" aria-hidden="true" />{$i18n.t("list.importFile")}
    </Button>
  {/if}
</div>

{#if loading}
  <LoadingIndicator message={$i18n.t("list.loading")} />
{:else if loadError}
  <p class="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">{loadError}</p>
{:else if tables.length === 0}
  <div class="py-12 text-center text-sm text-muted-foreground">
    <p>{$i18n.t("list.empty")}</p>
    {#if canWrite}
      <p class="mt-1">{$i18n.t("list.emptyHint")}</p>
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
              <Badge variant="secondary">{$i18n.t("rows", { count: table.rowCount })}</Badge>
            </CardTitle>
            <CardDescription class="font-mono text-xs">{table.name}</CardDescription>
          </CardHeader>
          <CardContent class="space-y-2 text-xs text-muted-foreground">
            {#if table.description}
              <p class="line-clamp-2">{table.description}</p>
            {/if}
            <p class="truncate">
              {$i18n.t("list.columns", {
                count: table.columns.length,
                names: table.columns.map((c) => c.label).join(", "),
              })}
            </p>
            <p>{$i18n.t("list.updatedAt", { date: $i18n.format.date(table.updatedAt) })}</p>
          </CardContent>
        </Card>
      </button>
    {/each}
  </div>
{/if}
