<script lang="ts">
import CheckCircleIcon from "phosphor-svelte/lib/CheckCircleIcon";
import InfoIcon from "phosphor-svelte/lib/InfoIcon";
import WarningIcon from "phosphor-svelte/lib/WarningIcon";

let { message = $bindable(null), timeout = 4000, variant = $bindable("accent") } = $props();

let timer = 0;

$effect(() => {
  if (message && timeout > 0) {
    clearTimeout(timer);
    timer = setTimeout(() => (message = null), timeout);
  }
});
</script>

{#if message}
  {#if variant === "success"}
    <div class="flex items-center gap-2 text-sm border border-background px-3 py-2 text-green-600 dark:text-green-400">
      <CheckCircleIcon class="w-4 h-4 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </div>
  {:else if variant === "error"}
    <div class="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-destructive">
      <WarningIcon class="w-4 h-4 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </div>
  {:else if variant === "info"}
    <div
      class="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground"
    >
      <InfoIcon class="w-4 h-4 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </div>
  {:else}
    <div class="px-3 py-2 rounded-md bg-accent text-accent-foreground text-sm">{message}</div>
  {/if}
{/if}
