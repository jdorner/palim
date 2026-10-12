<!--
  An (i) icon that shows explanatory text in a tooltip, placed next to a field
  label instead of a hint line under the field.
-->
<script lang="ts">
import { Tooltip } from "bits-ui";
import InfoIcon from "phosphor-svelte/lib/InfoIcon";

interface Props {
  /** The explanation. */
  text: string;
}

let { text }: Props = $props();
</script>

<Tooltip.Root delayDuration={0}>
  <Tooltip.Trigger
    class="inline-flex items-center pointer-events-auto cursor-help text-muted-foreground/60 hover:text-muted-foreground"
    aria-label={text}
  >
    <InfoIcon class="w-4 h-4" />
  </Tooltip.Trigger>
  <Tooltip.Portal>
    <Tooltip.Content
      class="z-9999 max-w-64 rounded-md border border-border px-3 py-2 text-xs text-foreground shadow-md"
      style="background: hsl(var(--popover));"
      sideOffset={4}
      side="top"
    >
      {text}
    </Tooltip.Content>
  </Tooltip.Portal>
</Tooltip.Root>
