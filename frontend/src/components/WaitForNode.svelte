<script lang="ts">
import { Handle, Position } from "@xyflow/svelte";
import { type NodeStatus, statusVisual, visualForStepType } from "$lib/nodeVisuals";
import { labelForStepType } from "$lib/stepTypes";

interface Props {
  data: {
    slug: string;
    type: string;
    status?: NodeStatus;
    selected?: boolean;
  };
}

let { data }: Props = $props();

let status = $derived<NodeStatus>(data.status ?? "waiting");
let isSkipped = $derived(status === "skipped");
let isWaitingSignal = $derived(status === "waiting-signal");

let visual = $derived(visualForStepType(data.type));
let statusInfo = $derived(statusVisual(status));
let typeLabel = $derived(labelForStepType(data.type).replace(/^[^\w]+\s*/u, ""));

// A node actively waiting for its signal gets an amber pulse ring to stand out.
let ringClass = $derived(
  data.selected
    ? "ring-2 ring-primary"
    : isWaitingSignal
      ? "ring-2 ring-amber-400/70 animate-pulse"
      : `ring-2 ${statusInfo.ringClass}`,
);
</script>

<div
  class="relative flex items-center gap-2.5 w-55 rounded-xl border border-border bg-card px-3 py-2.5 shadow-sm transition-shadow hover:shadow-md {ringClass}"
  class:opacity-50={isSkipped}
>
  <Handle
    type="target"
    position={Position.Left}
    class="h-2.5! w-2.5! border-2! border-background! bg-muted-foreground!"
  />

  <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white {visual.tileClass}">
    <visual.icon size={18} weight="bold" aria-hidden="true" />
  </div>

  <div class="min-w-0 flex-1 text-left">
    <div class="truncate text-xs font-semibold text-foreground">{data.slug}</div>
    <div class="truncate text-[10px] text-muted-foreground">{typeLabel}</div>
  </div>

  {#if statusInfo.icon}
    {@const StatusIcon = statusInfo.icon}
    <StatusIcon
      size={16}
      weight="fill"
      class="shrink-0 {statusInfo.colorClass} {statusInfo.spin ? 'animate-spin' : ''}"
      aria-hidden="true"
    />
  {/if}

  <Handle
    type="source"
    position={Position.Right}
    class="h-2.5! w-2.5! border-2! border-background! bg-muted-foreground!"
  />
</div>
