/**
 * Auto-layout utility for workflow graphs using dagre.
 *
 * Takes a FlatGraph (from workflowGraph.ts) and computes node positions
 * suitable for SvelteFlow rendering. Dagre owns all placement: nodes are never
 * moved after layout (except the small "+" add-step buttons), so the edge
 * routes dagre computes stay valid. Edges that skip columns carry those routes
 * (see edgeRoute.ts) so they are drawn around nodes instead of through them.
 * Branch handles on control-flow nodes are ordered to match the layout, rather
 * than moving nodes to match a fixed handle order.
 */

import dagre, { type GraphLabel, type graphlib } from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/svelte";
import type { EdgeRoute } from "./edgeRoute";
import type { FlatGraph, GraphEdge, GraphNode } from "./workflowGraph";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Default dimensions for standard step nodes. Must stay in sync with the card
 * in WorkflowStepNode/WaitForNode (`w-55` = 220px wide; the `h-9` icon tile plus
 * `py-2.5` vertical padding render at ~56px tall) so dagre spacing and handle
 * alignment line up with what is rendered.
 */
const NODE_WIDTH = 220;
const NODE_HEIGHT = 56;

/**
 * Default dimensions for control flow nodes. Must match the diamond container
 * size in ControlFlowNode (108px square).
 */
const CF_NODE_WIDTH = 108;
const CF_NODE_HEIGHT = 108;

/**
 * Dimensions for iterator/aggregator pentagon nodes.
 * Matches the clip-path container in IteratorNode/AggregatorNode (140x60).
 */
const ITER_NODE_WIDTH = 140;
const ITER_NODE_HEIGHT = 60;

/** Returns the width/height for a given step type's node. */
function nodeDimensions(stepType: string): { width: number; height: number } {
  if (stepType === "if" || stepType === "case") return { width: CF_NODE_WIDTH, height: CF_NODE_HEIGHT };
  if (stepType === "iterator" || stepType === "aggregator") return { width: ITER_NODE_WIDTH, height: ITER_NODE_HEIGHT };
  return { width: NODE_WIDTH, height: NODE_HEIGHT };
}

/** Default dimensions for the add-step button node. */
const ADD_NODE_WIDTH = 32;
const ADD_NODE_HEIGHT = 32;

/**
 * Horizontal gap between a source node's right edge and its add-step button.
 * Kept smaller than a full rank separation so the "+" reads as attached to its
 * source rather than as a node in the next rank.
 */
const ADD_NODE_ATTACH_GAP = 32;

const TRIGGER_ID = "__trigger__";
const ROOT_ADD_STEP_ID = "__addStep__";
const DASHED = "stroke-dasharray: 5 5;";

/** Layout options for dagre. */
const LAYOUT_OPTIONS: GraphLabel = {
  rankdir: "LR",
  nodesep: 56,
  ranksep: 96,
  marginx: 24,
  marginy: 24,
};

/**
 * Distance from a column's left edge at which routed edges turn. Placed in the
 * right half of the gap so the vertical segment stays clear of add-step buttons
 * attached to the previous column (which end ADD_NODE_ATTACH_GAP +
 * ADD_NODE_WIDTH = 64px past it).
 */
const BEND_INSET = LAYOUT_OPTIONS.ranksep! / 4;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Trigger info passed into the layout for rendering the trigger node. */
export interface TriggerInfo {
  type: string;
  ref?: string;
}

/** Options for computing the layout. */
export interface LayoutOptions {
  /** Include a trigger node at the start of the graph. */
  trigger?: TriggerInfo;
  /** Include an add-step node at the end (edit mode). */
  includeAddNode?: boolean;
  /** Set of step type identifiers that are terminal (no outgoing edge or add-step after them). */
  terminalTypes?: Set<string>;
}

