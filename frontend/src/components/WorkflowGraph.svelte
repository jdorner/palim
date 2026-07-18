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
import AddStepNode from "./AddStepNode.svelte";
import FitViewOnInit from "./FitViewOnInit.svelte";
import WorkflowStepNode from "./WorkflowStepNode.svelte";

interface StepInfo {
  slug: string;
  type: string;
  status?: "waiting" | "active" | "completed" | "failed";
  jobId?: string;
}

interface TriggerInfo {
  type: string;
  ref?: string;
}

interface Props {
  steps: StepInfo[];
  trigger?: TriggerInfo;
  editMode?: boolean;
  onNodeClick?: (step: StepInfo, index: number) => void;
  onAddStep?: () => void;
  onEdgesChange?: (edges: Edge[]) => void;
}

let { steps, trigger, editMode, onNodeClick, onAddStep, onEdgesChange }: Props = $props();

let colorMode = $state<ColorMode>("light");

/** Creates a stable node ID from a step's array index. */
function stepNodeId(index: number): string {
  return `step-${index}`;
}

const nodeTypes = { step: WorkflowStepNode, addStep: AddStepNode };

const STEP_NODE_WIDTH = 180;
const ADD_NODE_SIZE = 24;
const ADD_NODE_X = (STEP_NODE_WIDTH - ADD_NODE_SIZE) / 2;

// --- Nodes ---

/** Build the full node array from current step data, using provided positions. */
function buildNodes(positions?: Map<string, { x: number; y: number }>): Node[] {
  const offset = trigger ? 1 : 0;
  return [
    ...(trigger
      ? [
          {
            id: "__trigger__",
            type: "step",
            position: positions?.get("__trigger__") ?? { x: 0, y: 0 },
            data: {
              slug: trigger.ref ?? trigger.type,
              type: "trigger",
              status: "completed" as const,
              triggerType: trigger.type,
            },
          },
        ]
      : []),
    ...steps.map((s, i) => ({
      id: stepNodeId(i),
      type: "step",
      position: positions?.get(stepNodeId(i)) ?? { x: 0, y: (i + offset) * 100 },
      data: { slug: s.slug, type: s.type, status: s.status ?? "waiting" },
    })),
    ...(editMode && steps.length > 0
      ? [
          {
            id: "__addStep__",
            type: "addStep",
            position: positions?.get("__addStep__") ?? {
              x: ADD_NODE_X,
              y: (steps.length + offset) * 100,
            },
            data: {},
          },
        ]
      : []),
  ];
}

// Derived nodes for view mode (no user interaction, positions are static)
let derivedNodes = $derived<Node[]>(buildNodes());

// Mutable node state for edit mode — preserves drag positions
let editableNodes = $state<Node[]>([]);

// Track editMode and step count transitions
let prevEditModeForNodes = $state(false);
let prevStepCountForNodes = $state(0);

// Seed editable nodes on edit mode entry or step add/remove.
// On step data change (slug/type), update only node.data without touching position.
$effect(() => {
  const enteringEditMode = editMode && !prevEditModeForNodes;
  const stepsAddedOrRemoved = editMode && steps.length !== prevStepCountForNodes;

  if (enteringEditMode || stepsAddedOrRemoved) {
    // Full re-seed: new positions for new nodes, keep existing positions
    const existingPositions = new Map(untrack(() => editableNodes).map((n) => [n.id, n.position]));
    editableNodes = buildNodes(existingPositions);
  } else if (editMode) {
    // Data-only update: preserve positions, just sync node.data from steps
    editableNodes = untrack(() => editableNodes).map((node) => {
      if (node.id === "__trigger__") {
        return {
          ...node,
          data: {
            slug: trigger?.ref ?? trigger?.type ?? "",
            type: "trigger",
            status: "completed" as const,
            triggerType: trigger?.type ?? "",
          },
        };
      }
      if (node.id === "__addStep__") return node;
      const idx = Number.parseInt(node.id.replace("step-", ""), 10);
      const step = steps[idx];
      if (!step) return node;
      return {
        ...node,
        data: { slug: step.slug, type: step.type, status: step.status ?? "waiting" },
      };
    });
  }

  prevEditModeForNodes = !!editMode;
  if (editMode) {
    prevStepCountForNodes = steps.length;
  }
});

