/**
 * Utilities for converting a DAG workflow definition (steps map + edges array)
 * into the flat node/edge representation consumed by the SvelteFlow renderer
 * and the dagre auto-layout.
 *
 * The DAG format IS a graph, so this is a near-direct mapping:
 * - Each entry in the `steps` map becomes a node.
 * - Each entry in the `edges` array becomes an edge (branch label preserved).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal step shape for a node's data (includes slug for identification). */
export interface StepData {
  slug: string;
  type: string;
  [key: string]: unknown;
}

/** An edge in a DAG workflow definition. */
export interface DagEdge {
  from: string;
  to: string;
  branch?: string;
}

/** A node in the flat graph representation. */
export interface GraphNode {
  /** Unique ID within the graph (the step slug). */
  id: string;
  /** The step data. */
  data: StepData;
  /** Parent branch info (retained for layout compatibility; always null in DAG mode). */
  parent: BranchRef | null;
}

/** Identifies a branch on a control flow node. */
export interface BranchRef {
  /** ID of the parent CF node. */
  nodeId: string;
  /** Branch label (e.g. "then", "else", "default"). */
  branch: string;
}

/** An edge connecting two nodes in the flat graph. */
export interface GraphEdge {
  /** Unique edge ID. */
  id: string;
  /** Source node ID (slug). */
  source: string;
  /** Target node ID (slug). */
  target: string;
  /** Label for the edge (branch name for CF edges, undefined for sequential). */
  label?: string;
  /** Source handle ID (for CF nodes with multiple outputs). */
  sourceHandle?: string;
}

/** Result of building a flat graph from a workflow. */
export interface FlatGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Control flow step types that route via branch-labeled edges. */
const CF_TYPES = new Set(["if", "case"]);

// ---------------------------------------------------------------------------
// Build flat graph from DAG definition
// ---------------------------------------------------------------------------

/**
 * Builds a flat graph from a DAG workflow's steps map and edges array.
 *
 * @param steps - The steps map keyed by slug (values may omit the slug field)
 * @param edges - The edges array from the workflow definition
 * @returns A flat graph with all nodes and edges
 */
export function buildDagGraph(steps: Record<string, Omit<StepData, "slug">>, edges: DagEdge[]): FlatGraph {
  const nodes: GraphNode[] = Object.entries(steps).map(([slug, stepDef]) => ({
    id: slug,
    data: { slug, ...stepDef } as StepData,
    parent: null,
  }));

  const graphEdges: GraphEdge[] = edges.map((edge) => {
    const isBranch = edge.branch !== undefined;
    return {
      id: edge.branch ? `${edge.from}->${edge.to}:${edge.branch}` : `${edge.from}->${edge.to}`,
      source: edge.from,
      target: edge.to,
      ...(isBranch
        ? {
            label: edge.branch,
            sourceHandle: sourceHandleId(steps[edge.from]?.type as string | undefined, edge.from, edge.branch!),
          }
        : {}),
    };
  });

  return { nodes, edges: graphEdges };
}

/**
 * Computes the source handle ID for a branch edge, matching the handle IDs
 * rendered by ControlFlowNode.svelte.
 *
 * - `if` nodes:    `${nodeId}-${branch}`         (e.g. "decide-then")
 * - `case` nodes:  `${nodeId}-path-${branch}`    (e.g. "route-path-low"),
 *                  except the default branch:     `${nodeId}-default`
 *
 * @param sourceType - The source step's type ("if" | "case" | ...)
 * @param nodeId - The source step slug
 * @param branch - The branch label
 * @returns The handle ID string
 */
function sourceHandleId(sourceType: string | undefined, nodeId: string, branch: string): string {
  if (sourceType === "case" && branch !== "default") {
    return `${nodeId}-path-${branch}`;
  }
  return `${nodeId}-${branch}`;
}

/**
 * Determines whether a step type is a control flow node (branch-routed).
 *
 * @param type - The step type string
 * @returns true if the type routes via branch edges
 */
export function isControlFlowType(type: string): boolean {
  return CF_TYPES.has(type);
}
