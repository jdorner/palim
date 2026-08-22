<script lang="ts">
import {
  Background,
  type ColorMode,
  type Connection,
  Controls,
  type Edge,
  type Node,
  SvelteFlow,
} from "@xyflow/svelte";
import "@xyflow/svelte/dist/style.css";
import { onMount, untrack } from "svelte";
import { buildDagGraph, type DagEdge, type StepData } from "$lib/workflowGraph";
import { computeLayout } from "$lib/workflowLayout";
import { type GraphStepStatus, isEdgeAnimated } from "$lib/workflowRunStatus";
import AddStepNode from "./AddStepNode.svelte";
import ControlFlowNode from "./ControlFlowNode.svelte";
import FitViewOnInit from "./FitViewOnInit.svelte";
import WaitForNode from "./WaitForNode.svelte";
import WorkflowStepNode from "./WorkflowStepNode.svelte";

interface StepInfo {
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
  /** DAG edges connecting steps by slug. */
  edges?: DagEdge[];
  trigger?: TriggerInfo;
  editMode?: boolean;
  /** Slug of the currently selected step (for highlight). */
  selectedStepSlug?: string;
  /** Whether the trigger node is currently selected (shows orange highlight). */
  triggerSelected?: boolean;
  fitViewTrigger?: number;
  customStepTypes?: Array<{ type: string; label: string; icon?: string; terminal?: boolean }>;
  /**
   * Optional slug-based status map for runtime status overlay.
   * When provided, node status is resolved by slug lookup instead of by array index.
   * Used by WorkflowRunPage to overlay execution status onto the full definition graph.
   */
  statusMap?: Record<string, StepStatus>;
  onNodeClick?: (step: StepInfo, index: number) => void;
  /** Fired when the trigger node is clicked. */
  onTriggerClick?: () => void;
  onAddStep?: (
    type?: string,
    branchContext?: { parentNodeId: string; branch: string; lastNodeId: string | null },
  ) => void;
  onEdgesChange?: (edges: Edge[]) => void;
}

let {
  steps,
  edges: dagEdges = [],
  trigger,
  editMode,
  selectedStepSlug,
  triggerSelected = false,
  fitViewTrigger = 0,
  customStepTypes = [],
  statusMap,
  onNodeClick,
  onTriggerClick,
  onAddStep,
  onEdgesChange,
}: Props = $props();

let colorMode = $state<ColorMode>("light");

const nodeTypes = { step: WorkflowStepNode, controlFlow: ControlFlowNode, waitFor: WaitForNode, addStep: AddStepNode };

// ---------------------------------------------------------------------------
// Layout computation using flatten + dagre
// ---------------------------------------------------------------------------

