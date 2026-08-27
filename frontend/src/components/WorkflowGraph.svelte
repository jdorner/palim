<script lang="ts">
import {
  Background,
  BackgroundVariant,
  type ColorMode,
  type Connection,
  Controls,
  type Edge,
  MarkerType,
  MiniMap,
  type Node,
  SvelteFlow,
} from "@xyflow/svelte";
import "@xyflow/svelte/dist/style.css";
import { onMount, untrack } from "svelte";
import { visualForStepType } from "$lib/nodeVisuals";
import { buildDagGraph, type DagEdge, type StepData } from "$lib/workflowGraph";
import { computeLayout } from "$lib/workflowLayout";
import { type GraphStepStatus, isEdgeAnimated } from "$lib/workflowRunStatus";
import AddStepNode from "./AddStepNode.svelte";
import AggregatorNode from "./AggregatorNode.svelte";
import ControlFlowNode from "./ControlFlowNode.svelte";
import FitViewOnInit from "./FitViewOnInit.svelte";
import IteratorNode from "./IteratorNode.svelte";
import WaitForNode from "./WaitForNode.svelte";
import WorkflowStepNode from "./WorkflowStepNode.svelte";

interface StepInfo {
  /**
   * Stable synthetic node identity, independent of the editable slug. Used as
   * the SvelteFlow node id, selection key, and position-preservation key. Absent
   * in read-only run views (statusMap path), where identity falls back to slug.
   */
  id?: string;
  slug: string;
  type: string;
  status?: "waiting" | "active" | "completed" | "failed" | "waiting-signal" | "skipped";
  jobId?: string;
  [key: string]: unknown;
}

/** Status type for the statusMap prop. */
type StepStatus = "waiting" | "active" | "completed" | "failed" | "waiting-signal" | "skipped";

interface TriggerInfo {
  type: string;
  ref?: string;
}

interface Props {
  steps: StepInfo[];
  /**
   * DAG edges connecting steps. In the editor, `from`/`to` are the steps'
   * synthetic ids (stable across slug edits). In the read-only run view, steps
   * carry no synthetic id so `from`/`to` are slugs (which equal the node id
   * there). Either way the endpoints match the resolved node id space.
   */
  edges?: DagEdge[];
  trigger?: TriggerInfo;
  editMode?: boolean;
  /** Synthetic node id of the currently selected step (for highlight). */
  selectedStepId?: string;
  /** Whether the trigger node is currently selected (shows orange highlight). */
  triggerSelected?: boolean;
  fitViewTrigger?: number;
  customStepTypes?: Array<{ type: string; label: string; icon?: string; terminal?: boolean; category?: string }>;
  /**
   * Optional slug-based status map for runtime status overlay.
   * When provided, node status is resolved by slug lookup instead of by array index.
   * Used by WorkflowRunPage to overlay execution status onto the full definition graph.
   */
  statusMap?: Record<string, StepStatus>;
  /**
   * Set of step slugs that have a configuration/template error. Nodes whose
   * slug is in this set render a red error badge (circle with exclamation mark)
   * so the offending step is identifiable directly in the graph. Populated from
   * the workflow's template `warnings` in the read-only view.
   */
  errorSlugs?: Set<string>;
  /**
   * Set of synthetic node ids that have a configuration error. Used in edit
   * mode, where a step's slug may be empty or duplicated mid-edit and is thus
   * an unreliable key; the synthetic id is stable. Nodes whose id is in this
   * set render the same red error badge. Populated from the draft's inline
   * `validationErrors` (keyed by step index -> synthetic id) while editing.
   */
  errorNodeIds?: Set<string>;
  /**
   * Whether the trigger node has a configuration error (e.g. a missing/invalid
   * ref). When true the trigger node renders the same red error badge as step
   * nodes so trigger misconfiguration is visible directly on the canvas.
   */
  triggerHasError?: boolean;
  onNodeClick?: (step: StepInfo, index: number) => void;
  /** Fired when the trigger node is clicked. */
  onTriggerClick?: () => void;
  onAddStep?: (
    type?: string,
    branchContext?: { parentNodeId: string; branch?: string; lastNodeId: string | null },
  ) => void;
  onEdgesChange?: (edges: Edge[]) => void;
  /**
   * Fired when the user deletes step nodes via SvelteFlow's native keyboard
   * shortcut (Backspace/Delete). Reports the deleted steps by their synthetic
   * node id so the parent can drop them from the draft. Without this the node
   * disappears from SvelteFlow's internal store but survives in the draft and
   * reappears on the next layout recompute as an orphaned node.
   */
  onNodesDelete?: (ids: string[]) => void;
}

