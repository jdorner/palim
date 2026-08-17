<script lang="ts">
import { Handle, Position } from "@xyflow/svelte";
import { labelForStepType } from "$lib/stepTypes";

interface Props {
  data: {
    slug: string;
    type: string;
    status?: "waiting" | "active" | "completed" | "failed" | "waiting-signal";
    selected?: boolean;
  };
}

let { data }: Props = $props();

const statusColors: Record<string, string> = {
  waiting: "bg-muted border-border",
  active: "bg-yellow-100 border-yellow-400 dark:bg-yellow-900/30 dark:border-yellow-600",
  completed: "bg-green-100 border-green-400 dark:bg-green-900/30 dark:border-green-600",
  failed: "bg-red-100 border-red-400 dark:bg-red-900/30 dark:border-red-600",
  "waiting-signal": "bg-amber-100 border-amber-400 dark:bg-amber-900/30 dark:border-amber-600",
};

let colorClass = $derived(
  data.selected
    ? "bg-orange-100 border-orange-400 dark:bg-orange-900/30 dark:border-orange-500"
    : (statusColors[data.status ?? "waiting"] ?? statusColors.waiting),
);
let typeLabel = $derived(labelForStepType(data.type));
</script>

<div class="relative flex items-center justify-center" style="width: 130px; height: 130px;">
  <!-- Diamond shape via CSS rotation -->
  <div
    class="absolute inset-4 border-2 shadow-sm {colorClass}"
    style="transform: rotate(45deg); border-radius: 6px;"
  ></div>
  <!-- Content counter-rotated so text reads normally -->
  <div class="relative z-10 text-center">
    <div class="text-xs font-medium text-foreground">{data.slug}</div>
    <div class="text-[10px] text-muted-foreground mt-0.5">{typeLabel}</div>
  </div>
  <!-- Handles at left and right points of the diamond -->
  <Handle type="target" position={Position.Left} />
  <Handle type="source" position={Position.Right} />
</div>
