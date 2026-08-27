<script lang="ts">
/**
 * Custom edge that renders a smooth-step path with a "+" button at the midpoint.
 * The button appears on hover only when the edge data has `editMode: true`,
 * allowing users to insert a new step between two existing nodes.
 */
import { BaseEdge, type Position } from "@xyflow/svelte";
import { getSmoothStepPath } from "@xyflow/system";
import PlusIcon from "phosphor-svelte/lib/PlusIcon";

interface Props {
  id: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition: Position;
  targetPosition: Position;
  style?: string;
  markerEnd?: string;
  markerStart?: string;
  label?: string;
  labelStyle?: string;
  data?: {
    editMode?: boolean;
    onInsert?: (position: { x: number; y: number }) => void;
  };
}

let {
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  markerStart,
  label,
  labelStyle,
  data,
}: Props = $props();

let [path, labelX, labelY] = $derived(
  getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  }),
);

let showButton = $derived(data?.editMode === true && !!data?.onInsert);

function handleClick(e: MouseEvent) {
  e.stopPropagation();
  data?.onInsert?.({ x: e.clientX, y: e.clientY });
}
</script>

<BaseEdge {id} {path} {markerEnd} {markerStart} {style} {label} {labelStyle} {labelX} {labelY} />

{#if showButton}
  <foreignObject
    x={labelX - 12}
    y={labelY - 12}
    width="24"
    height="24"
    style="pointer-events: all; overflow: visible;"
    class="nodrag nopan"
  >
    <button type="button" class="insert-edge-btn" onclick={handleClick} title="Insert step here">
      <PlusIcon size={11} weight="bold" />
    </button>
  </foreignObject>
{/if}

<style>
.insert-edge-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 1px solid hsl(var(--border));
  background: hsl(var(--background));
  color: hsl(var(--muted-foreground));
  cursor: pointer;
  pointer-events: all;
  transition:
    background-color 150ms,
    border-color 150ms,
    color 150ms;
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.1);
}
.insert-edge-btn:hover,
.insert-edge-btn:focus {
  background: hsl(var(--muted));
  color: hsl(var(--foreground));
  border-color: hsl(var(--primary) / 0.5);
}
</style>
