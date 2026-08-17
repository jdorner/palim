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
import { flattenWorkflow, type StepData } from "$lib/workflowGraph";
import { computeLayout } from "$lib/workflowLayout";
import AddStepNode from "./AddStepNode.svelte";
import ControlFlowNode from "./ControlFlowNode.svelte";
import FitViewOnInit from "./FitViewOnInit.svelte";
import WaitForNode from "./WaitForNode.svelte";
import WorkflowStepNode from "./WorkflowStepNode.svelte";

interface StepInfo {
  slug: string;
  type: string;
  status?: "waiting" | "active" | "completed" | "failed" | "waiting-signal";
  jobId?: string;
  [key: string]: unknown;
}

interface TriggerInfo {
  type: string;
  ref?: string;
}

interface Props {
  steps: StepInfo[];
  trigger?: TriggerInfo;
  editMode?: boolean;
  selectedStepIndex?: number;
  fitViewTrigger?: number;
  customStepTypes?: Array<{ type: string; label: string; icon?: string }>;
  onNodeClick?: (step: StepInfo, index: number) => void;
  onAddStep?: (type?: string, branchContext?: { parentNodeId: string; branch: string }) => void;
  onEdgesChange?: (edges: Edge[]) => void;
}

let {
  steps,
  trigger,
  editMode,
  selectedStepIndex = -1,
  fitViewTrigger = 0,
  customStepTypes = [],
  onNodeClick,
  onAddStep,
  onEdgesChange,
}: Props = $props();

let colorMode = $state<ColorMode>("light");

const nodeTypes = { step: WorkflowStepNode, controlFlow: ControlFlowNode, waitFor: WaitForNode, addStep: AddStepNode };

// ---------------------------------------------------------------------------
// Layout computation using flatten + dagre
// ---------------------------------------------------------------------------

/** Compute the full graph layout from current steps. */
function computeGraphLayout(): { nodes: Node[]; edges: Edge[] } {
  const flatGraph = flattenWorkflow(steps as StepData[]);
  const layout = computeLayout(flatGraph, {
    trigger,
    includeAddNode: editMode && steps.length > 0,
  });

  // Merge runtime status and selection state into node data
  const nodesWithStatus = layout.nodes.map((node) => {
    if (node.id === "__trigger__") return node;

    // Inject addStep node callbacks and custom types (root + branch)
    if (node.id === "__addStep__" || node.id.startsWith("__addStep:")) {
      const branchContext =
        node.data.parentNodeId && node.data.branch
          ? { parentNodeId: node.data.parentNodeId as string, branch: node.data.branch as string }
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

    // Find the corresponding step for status overlay.
    // Root-level nodes have IDs like "step-0", "step-1", etc.
    // Branch nodes have IDs like "step-0.then-0", "step-1.path-create-0", etc.
    const rootIndex = parseRootIndex(node.id);
    const step = rootIndex !== null ? steps[rootIndex] : undefined;
    // Mark as selected if this node belongs to the currently selected top-level step
    const isSelected = rootIndex !== null && rootIndex === selectedStepIndex;

    return {
      ...node,
      data: {
        ...node.data,
        status: step?.status ?? node.data.status ?? "waiting",
        selected: isSelected,
      },
    };
  });

  // Animate edges to active nodes
  const edgesWithAnimation = layout.edges.map((edge) => {
    const targetNode = nodesWithStatus.find((n) => n.id === edge.target);
    const isActive = targetNode?.data?.status === "active";
    return { ...edge, animated: isActive || edge.animated };
  });

  return { nodes: nodesWithStatus, edges: edgesWithAnimation };
}

/**
 * Extracts the root-level step index from a node ID.
 * - "step-2" -> 2
 * - "step-1.then-0" -> 1 (the parent CF node index)
 * - "__trigger__" -> null
 */
function parseRootIndex(nodeId: string): number | null {
  if (!nodeId.startsWith("step-")) return null;
  const match = nodeId.match(/^step-(\d+)/);
  return match ? Number.parseInt(match[1], 10) : null;
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
  // Compute the flat node count to detect both top-level and branch step additions
  const flatGraph = flattenWorkflow(steps as StepData[]);
  const currentNodeCount = flatGraph.nodes.length;

  const enteringEditMode = editMode && !prevEditMode;
  const structureChanged = editMode && currentNodeCount !== prevNodeCount;

  if (enteringEditMode || structureChanged) {
    // Recompute layout but preserve existing positions for user-dragged nodes
    const layout = computeGraphLayout();
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
    const layout = computeGraphLayout();
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
  if (source === target) return false;
  const currentEdges = editMode ? editableEdges : derivedEdges;
  if (currentEdges.some((e) => e.target === target && e.source !== source)) return false;
  return true;
}

function handleConnect(connection: Connection) {
  const { source, target } = connection;
  if (!source || !target) return;

  const newEdge: Edge = {
    id: `${source}-${target}`,
    source,
    target,
    animated: false,
  };

  editableEdges = [...editableEdges, newEdge];
  onEdgesChange?.(editableEdges);
}

function handleDelete({ edges: deletedEdges }: { nodes: Node[]; edges: Edge[] }) {
  if (deletedEdges.length === 0) return;

  const deletedIds = new Set(deletedEdges.map((e) => e.id));
  editableEdges = editableEdges.filter((e) => !deletedIds.has(e.id));
  onEdgesChange?.(editableEdges);
}

function handleBeforeReconnect(newEdge: Edge, _oldEdge: Edge): Edge | null {
  const edgesWithoutOld = editableEdges.filter((e) => e.id !== _oldEdge.id);

  const targetHasIncoming = edgesWithoutOld.some((e) => e.target === newEdge.target && e.source !== newEdge.source);
  if (targetHasIncoming) return null;

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

  const rootIndex = parseRootIndex(ev.node.id);
  if (rootIndex === null) return;

  const step = steps[rootIndex];
  if (step && onNodeClick) onNodeClick(step, rootIndex);
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
