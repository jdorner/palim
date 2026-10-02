<script lang="ts">
import CaretDownIcon from "phosphor-svelte/lib/CaretDownIcon";
import SignOutIcon from "phosphor-svelte/lib/SignOutIcon";
import UserIcon from "phosphor-svelte/lib/UserIcon";
import { forceLogout } from "$lib/auth";
import { Button } from "$lib/components/ui/button";
import { identity } from "$lib/identity.svelte";

/** Whether the dropdown menu is open. */
let open = $state(false);
/** The menu container, used to detect outside clicks. */
let container = $state<HTMLElement | null>(null);

/** Display label for the current user (display name, else username). */
let label = $derived(identity.user?.displayName || identity.user?.username || "Account");

function toggle() {
  open = !open;
}

function close() {
  open = false;
}

function handleLogout() {
  close();
  forceLogout();
}

/** Closes the menu when clicking outside of it. */
function onWindowPointerDown(event: PointerEvent) {
  if (!open) return;
  if (container && event.target instanceof Node && !container.contains(event.target)) {
    close();
  }
}

function onWindowKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") close();
}
</script>

<svelte:window onpointerdown={onWindowPointerDown} onkeydown={onWindowKeydown} />

<div class="relative" bind:this={container}>
  <Button
    type="button"
    variant="outline"
    onclick={toggle}
    aria-haspopup="menu"
    aria-expanded={open}
    class="text-sm text-foreground transition-colors gap-1.5"
  >
    <UserIcon size={16} aria-hidden="true" />
    <span class="max-w-48 truncate">{label}</span>
    <CaretDownIcon size={12} aria-hidden="true" class="opacity-70 {open ? "rotate-180" : ""} transition-transform" />
  </Button>

  {#if open}
    <div
      role="menu"
      class="absolute right-0 mt-1 min-w-40 rounded-md border border-border bg-background text-foreground p-1 shadow-md z-50"
    >
      <button
        type="button"
        role="menuitem"
        onclick={handleLogout}
        class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-left
          text-foreground hover:bg-accent hover:text-foreground transition-colors"
      >
        <SignOutIcon size={16} aria-hidden="true" />
        Logout
      </button>
    </div>
  {/if}
</div>