let {
  steps,
  edges: dagEdges = [],
  trigger,
  editMode,
  selectedStepId,
  triggerSelected = false,
  fitViewTrigger = 0,
  customStepTypes = [],
  statusMap,
  errorSlugs,
  errorNodeIds,
  triggerHasError = false,
  onNodeClick,
  onTriggerClick,
  onAddStep,
  onEdgesChange,
  onNodesDelete,
}: Props = $props();

let colorMode = $state<ColorMode>("light");

const nodeTypes = {
  step: WorkflowStepNode,
  controlFlow: ControlFlowNode,
  iterator: IteratorNode,
  aggregator: AggregatorNode,
  waitFor: WaitForNode,
  addStep: AddStepNode,
};

/**
 * Colors a node dot in the minimap by its resolved category so the overview
 * mirrors the icon-tile accents on the canvas.
 */
function miniMapNodeColor(node: Node): string {
  const type = (node.data as { type?: string } | undefined)?.type;
  const triggerType = (node.data as { triggerType?: string } | undefined)?.triggerType;
  const stepCategory = (node.data as { category?: string } | undefined)?.category;
  if (node.id.startsWith("__addStep")) return "#94a3b8";
  const { category } = visualForStepType(type ?? "", { triggerType, category: stepCategory });
  switch (category) {
    case "trigger":
      return "#10b981";
    case "agent":
      return "#8b5cf6";
    case "logic":
      return "#0ea5e9";
    default:
      return "#f59e0b";
  }
}

// ---------------------------------------------------------------------------
// Layout computation using flatten + dagre
// ---------------------------------------------------------------------------

/** Compute the full graph layout from current steps + edges. */
function computeGraphLayout(): { nodes: Node[]; edges: Edge[] } {
  // Pass steps as an ordered array (never a slug-keyed map) so two steps with
  // the same or empty slug each keep a distinct node. The editor supplies a
  // stable synthetic `id`; the read-only run view does not, so fall back to the
  // slug (always valid/unique in a saved definition) as the node identity there.
  const stepList: StepData[] = steps.map((s) => ({ ...s, id: s.id ?? s.slug }) as StepData);
  const flatGraph = buildDagGraph(stepList, dagEdges);

  // Derive the set of terminal step types from extension metadata
  const terminalTypes = new Set(customStepTypes.filter((st) => st.terminal).map((st) => st.type));

  // Map each custom step type to its registered icon id so the step node can
  // render the extension's icon instead of the generic gear fallback. The
  // workflow JSON step itself never carries an icon; it comes from the
  // extension metadata keyed by step type.
  const iconIdByType = new Map(customStepTypes.filter((st) => st.icon).map((st) => [st.type, st.icon as string]));

  // Map each custom step type to its declared palette category so the step node
  // resolves the matching accent color (control-flow -> sky, action -> amber).
  const categoryByType = new Map(
    customStepTypes.filter((st) => st.category).map((st) => [st.type, st.category as string]),
  );

  const layout = computeLayout(flatGraph, {
    trigger,
    includeAddNode: editMode && steps.length > 0,
    terminalTypes,
  });

  // Merge runtime status and selection state into node data
  const nodesWithStatus = layout.nodes.map((node) => {
    if (node.id === "__trigger__") {
      return { ...node, data: { ...node.data, selected: triggerSelected, hasError: triggerHasError } };
    }

    // Inject addStep node callbacks and custom types (root + branch)
    if (node.id === "__addStep__" || node.id.startsWith("__addStep:")) {
      // Branch add-step: carries parentNodeId + branch (+ optional lastNodeId).
      // Root add-step: carries sourceNodeId (the tail of the main chain); the
      // new step must be appended sequentially after it so it stays attached.
      const branchContext =
        node.data.parentNodeId && node.data.branch
          ? {
              parentNodeId: node.data.parentNodeId as string,
              branch: node.data.branch as string,
              lastNodeId: (node.data.lastNodeId as string | null | undefined) ?? null,
            }
          : node.data.sourceNodeId
            ? {
                parentNodeId: node.data.sourceNodeId as string,
                lastNodeId: node.data.sourceNodeId as string,
              }
            : undefined;

      return {
        ...node,
        data: {
          ...node.data,
          onSelectType: (type: string) => onAddStep?.(type, branchContext),
          customStepTypes,
        },
      };
    }

    // Node IDs are step slugs in the DAG model. Resolve status/selection by slug.
    const isTerminal = terminalTypes.has(node.data.type as string);
    const slug = node.data.slug as string;
    const hasError = (errorSlugs?.has(slug) ?? false) || (errorNodeIds?.has(node.id) ?? false);
    const iconId = iconIdByType.get(node.data.type as string);
    const category = categoryByType.get(node.data.type as string);

    if (statusMap) {
      const status = statusMap[slug] ?? "waiting";
      return {
        ...node,
        data: {
          ...node.data,
          status,
          selected: node.id === selectedStepId,
          terminal: isTerminal,
          hasError,
          iconId,
          category,
        },
      };
    }

    const step = steps.find((s) => s.slug === slug);
    return {
      ...node,
      data: {
        ...node.data,
        status: step?.status ?? node.data.status ?? "waiting",
        selected: node.id === selectedStepId,
        terminal: isTerminal,
        hasError,
        iconId,
        category,
      },
    };
  });

  // Animate edges whose target node is active (incl. the trigger -> first-step edge)
  const statusNodes = nodesWithStatus.map((n) => ({
    id: n.id,
    status: (n.data as Record<string, unknown> | undefined)?.status as GraphStepStatus | undefined,
  }));
  const edgesWithAnimation = layout.edges.map((edge) => {
    // Add-step edges are dashed placeholders (they carry a stroke-dasharray
    // style); keep them arrow-free and muted. Real flow edges get an arrowhead
    // and a smooth curve so direction reads clearly.
    const isAddStepEdge = edge.target === "__addStep__" || edge.target.startsWith("__addStep:");
    return {
      ...edge,
      type: "smoothstep",
      animated: isEdgeAnimated({ source: edge.source, target: edge.target, animated: edge.animated }, statusNodes),
      ...(isAddStepEdge
        ? {}
        : {
            markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
          }),
      // Rounded branch-label pills for readable then/else/case labels.
      ...(edge.label
        ? {
            labelBgPadding: [6, 3] as [number, number],
            labelBgBorderRadius: 6,
            labelBgStyle: "fill: hsl(var(--muted)); fill-opacity: 0.95;",
            labelStyle: "fill: hsl(var(--muted-foreground)); font-size: 10px; font-weight: 500;",
          }
        : {}),
    };
  });

  return { nodes: nodesWithStatus, edges: edgesWithAnimation };
}

