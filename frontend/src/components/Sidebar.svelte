<script lang="ts">
import ArrowLineLeftIcon from "phosphor-svelte/lib/ArrowLineLeftIcon";
import ArrowLineRightIcon from "phosphor-svelte/lib/ArrowLineRightIcon";
import ChatTextIcon from "phosphor-svelte/lib/ChatTextIcon";
import GearIcon from "phosphor-svelte/lib/GearIcon";
import TrayIcon from "phosphor-svelte/lib/TrayIcon";
import { derived } from "svelte/store";
import { resolveBadge } from "$lib/badgeRegistry";
import { extensionNavItems } from "$lib/extensionStore";
import { resolveIcon } from "$lib/iconRegistry";
import { settings } from "$lib/settingsStore.svelte";
import { automationStyle } from "$lib/utils";
import { navigate, pathname } from "../router";

/** Number of jobs in the queue. */
let {
  jobCount = 0,
  hasUnreadChats = false,
  scheduleCount: _scheduleCount = 0,
}: { jobCount?: number; hasUnreadChats?: boolean; scheduleCount?: number } = $props();

let collapsed = $derived(settings.sidebarCollapsed);

let isChatActive = $derived($pathname === "/" || $pathname === "/chat" || $pathname.startsWith("/chat/"));
let isJobsActive = $derived($pathname === "/jobs");
let isSettingsActive = $derived($pathname === "/settings");

/**
 * Derived store that resolves badge counts for all current extension nav items.
 * Returns a map from route (unique key) to current badge count.
 */
const badgeCounts = derived(
  [extensionNavItems],
  ([$items], set) => {
    const unsubscribers: (() => void)[] = [];
    const counts = new Map<string, number>();

    for (const item of $items) {
      if (!item.badgeKey) continue;
      const store = resolveBadge(item.badgeKey);
      if (!store) continue;
      const unsub = store.subscribe((value) => {
        counts.set(item.route, value);
        set(new Map(counts));
      });
      unsubscribers.push(unsub);
    }

    set(new Map(counts));

    return () => {
      for (const unsub of unsubscribers) unsub();
    };
  },
  new Map<string, number>(),
);
</script>

<nav
  class="shrink-0 sticky top-0 h-screen overflow-y-auto overflow-x-hidden bg-muted/50 border-r border-border flex flex-col gap-1 transition-all duration-200
    {collapsed ? 'w-14 py-4 px-2' : 'w-56 p-4'}"
