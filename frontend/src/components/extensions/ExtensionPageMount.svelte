<script lang="ts">
import { untrack } from "svelte";
import LoadingIndicator from "$lib/components/LoadingIndicator.svelte";
import NotificationBanner from "$lib/components/NotificationBanner.svelte";
import { AlertDialog } from "$lib/components/ui/alert-dialog";
import { createPalimHost } from "$lib/extensionHost";
import { t, tx } from "$lib/i18n.svelte";
/**
 * Mounts one compiled extension page: imports its ES module, loads its
 * stylesheet, and calls the module's default export with a host object. The
 * page is unmounted (and the host disposed) when this component is destroyed;
 * callers re-create it (e.g. via `{#key}`) when the module URL changes.
 *
 * Also provides the shell services the host exposes: notifications and the
 * confirm dialog.
 */
import type { ExtensionUiPage } from "$shared/extensions";
import type { MountExtensionPage, PalimConfirmOptions, PalimNotifyKind } from "$shared/extensionUi";

interface Props {
  /** Owning extension. */
  extension: { name: string; version: string };
  /** The page to mount (must have a `module` URL). */
  page: ExtensionUiPage & { module: string };
  /** The page's base route, `/ext-page/<extension>/<page>`. */
  pageRoute: string;
}

let { extension, page, pageRoute }: Props = $props();

let target: HTMLDivElement | undefined = $state();
let loading = $state(true);
let mountError: string | null = $state(null);

let notice: string | null = $state(null);
let noticeKind: PalimNotifyKind = $state("info");

let confirmRequest: { options: PalimConfirmOptions; resolve: (ok: boolean) => void } | null = $state(null);

/**
 * Loads the extension's stylesheet for the lifetime of the mounted page. It
 * loads after the host's into the same cascade layers, so it must not outlive
 * the page: another extension's page would see its rules out of order.
 *
 * @param extensionName - Owning extension
 * @param href - Stylesheet URL, if the build produced one
 * @returns Removes the stylesheet again
 */
function loadStylesheet(extensionName: string, href: string | undefined): () => void {
  if (!href) return () => {};
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.extUi = extensionName;
  document.head.append(link);
  return () => link.remove();
}

function showNotice(message: string, kind: PalimNotifyKind): void {
  noticeKind = kind;
  // Reset first so repeating the same message restarts the banner timeout.
  notice = null;
  queueMicrotask(() => {
    notice = message;
  });
}

function requestConfirm(options: PalimConfirmOptions): Promise<boolean> {
  // A newer request supersedes (cancels) a pending one.
  confirmRequest?.resolve(false);
  return new Promise((resolve) => {
    confirmRequest = { options, resolve };
  });
}

function settleConfirm(ok: boolean): void {
  const request = confirmRequest;
  confirmRequest = null;
  request?.resolve(ok);
}

$effect(() => {
  const el = target;
  if (!el) return;

  // Track only the target element: the extension list is refetched often and
  // yields new prop objects; the parent re-creates this component when the
  // page's module URL actually changes.
  const { ext, current, baseRoute } = untrack(() => ({ ext: extension, current: page, baseRoute: pageRoute }));
  const { host, dispose } = createPalimHost({
    extension: { name: ext.name, version: ext.version },
    pageId: current.id,
    pageRoute: baseRoute,
    notify: showNotice,
    confirm: requestConfirm,
  });
  const unloadStylesheet = loadStylesheet(ext.name, current.css);

  let cancelled = false;
  let unmount: (() => void) | null = null;
  loading = true;
  mountError = null;

  import(/* @vite-ignore */ current.module)
    .then((mod: { default?: MountExtensionPage }) => {
      if (cancelled) return;
      if (typeof mod.default !== "function") throw new Error("Page module has no default export");
      unmount = mod.default(el, host);
    })
    .catch((err: unknown) => {
      if (cancelled) return;
      console.error(`Failed to mount page "${current.id}" of extension "${ext.name}":`, err);
      mountError = err instanceof Error ? err.message : String(err);
    })
    .finally(() => {
      if (!cancelled) loading = false;
    });

  return () => {
    cancelled = true;
    try {
      unmount?.();
    } catch (err) {
      console.error(`Failed to unmount page "${current.id}" of extension "${ext.name}":`, err);
    }
    unloadStylesheet();
    dispose();
    settleConfirm(false);
  };
});
</script>

<div class="relative flex-1 min-h-0 overflow-auto">
  {#if loading}
    <div class="absolute inset-0 flex items-center justify-center">
      <LoadingIndicator message={t("extPage.loading")} />
    </div>
  {/if}
  {#if mountError}
    <div class="rounded-md border border-destructive/40 p-4 text-sm">
      <p class="font-medium text-destructive">
        {t("extPage.loadFailed", { title: tx(extension.name, `pages.${page.id}.title`, page.title) })}
      </p>
      <pre class="mt-2 whitespace-pre-wrap wrap-break-word text-xs text-muted-foreground">{mountError}</pre>
    </div>
  {/if}
  <div bind:this={target} class="contents"></div>
</div>

{#if notice}
  <div class="fixed bottom-4 right-4 z-50 max-w-sm rounded-md bg-background shadow-lg" role="status">
    <NotificationBanner bind:message={notice} variant={noticeKind} />
  </div>
{/if}

<AlertDialog
  open={confirmRequest !== null}
  title={confirmRequest?.options.title}
  description={confirmRequest?.options.message}
  confirmLabel={confirmRequest?.options.confirmLabel ?? "Confirm"}
  confirmVariant={confirmRequest?.options.destructive ? "destructive" : "default"}
  onConfirm={() => settleConfirm(true)}
  onCancel={() => settleConfirm(false)}
/>
