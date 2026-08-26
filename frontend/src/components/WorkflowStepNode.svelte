<script lang="ts">
import { Handle, Position } from "@xyflow/svelte";
import WarningCircleIcon from "phosphor-svelte/lib/WarningCircleIcon";
import { type NodeStatus, statusVisual, visualForStepType } from "$lib/nodeVisuals";
import { labelForStepType } from "$lib/stepTypes";

interface Props {
  data: {
    slug: string;
    type: string;
    status?: NodeStatus;
    triggerType?: string;
    /** Optional custom-extension icon id for the shared icon registry. */
    iconId?: string;
    /** Optional custom-extension palette category (drives the accent color). */
    category?: string;
    selected?: boolean;
    terminal?: boolean;
    /** Whether this step has a configuration/template error (shows red badge). */
    hasError?: boolean;
  };
}

let { data }: Props = $props();

let isTrigger = $derived(data.type === "trigger");
let isTerminal = $derived(data.terminal === true);
let status = $derived<NodeStatus>(data.status ?? "waiting");
let isSkipped = $derived(status === "skipped");

let visual = $derived(
  visualForStepType(data.type, { triggerType: data.triggerType, iconId: data.iconId, category: data.category }),
);
let statusInfo = $derived(statusVisual(status));

// Plain-text type label for the card subtitle; the icon tile conveys the
// type visually.
let typeLabel = $derived(labelForStepType(data.type, data.triggerType));

// Selection ring takes precedence; otherwise the ring reflects run status.
let ringClass = $derived(data.selected ? "ring-2 ring-primary" : `ring-2 ${statusInfo.ringClass}`);
</script>

<div
  class="group relative flex items-center gap-2.5 w-55 rounded-xl border border-border bg-card px-3 py-2.5 shadow-sm transition-shadow hover:shadow-md {ringClass}"
  class:opacity-50={isSkipped}
  class:border-dashed={isTrigger}
>
  {#if !isTrigger}
    <Handle
      type="target"
      position={Position.Left}
      class="h-2.5! w-2.5! border-2! border-background! bg-muted-foreground!"
    />
  {/if}

  <!-- Icon tile -->
  <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white {visual.tileClass}">
    <visual.icon size={18} weight="bold" aria-hidden="true" />
  </div>

  <!-- Name + subtitle -->
  <div class="min-w-0 flex-1 text-left">
    <div class="truncate text-xs font-semibold text-foreground">{data.slug}</div>
    <div class="truncate text-[10px] text-muted-foreground">{typeLabel}</div>
  </div>

  <!-- Status badge -->
  {#if statusInfo.icon}
    {@const StatusIcon = statusInfo.icon}
    <StatusIcon
      size={16}
      weight="fill"
      class="shrink-0 {statusInfo.colorClass} {statusInfo.spin ? 'animate-spin' : ''}"
      aria-hidden="true"
    />
  {/if}

  {#if !isTerminal}
    <Handle
      type="source"
      position={Position.Right}
      class="h-2.5! w-2.5! border-2! border-background! bg-muted-foreground!"
    />
  {/if}

  <!-- Config/template error badge: red circle with white exclamation mark,
       pinned to the top-right corner of the card. -->
  {#if data.hasError}
    <div
      class="absolute -right-2 -top-2 z-30 rounded-full bg-white leading-none"
      title="This step has a configuration error"
    >
      <WarningCircleIcon size={18} weight="fill" class="text-red-500" aria-label="Configuration error" />
    </div>
  {/if}
</div>