>
  <!-- Header: favicon only when collapsed, full branding when expanded -->
  <div class="flex items-center mb-3 {collapsed ? 'justify-center' : 'pl-2'}">
    <a href="#/" class="flex items-center gap-2 leading-2 no-underline">
      <img src="/favicon.svg" alt="Palim" class="w-7 h-7 shrink-0">
      {#if !collapsed}
        <span
          class="font-semibold text-amber-500 dark:text-amber-500 tracking-wide mt-1"
          style="font-family: 'Satisfy', cursive; font-size: 1.4rem; text-transform: none;"
          >Palim</span
        >
      {/if}
    </a>
  </div>

  <!-- Chat -->
  <button
    type="button"
    class="relative flex items-center rounded-md text-sm font-medium transition-colors w-full
      {collapsed ? 'justify-center p-2' : 'gap-2 px-3 py-2 text-left'}
      {isChatActive
      ? 'bg-accent text-accent-foreground'
      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'}"
    onclick={() => navigate("/chat")}
    title={collapsed ? "Chat" : undefined}
  >
    {#if hasUnreadChats && collapsed}
      <span
        class="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full {automationStyle('chat').bg} animate-pulse ring-2 ring-background"
        role="status"
        aria-label="Unread messages"
      ></span>
    {/if}
    <ChatTextIcon
      class="{collapsed ? 'w-6 h-6' : 'w-4 h-4'} shrink-0 {automationStyle('chat').color}"
      aria-hidden="true"
    />
    {#if !collapsed}
      Chat
      {#if hasUnreadChats}
        <span
          class="ml-auto mr-2 mt-1 w-2 h-2 rounded-full {automationStyle('chat').bg} animate-pulse"
          role="status"
          aria-label="Unread messages"
        ></span>
      {/if}
    {/if}
  </button>

  <!-- Extension nav items -->
  {#each $extensionNavItems as item (item.route)}
    {@const IconComponent = resolveIcon(item.icon)}
    {@const isActive = $pathname === item.route || $pathname.startsWith(`${item.route}/`)}
    {@const badgeCount = $badgeCounts.get(item.route) ?? 0}
    <button
      type="button"
      class="relative flex items-center rounded-md text-sm font-medium transition-colors w-full
        {collapsed ? 'justify-center p-2 leading-2' : 'gap-2 px-3 py-2 text-left'}
        {isActive
        ? 'bg-accent text-accent-foreground'
        : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'}"
      onclick={() => navigate(item.route as any)}
      title={collapsed ? item.label : undefined}
    >
      {#if badgeCount > 0 && collapsed}
        <span
          class="absolute bottom-0 right-0 text-[10px] font-bold leading-none rounded-full bg-primary text-primary-foreground px-1 py-0.5 min-w-[16px] text-center ring-2 ring-background"
          >{badgeCount > 99 ? "99+" : badgeCount}</span
        >
      {/if}
      {#if IconComponent}
        <IconComponent class="{collapsed ? 'w-6 h-6' : 'w-4 h-4'} shrink-0 {item.iconColor ?? ''}" aria-hidden="true" />
      {/if}
      {#if !collapsed}
        <span class="text-nowrap">{item.label}</span>
        {#if badgeCount > 0}
          <span class="ml-auto text-xs font-semibold rounded-full bg-primary/15 text-primary px-2 py-0.5"
            >{badgeCount}</span
          >
        {/if}
      {/if}
    </button>
  {/each}

  <!-- Job Queues -->
  <button
    type="button"
    class="relative flex items-center rounded-md text-sm font-medium transition-colors w-full
      {collapsed ? 'justify-center p-2' : 'gap-2 px-3 py-2 text-left'}
      {isJobsActive
      ? 'bg-accent text-accent-foreground'
      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'}"
    onclick={() => navigate("/jobs")}
    title={collapsed ? "Job Queues" : undefined}
  >
    {#if jobCount > 0 && collapsed}
      <span
        class="absolute bottom-0 right-0 text-[10px] font-bold leading-none rounded-full bg-primary text-primary-foreground px-1 py-0.5 min-w-[16px] text-center ring-2 ring-background"
        >{jobCount > 99 ? "99+" : jobCount}</span
      >
    {/if}
    <TrayIcon class="{collapsed ? 'w-6 h-6' : 'w-4 h-4'} shrink-0" aria-hidden="true" />
    {#if !collapsed}
      <span class="text-nowrap">Job Queues</span>
      {#if jobCount > 0}
        <span class="ml-auto text-xs font-semibold rounded-full bg-primary/15 text-primary px-2 py-0.5"
          >{jobCount}</span
        >
      {/if}
    {/if}
  </button>

  <!-- Bottom section: Settings + collapse toggle -->
  <div class="mt-auto pt-4 border-t border-border flex flex-col gap-1">
    <button
      type="button"
      class="flex items-center rounded-md text-sm font-medium transition-colors w-full text-muted-foreground hover:bg-accent/50 hover:text-foreground
        {collapsed ? 'justify-center p-2' : 'gap-2 px-3 py-2 text-left'}"
      onclick={() => settings.toggleSidebarCollapsed()}
      title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
    >
      {#if collapsed}
        <ArrowLineRightIcon class="{collapsed ? 'w-6 h-6' : 'w-4 h-4'} shrink-0" aria-hidden="true" />
      {:else}
        <ArrowLineLeftIcon class="{collapsed ? 'w-6 h-6' : 'w-4 h-4'} shrink-0" aria-hidden="true" />
        Collapse
      {/if}
    </button>

    <button
      type="button"
      class="relative flex items-center rounded-md text-sm font-medium transition-colors w-full
        {collapsed ? 'justify-center p-2' : 'gap-2 px-3 py-2 text-left'}
        {isSettingsActive
        ? 'bg-accent text-accent-foreground'
        : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'}"
      onclick={() => navigate("/settings")}
      title={collapsed ? "Settings" : undefined}
    >
      <GearIcon class="{collapsed ? 'w-6 h-6' : 'w-4 h-4'} shrink-0" aria-hidden="true" />
      {#if !collapsed}
        Settings
      {/if}
    </button>
  </div>
</nav>
