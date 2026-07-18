<script lang="ts">
import { tick } from "svelte";
import { Button } from "$lib/components/ui/button";

interface Props {
  /** Whether the dialog is open. */
  open?: boolean;
  /** Dialog title. */
  title?: string;
  /** Dialog description/body text. */
  description?: string;
  /** Label for the confirm button. */
  confirmLabel?: string;
  /** Label for the cancel button. */
  cancelLabel?: string;
  /** Visual variant for the confirm button. */
  confirmVariant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
  /** Called when the user confirms. */
  onConfirm?: () => void;
  /** Called when the user cancels or dismisses. */
  onCancel?: () => void;
}

let {
  open = false,
  title = "Are you sure?",
  description = "",
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  confirmVariant = "destructive",
  onConfirm,
  onCancel,
}: Props = $props();

let cancelBtnEl = $state<HTMLButtonElement | undefined>(undefined);

$effect(() => {
  if (open) {
    tick().then(() => cancelBtnEl?.focus());
  }
});

function handleBackdropClick(e: MouseEvent) {
  if (e.target === e.currentTarget) {
    onCancel?.();
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    onCancel?.();
  }
}
</script>

{#if open}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <!-- svelte-ignore a11y_interactive_supports_focus -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    role="dialog"
    aria-modal="true"
    aria-labelledby="alert-dialog-title"
    onclick={handleBackdropClick}
    onkeydown={handleKeydown}
  >
    <div class="bg-background border border-border rounded-lg shadow-lg p-6 max-w-sm w-full mx-4 space-y-4">
      <h2 id="alert-dialog-title" class="text-lg font-semibold">{title}</h2>
      {#if description}
        <p class="text-sm text-muted-foreground">{description}</p>
      {/if}
      <div class="flex justify-end gap-2">
        <button
          bind:this={cancelBtnEl}
          type="button"
          class="inline-flex items-center justify-center rounded-md text-sm font-medium ring-offset-background transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-9 px-3"
          onclick={() => onCancel?.()}
        >
          {cancelLabel}
        </button>
        <Button size="sm" variant={confirmVariant} onclick={() => onConfirm?.()}> {confirmLabel} </Button>
      </div>
    </div>
  </div>
{/if}
