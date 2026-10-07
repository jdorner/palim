<script lang="ts">
/**
 * Generic extension page.
 *
 * Routes: `/ext-page/:extensionName`, `/ext-page/:extensionName/:pageId`, and
 * `/ext-page/:extensionName/:pageId/*rest` (sub-paths for in-page routing).
 *
 * Mounts the compiled Svelte page an extension declares in `ui.pages`
 * (without a page id, the first page is shown).
 */
import { onMount } from "svelte";
import { get } from "svelte/store";
import LoadingIndicator from "$lib/components/LoadingIndicator.svelte";
import { extensions, fetchExtensions } from "$lib/extensionStore";
import ExtensionPageMount from "../components/extensions/ExtensionPageMount.svelte";
import { route } from "../router";

let extensionName = $derived(route.params.extensionName ?? "");
let pageId = $derived(route.params.pageId ?? "");

let fetched = $state(false);
onMount(async () => {
  if (get(extensions).length === 0) await fetchExtensions();
  fetched = true;
});

let ready = $derived($extensions.length > 0 || fetched);
let ext = $derived($extensions.find((e) => e.name === extensionName));
let pages = $derived(ext?.ui?.pages ?? []);
let page = $derived(pageId ? pages.find((p) => p.id === pageId) : pages[0]);
</script>

{#snippet message(
  text: string,
)}
  <div class="flex items-center justify-center h-full">
    <p class="text-sm text-muted-foreground">{text}</p>
  </div>
{/snippet}

{#if !ready}
  <div class="flex items-center justify-center h-full">
    <LoadingIndicator message="Loading extension page..." />
  </div>
{:else if !ext}
  {@render message(`Extension "${extensionName}" is not installed.`)}
{:else if !ext.enabled}
  {@render message(`Extension "${ext.name}" is disabled.`)}
{:else if pages.length === 0}
  {@render message(`Extension "${ext.name}" has no pages.`)}
{:else if !page}
  {@render message(`Extension "${ext.name}" has no page "${pageId}".`)}
{:else if page.error}
  <div class="rounded-md border border-destructive/40 p-4 text-sm">
    <p class="font-medium text-destructive">The page "{page.title}" could not be built.</p>
    <pre class="mt-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">{page.error}</pre>
  </div>
{:else if !page.module}
  {@render message(`The page "${page.title}" is not available yet.`)}
{:else}
  {#key page.module}
    <ExtensionPageMount
      extension={{ name: ext.name, version: ext.version }}
      page={{ ...page, module: page.module }}
      pageRoute={`/ext-page/${ext.name}/${page.id}`}
    />
  {/key}
{/if}
