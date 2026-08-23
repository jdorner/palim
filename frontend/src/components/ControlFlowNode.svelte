<script lang="ts">
import { Handle, Position } from "@xyflow/svelte";
import { type NodeStatus, statusVisual, visualForStepType } from "$lib/nodeVisuals";

interface Props {
  id: string;
  data: {
    slug: string;
    type: string;
    status?: NodeStatus;
    selected?: boolean;
    /** Branch labels for source handles (e.g. ["then", "else"] or path keys). */
    branches?: string[];
  };
}

let { id, data }: Props = $props();

let status = $derived<NodeStatus>(data.status ?? "waiting");
let isSkipped = $derived(status === "skipped");

let visual = $derived(visualForStepType(data.type));
let statusInfo = $derived(statusVisual(status));
let branches = $derived(data.branches ?? []);

// Selection ring takes precedence; otherwise reflect run status. Applied to the
// rotated diamond face so the accent traces the diamond outline.
let ringClass = $derived(data.selected ? "ring-2 ring-primary" : `ring-2 ${statusInfo.ringClass}`);
</script>

<div
  class="relative flex items-center justify-center"
  style="width: 108px; height: 108px;"
  class:opacity-50={isSkipped}
>
  <!-- Diamond face via CSS rotation -->
  <div
    class="absolute inset-4 rounded-md border border-sky-400/70 bg-card shadow-sm {ringClass}"
    style="transform: rotate(45deg);"
  ></div>

  <!-- Content (upright, centered over the diamond) -->
  <div class="relative z-10 flex flex-col items-center gap-0.5 px-1 text-center">
    <div class="flex h-7 w-7 items-center justify-center rounded-md text-white {visual.tileClass}">
      <visual.icon size={15} weight="bold" aria-hidden="true" />
    </div>
    <div class="max-w-16 truncate text-[10px] font-semibold text-foreground">{data.slug}</div>
  </div>

  <!-- Status badge, pinned to the top point of the diamond -->
  {#if statusInfo.icon}
    {@const StatusIcon = statusInfo.icon}
    <div class="absolute right-3 top-3 z-20 rounded-full bg-background">
      <StatusIcon
        size={14}
        weight="fill"
        class="{statusInfo.colorClass} {statusInfo.spin ? 'animate-spin' : ''}"
        aria-hidden="true"
      />
    </div>
  {/if}

  <!-- Target handle: left point of diamond (center-left) -->
  <Handle
    type="target"
    position={Position.Left}
    style="left: 0px; top: 50%;"
    class="h-2.5! w-2.5! border-2! border-background! bg-sky-500!"
  />

  {#if branches.length > 0}
    <!-- Source handles: right side, stacked vertically per branch. Spacing
         scales down as branch count grows so many-branch case nodes stay
         compact, but stays wide enough that edges leave from distinct points
         and do not overlap near the source. Each handle gets a small label pill
         so branch names (then/else/path keys) are legible. -->
    {#each branches as branch, i}
      {@const spacing = branches.length > 4 ? 24 : 18}
      {@const totalHeight = (branches.length - 1) * spacing}
      {@const yOffset = branches.length === 1 ? 0 : i * spacing - totalHeight / 2}
      <Handle
        type="source"
        position={Position.Right}
        id="{id}-{data.type === 'case' && branch !== 'default' ? `path-${branch}` : branch}"
        style="right: 0px; top: calc(50% + {yOffset}px);"
        class="h-2.5! w-2.5! border-2! border-background! bg-sky-500!"
      />
      <span
        class="pointer-events-none absolute z-20 whitespace-nowrap rounded bg-muted px-1 py-px text-[8px] font-medium text-muted-foreground"
        style="left: calc(100% + 6px); top: calc(50% + {yOffset}px); transform: translateY(-50%);"
      >
        {branch}
      </span>
    {/each}
  {:else}
    <Handle
      type="source"
      position={Position.Right}
      style="right: 0px; top: 50%;"
      class="h-2.5! w-2.5! border-2! border-background! bg-sky-500!"
    />
  {/if}
</div>
