<!-- The workflows the user may start. With a single one, it opens directly. -->
<script lang="ts">
import { Button } from "@palim/ui";
import CaretRightIcon from "phosphor-svelte/lib/CaretRightIcon";
import { t } from "$app/i18n.svelte";
import { router } from "$app/router.svelte";
import { launchers } from "./store.svelte";

// Route params (none used); declared so the page fits the module route contract.
let _props: { params: Record<string, string> } = $props();

// Always refresh: workflows may have been added or changed since the last visit.
void launchers.load();

$effect(() => {
  if (launchers.loaded && launchers.items.length === 1) {
    router.navigate(`/start/${encodeURIComponent(launchers.items[0]!.name)}`, true);
  }
});
</script>

<div class="space-y-4">
  <header class="space-y-1">
    <h2 class="text-xl font-semibold">{t("launch.title")}</h2>
    <p class="text-sm text-muted-foreground">{t("launch.subtitle")}</p>
  </header>

  {#if launchers.error && launchers.items.length === 0}
    <div class="space-y-2 rounded-lg border p-4 text-sm">
      <p class="text-destructive">{t("launch.loadFailed", { message: launchers.error })}</p>
      <Button size="sm" variant="outline" onclick={() => launchers.load()}>{t("launch.retry")}</Button>
    </div>
  {:else if !launchers.loaded}
    <p class="py-8 text-center text-sm text-muted-foreground">{t("app.loading")}</p>
  {:else if launchers.items.length === 0}
    <p class="py-8 text-center text-sm text-muted-foreground">{t("launch.empty")}</p>
  {:else}
    <div class="space-y-2">
      {#each launchers.items as item (item.name)}
        <a
          href="#/start/{encodeURIComponent(item.name)}"
          class="flex items-center gap-3 rounded-lg border bg-card px-4 py-3 no-underline text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div class="min-w-0 flex-1 space-y-1">
            <span class="block truncate font-medium">{item.title}</span>
            {#if item.description}
              <span class="line-clamp-2 text-xs text-muted-foreground">{item.description}</span>
            {/if}
          </div>
          <CaretRightIcon size={16} class="shrink-0 text-muted-foreground" aria-hidden="true" />
        </a>
      {/each}
    </div>
  {/if}
</div>