// ---------------------------------------------------------------------------
// View mode: derived layout (recomputed when steps/trigger/selection change)
// ---------------------------------------------------------------------------

let derivedLayout = $derived(computeGraphLayout());

// ---------------------------------------------------------------------------
// SvelteFlow state
//
// SvelteFlow manages its own internal nodes/edges store seeded from these
// bound arrays. It does NOT repaint when only nested `data` (status/animated)
// values change behind a new array identity, so we cannot hand it a plain
// $derived. Instead we own `nodes`/`edges` as $state and sync the derived
// layout into them via an $effect (view mode) while preserving user-dragged
// positions in edit mode. Reassigning the arrays here is what makes live
// status/animation updates (e.g. WebSocket-driven run progress) repaint.
// ---------------------------------------------------------------------------

let nodes = $state<Node[]>([]);
let edges = $state<Edge[]>([]);

let prevEditMode = $state(false);
let prevNodeIds = $state<string>("");

/**
 * Builds a stable structural fingerprint from the computed layout: the sorted
 * set of node IDs PLUS the sorted set of edges (source, target, handle). Node
 * IDs alone are insufficient because connecting a branch tail to a shared join
 * node re-anchors an existing add-step node (same ID, new position and source
 * edge) without changing the node-ID set. Folding edges into the fingerprint
 * makes that re-anchoring register as a structural change so the effect takes
 * the full-reseed path and drops the stale add-step position.
 */
function layoutFingerprint(layout: { nodes: Node[]; edges: Edge[] }): string {
  const nodeIds = layout.nodes.map((n) => n.id).sort();
  // Fold the edge label into the key alongside source/target/handle. A branch
  // label edit (e.g. an if node's custom then/else label) changes only the edge
  // label, not the endpoints; without the label here the fingerprint would be
  // unchanged, the data-only path would leave the bound `edges` store stale, and
  // the graph would show duplicated/mismatched edge labels until the next
  // structural change. Including it forces a full edge reseed on relabel.
  const edgeKeys = layout.edges.map((e) => `${e.source}>${e.target}>${e.sourceHandle ?? ""}>${e.label ?? ""}`).sort();
  return `${nodeIds.join(" ")}||${edgeKeys.join(" ")}`;
}

