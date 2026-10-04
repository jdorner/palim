<script lang="ts">
import CheckCircleIcon from "phosphor-svelte/lib/CheckCircleIcon";

/** Inline success message; renders nothing while `message` is null. */
interface Props {
  /** Message to show. */
  message: string | null;
}

let { message }: Props = $props();
</script>

{#if message}
  <div class="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
    <CheckCircleIcon class="w-4 h-4 shrink-0" aria-hidden="true" />
    <span>{message}</span>
  </div>
{/if}
