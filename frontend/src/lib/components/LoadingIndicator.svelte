<script lang="ts">
import SpinnerGapIcon from "phosphor-svelte/lib/SpinnerGapIcon";
import { onDestroy } from "svelte";
import { useI18n } from "$lib/kitI18n";

interface Props {
  message?: string;
  delay?: number;
}

let { message, delay = 350 }: Props = $props();

const i18n = useI18n();

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
    <span class="text-base">{message ?? $i18n.t("common.loading")}</span>
  </div>
{/if}
