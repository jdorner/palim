<script lang="ts">
import type { Snippet } from "svelte";
import { cn } from "$lib/utils";

interface Props extends Record<string, any> {
  class?: string;
  children?: Snippet;
}

let { class: className, children, ...restProps }: Props = $props();
</script>

<td class={cn("p-3 align-middle has-[[role=checkbox]]:pr-0", className)} {...restProps}>
  {@render children?.()}
</td>
