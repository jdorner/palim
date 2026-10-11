<!--
  Portal shell: session gate, navigation from the registered modules, the
  shared live event stream, and route rendering.
-->
<script lang="ts">
import GearIcon from "phosphor-svelte/lib/GearIcon";
import type { Component } from "svelte";
import { session } from "$app/auth.svelte";
import { i18n, t } from "$app/i18n.svelte";
import { matchRoute, router } from "$app/router.svelte";
import { openEventStream } from "$app/sse";
import { provideI18n } from "$lib/kitI18n";
import type { PortalEvent } from "$shared/portal";
import { MODULES } from "./modules";
import LoginPage from "./pages/LoginPage.svelte";
import NoAccessPage from "./pages/NoAccessPage.svelte";
import NotFoundPage from "./pages/NotFoundPage.svelte";
import SettingsPage from "./pages/SettingsPage.svelte";

// Kit components (`@palim/ui`) read translations from context.
provideI18n(i18n.store);

let connected = $state(true);

const available = $derived(session.state === "ready" ? MODULES.filter((m) => m.isAvailable()) : []);

/** Navigation entries: the modules, then settings. */
const navItems = $derived([
  ...available.map((m) => ({
    path: m.nav.path,
    label: t(m.nav.labelKey),
    icon: m.nav.icon,
    badge: m.nav.badge?.() ?? 0,
  })),
  { path: "/settings", label: t("nav.settings"), icon: GearIcon as Component, badge: 0 },
]);

/** The page for the current path. */
const current = $derived.by(
  (): { component: Component<{ params: Record<string, string> }>; params: Record<string, string> } => {
    const path = router.path;
    if (path === "/settings") return { component: SettingsPage as never, params: {} };
    for (const module of available) {
      for (const route of module.routes) {
        const params = matchRoute(route.pattern, path);
        if (params) return { component: route.component, params };
      }
    }
    return { component: NotFoundPage as never, params: {} };
  },
);

// "/" goes to the first module.
$effect(() => {
  if (router.path === "/" && available.length > 0) router.navigate(available[0]!.nav.path, true);
});

// One live event stream while signed in, when a module consumes it (the
// stream needs task access; launcher-only accounts would be refused).
const wantsEvents = $derived(available.some((m) => m.onEvent));
$effect(() => {
  if (!wantsEvents) return;
  const close = openEventStream("/api/portal/events", {
    onMessage: (message) => {
      let event: PortalEvent;
      try {
        event = JSON.parse(message.data) as PortalEvent;
      } catch {
        return;
      }
      for (const module of available) module.onEvent?.(event);
    },
    onStatus: (value) => {
      connected = value;
    },
    onDenied: () => void session.restore(),
  });
  return close;
});

// Clear module state on sign-out.
$effect(() => {
  if (session.state === "anonymous") for (const module of MODULES) module.reset?.();
});

const isActive = (path: string) => router.path === path || router.path.startsWith(`${path}/`);
</script>

<svelte:head>
  <title>{t("app.title")}</title>
</svelte:head>

{#if session.state === "loading"}
  <div class="flex min-h-dvh items-center justify-center text-sm text-muted-foreground">{t("app.loading")}</div>
{:else if session.state === "anonymous"}
  <LoginPage />
{:else if available.length === 0}
  <NoAccessPage />
{:else}
  <div class="flex min-h-dvh flex-col">
    <header class="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
      <div class="mx-auto flex h-14 max-w-3xl items-center gap-3 px-4">
        <a href="#/" class="flex items-center gap-2 font-semibold text-foreground no-underline">
          <img src="./favicon.svg" alt="" class="size-6">
          <span>{t("app.title")}</span>
        </a>
        <nav class="ml-auto hidden gap-1 sm:flex">
          {#each navItems as item (item.path)}
            <a
              href="#{item.path}"
              class="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm no-underline {isActive(item.path)
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground"}"
            >
              <item.icon size={16} aria-hidden="true" />
              {item.label}
              {#if item.badge > 0}
                <span class="rounded-full bg-primary px-1.5 text-xs text-primary-foreground">{item.badge}</span>
              {/if}
            </a>
          {/each}
        </nav>
      </div>
      {#if !connected}
        <p class="bg-amber-100 px-4 py-1 text-center text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {t("app.offline")}
        </p>
      {/if}
    </header>

    <main class="mx-auto w-full max-w-3xl flex-1 px-4 py-5 pb-24 sm:pb-8">
      {#key router.path}
        <current.component params={current.params} />
      {/key}
    </main>

    <!-- Bottom navigation on phones. -->
    <nav class="fixed inset-x-0 bottom-0 z-10 flex border-t bg-background pb-[env(safe-area-inset-bottom)] sm:hidden">
      {#each navItems as item (item.path)}
        <a
          href="#{item.path}"
          class="relative flex flex-1 flex-col items-center gap-0.5 py-2 text-xs no-underline {isActive(item.path)
            ? "text-foreground"
            : "text-muted-foreground"}"
        >
          <item.icon size={22} aria-hidden="true" />
          {item.label}
          {#if item.badge > 0}
            <span
              class="absolute left-1/2 top-1 ml-2 rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground"
            >
              {item.badge}
            </span>
          {/if}
        </a>
      {/each}
    </nav>
  </div>
{/if}
