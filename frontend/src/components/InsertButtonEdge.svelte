<script lang="ts">
import { BaseEdge, type Position, portal, useStore } from "@xyflow/svelte";
import { getSmoothStepPath } from "@xyflow/system";
import PlusIcon from "phosphor-svelte/lib/PlusIcon";
/**
 * Custom edge that renders a smooth-step path with a "+" button at the midpoint.
 *
 * The button is portaled into the `edge-labels` overlay (the same layer the edge
 * label is rendered into) with a z-index one above the label, so it always paints
 * on top of the label. It is only revealed while the edge is hovered: an invisible
 * wide hit path along the edge drives a `hovered` state, and a short grace timer
 * keeps the button alive while the pointer moves from the edge onto the button.
 */
import { onDestroy } from "svelte";

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

const store = useStore();

// Mirrors EdgeLabel: the label is painted at the edge's zIndex inside the
// `edge-labels` overlay, so the button uses zIndex + 1 to sit just above it.
let zIndex = $derived(store.visible.edges.get(id)?.zIndex ?? 0);

let isEditable = $derived(data?.editMode === true && !!data?.onInsert);

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

// Brief delay before hiding so the button doesn't flicker out while the pointer
// travels from the edge hit path onto the button itself.
const HIDE_DELAY = 120;
let hovered = $state(false);
let hideTimer: ReturnType<typeof setTimeout> | undefined;

// The button follows the pointer along the edge so it shows up right where you
// hover (left / middle / right), not only at the fixed midpoint.
let hoverPos = $state({ x: 0, y: 0 });
let hasPos = $state(false);

function onEnter() {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = undefined;
  }
  hovered = true;
}

function onLeave() {
  if (hideTimer) return;
  hideTimer = setTimeout(() => {
    hovered = false;
    hideTimer = undefined;
  }, HIDE_DELAY);
}

onDestroy(() => {
  if (hideTimer) clearTimeout(hideTimer);
});

// Convert a pointer event to flow (SVG) coordinates so the button can be placed
// at the hovered spot on the edge. If the transform can't be resolved, the
// button falls back to the midpoint.
function trackPos(e: PointerEvent) {
  const svg = (e.currentTarget as SVGElement).ownerSVGElement;
  const ctm = svg?.getScreenCTM();
  if (!ctm) return;
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
  hoverPos = { x: p.x, y: p.y };
  hasPos = true;
}

const btnX = $derived(hasPos ? hoverPos.x : labelX);
const btnY = $derived(hasPos ? hoverPos.y : labelY);

function handleClick(e: MouseEvent) {
  e.stopPropagation();
  data?.onInsert?.({ x: e.clientX, y: e.clientY });
}
</script>

<BaseEdge {id} {path} {markerEnd} {markerStart} {style} {label} {labelStyle} {labelX} {labelY} />

{#if isEditable}
  <!-- Invisible wide hit path: the always-present hover target for the whole edge. -->
  <path
    d={path}
    class="insert-hit"
    fill="none"
    stroke="transparent"
    stroke-width={24}
    aria-hidden="true"
    onpointerenter={(e) => {
      onEnter();
      trackPos(e);
    }}
    onpointermove={trackPos}
    onpointerleave={onLeave}
  />

  <!--
    Button portaled into the edge-labels overlay, above the label (zIndex + 1).
    Always mounted so the portal is stable and its pointer handlers stay live;
    visibility is toggled via opacity + pointer-events. It follows the pointer
    along the edge so it appears where you hover, not only at the midpoint.
  -->
  <div
    use:portal={'edge-labels'}
    class="insert-edge-wrap"
    role="presentation"
    style:z-index={zIndex + 1}
    style:transform="translate(-50%, -50%) translate({btnX}px, {btnY}px)"
    style:opacity={hovered ? "1" : "0"}
    style:pointer-events={hovered ? "all" : "none"}
    onpointerenter={onEnter}
    onpointerleave={onLeave}
  >
    <button type="button" class="insert-edge-btn" onclick={handleClick} title="Insert step here">
      <PlusIcon size={11} weight="bold" />
    </button>
  </div>
{/if}

<style>
.insert-hit {
  pointer-events: stroke;
}
.insert-edge-wrap {
  position: absolute;
  left: 0;
  top: 0;
}
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
