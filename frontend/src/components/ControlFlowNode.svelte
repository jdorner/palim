<script lang="ts">
import { Handle, Position } from "@xyflow/svelte";
import { labelForStepType } from "$lib/stepTypes";

interface Props {
  id: string;
  data: {
    slug: string;
    type: string;
    status?: "waiting" | "active" | "completed" | "failed" | "waiting-signal" | "skipped";
    selected?: boolean;
    /** Branch labels for source handles (e.g. ["then", "else"] or path keys). */
    branches?: string[];
  };
}

let { id, data }: Props = $props();

const statusColors: Record<string, string> = {
  waiting: "bg-muted border-border",
  active: "bg-yellow-100 border-yellow-400 dark:bg-yellow-900/30 dark:border-yellow-600",
  completed: "bg-green-100 border-green-400 dark:bg-green-900/30 dark:border-green-600",
  failed: "bg-red-100 border-red-400 dark:bg-red-900/30 dark:border-red-600",
  "waiting-signal": "bg-amber-100 border-amber-400 dark:bg-amber-900/30 dark:border-amber-600",
  skipped: "bg-muted/50 border-border/50 opacity-50",
};

let colorClass = $derived(
  data.selected
    ? "bg-orange-100 border-orange-400 dark:bg-orange-900/30 dark:border-orange-500"
    : (statusColors[data.status ?? "waiting"] ?? statusColors.waiting),
);
let typeLabel = $derived(labelForStepType(data.type));

let branches = $derived(data.branches ?? []);
</script>

<div class="relative flex items-center justify-center" style="width: 100px; height: 100px;">
  <!-- Diamond shape via CSS rotation -->
  <div
    class="absolute inset-3.5 border-2 shadow-sm {colorClass}"
    style="transform: rotate(45deg); border-radius: 4px;"
  ></div>
  <!-- Content -->
  <div class="relative z-10 text-center px-1">
    <div class="text-[10px] font-medium text-foreground truncate max-w-15">{data.slug}</div>
    <div class="text-[9px] text-muted-foreground">{typeLabel}</div>
  </div>

  <!-- Target handle: left point of diamond (center-left) -->
  <Handle type="target" position={Position.Left} style="left: 0px; top: 50%;" />

  {#if branches.length > 0}
    <!-- Source handles: right side, stacked vertically per branch -->
    {#each branches as branch, i}
      {@const spacing = 16}
      {@const totalHeight = (branches.length - 1) * spacing}
      {@const yOffset = branches.length === 1 ? 0 : i * spacing - totalHeight / 2}
      <Handle
        type="source"
        position={Position.Right}
        id="{id}-{data.type === 'case' && branch !== 'default' ? `path-${branch}` : branch}"
        style="right: 0px; top: calc(50% + {yOffset}px);"
      />
    {/each}
  {:else}
    <Handle type="source" position={Position.Right} style="right: 0px; top: 50%;" />
  {/if}
</div>