$effect(() => {
  const layout = derivedLayout;
  const currentNodeIds = layoutFingerprint(layout);

  const enteringEditMode = editMode && !prevEditMode;
  const structureChanged = editMode && currentNodeIds !== prevNodeIds;

  if (editMode && !enteringEditMode && !structureChanged) {
    // Edit mode, stable structure: data-only update that preserves the
    // positions of user-dragged nodes.
    const layoutDataMap = new Map(layout.nodes.map((n) => [n.id, n.data]));
    nodes = untrack(() => nodes).map((node) => {
      const newData = layoutDataMap.get(node.id);
      return newData ? { ...node, data: newData } : node;
    });
  } else if (editMode) {
    // Entering edit mode or structure changed: reseed, preserving positions.
    const existingPositions = new Map(untrack(() => nodes).map((n) => [n.id, n.position]));
    nodes = layout.nodes.map((node) => {
      // Always use fresh positions for addStep nodes (they move as branches grow)
      if (node.id.startsWith("__addStep")) return node;
      const existing = existingPositions.get(node.id);
      return existing ? { ...node, position: existing } : node;
    });
    edges = [...layout.edges];
  } else {
    // View mode (e.g. run page): always take the freshly computed layout so
    // live status and edge-animation changes repaint.
    nodes = layout.nodes;
    edges = layout.edges;
  }

  prevEditMode = !!editMode;
  if (editMode) {
    prevNodeIds = currentNodeIds;
  }
});

// ---------------------------------------------------------------------------
// Node drag
// ---------------------------------------------------------------------------

function handleNodeDragStop(ev: { event: MouseEvent | TouchEvent; targetNode: Node | null; nodes: Node[] }) {
  const { targetNode } = ev;
  if (!targetNode) return;
  nodes = nodes.map((n) => (n.id === targetNode.id ? { ...n, position: targetNode.position } : n));
}

// ---------------------------------------------------------------------------
// Edge interactions (edit mode)
// ---------------------------------------------------------------------------

function isValidConnection({ source, target }: { source: string; target: string }): boolean {
  // Only reject self-loops. Fan-in (multiple incoming edges to a join node) is
  // valid in the DAG model; cycle prevention is enforced by backend validation.
  return source !== target;
}

function handleConnect(connection: Connection) {
  const { source, target, sourceHandle } = connection;
  if (!source || !target) return;

  const branch = branchFromHandle(source, sourceHandle);
  const edgeId = branch ? `${source}->${target}:${branch}` : `${source}->${target}`;

  // SvelteFlow inserts the new edge into the bound `edges` store BEFORE invoking
  // this handler, so the connection is already present (typically with an
  // auto-generated id and no label/metadata). We must therefore NOT bail out on
  // "already exists" -- that would skip the onEdgesChange notification and the
  // connection would never round-trip into the persisted workflow definition
  // (leaving the source node's add-step button visible). Instead, normalize the
  // matching edge in place (stable id + branch label) and always notify.
  const matchIndex = edges.findIndex(
    (e) => e.source === source && e.target === target && (e.sourceHandle ?? null) === (sourceHandle ?? null),
  );

  const normalized: Edge = {
    id: edgeId,
    source,
    target,
    ...(sourceHandle ? { sourceHandle } : {}),
    ...(branch ? { label: branch } : {}),
    animated: false,
  };

  if (matchIndex >= 0) {
    // SvelteFlow already added it (or a duplicate exists): replace in place so
    // the edge carries our stable id and branch metadata, then dedupe any extra
    // copies sharing the same source/target/handle.
    edges = edges
      .map((e, i) => (i === matchIndex ? normalized : e))
      .filter(
        (e, i) =>
          i === matchIndex ||
          !(e.source === source && e.target === target && (e.sourceHandle ?? null) === (sourceHandle ?? null)),
      );
  } else {
    edges = [...edges, normalized];
  }

  onEdgesChange?.(edges);
}

/**
 * Extracts the branch label from a CF node's source handle ID. Handle ids are
 * prefixed with the synthetic source node id (see ControlFlowNode.svelte, which
 * builds `<Handle id>` from the node id):
 *  - case path:  `${sourceId}-path-${key}` -> key
 *  - if / default: `${sourceId}-${branch}` -> branch
 * Returns undefined for non-CF edges (no handle).
 */