// The nodes passed to SvelteFlow
let nodes = $derived<Node[]>(editMode ? editableNodes : derivedNodes);

/** Apply node position changes from SvelteFlow (drag). */
function handleNodeDragStop(ev: { event: MouseEvent | TouchEvent; targetNode: Node | null; nodes: Node[] }) {
  const { targetNode } = ev;
  if (!targetNode) return;
  editableNodes = editableNodes.map((n) => (n.id === targetNode.id ? { ...n, position: targetNode.position } : n));
}

// --- Edges ---

// Edges derived from the steps data (used in view mode)
let derivedEdges = $derived<Edge[]>([
  ...(trigger && steps.length > 0
    ? [
        {
          id: `__trigger__-${stepNodeId(0)}`,
          source: "__trigger__",
          target: stepNodeId(0),
          animated: steps[0]!.status === "active",
        },
      ]
    : []),
  ...steps.slice(1).map((_, i) => ({
    id: `${stepNodeId(i)}-${stepNodeId(i + 1)}`,
    source: stepNodeId(i),
    target: stepNodeId(i + 1),
    animated: steps[i + 1]!.status === "active",
  })),
  ...(editMode && steps.length > 0
    ? [
        {
          id: `${stepNodeId(steps.length - 1)}--addStep--`,
          source: stepNodeId(steps.length - 1),
          target: "__addStep__",
          animated: false,
        },
      ]
    : []),
]);

// Mutable edge state for edit mode — seeded from derived edges
let editableEdges = $state<Edge[]>([]);

// Track previous editMode and step count to detect when to re-seed edges
let prevEditMode = $state(false);
let prevStepCount = $state(0);

// Seed editable edges when entering edit mode or when steps are added/removed.
$effect(() => {
  const enteringEditMode = editMode && !prevEditMode;
  const stepsAddedOrRemoved = editMode && steps.length !== prevStepCount;

  if (enteringEditMode || stepsAddedOrRemoved) {
    editableEdges = [...derivedEdges];
  }

  prevEditMode = !!editMode;
  if (editMode) {
    prevStepCount = steps.length;
  }
});

// The edges passed to SvelteFlow — mutable in edit mode, derived in view mode
let edges = $derived<Edge[]>(editMode ? editableEdges : derivedEdges);

// --- Connection validation ---

function isValidConnection({ source, target }: { source: string; target: string }): boolean {
  if (source === target) return false;

  const currentEdges = editMode ? editableEdges : derivedEdges;

  if (currentEdges.some((e) => e.target === target && e.source !== source)) return false;
  if (currentEdges.some((e) => e.source === source && e.target !== target)) return false;

  return true;
}

// --- Edge event handlers ---

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

  const sourceHasOutgoing = edgesWithoutOld.some((e) => e.source === newEdge.source && e.target !== newEdge.target);
  if (sourceHasOutgoing) return null;

  return newEdge;
}

function handleReconnect(newEdge: Edge) {
  editableEdges = editableEdges.map((e) => (e.id === newEdge.id ? newEdge : e));
  onEdgesChange?.(editableEdges);
}

// --- Misc ---

onMount(() => {
  function sync() {
    colorMode = document.documentElement.classList.contains("dark") ? "dark" : "light";
  }
  sync();
  const observer = new MutationObserver(sync);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
});

function handleNodeClick(ev: { event: MouseEvent | TouchEvent; node: Node }) {
  if (ev.node.id === "__addStep__") {
    onAddStep?.();
    return;
  }
  const index = Number.parseInt(ev.node.id.replace("step-", ""), 10);
  const step = steps[index];
  if (step && onNodeClick) onNodeClick(step, index);
}
</script>

<div class="w-full border rounded-lg overflow-hidden bg-background" style="height: 650px">
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
    <FitViewOnInit />
    <Background />
    <Controls />
  </SvelteFlow>
</div>
