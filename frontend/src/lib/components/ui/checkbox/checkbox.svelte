<script lang="ts">
import { Checkbox as CheckboxPrimitive } from "bits-ui";
import CheckIcon from "phosphor-svelte/lib/CheckIcon";
import { cn } from "$lib/utils";

let {
  class: className,
  checked = $bindable(false),
  onCheckedChange,
  ...restProps
}: {
  class?: string;
  checked?: boolean;
  onCheckedChange?: (checked: boolean | "indeterminate") => void;
} = $props();
</script>

<CheckboxPrimitive.Root
  bind:checked
  {onCheckedChange}
  class={cn(
    'peer h-4 w-4 shrink-0 rounded-sm border border-primary ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
    className
  )}
  {...restProps}
>
  {#snippet children({ checked: _isChecked })}
    {#if _isChecked}
      <div class="flex items-center justify-center text-current"><CheckIcon class="h-4 w-4" /></div>
    {/if}
  {/snippet}
</CheckboxPrimitive.Root>
