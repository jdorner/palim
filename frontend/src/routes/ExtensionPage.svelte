<script lang="ts">
import { onMount } from "svelte";
import { get } from "svelte/store";
import LoadingIndicator from "$lib/components/LoadingIndicator.svelte";
import { extensions, fetchExtensions } from "$lib/extensionStore";
/**
 * Generic extension page.
 *
 * Routes: `/ext-page/:extensionName`, `/ext-page/:extensionName/:pageId`, and
 * `/ext-page/:extensionName/:pageId/*rest` (sub-paths for in-page routing).
 *
 * Mounts the compiled Svelte page an extension declares in `ui.pages`
 * (without a page id, the first page is shown).
 */
import { t, tx } from "$lib/i18n.svelte";
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
    <LoadingIndicator message={t("extPage.loading")} />
  </div>
{:else if !ext}
  {@render message(t("extPage.notInstalled", { name: extensionName }))}
{:else if !ext.enabled}
  {@render message(t("extPage.disabled", { name: ext.name }))}
{:else if pages.length === 0}
  {@render message(t("extPage.noPages", { name: ext.name }))}
{:else if !page}
  {@render message(t("extPage.noPage", { name: ext.name, page: pageId }))}
{:else if page.error}
  <div class="rounded-md border border-destructive/40 p-4 text-sm">
    <p class="font-medium text-destructive">
      {t("extPage.buildFailed", { title: tx(ext.name, `pages.${page.id}.title`, page.title) })}
    </p>
    <pre class="mt-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">{page.error}</pre>
  </div>
{:else if !page.module}
  {@render message(t("extPage.notAvailable", { title: tx(ext.name, `pages.${page.id}.title`, page.title) }))}
{:else}
  {#key page.module}
    <ExtensionPageMount
      extension={{ name: ext.name, version: ext.version }}
      page={{ ...page, module: page.module }}
      pageRoute={`/ext-page/${ext.name}/${page.id}`}
    />
  {/key}
{/if}
