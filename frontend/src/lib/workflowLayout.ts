/**
 * Auto-layout utility for workflow graphs using dagre.
 *
 * Takes a FlatGraph (from workflowGraph.ts) and computes node positions
 * suitable for SvelteFlow rendering. Handles branching control flow nodes
 * with multiple output handles.
 */

import dagre, { type GraphLabel } from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/svelte";
import type { FlatGraph, GraphEdge, GraphNode } from "./workflowGraph";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Default dimensions for standard step nodes. Must stay in sync with the card
 * in WorkflowStepNode/WaitForNode (`w-55` = 220px wide; the `h-9` icon tile plus
 * `py-2.5` vertical padding render at ~56px tall) so dagre spacing, handle
 * alignment, and add-step re-anchoring line up with what is rendered. The height
 * matters for re-anchoring: an add-step's rendered center (top-left + its own
 * half-height) must equal the source node's rendered center, which only holds
 * when this constant equals the true card height.
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
 * Horizontal gap between a source node's right edge and its re-anchored add-step
 * button. Kept smaller than a full rank separation so the "+" reads as attached
 * to its source rather than as a node in the next rank.
 */
const ADD_NODE_ATTACH_GAP = 32;

/** Layout options for dagre. */
const LAYOUT_OPTIONS: GraphLabel = {
  rankdir: "LR",
  nodesep: 56,
  ranksep: 96,
  marginx: 24,
  marginy: 24,
};

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
}

