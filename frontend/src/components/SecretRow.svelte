<script lang="ts">
import CheckCircleIcon from "phosphor-svelte/lib/CheckCircleIcon";
import CircleIcon from "phosphor-svelte/lib/CircleIcon";
import PencilSimpleIcon from "phosphor-svelte/lib/PencilSimpleIcon";
import TrashIcon from "phosphor-svelte/lib/TrashIcon";
import type { Snippet } from "svelte";
import { Button } from "$lib/components/ui/button";

/**
 * One secret in a secrets list: a status icon, the key, optional badges and
 * edit/delete actions, with row-specific content rendered beneath.
 */
interface Props {
  /** Secret key. */
  secretKey: string;
  /** Whether a value is stored for the key. */
  isSet: boolean;
  /** Highlight the row (e.g. while it is being edited elsewhere). */
  highlighted?: boolean;
  /** Edit action; the button is hidden when omitted. */
  onEdit?: () => void;
  /** Delete action; the button is hidden when omitted. */
  onDelete?: () => void;
  /** Badges and indicators rendered after the key. */
  badges?: Snippet;
  /** Content rendered beneath the header row. */
  children?: Snippet;
}

let { secretKey, isSet, highlighted = false, onEdit, onDelete, badges, children }: Props = $props();
</script>

<div class="rounded-md border border-border px-3 py-2 space-y-1.5 {highlighted ? "bg-accent" : ""}">
  <div class="flex items-center gap-2">
    {#if isSet}
      <CheckCircleIcon class="w-4 h-4 text-green-600 dark:text-green-400 shrink-0" aria-label="Secret is set" />
    {:else}
      <CircleIcon class="w-4 h-4 text-muted-foreground shrink-0" aria-label="Secret is not set" />
    {/if}

    <span class="text-sm font-medium font-mono">{secretKey}</span>

    {@render badges?.()}

    <div class="ml-auto flex items-center gap-1">
      {#if onEdit}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          class="h-7 w-7"
          aria-label="Edit {secretKey}"
          title="Edit"
          onclick={onEdit}
        >
          <PencilSimpleIcon class="w-4 h-4" aria-hidden="true" />
        </Button>
      {/if}
      {#if onDelete}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          class="h-7 w-7 text-destructive hover:text-destructive"
          aria-label="Delete {secretKey}"
          title="Delete"
          onclick={onDelete}
        >
          <TrashIcon class="w-4 h-4" aria-hidden="true" />
        </Button>
      {/if}
    </div>
  </div>

  {@render children?.()}
</div>