/** Metadata about a branch addStep node for the caller to wire callbacks. */
export interface BranchAddStepInfo {
  /** The addStep node ID (e.g. "__addStep:step-0:then__"). */
  nodeId: string;
  /** The parent CF node ID. */
  parentNodeId: string;
  /** The branch label (e.g. "then", "else", "success", "default"). */
  branch: string;
  /**
   * The branch's tail node ID, or null when the branch is empty.
   *
   * When set, the branch already has steps and a new step must be appended
   * sequentially after this tail (edge: tail -> newStep). When null, the branch
   * is empty and a new step must connect to the CF node via the labeled branch
   * edge (edge: parentNodeId -> newStep [branch]). Getting this wrong creates a
   * second edge out of the same branch, corrupting the graph.
   */
  lastNodeId: string | null;
  /**
   * True when `lastNodeId` is an aggregator that this branch reaches by
   * threading through a nested iterator/aggregator pair. The add-step and its
   * dashed edge anchor to the aggregator itself (not the branch's linear tail),
   * and a new step appended here connects sequentially after the aggregator
   * (edge: aggregator -> newStep).
   */
  isAggregatorContinuation?: boolean;
}

/** Result of the layout computation. */
export interface LayoutResult {
  nodes: Node[];
  edges: Edge[];
  /** Info about per-branch addStep nodes (for wiring callbacks). */
  branchAddSteps: BranchAddStepInfo[];
}

