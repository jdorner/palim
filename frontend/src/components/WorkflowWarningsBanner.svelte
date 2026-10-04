<script lang="ts">
/**
 * Collapsible banner listing a workflow's template/config warnings. Collapsed
 * by default so it stays compact; the header count still signals the issues.
 */
import CaretRightIcon from "phosphor-svelte/lib/CaretRightIcon";
import WarningIcon from "phosphor-svelte/lib/WarningIcon";
import { slide } from "svelte/transition";
import type { WorkflowWarning } from "$lib/workflowDetail";

interface Props {
  /** Warnings to list; the banner is hidden when empty. */
  warnings: WorkflowWarning[];
}

let { warnings }: Props = $props();

let expanded = $state(false);
</script>

{#if warnings.length > 0}
  <div class="mb-4 px-3 py-2 rounded-md border border-amber-500/50 bg-amber-500/10 text-sm shrink-0">
    <button
      type="button"
      class="flex w-full items-center gap-1.5 font-medium text-amber-500 text-left"
      aria-expanded={expanded}
      onclick={() => {
        expanded = !expanded;
      }}
    >
      <CaretRightIcon size={12} aria-hidden="true" class="transition-transform {expanded ? "rotate-90" : ""}" />
      <WarningIcon size={14} aria-hidden="true" />
      Template {warnings.length === 1 ? "Issue" : "Issues"} ({warnings.length})
    </button>
    {#if expanded}
      <ul class="list-disc list-inside text-xs text-amber-500/80 space-y-0.5 mt-1" transition:slide={{ duration: 100 }}>
        {#each warnings as warning}
          <li><span class="font-mono">{warning.stepSlug}.{warning.field}</span>: {warning.message}</li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}
