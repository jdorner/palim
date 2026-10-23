<script lang="ts">
/**
 * Lists the source repositories with fetch, edit, and delete actions. Laid
 * out like the MCP servers page: bordered table on desktop, cards below.
 * New sources are added from the page's tab bar.
 */
import type { PalimHost } from "@ext/ui";
import { Button, LoadingIndicator, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@palim/ui";
import ArrowsClockwiseIcon from "phosphor-svelte/lib/ArrowsClockwiseIcon";
import KeyIcon from "phosphor-svelte/lib/KeyIcon";
import PencilSimpleIcon from "phosphor-svelte/lib/PencilSimpleIcon";
import TrashIcon from "phosphor-svelte/lib/TrashIcon";
import { onMount } from "svelte";
import { errorText, request, type SourceInfo } from "./api";
import SourceDialog from "./SourceDialog.svelte";

let { palim, canWrite }: { palim: PalimHost; canWrite: boolean } = $props();
const i18n = palim.i18n;

let sources: SourceInfo[] = $state([]);
let loading = $state(true);
let loadError: string | null = $state(null);
let busy: string | null = $state(null);
let editing: SourceInfo | null = $state(null);

async function load() {
  try {
    sources = (await request<{ sources: SourceInfo[] }>(palim, "/sources")).sources;
    loadError = null;
  } catch (err) {
    loadError = errorText(err);
  } finally {
    loading = false;
  }
}

onMount(load);

async function refresh(source: SourceInfo) {
  busy = source.id;
  try {
    const result = await request<{ error: string | null }>(palim, `/sources/${encodeURIComponent(source.id)}/refresh`, {
      method: "POST",
    });
    if (result.error) palim.notify(i18n.current.t("sources.fetchFailed", { error: result.error }), "error");
    else palim.notify(i18n.current.t("sources.refreshed", { name: source.name }), "success");
  } catch (err) {
    palim.notify(errorText(err), "error");
  } finally {
    busy = null;
    await load();
  }
}

async function remove(source: SourceInfo) {
  const t = i18n.current.t;
  const ok = await palim.confirm({
    title: t("sources.deleteTitle", { name: source.name }),
    message: t("sources.deleteMessage"),
    confirmLabel: t("common.delete"),
    destructive: true,
  });
  if (!ok) return;
  busy = source.id;
  try {
    await request(palim, `/sources/${encodeURIComponent(source.id)}`, { method: "DELETE" });
    palim.notify(t("sources.deleted", { name: source.name }), "success");
  } catch (err) {
    palim.notify(errorText(err), "error");
  } finally {
    busy = null;
    await load();
  }
}

function saved() {
  editing = null;
  load();
}
</script>

{#snippet lastFetch(source: SourceInfo)}
  <span class="text-sm text-muted-foreground">
    {source.lastFetchedAt ? $i18n.format.date(source.lastFetchedAt) : $i18n.t("common.never")}
  </span>
  {#if source.lastError}
    <p class="mt-0.5 line-clamp-2 text-xs text-destructive" title={source.lastError}>{source.lastError}</p>
  {/if}
{/snippet}

{#snippet repository(source: SourceInfo)}
  <div class="truncate font-mono text-xs" title={source.url}>{source.url}</div>
  {#if source.hasToken}
    <p class="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
      <KeyIcon size={12} aria-hidden="true" />{$i18n.t("sources.withToken")}
    </p>
  {/if}
{/snippet}

{#snippet actions(source: SourceInfo)}
  <Button size="sm" variant="outline" disabled={busy !== null} onclick={() => refresh(source)}>
    <ArrowsClockwiseIcon size={14} class="mr-1.5 {busy === source.id ? "animate-spin" : ""}" aria-hidden="true" />
    {$i18n.t("sources.refresh")}
  </Button>
  <Button size="sm" variant="outline" disabled={busy !== null} onclick={() => (editing = source)}>
    <PencilSimpleIcon size={14} class="mr-1.5" aria-hidden="true" />{$i18n.t("common.edit")}
  </Button>
  <Button size="sm" variant="destructive" disabled={busy !== null} onclick={() => remove(source)}>
    <TrashIcon size={14} class="mr-1.5" aria-hidden="true" />{$i18n.t("common.delete")}
  </Button>
{/snippet}

{#if loading}
  <LoadingIndicator message={$i18n.t("sources.loading")} />
{:else if loadError}
  <p class="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">{loadError}</p>
{:else if sources.length === 0}
  <div class="space-y-1 text-sm text-muted-foreground">
    <p>{$i18n.t("sources.empty")}</p>
    <p>{$i18n.t("sources.emptyHint")}</p>
  </div>
{:else}
  <!-- Mobile & tablet: cards -->
  <div class="responsive-cards">
    {#each sources as source (source.id)}
      <div class="space-y-3 rounded-md border border-border p-4">
        <div class="flex items-start justify-between gap-2">
          <span class="font-medium">{source.name}</span>
          <span class="font-mono text-xs text-muted-foreground"
            >{source.branch ?? $i18n.t("sources.defaultBranch")}</span
          >
        </div>
        <div class="min-w-0">{@render repository(source)}</div>
        <div>{@render lastFetch(source)}</div>
        {#if canWrite}
          <hr>
          <div class="flex flex-wrap items-center gap-2">{@render actions(source)}</div>
        {/if}
      </div>
    {/each}
  </div>

  <!-- Desktop: table -->
  <div class="responsive-table rounded-md border border-border">
    <Table>
      <TableHeader class="bg-muted/30">
        <TableRow>
          <TableHead>{$i18n.t("sources.name")}</TableHead>
          <TableHead>{$i18n.t("sources.url")}</TableHead>
          <TableHead>{$i18n.t("sources.branch")}</TableHead>
          <TableHead>{$i18n.t("sources.lastFetch")}</TableHead>
          {#if canWrite}
            <TableHead class="text-center">{$i18n.t("columns.actions")}</TableHead>
          {/if}
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each sources as source (source.id)}
          <TableRow>
            <TableCell><span class="font-medium">{source.name}</span></TableCell>
            <TableCell class="max-w-xs">{@render repository(source)}</TableCell>
            <TableCell class="font-mono text-xs">{source.branch ?? $i18n.t("sources.defaultBranch")}</TableCell>
            <TableCell class="max-w-xs">{@render lastFetch(source)}</TableCell>
            {#if canWrite}
              <TableCell class="w-1 text-right">
                <div class="inline-flex flex-wrap justify-end gap-2 xl:flex-nowrap">{@render actions(source)}</div>
              </TableCell>
            {/if}
          </TableRow>
        {/each}
      </TableBody>
    </Table>
  </div>
{/if}

{#if editing}
  {#key editing.id}
    <SourceDialog {palim} source={editing} onSaved={saved} onClose={() => (editing = null)} />
  {/key}
{/if}
