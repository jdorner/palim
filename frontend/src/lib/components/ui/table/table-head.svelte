<script lang="ts">
import type { Snippet } from "svelte";
import { cn } from "$lib/utils";

interface Props extends Record<string, any> {
  class?: string;
  children?: Snippet;
}

let { class: className, children, ...restProps }: Props = $props();
</script>

<th
  class={cn("h-10 px-3 text-left align-middle font-medium text-muted-foreground has-[[role=checkbox]]:pr-0", className)}
  {...restProps}
>
  {@render children?.()}
</th>
