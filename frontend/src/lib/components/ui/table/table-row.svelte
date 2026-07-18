<script lang="ts">
import type { Snippet } from "svelte";
import { cn } from "$lib/utils";

interface Props extends Record<string, any> {
  class?: string;
  children?: Snippet;
}

let { class: className, children, ...restProps }: Props = $props();
</script>

<tr class={cn("border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted", className)} {...restProps}>
  {@render children?.()}
</tr>
