<!-- The task inbox: open tasks and the tasks I answered. -->
<script lang="ts">
import { Button } from "@palim/ui";
import { t } from "$app/i18n.svelte";
import { type InboxTab, tasks } from "./store.svelte";
import TaskCard from "./TaskCard.svelte";

// Route params (none used); declared so the page fits the module route contract.
let _props: { params: Record<string, string> } = $props();

let tab = $state<InboxTab>("open");

$effect(() => {
  const list = tasks.lists[tab];
  if (!list.loaded && !list.loading && !list.error) void tasks.load(tab);
});

const list = $derived(tasks.lists[tab]);
</script>

<div class="space-y-4">
  <div class="flex gap-1 rounded-lg bg-muted p-1" role="tablist">
    {#each [
      ["open", t("tasks.tabOpen")],
      ["done", t("tasks.tabDone")],
    ] as [id, label] (id)}
      <button
        type="button"
        role="tab"
        aria-selected={tab === id}
        class="flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors {tab === id
          ? "bg-background shadow-sm"
          : "text-muted-foreground hover:text-foreground"}"
        onclick={() => (tab = id as InboxTab)}
      >
        {label}
        {#if id === "open" && tasks.counts.open > 0}
          <span class="ml-1 rounded-full bg-primary px-1.5 text-xs text-primary-foreground">{tasks.counts.open}</span>
        {/if}
      </button>
    {/each}
  </div>

  {#if list.error && list.tasks.length === 0}
    <div class="space-y-2 rounded-lg border p-4 text-sm">
      <p class="text-destructive">{t("tasks.loadFailed", { message: list.error })}</p>
      <Button size="sm" variant="outline" onclick={() => tasks.load(tab)}>{t("tasks.retry")}</Button>
    </div>
  {:else if !list.loaded}
    <p class="py-8 text-center text-sm text-muted-foreground">{t("app.loading")}</p>
  {:else if list.tasks.length === 0}
    <p class="py-8 text-center text-sm text-muted-foreground">
      {tab === "open" ? t("tasks.emptyOpen") : t("tasks.emptyDone")}
    </p>
  {:else}
    <div class="space-y-2">
      {#each list.tasks as task (task.id)}
        <TaskCard {task} />
      {/each}
    </div>
    {#if list.nextCursor}
      <div class="flex justify-center">
        <Button size="sm" variant="outline" disabled={list.loading} onclick={() => tasks.load(tab, true)}>
          {t("tasks.loadMore")}
        </Button>
      </div>
    {/if}
  {/if}
</div>
