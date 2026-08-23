<script lang="ts">
import { Select } from "bits-ui";
import CheckIcon from "phosphor-svelte/lib/CheckIcon";
import type { Snippet } from "svelte";
import { cn } from "$lib/utils";

interface Props extends Record<string, any> {
  class?: string;
  /** The value submitted when this item is selected. */
  value: string;
  /** Text label used for typeahead and the default rendering. */
  label?: string;
  /** Optional custom content (e.g. icon + label). Receives the selected state. */
  children?: Snippet<[{ selected: boolean; highlighted: boolean }]>;
}

let { class: className, value, label, children, ...restProps }: Props = $props();
</script>

<Select.Item
  {value}
  {label}
  class={cn(
    "relative flex w-full cursor-pointer select-none items-center gap-2 rounded-sm py-1.5 pl-2 pr-8 text-sm outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
    className,
  )}
  {...restProps}
>
  {#snippet children({ selected, highlighted })}
    {#if children}
      {@render children({ selected, highlighted })}
    {:else}
      <span class="truncate">{label ?? value}</span>
    {/if}
    {#if selected}
      <span class="absolute right-2 flex items-center justify-center">
        <CheckIcon size={16} weight="bold" aria-hidden="true" />
      </span>
    {/if}
  {/snippet}
</Select.Item>
