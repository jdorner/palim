<script lang="ts">
import { Select } from "bits-ui";
import type { Snippet } from "svelte";
import { cn } from "$lib/utils";

interface Props extends Record<string, any> {
  class?: string;
  /** Distance in px between the trigger and the content. */
  sideOffset?: number;
  children?: Snippet;
}

let { class: className, sideOffset = 4, children, ...restProps }: Props = $props();
</script>

<Select.Portal>
  <Select.Content
    {sideOffset}
    class={cn(
      "z-50 max-h-60 min-w-(--bits-select-anchor-width) overflow-hidden rounded-md border border-border bg-background text-foreground shadow-md",
      className,
    )}
    {...restProps}
  >
    <Select.Viewport class="p-1"> {@render children?.()} </Select.Viewport>
  </Select.Content>
</Select.Portal>
