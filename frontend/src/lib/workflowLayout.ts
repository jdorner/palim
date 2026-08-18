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

/** Default dimensions for standard step nodes. */
const NODE_WIDTH = 180;
const NODE_HEIGHT = 56;

/** Default dimensions for control flow nodes. */
const CF_NODE_WIDTH = 100;
const CF_NODE_HEIGHT = 100;

/** Default dimensions for the add-step button node. */
const ADD_NODE_WIDTH = 32;
const ADD_NODE_HEIGHT = 32;

/** Layout options for dagre. */
const LAYOUT_OPTIONS: GraphLabel = {
  rankdir: "LR",
  nodesep: 40,
  ranksep: 80,
  marginx: 20,
  marginy: 20,
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
}

/** Metadata about a branch addStep node for the caller to wire callbacks. */
export interface BranchAddStepInfo {
  /** The addStep node ID (e.g. "__addStep:step-0:then__"). */
  nodeId: string;
  /** The parent CF node ID. */
  parentNodeId: string;
  /** The branch label (e.g. "then", "else", "success", "default"). */
  branch: string;
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
    const isCF = node.data.type === "if" || node.data.type === "case";
    g.setNode(node.id, {
      width: isCF ? CF_NODE_WIDTH : NODE_WIDTH,
      height: isCF ? CF_NODE_HEIGHT : NODE_HEIGHT,
    });
  }

  // Add root add-step node (only if last root step is NOT a CF node, since CF nodes have branch addSteps)
  const rootNodes = graph.nodes.filter((n) => n.parent === null);
  const lastRoot = rootNodes[rootNodes.length - 1];
  const lastRootIsCF = lastRoot && (lastRoot.data.type === "if" || lastRoot.data.type === "case");
  const showRootAddStep = options.includeAddNode && graph.nodes.length > 0 && !lastRootIsCF;

  if (showRootAddStep) {
    g.setNode("__addStep__", { width: ADD_NODE_WIDTH, height: ADD_NODE_HEIGHT });
  }

  // Discover branches and add per-branch addStep nodes
  const branchAddSteps: BranchAddStepInfo[] = [];

  if (options.includeAddNode) {
    const branchInfos = discoverBranches(graph);
    for (const info of branchInfos) {
      const addNodeId = `__addStep:${info.parentNodeId}:${info.branch}__`;
      branchAddSteps.push({ nodeId: addNodeId, parentNodeId: info.parentNodeId, branch: info.branch });
      g.setNode(addNodeId, { width: ADD_NODE_WIDTH, height: ADD_NODE_HEIGHT });

      // Connect: last step in branch -> addStep, or CF node -> addStep (empty branch)
      if (info.lastNodeId) {
        g.setEdge(info.lastNodeId, addNodeId);
      } else {
        g.setEdge(info.parentNodeId, addNodeId);
      }
    }
  }

  // Connect trigger to first root-level node
  if (options.trigger && graph.nodes.length > 0) {
    const firstRoot = graph.nodes.find((n) => n.parent === null);
    if (firstRoot) {
      g.setEdge("__trigger__", firstRoot.id);
    }
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
    if (node.data.type !== "if" && node.data.type !== "case") continue;

    const branchLabels =
      node.data.type === "if"
        ? ["then", "else"]
        : (() => {
            const pathEdges = graph.edges.filter((e) => e.source === node.id && e.label && e.label !== "default");
            const labels = [...new Set(pathEdges.map((e) => e.label!))];
            if (graph.nodes.some((n) => n.parent?.nodeId === node.id && n.parent?.branch === "default")) {
              labels.push("default");
            }
            return labels;
          })();

    if (branchLabels.length < 2) continue;

    const cfPos = g.node(node.id);
    if (!cfPos) continue;

    // Collect all node IDs per branch (step nodes + addStep nodes)
    const branchNodeIds: string[][] = branchLabels.map((label) => {
      const stepIds = graph.nodes
        .filter((n) => n.parent?.nodeId === node.id && n.parent?.branch === label)
        .map((n) => n.id);
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

  // Extract positioned nodes
  const svelteNodes: Node[] = [];

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
    const isCF = node.data.type === "if" || node.data.type === "case";
    const w = isCF ? CF_NODE_WIDTH : NODE_WIDTH;
    const h = isCF ? CF_NODE_HEIGHT : NODE_HEIGHT;

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
  // Root add-step node
  if (showRootAddStep) {
    const pos = g.node("__addStep__");
    svelteNodes.push({
      id: "__addStep__",
      type: "addStep",
      position: { x: pos.x - ADD_NODE_WIDTH / 2, y: pos.y - ADD_NODE_HEIGHT / 2 },
      data: {},
    });
  }

  // Branch add-step nodes
  for (const info of branchAddSteps) {
    const pos = g.node(info.nodeId);
    svelteNodes.push({
      id: info.nodeId,
      type: "addStep",
      position: { x: pos.x - ADD_NODE_WIDTH / 2, y: pos.y - ADD_NODE_HEIGHT / 2 },
      data: { parentNodeId: info.parentNodeId, branch: info.branch },
    });
  }

  // Build SvelteFlow edges
  const svelteEdges: Edge[] = [];

  // Trigger -> first node edge
  if (options.trigger) {
    const firstRoot = graph.nodes.find((n) => n.parent === null);
    if (firstRoot) {
      svelteEdges.push({
        id: "__trigger__->first",
        source: "__trigger__",
        target: firstRoot.id,
      });
    }
  }

  // Workflow edges
  for (const edge of graph.edges) {
    svelteEdges.push(toSvelteEdge(edge));
  }

  // Root add-step edge (dashed)
  if (showRootAddStep && lastRoot) {
    svelteEdges.push({
      id: `${lastRoot.id}->__addStep__`,
      source: lastRoot.id,
      target: "__addStep__",
      style: "stroke-dasharray: 5 5;",
    });
  }

  // Branch add-step edges (dashed)
  for (const info of branchAddSteps) {
    const branchNodes = graph.nodes.filter(
      (n) => n.parent?.nodeId === info.parentNodeId && n.parent?.branch === info.branch,
    );
    const lastInBranch = branchNodes[branchNodes.length - 1];

    svelteEdges.push({
      id: `${lastInBranch?.id ?? info.parentNodeId}->${info.nodeId}`,
      source: lastInBranch?.id ?? info.parentNodeId,
      target: info.nodeId,
      // Show branch label only on direct CF->addStep edges (empty branches)
      label: lastInBranch ? undefined : info.branch,
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
  if (stepType === "waitFor") return "waitFor";
  return "step";
}

/** Converts a graph edge to a SvelteFlow edge with optional label and handle. */
function toSvelteEdge(edge: GraphEdge): Edge {
  const svelteEdge: Edge = {
    id: edge.id,
    source: edge.source,
    target: edge.target,
  };

  if (edge.label) {
    svelteEdge.label = edge.label;
    svelteEdge.animated = true;
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
  if (node.data.type !== "if" && node.data.type !== "case") {
    return {};
  }

  const branchEdges = edges.filter((e) => e.source === node.id && e.label);
  const branches = branchEdges.map((e) => e.label!);

  // For if nodes, always include "then" and "else" even if branches are empty
  if (node.data.type === "if") {
    const allBranches = new Set(branches);
    allBranches.add("then");
    allBranches.add("else");
    return { branches: [...allBranches] };
  }

  return branches.length > 0 ? { branches } : {};
}

/** Info about a branch discovered from the graph structure. */
interface BranchDiscovery {
  parentNodeId: string;
  branch: string;
  lastNodeId: string | null;
}

/**
 * Discovers all branches in the graph that should get an addStep node.
 * A branch exists when a CF node has outgoing branch edges, or
 * when a CF node type implies branches (e.g. if always has then/else).
 */
function discoverBranches(graph: FlatGraph): BranchDiscovery[] {
  const branches: BranchDiscovery[] = [];

  for (const node of graph.nodes) {
    if (node.data.type === "if") {
      for (const branch of ["then", "else"]) {
        const branchNodes = graph.nodes.filter((n) => n.parent?.nodeId === node.id && n.parent?.branch === branch);
        const lastNode = branchNodes.length > 0 ? branchNodes[branchNodes.length - 1] : null;
        // Skip if last node in branch is a CF node (its own branches will have addStep buttons)
        if (lastNode && (lastNode.data.type === "if" || lastNode.data.type === "case")) continue;
        branches.push({
          parentNodeId: node.id,
          branch,
          lastNodeId: lastNode?.id ?? null,
        });
      }
    } else if (node.data.type === "case") {
      const pathEdges = graph.edges.filter((e) => e.source === node.id && e.label && e.label !== "default");
      const pathKeys = new Set(pathEdges.map((e) => e.label!));

      for (const pathKey of pathKeys) {
        const branchNodes = graph.nodes.filter((n) => n.parent?.nodeId === node.id && n.parent?.branch === pathKey);
        const lastNode = branchNodes.length > 0 ? branchNodes[branchNodes.length - 1] : null;
        if (lastNode && (lastNode.data.type === "if" || lastNode.data.type === "case")) continue;
        branches.push({
          parentNodeId: node.id,
          branch: pathKey,
          lastNodeId: lastNode?.id ?? null,
        });
      }

      const defaultNodes = graph.nodes.filter((n) => n.parent?.nodeId === node.id && n.parent?.branch === "default");
      const lastDefault = defaultNodes.length > 0 ? defaultNodes[defaultNodes.length - 1] : null;
      if (!lastDefault || !(lastDefault.data.type === "if" || lastDefault.data.type === "case")) {
        branches.push({
          parentNodeId: node.id,
          branch: "default",
          lastNodeId: lastDefault?.id ?? null,
        });
      }
    }
  }

  return branches;
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