function branchFromHandle(sourceId: string, sourceHandle: string | null | undefined): string | undefined {
  if (!sourceHandle) return undefined;
  const pathPrefix = `${sourceId}-path-`;
  if (sourceHandle.startsWith(pathPrefix)) return sourceHandle.slice(pathPrefix.length);
  const prefix = `${sourceId}-`;
  if (sourceHandle.startsWith(prefix)) return sourceHandle.slice(prefix.length);
  return undefined;
}

function handleDelete({ nodes: deletedNodes, edges: deletedEdges }: { nodes: Node[]; edges: Edge[] }) {
  // Native node deletion (Backspace/Delete) removes step nodes from SvelteFlow's
  // internal store, but the underlying draft step must also be dropped or it
  // reappears on the next layout recompute as an orphaned node. Filter out
  // synthetic nodes (trigger, addStep) -- only real step nodes map to draft
  // steps -- and hand their ids to the parent for removal. The parent also
  // strips the connected edges, so we skip the edge cleanup below when nodes
  // were deleted to avoid a redundant onEdgesChange notification.
  const deletedStepNodeIds = deletedNodes
    .map((n) => n.id)
    .filter((id) => id !== "__trigger__" && !id.startsWith("__addStep"));
  if (deletedStepNodeIds.length > 0) {
    onNodesDelete?.(deletedStepNodeIds);
    return;
  }

  if (deletedEdges.length === 0) return;

  const deletedIds = new Set(deletedEdges.map((e) => e.id));
  edges = edges.filter((e) => !deletedIds.has(e.id));
  onEdgesChange?.(edges);
}

function handleBeforeReconnect(newEdge: Edge, _oldEdge: Edge): Edge | null {
  // Reject self-loops; fan-in is allowed in the DAG model.
  if (newEdge.source === newEdge.target) return null;
  return newEdge;
}

function handleReconnect(newEdge: Edge) {
  edges = edges.map((e) => (e.id === newEdge.id ? newEdge : e));
  onEdgesChange?.(edges);
}

// ---------------------------------------------------------------------------
// Node click
// ---------------------------------------------------------------------------

function handleNodeClick(ev: { event: MouseEvent | TouchEvent; node: Node }) {
  // AddStepNode handles its own clicks via the popover menu
  if (ev.node.id === "__addStep__" || ev.node.id.startsWith("__addStep:")) return;

  // Trigger node click
  if (ev.node.id === "__trigger__") {
    onTriggerClick?.();
    return;
  }

  // Resolve the clicked step by its stable synthetic node id (falling back to
  // the slug for the read-only run view, where nodes carry no synthetic id).
  // Keying on the node id -- not the slug -- means a step whose slug is
  // temporarily empty or duplicated mid-edit is still selectable.
  if (!onNodeClick) return;
  const nodeId = ev.node.id;
  const index = steps.findIndex((s) => (s.id ?? s.slug) === nodeId);
  if (index >= 0) {
    onNodeClick(steps[index], index);
  }
}

// ---------------------------------------------------------------------------
// Dark mode sync
// ---------------------------------------------------------------------------

onMount(() => {
  function sync() {
    colorMode = document.documentElement.classList.contains("dark") ? "dark" : "light";
  }
  sync();
  const observer = new MutationObserver(sync);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
});
</script>

<div class="w-full h-full border rounded-lg overflow-hidden bg-background">
  <SvelteFlow
    bind:nodes
    bind:edges
    {nodeTypes}
    {colorMode}
    nodesDraggable={editMode}
    nodesConnectable={editMode}
    elementsSelectable={editMode}
    {isValidConnection}
    onconnect={editMode ? handleConnect : undefined}
    ondelete={editMode ? handleDelete : undefined}
    onbeforereconnect={editMode ? handleBeforeReconnect : undefined}
    onreconnect={editMode ? handleReconnect : undefined}
    onnodedragstop={editMode ? handleNodeDragStop : undefined}
    onnodeclick={handleNodeClick}
  >
    <FitViewOnInit {fitViewTrigger} />
    <Background variant={BackgroundVariant.Dots} gap={20} size={1.5} patternColor="hsl(var(--border))" />
    <Controls class="shadow-md! rounded-lg! border! border-border! overflow-hidden!" />
    <MiniMap
      class="rounded-lg! border! border-border! bg-card!"
      pannable
      zoomable
      nodeColor={miniMapNodeColor}
      nodeStrokeWidth={0}
    />
  </SvelteFlow>
</div>