/** Result of the layout computation. */
export interface LayoutResult {
  nodes: Node[];
  edges: Edge[];
  /** Info about per-branch addStep nodes (for wiring callbacks). */
  branchAddSteps: BranchAddStepInfo[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Computes a dagre-based layout for a flat workflow graph.
 *
 * Converts the FlatGraph into dagre nodes/edges, runs the layout algorithm,
 * and returns SvelteFlow-compatible nodes and edges with computed positions.
 *
 * @param graph - The flattened workflow graph (nodes + edges)
 * @param options - Layout options (trigger node, add-step node)
 * @returns Positioned nodes and styled edges for SvelteFlow
 */
export function computeLayout(graph: FlatGraph, options: LayoutOptions = {}): LayoutResult {
  const g = new dagre.graphlib.Graph();
  g.setGraph(LAYOUT_OPTIONS);
  g.setDefaultEdgeLabel(() => ({}));

  // Add trigger node
  if (options.trigger) {
    g.setNode("__trigger__", { width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  // Add workflow step nodes
  for (const node of graph.nodes) {
    const { width, height } = nodeDimensions(node.data.type);
    g.setNode(node.id, { width, height });
  }

  // Identify the graph's entry node (no incoming edge) and the tail of the main
  // (non-branch) flow. In the DAG model "root" membership is defined by edges,
  // not node.parent: the root add-step must hang off the end of the top-level
  // chain, never off a node that lives inside a control-flow branch.
  const firstRootId = findRootNodeId(graph);
  const lastRoot = firstRootId ? graph.nodes.find((n) => n.id === branchTail(graph, firstRootId)) : undefined;
  const lastRootIsCF =
    lastRoot && (lastRoot.data.type === "if" || lastRoot.data.type === "case" || lastRoot.data.type === "iterator");
  const lastRootIsTerminal = lastRoot && options.terminalTypes?.has(lastRoot.data.type);
  const showRootAddStep = options.includeAddNode && !!lastRoot && !lastRootIsCF && !lastRootIsTerminal;

  if (showRootAddStep) {
    g.setNode("__addStep__", { width: ADD_NODE_WIDTH, height: ADD_NODE_HEIGHT });
  }

  // Discover branches and add per-branch addStep nodes
  const branchAddSteps: BranchAddStepInfo[] = [];

  if (options.includeAddNode) {
    const branchInfos = discoverBranches(graph, options.terminalTypes);
    for (const info of branchInfos) {
      // Skip if the last node in this branch is terminal (no outgoing edge possible)
      if (info.lastNodeId) {
        const lastNode = graph.nodes.find((n) => n.id === info.lastNodeId);
        if (lastNode && options.terminalTypes?.has(lastNode.data.type)) continue;
      }

      const addNodeId = `__addStep:${info.parentNodeId}:${info.branch}__`;
      branchAddSteps.push({
        nodeId: addNodeId,
        parentNodeId: info.parentNodeId,
        branch: info.branch,
        lastNodeId: info.lastNodeId,
      });
      g.setNode(addNodeId, { width: ADD_NODE_WIDTH, height: ADD_NODE_HEIGHT });

      // Connect: last step in branch -> addStep, or CF node -> addStep (empty branch)
      if (info.lastNodeId) {
        g.setEdge(info.lastNodeId, addNodeId);
      } else {
        g.setEdge(info.parentNodeId, addNodeId);
      }
    }
  }

  // Connect trigger to the entry node
  if (options.trigger && firstRootId) {
    g.setEdge("__trigger__", firstRootId);
  }

  // Add workflow edges
  for (const edge of graph.edges) {
    g.setEdge(edge.source, edge.target);
  }

  // Connect root add-step node to last root-level node
  if (showRootAddStep && lastRoot) {
    g.setEdge(lastRoot.id, "__addStep__");
  }

  // Run dagre layout
  dagre.layout(g);

  // Post-process: ensure branch targets are vertically separated and ordered.
  // Dagre does not guarantee vertical ordering of branches, so we enforce it:
  // For each CF node, collect all nodes (step nodes + addStep nodes) per branch,
  // then ensure branches are vertically stacked in order with sufficient spacing.
  for (const node of graph.nodes) {
    if (node.data.type !== "if" && node.data.type !== "case" && node.data.type !== "iterator") continue;

    const branchLabels = branchLabelsFor(node, graph);

    if (branchLabels.length < 2) continue;

    const cfPos = g.node(node.id);
    if (!cfPos) continue;

    // Collect the node IDs that are EXCLUSIVE to each branch (+ its addStep node).
    // Join nodes (reached by more than one edge, e.g. a follow-up node several
    // branches converge on) are excluded: they belong to no single branch, so
    // including them would skew a branch's computed center and, worse, cause the
    // shared node to be shifted once per branch, fighting itself.
    const joinNodeIds = nodesWithMultipleIncoming(graph);
    const branchNodeIds: string[][] = branchLabels.map((label) => {
      const stepIds = branchChainNodeIds(graph, node.id, label).filter((id) => !joinNodeIds.has(id));
      const addStepId = branchAddSteps.find((b) => b.parentNodeId === node.id && b.branch === label)?.nodeId;
      if (addStepId) stepIds.push(addStepId);
      return stepIds;
    });

    // Calculate the vertical center (median Y) of each branch
    const branchCenters = branchNodeIds.map((ids) => {
      if (ids.length === 0) return cfPos.y;
      const ys = ids.map((id) => g.node(id)?.y ?? cfPos.y);
      return ys.reduce((sum, y) => sum + y, 0) / ys.length;
    });

    // Desired vertical spacing between branch centers
    const minSpacing = NODE_HEIGHT + LAYOUT_OPTIONS.nodesep!;

    // Check if branches overlap or are not in the correct order
    let needsReorder = false;
    for (let i = 0; i < branchCenters.length - 1; i++) {
      if (branchCenters[i + 1] - branchCenters[i] < minSpacing) {
        needsReorder = true;
        break;
      }
    }

    if (needsReorder) {
      // Place branches symmetrically around the CF node's Y position
      const totalSpan = (branchLabels.length - 1) * minSpacing;
      const startY = cfPos.y - totalSpan / 2;

      for (let i = 0; i < branchLabels.length; i++) {
        const targetCenter = startY + i * minSpacing;
        const currentCenter = branchCenters[i];
        const delta = targetCenter - currentCenter;

        for (const id of branchNodeIds[i]) {
          const pos = g.node(id);
          if (pos) pos.y += delta;
        }
      }
    }
  }

  // Post-process: vertically align each join node (a follow-up node that several
  // branches converge on) with the centroid of its feeders. Dagre tends to place
  // such a node at the median of its many long incoming edges, leaving it far
  // from the branches that feed it. Centering it on its sources keeps it visually
  // attached to the cluster it belongs to.
  const joinIds = nodesWithMultipleIncoming(graph);
  for (const joinId of joinIds) {
    const joinPos = g.node(joinId);
    if (!joinPos) continue;
    const feederYs = graph.edges
      .filter((e) => e.target === joinId)
      .map((e) => g.node(e.source)?.y)
      .filter((y): y is number => typeof y === "number");
    if (feederYs.length === 0) continue;
    joinPos.y = feederYs.reduce((sum, y) => sum + y, 0) / feederYs.length;
  }

  // Post-process: re-anchor every add-step node next to its resolved source
  // node. The branch-separation and join-centering passes above move step nodes
  // AFTER dagre positioned the add-step nodes, so an add-step whose source was
  // shifted (e.g. a join node recentered on its feeders) is left dangling far
  // from the node its dashed edge originates from. Pinning each add-step to the
  // right edge of its source, vertically aligned, keeps the "+" button attached.
  const reanchorAddStep = (addStepId: string, sourceId: string): void => {
    const addPos = g.node(addStepId);
    const srcPos = g.node(sourceId);
    if (!addPos || !srcPos) return;
    const srcIsCF = graph.nodes.find((n) => n.id === sourceId)?.data.type;
    const srcWidth = nodeDimensions(srcIsCF ?? "agent").width;
    // Place the add-step a small attach-gap to the right of the source's right
    // edge, centered on it, so the "+" stays visually attached to its source.
    addPos.x = srcPos.x + srcWidth / 2 + ADD_NODE_ATTACH_GAP + ADD_NODE_WIDTH / 2;
    addPos.y = srcPos.y;
  };

  if (showRootAddStep && lastRoot) {
    reanchorAddStep("__addStep__", lastRoot.id);
  }
  for (const info of branchAddSteps) {
    // The add-step's real source is the branch tail, or the CF node for an
    // empty branch (mirrors the edge-building logic below).
    const branchChain = branchChainNodeIds(graph, info.parentNodeId, info.branch);
    const sourceId = branchChain[branchChain.length - 1] ?? info.parentNodeId;
    reanchorAddStep(info.nodeId, sourceId);
  }

  // Extract positioned nodes
  const svelteNodes: Node[] = [];

  // SvelteFlow positions nodes by their top-left corner (this version does not
  // honor a per-node `origin`). Dagre gives each node a center point, so we
  // convert center -> top-left by subtracting half the node's height. Using the
  // correct per-node half-height is what keeps handle Ys aligned: the tall step
  // node and the small 32px add-step button must each be offset by their OWN
  // half-height so both handles land on the same center line (pos.y).

  // Trigger node
  if (options.trigger) {
    const pos = g.node("__trigger__");
    svelteNodes.push({
      id: "__trigger__",
      type: "step",
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 },
      data: {
        slug: options.trigger.ref ?? options.trigger.type,
        type: "trigger",
        status: "completed",
        triggerType: options.trigger.type,
      },
    });
  }

  // Workflow step nodes
  for (const node of graph.nodes) {
    const pos = g.node(node.id);
    const { width: w, height: h } = nodeDimensions(node.data.type);

    svelteNodes.push({
      id: node.id,
      type: nodeTypeForStep(node.data.type),
      position: { x: pos.x - w / 2, y: pos.y - h / 2 },
      data: {
        slug: node.data.slug,
        type: node.data.type,
        status: "waiting",
        ...extractCFMeta(node, graph.edges),
      },
    });
  }

  // Root add-step node
  if (showRootAddStep) {
    const pos = g.node("__addStep__");
    svelteNodes.push({
      id: "__addStep__",
      type: "addStep",
      position: { x: pos.x - ADD_NODE_WIDTH / 2, y: pos.y - ADD_NODE_HEIGHT / 2 },
      // Stamp the source node this add-step hangs off (the tail of the main
      // chain) so the caller can wire the new step sequentially after it.
      // Without this the new step is created detached from the graph.
      data: { sourceNodeId: lastRoot?.id },
    });
  }

  // Branch add-step nodes
  for (const info of branchAddSteps) {
    const pos = g.node(info.nodeId);
    svelteNodes.push({
      id: info.nodeId,
      type: "addStep",
      position: { x: pos.x - ADD_NODE_WIDTH / 2, y: pos.y - ADD_NODE_HEIGHT / 2 },
      data: { parentNodeId: info.parentNodeId, branch: info.branch, lastNodeId: info.lastNodeId },
    });
  }

  // Build SvelteFlow edges
  const svelteEdges: Edge[] = [];

  // Trigger -> entry node edge
  if (options.trigger && firstRootId) {
    svelteEdges.push({
      id: "__trigger__->first",
      source: "__trigger__",
      target: firstRootId,
    });
  }

  // Workflow edges (skip edges originating from terminal nodes — they have no source handle)
  for (const edge of graph.edges) {
    if (options.terminalTypes) {
      const sourceNode = graph.nodes.find((n) => n.id === edge.source);
      if (sourceNode && options.terminalTypes.has(sourceNode.data.type)) continue;
    }
    svelteEdges.push(toSvelteEdge(edge));
  }

  // Root add-step edge (dashed)
  if (showRootAddStep && lastRoot) {
    // Skip edge if the last root node is terminal (no outgoing handle)
    if (!options.terminalTypes?.has(lastRoot.data.type)) {
      svelteEdges.push({
        id: `${lastRoot.id}->__addStep__`,
        source: lastRoot.id,
        target: "__addStep__",
        style: "stroke-dasharray: 5 5;",
      });
    }
  }

  // Branch add-step edges (dashed)
  for (const info of branchAddSteps) {
    // Resolve the branch's tail node via edges (DAG model). If the branch has
    // no target, the addStep hangs directly off the CF node (empty branch).
    const branchChain = branchChainNodeIds(graph, info.parentNodeId, info.branch);
    const lastInBranchId = branchChain[branchChain.length - 1];
    const lastInBranch = lastInBranchId ? graph.nodes.find((n) => n.id === lastInBranchId) : undefined;

    // Skip edge if the source node is a terminal step type (no outgoing handle)
    if (lastInBranch && options.terminalTypes?.has(lastInBranch.data.type)) continue;

    svelteEdges.push({
      id: `${lastInBranch?.id ?? info.parentNodeId}->${info.nodeId}`,
      source: lastInBranch?.id ?? info.parentNodeId,
      target: info.nodeId,
      // Show branch label only on direct CF->addStep edges (empty branches).
      // Honor an if node's custom then/else label override so an empty branch's
      // dashed placeholder edge matches the populated-branch edge label.
      label: lastInBranch ? undefined : branchAddStepLabel(graph, info.parentNodeId, info.branch),
      style: "stroke-dasharray: 5 5;",
      sourceHandle: lastInBranch ? undefined : sourceHandleForBranch(info.parentNodeId, info.branch, graph),
    });
  }

  return { nodes: svelteNodes, edges: svelteEdges, branchAddSteps };
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
 * Extracts control flow branch labels for a node from the graph edges.
 * For if nodes: ["then"] or ["then", "else"].
 * For case nodes: the path keys + optional "default".
 *
 * @param node - The graph node to inspect
 * @param edges - All edges in the flat graph
 * @returns Object with `branches` array if the node has outgoing branch edges
 */
function extractCFMeta(node: GraphNode, edges: GraphEdge[]): Record<string, unknown> {
  if (node.data.type !== "if" && node.data.type !== "case" && node.data.type !== "iterator") {
    return {};
  }

  // For if nodes, always include "then" and "else" even if branches are empty
  if (node.data.type === "if") {
    return { branches: ["then", "else"] };
  }

  // case node: branch handles are driven by the declared `paths` (+ `default`)
  // so a newly added path key surfaces a connectable handle even before any
  // edge exists. Falls back to edge-derived labels for robustness.
  const branches = caseBranchLabels(node, edges);
  return branches.length > 0 ? { branches } : {};
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
 * Returns the set of node IDs that are the target of more than one edge.
 *
 * These are "join" nodes where multiple branches (or paths) converge. They are
 * not exclusive to any single branch and must be excluded from per-branch
 * vertical-separation math so shared nodes are not repositioned repeatedly.
 *
 * @param graph - The flat graph.
 * @returns Set of join node IDs.
 */
function nodesWithMultipleIncoming(graph: FlatGraph): Set<string> {
  const incoming = new Map<string, number>();
  for (const edge of graph.edges) {
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
  }
  const joins = new Set<string>();
  for (const [id, count] of incoming) {
    if (count > 1) joins.add(id);
  }
  return joins;
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
    // Only follow plain sequential edges (no branch key). If the current node
    // branches, it is a CF node and owns its own addStep buttons.
    const outgoing = graph.edges.filter((e) => e.source === currentId && !e.branch);
    if (outgoing.length !== 1) break;
    currentId = outgoing[0]!.target;
  }

  return currentId;
}

/**
 * Returns the IDs of all nodes in a CF node's branch chain, in order.
 *
 * Starts at the branch's labeled edge target and follows sequential (unlabeled)
 * edges. Stops at a node that branches (a nested CF node), including that node
 * but not descending into its branches.
 *
 * @param graph - The flat graph.
 * @param cfNodeId - The control-flow node ID.
 * @param branch - The branch label.
 * @returns Ordered list of node IDs in the branch chain (empty if no edge).
 */
function branchChainNodeIds(graph: FlatGraph, cfNodeId: string, branch: string): string[] {
  // Match branches by the canonical `branch` key
  const branchEdge = graph.edges.find((e) => e.source === cfNodeId && e.branch === branch);
  if (!branchEdge) return [];

  const ids: string[] = [];
  const seen = new Set<string>();
  let currentId: string | undefined = branchEdge.target;

  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    ids.push(currentId);
    const node = graph.nodes.find((n) => n.id === currentId);
    if (node && (node.data.type === "if" || node.data.type === "case" || node.data.type === "iterator")) break;
    const outgoing = graph.edges.filter((e) => e.source === currentId && !e.branch);
    if (outgoing.length !== 1) break;
    currentId = outgoing[0]!.target;
  }

  return ids;
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
  const isBranchingType = (type: string) => type === "if" || type === "case" || type === "iterator";

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
      const tailId = branchEdge ? branchTail(graph, branchEdge.target) : null;
      const tailNode = tailId ? graph.nodes.find((n) => n.id === tailId) : null;

      // A CF tail owns its own per-branch addSteps; skip adding one here.
      if (tailNode && isBranchingType(tailNode.data.type)) continue;
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
