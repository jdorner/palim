<script lang="ts">
import XIcon from "phosphor-svelte/lib/XIcon";
import type { Snippet } from "svelte";
import { tick } from "svelte";
import { cn } from "$lib/utils";

interface Props {
  /** Whether the dialog is open. */
  open?: boolean;
  /** Dialog title. */
  title: string;
  /** Optional muted text below the title. */
  description?: string;
  /** Extra classes for the panel (e.g. a wider max-width). */
  class?: string;
  /** Called when the user dismisses the dialog (Escape, backdrop click, or the close button). */
  onClose?: () => void;
  /** Called on Ctrl/Cmd+S or Ctrl/Cmd+Enter inside the dialog. */
  onSave?: () => void;
  /** Dialog body. */
  children?: Snippet;
  /** Action row, rendered right-aligned below the body. */
  footer?: Snippet;
}

let { open = false, title, description, class: className, onClose, onSave, children, footer }: Props = $props();

let panelEl = $state<HTMLDivElement | undefined>(undefined);
const titleId = `dialog-title-${Math.random().toString(36).slice(2, 9)}`;

$effect(() => {
  if (open) {
    tick().then(() => {
      const first = panelEl?.querySelector<HTMLElement>(
        "input:not([disabled]), textarea, select, button:not([disabled]):not([data-dialog-close])",
      );
      first?.focus();
    });
  }
});

function handleBackdropClick(e: MouseEvent) {
  if (e.target === e.currentTarget) onClose?.();
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") onClose?.();
  if (onSave && (e.key === "s" || e.key === "Enter") && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    onSave();
  }
}
</script>

{#if open}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <!-- svelte-ignore a11y_interactive_supports_focus -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    role="dialog"
    aria-modal="true"
    aria-labelledby={titleId}
    onclick={handleBackdropClick}
    onkeydown={handleKeydown}
  >
    <div
      bind:this={panelEl}
      class={cn(
        "bg-background border border-border rounded-lg shadow-lg w-full max-w-md max-h-full flex flex-col",
        className,
      )}
    >
      <div class="px-6 pt-5 pb-3 flex items-start justify-between gap-4">
        <div class="min-w-0 space-y-1">
          <h2 id={titleId} class="text-lg font-semibold">{title}</h2>
          {#if description}
            <p class="text-sm text-muted-foreground">{description}</p>
          {/if}
        </div>
        {#if onClose}
          <button
            type="button"
            aria-label="Close"
            data-dialog-close
            onclick={onClose}
            class="-mr-2 -mt-1 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <XIcon size={16} aria-hidden="true" />
          </button>
        {/if}
      </div>
      <div class="px-6 py-2 overflow-y-auto space-y-4">{@render children?.()}</div>
      {#if footer}
        <div class="px-6 pt-3 pb-5 flex flex-wrap justify-end gap-2">{@render footer()}</div>
      {/if}
    </div>
  </div>
{/if}
