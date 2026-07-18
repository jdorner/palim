<script lang="ts">
import { Label as LabelPrimitive, type LabelRootProps } from "bits-ui";
import { cn } from "$lib/utils";

let { class: className, children, ...restProps }: LabelRootProps = $props();
</script>

<LabelPrimitive.Root
  class={cn(
    'text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
    className
  )}
  {...restProps}
>
  {@render children?.()}
</LabelPrimitive.Root>
