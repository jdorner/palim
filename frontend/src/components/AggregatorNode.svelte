<script lang="ts">
import { Handle, Position } from "@xyflow/svelte";
import WarningCircleIcon from "phosphor-svelte/lib/WarningCircleIcon";
import { type NodeStatus, statusVisual, visualForStepType } from "$lib/nodeVisuals";

interface Props {
  id: string;
  data: {
    slug: string;
    type: string;
    status?: NodeStatus;
    selected?: boolean;
    hasError?: boolean;
  };
}

let { id, data }: Props = $props();

let status = $derived<NodeStatus>(data.status ?? "waiting");
let isSkipped = $derived(status === "skipped");

let visual = $derived(visualForStepType(data.type));
let statusInfo = $derived(statusVisual(status));

let strokeClass = $derived(data.selected ? "stroke-primary" : "stroke-sky-400/70");
</script>

<div class="relative flex items-center justify-center" style="width: 140px; height: 62px;" class:opacity-50={isSkipped}>
  <!-- Pentagon shape pointing left (reversed) via SVG -->
  <svg
    class="absolute inset-0 w-full h-full"
    style="filter: drop-shadow(0 1px 2px var(--tw-shadow-color, rgb(0 0 0 / 0.2)));"
    viewBox="0 0 140 60"
    role="img"
    aria-label="Aggregator node shape"
  >
    <polygon
      points="22,1 139,1 139,59 22,59 1,30"
      class="fill-card {strokeClass}"
      stroke-width={data.selected ? "2" : "1.5"}
      stroke-linejoin="round"
    />
  </svg>

  <!-- Content -->
  <div class="relative z-10 flex items-center gap-1.5 pr-2 pl-8">
    <div class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-white {visual.tileClass}">
      <visual.icon size={13} weight="bold" aria-hidden="true" />
    </div>
    <div class="max-w-16 truncate text-[10px] font-semibold text-foreground">{data.slug}</div>
  </div>

  <!-- Status badge -->
  {#if statusInfo.icon}
    {@const StatusIcon = statusInfo.icon}
    <div class="absolute right-1 top-0.5 z-20 rounded-full bg-background">
      <StatusIcon
        size={14}
        weight="fill"
        class="{statusInfo.colorClass} {statusInfo.spin ? 'animate-spin' : ''}"
        aria-hidden="true"
      />
    </div>
  {/if}

  <!-- Error badge -->
  {#if data.hasError}
    <div
      class="absolute -right-2 -top-1.5 z-30 rounded-full bg-white leading-none"
      title="This step has a configuration error"
    >
      <WarningCircleIcon size={18} weight="fill" class="text-red-500" aria-label="Configuration error" />
    </div>
  {/if}

  <!-- Target handle: left tip -->
  <Handle
    type="target"
    position={Position.Left}
    style="left: 5px; top: 50%;"
    class="h-2.5! w-2.5! border-2! border-background! bg-sky-500!"
  />

  <!-- Source handle: right center -->
  <Handle
    type="source"
    position={Position.Right}
    style="right: 2px; top: 50%;"
    class="h-2.5! w-2.5! border-2! border-background! bg-sky-500!"
  />
</div>
