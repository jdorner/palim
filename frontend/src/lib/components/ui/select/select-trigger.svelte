<script lang="ts">
import { Select } from "bits-ui";
import CaretUpDownIcon from "phosphor-svelte/lib/CaretUpDownIcon";
import type { Snippet } from "svelte";
import { cn } from "$lib/utils";

interface Props extends Record<string, any> {
  class?: string;
  children?: Snippet;
}

let { class: className, children, ...restProps }: Props = $props();
</script>

<Select.Trigger
  class={cn(
    "flex h-8 w-full items-center justify-between gap-2 rounded-md border border-border bg-background px-2 py-1 text-sm ring-offset-background transition-colors focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
    className,
  )}
  {...restProps}
>
  <span class="flex min-w-0 flex-1 items-center gap-1.5"> {@render children?.()} </span>
  <CaretUpDownIcon size={16} class="shrink-0 text-muted-foreground" aria-hidden="true" />
</Select.Trigger>
