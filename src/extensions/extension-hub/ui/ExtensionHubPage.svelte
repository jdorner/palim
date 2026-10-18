<script lang="ts">
/**
 * Extension Hub page: the catalog of extensions offered by the registered
 * git sources, and the source list.
 *
 * Sub-paths: "" (catalog), "sources".
 */
import type { PalimHost } from "@ext/ui";
import { Badge, Button, cn } from "@palim/ui";
import ArrowsClockwiseIcon from "phosphor-svelte/lib/ArrowsClockwiseIcon";
import PlusIcon from "phosphor-svelte/lib/PlusIcon";
import { onMount } from "svelte";
import { PAGE_ROUTE, UPDATES_CHANGED_EVENT } from "../events";
import { type CheckResult, errorText, request } from "./api";
import CatalogTab from "./CatalogTab.svelte";
import SourceDialog from "./SourceDialog.svelte";
import SourcesTab from "./SourcesTab.svelte";

let { palim }: { palim: PalimHost } = $props();
const i18n = palim.i18n;

let path = $state(palim.page.path);
$effect(() =>
  palim.page.subscribe((route) => {
    path = route.path;
  }),
);

const tab = $derived(path.split("/").filter(Boolean)[0] === "sources" ? "sources" : "catalog");
const canWrite = $derived(palim.user.can("manage", "Extension"));

let checking = $state(false);
let addingSource = $state(false);
let updateCount = $state(0);
/** Bumped after a check or a new source so the tabs reload. */
let revision = $state(0);

async function loadUpdateCount() {
  try {
    updateCount = (await request<{ count: number }>(palim, "/updates")).count;
  } catch {
    // The badge is optional.
  }
}

onMount(() => {
  loadUpdateCount();
  return palim.onEvent((event, data) => {
    if (event === UPDATES_CHANGED_EVENT) updateCount = (data as { count?: number } | undefined)?.count ?? 0;
  });
});

async function checkNow() {
  checking = true;
  try {
    const result = await request<CheckResult>(palim, "/check", { method: "POST" });
    for (const e of result.errors) palim.notify(i18n.current.t("check.sourceError", e), "error");
    updateCount = result.updates.length;
    palim.notify(
      result.updates.length > 0
        ? i18n.current.t("check.updates", { count: result.updates.length })
        : i18n.current.t("check.upToDate"),
      result.updates.length > 0 ? "info" : "success",
    );
    revision++;
  } catch (err) {
    palim.notify(errorText(err), "error");
  } finally {
    checking = false;
  }
}

function sourceAdded() {
  addingSource = false;
  revision++;
  loadUpdateCount();
}

/** Same look as the tabs of the Users page. */
const tabClass = (active: boolean) =>
  cn(
    "-mb-px px-3 py-1.5 text-sm font-medium",
    active ? "border-b-2 border-primary text-foreground" : "text-muted-foreground hover:text-foreground",
  );
</script>

<div class="h-full space-y-4 overflow-auto p-1">
  <div class="flex items-end gap-3 border-b border-border">
    <nav class="flex gap-1" aria-label={$i18n.t("tabs.label")}>
      <button
        type="button"
        class={tabClass(tab === "catalog")}
        aria-current={tab === "catalog" ? "page" : undefined}
        onclick={() => palim.navigate(PAGE_ROUTE)}
      >
        {$i18n.t("tabs.catalog")}
        {#if updateCount > 0}
          <Badge class="ml-1 px-1.5 py-0 text-[10px]" title={$i18n.t("check.updates", { count: updateCount })}>
            {updateCount}
          </Badge>
        {/if}
      </button>
      <button
        type="button"
        class={tabClass(tab === "sources")}
        aria-current={tab === "sources" ? "page" : undefined}
        onclick={() => palim.navigate(`${PAGE_ROUTE}/sources`)}
      >
        {$i18n.t("tabs.sources")}
      </button>
    </nav>
    {#if canWrite}
      {#if tab === "sources"}
        <Button size="sm" class="mb-1 ml-auto" onclick={() => (addingSource = true)}>
          <PlusIcon size={14} class="mr-1.5" aria-hidden="true" />{$i18n.t("sources.add")}
        </Button>
      {:else}
        <Button size="sm" variant="outline" class="mb-1 ml-auto" disabled={checking} onclick={checkNow}>
          <ArrowsClockwiseIcon size={14} class={cn("mr-1.5", checking && "animate-spin")} aria-hidden="true" />
          {checking ? $i18n.t("check.running") : $i18n.t("check.button")}
        </Button>
      {/if}
    {/if}
  </div>

  {#key revision}
    {#if tab === "sources"}
      <SourcesTab {palim} {canWrite} />
    {:else}
      <CatalogTab {palim} {canWrite} />
    {/if}
  {/key}
</div>

{#if addingSource}
  <SourceDialog {palim} onSaved={sourceAdded} onClose={() => (addingSource = false)} />
{/if}
