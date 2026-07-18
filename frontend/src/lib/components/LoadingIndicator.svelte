<script lang="ts">
import SpinnerGapIcon from "phosphor-svelte/lib/SpinnerGapIcon";
import { onDestroy } from "svelte";

interface Props {
  message?: string;
  delay?: number;
}

let { message = "Loading...", delay = 350 }: Props = $props();

let visible = $state(false);
let timer: ReturnType<typeof setTimeout> | undefined;

$effect(() => {
  if (delay <= 0) {
    visible = true;
  } else {
    timer = setTimeout(() => {
      visible = true;
    }, delay);
  }
});

onDestroy(() => {
  if (timer) clearTimeout(timer);
});
</script>

{#if visible}
  <div class="flex items-center gap-2 text-muted-foreground py-4">
    <SpinnerGapIcon class="w-5 h-5 animate-spin" aria-hidden="true" />
    <span class="text-base">{message}</span>
  </div>
{/if}