/** Compute the full graph layout from current steps + edges. */
function computeGraphLayout(): { nodes: Node[]; edges: Edge[] } {
  const stepsMap: Record<string, Omit<StepData, "slug">> = {};
  for (const s of steps) {
    const { slug, ...rest } = s;
    stepsMap[slug] = rest as Omit<StepData, "slug">;
  }
  const flatGraph = buildDagGraph(stepsMap, dagEdges);

  // Derive the set of terminal step types from extension metadata
  const terminalTypes = new Set(customStepTypes.filter((st) => st.terminal).map((st) => st.type));

  const layout = computeLayout(flatGraph, {
    trigger,
    includeAddNode: editMode && steps.length > 0,
    terminalTypes,
  });

  // Merge runtime status and selection state into node data
  const nodesWithStatus = layout.nodes.map((node) => {
    if (node.id === "__trigger__") {
      return { ...node, data: { ...node.data, selected: triggerSelected } };
    }

    // Inject addStep node callbacks and custom types (root + branch)
    if (node.id === "__addStep__" || node.id.startsWith("__addStep:")) {
      const branchContext =
        node.data.parentNodeId && node.data.branch
          ? {
              parentNodeId: node.data.parentNodeId as string,
              branch: node.data.branch as string,
              lastNodeId: (node.data.lastNodeId as string | null | undefined) ?? null,
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

    if (statusMap) {
      const status = statusMap[slug] ?? "waiting";
      return {
        ...node,
        data: {
          ...node.data,
          status,
          selected: slug === selectedStepSlug,
          terminal: isTerminal,
        },
      };
    }

    const step = steps.find((s) => s.slug === slug);
    return {
      ...node,
      data: {
        ...node.data,
        status: step?.status ?? node.data.status ?? "waiting",
        selected: slug === selectedStepSlug,
        terminal: isTerminal,
      },
    };
  });

  // Animate edges whose target node is active (incl. the trigger -> first-step edge)
  const statusNodes = nodesWithStatus.map((n) => ({
    id: n.id,
    status: (n.data as Record<string, unknown> | undefined)?.status as GraphStepStatus | undefined,
  }));
  const edgesWithAnimation = layout.edges.map((edge) => ({
    ...edge,
    animated: isEdgeAnimated({ target: edge.target, animated: edge.animated }, statusNodes),
  }));

  return { nodes: nodesWithStatus, edges: edgesWithAnimation };
}

// ---------------------------------------------------------------------------
// View mode: derived layout (recomputed when steps/trigger/selection change)
// ---------------------------------------------------------------------------

let derivedLayout = $derived(computeGraphLayout());
let derivedNodes = $derived<Node[]>(derivedLayout.nodes);
let derivedEdges = $derived<Edge[]>(derivedLayout.edges);

// ---------------------------------------------------------------------------
// Edit mode: mutable state seeded from layout
// ---------------------------------------------------------------------------

let editableNodes = $state<Node[]>([]);
let editableEdges = $state<Edge[]>([]);

let prevEditMode = $state(false);
let prevNodeCount = $state(0);

// Seed editable state when entering edit mode or when the graph structure changes.
$effect(() => {
  // Compute full layout to detect structural changes including addStep node presence
  const layout = computeGraphLayout();
  const currentNodeCount = layout.nodes.length;

  const enteringEditMode = editMode && !prevEditMode;
  const structureChanged = editMode && currentNodeCount !== prevNodeCount;

  if (enteringEditMode || structureChanged) {
    // Recompute layout but preserve existing positions for user-dragged nodes
    const existingPositions = new Map(untrack(() => editableNodes).map((n) => [n.id, n.position]));

    editableNodes = layout.nodes.map((node) => {
      // Always use fresh positions for addStep nodes (they move as branches grow)
      if (node.id.startsWith("__addStep")) return node;
      const existing = existingPositions.get(node.id);
      return existing ? { ...node, position: existing } : node;
    });
    editableEdges = [...layout.edges];
  } else if (editMode) {
    // Data-only update: sync slug/type/status/selected without touching positions
    const layoutDataMap = new Map(layout.nodes.map((n) => [n.id, n.data]));

    editableNodes = untrack(() => editableNodes).map((node) => {
      const newData = layoutDataMap.get(node.id);
      return newData ? { ...node, data: newData } : node;
    });
  }

  prevEditMode = !!editMode;
  if (editMode) {
    prevNodeCount = currentNodeCount;
  }
});

// The state passed to SvelteFlow
let nodes = $derived<Node[]>(editMode ? editableNodes : derivedNodes);
let edges = $derived<Edge[]>(editMode ? editableEdges : derivedEdges);

// ---------------------------------------------------------------------------
// Node drag
// ---------------------------------------------------------------------------

function handleNodeDragStop(ev: { event: MouseEvent | TouchEvent; targetNode: Node | null; nodes: Node[] }) {
  const { targetNode } = ev;
  if (!targetNode) return;
  editableNodes = editableNodes.map((n) => (n.id === targetNode.id ? { ...n, position: targetNode.position } : n));
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
  const newEdge: Edge = {
    id: branch ? `${source}->${target}:${branch}` : `${source}->${target}`,
    source,
    target,
    ...(sourceHandle ? { sourceHandle } : {}),
    ...(branch ? { label: branch } : {}),
    animated: false,
  };

  // Avoid duplicate edges (same source+target+handle)
  const exists = editableEdges.some(
    (e) => e.source === source && e.target === target && (e.sourceHandle ?? null) === (sourceHandle ?? null),
  );
  if (exists) return;

  editableEdges = [...editableEdges, newEdge];
  onEdgesChange?.(editableEdges);
}

/**
 * Extracts the branch label from a CF node's source handle ID.
 * Mirrors the convention in workflowGraph.ts / ControlFlowNode.svelte:
 *  - case path:  `${slug}-path-${key}` -> key
 *  - if / default: `${slug}-${branch}` -> branch
 * Returns undefined for non-CF edges (no handle).
 */
function branchFromHandle(sourceSlug: string, sourceHandle: string | null | undefined): string | undefined {
  if (!sourceHandle) return undefined;
  const pathPrefix = `${sourceSlug}-path-`;
  if (sourceHandle.startsWith(pathPrefix)) return sourceHandle.slice(pathPrefix.length);
  const prefix = `${sourceSlug}-`;
  if (sourceHandle.startsWith(prefix)) return sourceHandle.slice(prefix.length);
  return undefined;
}

function handleDelete({ edges: deletedEdges }: { nodes: Node[]; edges: Edge[] }) {
  if (deletedEdges.length === 0) return;

  const deletedIds = new Set(deletedEdges.map((e) => e.id));
  editableEdges = editableEdges.filter((e) => !deletedIds.has(e.id));
  onEdgesChange?.(editableEdges);
}

function handleBeforeReconnect(newEdge: Edge, _oldEdge: Edge): Edge | null {
  // Reject self-loops; fan-in is allowed in the DAG model.
  if (newEdge.source === newEdge.target) return null;
  return newEdge;
}

function handleReconnect(newEdge: Edge) {
  editableEdges = editableEdges.map((e) => (e.id === newEdge.id ? newEdge : e));
  onEdgesChange?.(editableEdges);
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

  // Node IDs are step slugs. Resolve the clicked step by slug.
  const slug = ev.node.data?.slug as string | undefined;
  if (!slug || !onNodeClick) return;
  const step = steps.find((s) => s.slug === slug);
  if (step) {
    const index = steps.findIndex((s) => s.slug === slug);
    onNodeClick(step, index);
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
    {nodes}
    {edges}
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
    <Background />
    <Controls />
  </SvelteFlow>
</div>
