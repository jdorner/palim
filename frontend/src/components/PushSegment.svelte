<script lang="ts">
import ArrowSquareInIcon from "phosphor-svelte/lib/ArrowSquareInIcon";
import { renderMarkdown } from "$lib/utils";

interface Props {
  content: string;
  contentType: string;
}

let { content, contentType }: Props = $props();
</script>

<div class="flex justify-start">
  <div
    class="max-w-none rounded-lg px-4 py-2 text-sm border-l-4 border-primary/50 bg-primary/5 dark:bg-primary/10 text-foreground"
  >
    <div class="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
      <ArrowSquareInIcon class="w-3.5 h-3.5" aria-hidden="true" />
      <span>Push</span>
    </div>
    {#if contentType === "text/markdown"}
      <div class="prose prose-sm dark:prose-invert max-w-none">
        <span class="markdown">{@html renderMarkdown(content)}</span>
      </div>
    {:else}
      <pre class="whitespace-pre-wrap text-sm font-mono">{content}</pre>
    {/if}
  </div>
</div>