/** An add-step ("+") node to render, with the node it hangs off. */
interface AddStepPlacement {
  id: string;
  sourceId: string;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Computes a dagre-based layout for a flat workflow graph.
 *
 * Converts the FlatGraph into dagre nodes/edges, runs the layout algorithm,
 * and returns SvelteFlow-compatible nodes and edges with computed positions.
 * Edges spanning more than one column carry `data.route` ({@link EdgeRoute}).
 *
 * @param graph - The flattened workflow graph (nodes + edges)
 * @param options - Layout options (trigger node, add-step node)
 * @returns Positioned nodes and styled edges for SvelteFlow
 */
export function computeLayout(graph: FlatGraph, options: LayoutOptions = {}): LayoutResult {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const isTerminal = (id: string) => {
    const type = nodeById.get(id)?.data.type;
    return !!type && !!options.terminalTypes?.has(type);
  };

  // --- Add-step ("+") nodes (edit mode) ------------------------------------

  // In the DAG model "root" membership is defined by edges, not node.parent:
  // the root add-step hangs off the end of the top-level chain, never off a
  // node that lives inside a control-flow branch.
  const firstRootId = findRootNodeId(graph);
  const lastRoot = firstRootId ? nodeById.get(mainFlowTail(graph, firstRootId)) : undefined;
  const lastRootIsCF = lastRoot && isBranchingType(lastRoot.data.type);
  const showRootAddStep = options.includeAddNode && !!lastRoot && !lastRootIsCF && !isTerminal(lastRoot.id);
  // No steps at all: the add-step hangs off the trigger so the user can add the first step.
  const showEmptyAddStep = options.includeAddNode && graph.nodes.length === 0 && !!options.trigger;

  const addSteps: AddStepPlacement[] = [];
  const addStepEdges: Edge[] = [];
  if (showRootAddStep && lastRoot) {
    // The source is stamped so the caller can wire the new step after it.
    addSteps.push({ id: ROOT_ADD_STEP_ID, sourceId: lastRoot.id, data: { sourceNodeId: lastRoot.id } });
    addStepEdges.push({ id: `${lastRoot.id}->${ROOT_ADD_STEP_ID}`, source: lastRoot.id, target: ROOT_ADD_STEP_ID });
  }
  if (showEmptyAddStep) {
    addSteps.push({ id: ROOT_ADD_STEP_ID, sourceId: TRIGGER_ID, data: {} });
    addStepEdges.push({ id: `${TRIGGER_ID}->${ROOT_ADD_STEP_ID}`, source: TRIGGER_ID, target: ROOT_ADD_STEP_ID });
  }

  const branchAddSteps = options.includeAddNode ? branchAddStepsFor(graph, options.terminalTypes) : [];
  for (const info of branchAddSteps) {
    // Hang off the branch tail, or off the CF node's branch handle when empty.
    const sourceId = info.lastNodeId ?? info.parentNodeId;
    addSteps.push({
      id: info.nodeId,
      sourceId,
      data: { parentNodeId: info.parentNodeId, branch: info.branch, lastNodeId: info.lastNodeId },
    });
    addStepEdges.push({
      id: `${sourceId}->${info.nodeId}`,
      source: sourceId,
      target: info.nodeId,
      // Empty branch: the edge leaves the CF node's branch handle with its label.
      ...(info.lastNodeId
        ? {}
        : {
            label: branchAddStepLabel(graph, info.parentNodeId, info.branch),
            sourceHandle: sourceHandleForBranch(info.parentNodeId, info.branch, graph),
          }),
    });
  }

  // --- Edges ----------------------------------------------------------------

  // The branch each edge leaves its CF node on, for ordering handles later.
  const edgeBranch = new Map<string, string>();
  for (const info of branchAddSteps) {
    if (!info.lastNodeId) edgeBranch.set(`${info.parentNodeId}->${info.nodeId}`, info.branch);
  }

  const flowEdges: Edge[] = [];
  if (options.trigger && firstRootId) {
    flowEdges.push({ id: `${TRIGGER_ID}->first`, source: TRIGGER_ID, target: firstRootId });
  }
  // Terminal nodes have no source handle, so their (invalid) outgoing edges are dropped.
  for (const edge of graph.edges) {
    if (isTerminal(edge.source)) continue;
    flowEdges.push(toSvelteEdge(edge));
    if (edge.branch) edgeBranch.set(edge.id, edge.branch);
  }

  // --- Dagre layout ---------------------------------------------------------

  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph(LAYOUT_OPTIONS);
  g.setDefaultEdgeLabel(() => ({}));

  const dims = new Map<string, { width: number; height: number }>();
  if (options.trigger) dims.set(TRIGGER_ID, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const node of graph.nodes) dims.set(node.id, nodeDimensions(node.data.type));
  for (const a of addSteps) dims.set(a.id, { width: ADD_NODE_WIDTH, height: ADD_NODE_HEIGHT });

  for (const [id, d] of dims) g.setNode(id, { ...d });
  // Each edge is named by its id so parallel edges (e.g. two case paths to the
  // same target) are laid out and routed separately.
  for (const e of [...flowEdges, ...addStepEdges]) g.setEdge(e.source, e.target, {}, e.id);

  dagre.layout(g);

  const center = (id: string) => g.node(id) as { x: number; y: number };
  const columns = layoutColumns(g, dims);

  // Pull each add-step next to its source so the "+" reads as attached to it.
  // Add-steps are leaves and keep their dagre slot reserved, so this cannot
  // collide with nodes or routed edges. Off a CF node the dagre y is kept, so
  // the add-steps of several empty branches stay stacked apart.
  for (const a of addSteps) {
    const pos = center(a.id);
    const src = center(a.sourceId);
    pos.x = src.x + dims.get(a.sourceId)!.width / 2 + ADD_NODE_ATTACH_GAP + ADD_NODE_WIDTH / 2;
    if (!isBranchingType(nodeById.get(a.sourceId)?.data.type ?? "")) pos.y = src.y;
  }

  // --- SvelteFlow output ----------------------------------------------------

  // SvelteFlow positions nodes by their top-left corner; dagre gives centers.
  const topLeft = (id: string) => {
    const { x, y } = center(id);
    const { width, height } = dims.get(id)!;
    return { x: x - width / 2, y: y - height / 2 };
  };

  // Branch order on a CF node: the vertical order dagre chose for the edges
  // leaving it. Branches without an edge go last, in declared order.
  const firstLaneY = (edge: Edge): number =>
    (g.edge({ v: edge.source, w: edge.target, name: edge.id }) as { points?: { y: number }[] })?.points?.[1]?.y ??
    Number.POSITIVE_INFINITY;
  const branchY = new Map<string, number>();
  for (const e of [...flowEdges, ...addStepEdges]) {
    const branch = edgeBranch.get(e.id);
    if (branch) branchY.set(`${e.source}\0${branch}`, firstLaneY(e));
  }

  const svelteNodes: Node[] = [];

  if (options.trigger) {
    svelteNodes.push({
      id: TRIGGER_ID,
      type: "step",
      position: topLeft(TRIGGER_ID),
      deletable: false,
      data: {
        slug: options.trigger.ref || options.trigger.type,
        type: "trigger",
        status: "completed",
        triggerType: options.trigger.type,
      },
    });
  }

  for (const node of graph.nodes) {
    const data: Record<string, unknown> = { slug: node.data.slug, type: node.data.type, status: "waiting" };
    if (isBranchingType(node.data.type)) {
      const yOf = (b: string) => branchY.get(`${node.id}\0${b}`) ?? Number.POSITIVE_INFINITY;
      const branches = branchLabelsFor(node, graph).sort((a, b) => yOf(a) - yOf(b));
      if (branches.length > 0) data.branches = branches;
    }
    svelteNodes.push({ id: node.id, type: nodeTypeForStep(node.data.type), position: topLeft(node.id), data });
  }

  for (const a of addSteps) {
    svelteNodes.push({ id: a.id, type: "addStep", position: topLeft(a.id), data: a.data });
  }

  // Edges crossing intermediate columns follow dagre's lanes through them.
  for (const e of flowEdges) {
    const route = routeFor(g, e, columns);
    if (route) e.data = { ...e.data, route };
  }
  for (const e of addStepEdges) e.style = DASHED;

  return { nodes: svelteNodes, edges: [...flowEdges, ...addStepEdges], branchAddSteps };
}

// ---------------------------------------------------------------------------
// Edge routing
// ---------------------------------------------------------------------------

/** Horizontal extent of one layout rank (all its nodes share a center x). */
interface Column {
  x: number;
  left: number;
  right: number;
}

/**
 * Groups the laid-out nodes into columns. With `rankdir: "LR"` every node of a
 * rank shares the same center x, and the column is as wide as its widest node.
 * Must run before add-steps are pulled toward their sources.
 */
function layoutColumns(g: graphlib.Graph, dims: Map<string, { width: number }>): Column[] {
  const byX = new Map<number, Column>();
  for (const [id, { width }] of dims) {
    const { x } = g.node(id);
    const key = Math.round(x);
    const col = byX.get(key) ?? { x, left: x, right: x };
    col.left = Math.min(col.left, x - width / 2);
    col.right = Math.max(col.right, x + width / 2);
    byX.set(key, col);
  }
  return [...byX.values()].sort((a, b) => a.x - b.x);
}

/**
 * Derives an {@link EdgeRoute} from dagre's routing points for an edge that
 * crosses at least one intermediate column, or undefined for edges between
 * neighboring columns (drawn as a plain smooth-step).
 *
 * Dagre places a dummy point for the edge in each crossed column, in a slot
 * kept clear of nodes; those become the lanes. Points dagre puts in the gaps
 * between columns are ignored, since the bends are placed there instead.
 */
function routeFor(g: graphlib.Graph, edge: Edge, columns: Column[]): EdgeRoute | undefined {
  const points = (g.edge({ v: edge.source, w: edge.target, name: edge.id }) as { points?: { x: number; y: number }[] })
    ?.points;
  if (!points || points.length < 3) return undefined;

  const columnAt = (x: number) => columns.find((c) => x >= c.left - 0.5 && x <= c.right + 0.5);
  const bends: number[] = [];
  const lanes: number[] = [];
  for (const p of points.slice(1, -1)) {
    const col = columnAt(p.x);
    if (!col) continue;
    bends.push(col.left - BEND_INSET);
    lanes.push(p.y);
  }
  const targetCol = columnAt(g.node(edge.target).x);
  if (lanes.length === 0 || !targetCol) return undefined;
  bends.push(targetCol.left - BEND_INSET);
  return { bends, lanes };
}

/**
 * Picks the branch add-steps to render: one per control-flow branch whose end
 * can take another step.
 *
 * @param graph - The flat graph.
 * @param terminalTypes - Step types that cannot have an outgoing edge.
 * @returns The branch add-steps, with their node IDs.
 */
function branchAddStepsFor(graph: FlatGraph, terminalTypes?: Set<string>): BranchAddStepInfo[] {
  const result: BranchAddStepInfo[] = [];
  for (const info of discoverBranches(graph, terminalTypes)) {
    // The aggregator-continuation case is exempt from the aggregator guards
    // below: there the aggregator is the branch's genuine continuation tail and
    // MUST own the add-step (nothing on the top-level flow anchors it).
    if (info.lastNodeId && !info.isAggregatorContinuation) {
      const lastNode = graph.nodes.find((n) => n.id === info.lastNodeId);
      // Branch tail IS an aggregator (empty iteration body): the aggregator's
      // main-flow continuation owns the add-step.
      if (lastNode?.data.type === "aggregator") continue;
      // The chain ends in an aggregator: the insert button on the edge into the
      // aggregator serves as the add-step for the iteration body.
      const nextEdge = graph.edges.find((e) => e.source === info.lastNodeId && !e.branch);
      const nextNode = nextEdge && graph.nodes.find((n) => n.id === nextEdge.target);
      if (nextNode?.data.type === "aggregator") continue;
    }
    result.push({ ...info, nodeId: `__addStep:${info.parentNodeId}:${info.branch}__` });
  }
  return result;
}

/** Whether a step type fans out over labeled branch edges. */
function isBranchingType(type: string): boolean {
  return type === "if" || type === "case" || type === "iterator";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Maps a workflow step type to the corresponding SvelteFlow node type. */
function nodeTypeForStep(stepType: string): string {
  if (stepType === "if" || stepType === "case") return "controlFlow";
  if (stepType === "iterator") return "iterator";
  if (stepType === "aggregator") return "aggregator";
  if (stepType === "waitFor") return "waitFor";
  return "step";
}

/**
 * Converts a graph edge to a SvelteFlow edge with optional label and handle.
 *
 * Edges use the default bezier (curved) renderer. Branch edges carry a
 * `sourceHandle` so they originate from the correct handle on the CF node.
 *
 * @param edge - The flat-graph edge to convert.
 * @returns A SvelteFlow edge.
 */
function toSvelteEdge(edge: GraphEdge): Edge {
  const svelteEdge: Edge = {
    id: edge.id,
    source: edge.source,
    target: edge.target,
  };

  if (edge.label) {
    svelteEdge.label = edge.label;
  }

  if (edge.sourceHandle) {
    svelteEdge.sourceHandle = edge.sourceHandle;
  }

  return svelteEdge;
}

/**
 * Computes the branch labels for a `case` node.
 *
 * Branches are derived from the step's declared `paths` array (carried in
 * `node.data`) plus a `default` branch when the step declares a non-empty
 * `default` key. The set is unioned with any labels already present on the
 * node's outgoing edges, so a draft that has edges for a path not (yet) in
 * `paths` still renders that handle rather than orphaning the edge.
 *
 * Deriving handles from `paths` (not only from edges) is what lets a user add a
 * new branch: typing a new key into the sidebar `paths` field surfaces a
 * connectable source handle and a per-branch "+" add-step.
 *
 * @param node - The case control-flow node.
 * @param edges - All edges in the flat graph.
 * @returns Ordered, de-duplicated branch labels (declared paths, then any
 *   edge-only labels, with "default" last when present).
 */
function caseBranchLabels(node: GraphNode, edges: GraphEdge[]): string[] {
  const paths = Array.isArray(node.data.paths)
    ? (node.data.paths as unknown[]).filter((p): p is string => typeof p === "string" && p.length > 0)
    : [];
  const hasDefaultKey = typeof node.data.default === "string" && (node.data.default as string).length > 0;

  // Use the canonical branch keys (not display labels) so this returns routing
  // keys consistent with everything else the layout matches on.
  const edgeBranches = edges.filter((e) => e.source === node.id && e.branch).map((e) => e.branch!);

  const labels: string[] = [];
  const seen = new Set<string>();
  // Declared path keys first (preserves the order the user entered them).
  for (const key of paths) {
    if (key === "default") continue;
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(key);
  }
  // Any edge-only branch keys (excluding "default") that are not declared paths.
  for (const branch of edgeBranches) {
    if (branch === "default") continue;
    if (seen.has(branch)) continue;
    seen.add(branch);
    labels.push(branch);
  }
  // "default" always sorts last when the step declares it or an edge uses it.
  if (hasDefaultKey || edgeBranches.includes("default")) {
    labels.push("default");
  }
  return labels;
}

/** Info about a branch discovered from the graph structure. */
interface BranchDiscovery {
  parentNodeId: string;
  branch: string;
  lastNodeId: string | null;
  /**
   * True when `lastNodeId` was resolved by threading through an iterator/
   * aggregator pair nested inside this branch (i.e. the branch's linear tail was
   * an iterator, so the real continuation point is that iterator's paired
   * aggregator). In this case the aggregator legitimately owns the branch's
   * add-step and the aggregator-skip guards in `computeLayout` (which exist to
   * avoid duplicating the TOP-LEVEL continuation's add-step) must NOT fire.
   */
  isAggregatorContinuation?: boolean;
}

/**
 * Finds the graph's entry node: the first node that has no incoming edge.
 *
 * In the DAG model there is normally a single entry point (the node the trigger
 * connects to). Falls back to the first declared node if every node has an
 * incoming edge (e.g. a cyclic draft mid-edit).
 *
 * @param graph - The flat graph.
 * @returns The entry node ID, or undefined for an empty graph.
 */
function findRootNodeId(graph: FlatGraph): string | undefined {
  if (graph.nodes.length === 0) return undefined;
  const hasIncoming = new Set(graph.edges.map((e) => e.target));
  const root = graph.nodes.find((n) => !hasIncoming.has(n.id));
  return (root ?? graph.nodes[0]!).id;
}

/**
 * Follows the sequential chain starting at `startId` down non-branch edges and
 * returns the tail node's ID. Branch (labeled) edges are not followed, since a
 * CF node encountered along the way owns its own per-branch addStep nodes.
 *
 * @param graph - The flat graph.
 * @param startId - ID of the branch's immediate target node.
 * @returns The ID of the last node in the linear chain.
 */
function branchTail(graph: FlatGraph, startId: string): string {
  const seen = new Set<string>();
  let currentId = startId;

  while (!seen.has(currentId)) {
    seen.add(currentId);
    // An aggregator marks the boundary between an iteration body and the
    // main-flow continuation. The iterator body branch must not traverse into
    // or past it, so stop as soon as the current node is an aggregator (whether
    // it was the branch's immediate target or reached along the chain).
    const currentNode = graph.nodes.find((n) => n.id === currentId);
    if (currentNode && currentNode.data.type === "aggregator") break;
    // Only follow plain sequential edges (no branch key). If the current node
    // branches, it is a CF node and owns its own addStep buttons.
    const outgoing = graph.edges.filter((e) => e.source === currentId && !e.branch);
    if (outgoing.length !== 1) break;
    // Stop before an aggregator too, so the tail is the last body step rather
    // than the aggregator itself.
    const nextNode = graph.nodes.find((n) => n.id === outgoing[0]!.target);
    if (nextNode && nextNode.data.type === "aggregator") break;
    currentId = outgoing[0]!.target;
  }

  return currentId;
}

/**
 * Follows the main (top-level) flow from a start node to its tail, treating an
 * iterator/aggregator pair as a single pass-through: when the chain reaches an
 * iterator, it jumps to the iterator's paired aggregator and continues from the
 * aggregator's sequential successor. This keeps the root add-step anchored to
 * the true end of the top-level chain (e.g. a step appended after an aggregator)
 * rather than stopping at the iterator or aggregator.
 *
 * @param graph - The flat graph.
 * @param startId - ID of the entry node.
 * @returns The ID of the last node in the main flow.
 */
function mainFlowTail(graph: FlatGraph, startId: string): string {
  const seen = new Set<string>();
  let currentId = startId;

  while (!seen.has(currentId)) {
    seen.add(currentId);
    const node = graph.nodes.find((n) => n.id === currentId);

    // When we reach an iterator, jump to its paired aggregator (the join point)
    // and continue the main flow from there.
    if (node && node.data.type === "iterator") {
      const aggId = findAggregatorFor(graph, node);
      if (aggId && !seen.has(aggId)) {
        currentId = aggId;
        continue;
      }
      break;
    }

    // Follow plain sequential edges. A node that only has branch edges (if/case)
    // ends the main flow (its branches own their own add-steps).
    const outgoing = graph.edges.filter((e) => e.source === currentId && !e.branch);
    if (outgoing.length !== 1) break;
    currentId = outgoing[0]!.target;
  }

  return currentId;
}

/**
 * Finds the paired aggregator node for a given iterator by matching the
 * aggregator's `iterator` field against the iterator's slug.
 *
 * @param graph - The flat graph.
 * @param iteratorNode - The iterator node.
 * @returns The aggregator node ID, or undefined if none is paired.
 */
function findAggregatorFor(graph: FlatGraph, iteratorNode: GraphNode): string | undefined {
  const iteratorSlug = (iteratorNode.data as { slug?: string }).slug;
  if (!iteratorSlug) return undefined;
  const agg = graph.nodes.find(
    (n) => n.data.type === "aggregator" && (n.data as { iterator?: string }).iterator === iteratorSlug,
  );
  return agg?.id;
}

/**
 * Discovers all control-flow branches that should get an addStep node.
 *
 * In the DAG model, branch membership is expressed through labeled edges from
 * the CF node (not through `node.parent`). For each branch:
 * - If the branch has an outgoing labeled edge, follow that chain to its tail;
 *   the addStep hangs off the tail (unless the tail is a CF or terminal node).
 * - If the branch has no edge, it is empty and the addStep hangs directly off
 *   the CF node (`lastNodeId: null`).
 *
 * @param graph - The flat graph.
 * @param terminalTypes - Step types that cannot have an outgoing edge.
 * @returns One entry per branch that should render an addStep node.
 */
function discoverBranches(graph: FlatGraph, terminalTypes?: Set<string>): BranchDiscovery[] {
  const branches: BranchDiscovery[] = [];

  // Track tail nodes that already have an addStep so that branches converging on
  // a common join node produce a single addStep, not one per incoming branch.
  const seenTails = new Set<string>();

  for (const node of graph.nodes) {
    if (!isBranchingType(node.data.type)) continue;

    // Determine the set of branch labels this CF node exposes.
    const branchLabels = branchLabelsFor(node, graph);

    for (const branch of branchLabels) {
      // The branch's immediate target, resolved via the canonical branch key
      const branchEdge = graph.edges.find((e) => e.source === node.id && e.branch === branch);
      let tailId = branchEdge ? branchTail(graph, branchEdge.target) : null;
      let tailNode = tailId ? graph.nodes.find((n) => n.id === tailId) : null;

      // If the branch's linear tail is an iterator, the branch does not actually
      // end there: the iteration's continuation point is the iterator's paired
      // aggregator. Thread through the pair (mirroring `mainFlowTail`) so the
      // add-step attaches after the aggregator. Without this, an iterator/
      // aggregator nested inside a control-flow branch produces no add-step at
      // all -- the branch bails at the iterator (a CF tail owns its own
      // per-branch add-steps), and the aggregator's continuation is only ever
      // anchored for iterators that sit on the TOP-LEVEL flow.
      let isAggregatorContinuation = false;
      if (tailNode && tailNode.data.type === "iterator") {
        const contId = mainFlowTail(graph, tailId!);
        const contNode = graph.nodes.find((n) => n.id === contId);
        if (contNode && contNode.data.type === "aggregator") {
          tailId = contId;
          tailNode = contNode;
          isAggregatorContinuation = true;
        }
      }

      // A CF tail owns its own per-branch addSteps; skip adding one here. (An
      // aggregator continuation is exempt: the aggregator is the branch's real
      // end point and is not itself a branching CF node.)
      if (!isAggregatorContinuation && tailNode && isBranchingType(tailNode.data.type)) continue;
      // A terminal tail has no outgoing handle; no addStep possible.
      if (tailNode && terminalTypes?.has(tailNode.data.type)) continue;

      // Join node: several branches converge on the same tail. Emit a single
      // addStep for that tail (keyed by the tail node) instead of one per branch.
      if (tailId) {
        if (seenTails.has(tailId)) continue;
        seenTails.add(tailId);
      }

      branches.push({
        parentNodeId: node.id,
        branch,
        lastNodeId: tailId,
        isAggregatorContinuation,
      });
    }
  }

  return branches;
}

/**
 * Returns the ordered set of branch labels a CF node exposes.
 * - `if` nodes always expose "then" and "else".
 * - `case` nodes expose their path keys plus "default" when a default edge exists.
 *
 * @param node - The control-flow node.
 * @param graph - The flat graph.
 * @returns The branch labels for the node.
 */
function branchLabelsFor(node: GraphNode, graph: FlatGraph): string[] {
  if (node.data.type === "if") {
    return ["then", "else"];
  }

  // case node: derive from the declared `paths` (+ `default`) unioned with any
  // edge-only labels, matching the handles rendered by ControlFlowNode.
  return caseBranchLabels(node, graph.edges);
}

/**
 * Resolves the label shown on an empty-branch add-step ("+") edge.
 *
 * Mirrors the populated-branch edge label: for an `if` node with a custom
 * then/else label override, the placeholder edge shows that label; otherwise it
 * shows the raw branch key. Only affects display text, not the branch routing.
 *
 * @param graph - The flat graph.
 * @param parentNodeId - The CF node the branch belongs to.
 * @param branch - The canonical branch key ("then"/"else"/path key/"default").
 * @returns The label text for the add-step edge.
 */
function branchAddStepLabel(graph: FlatGraph, parentNodeId: string, branch: string): string {
  const parentNode = graph.nodes.find((n) => n.id === parentNodeId);
  if (parentNode?.data.type === "if") {
    const labels = parentNode.data.branchLabels as { then?: string; else?: string } | undefined;
    const override = branch === "then" ? labels?.then : branch === "else" ? labels?.else : undefined;
    const trimmed = override?.trim();
    if (trimmed) return trimmed;
  }
  return branch;
}

/**
 * Returns the sourceHandle ID for a branch edge from a CF node.
 * Used when connecting an addStep node directly to a CF node (empty branch).
 */
function sourceHandleForBranch(parentNodeId: string, branch: string, graph: FlatGraph): string | undefined {
  // Find the parent node to determine its type
  const parentNode = graph.nodes.find((n) => n.id === parentNodeId);
  if (!parentNode) return undefined;

  if (parentNode.data.type === "if") {
    return `${parentNodeId}-${branch}`;
  }
  if (parentNode.data.type === "case") {
    return branch === "default" ? `${parentNodeId}-default` : `${parentNodeId}-path-${branch}`;
  }
  return undefined;
}
