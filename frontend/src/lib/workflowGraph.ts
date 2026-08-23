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
  /**
   * Stable synthetic node identity, independent of the user-editable slug.
   * Used as the SvelteFlow node id, edge endpoint, and handle-id prefix. The
   * slug is data only (label + persistence) and may be empty or duplicated
   * mid-edit without affecting node identity.
   *
   * Optional at the input boundary: callers that do not mint ids (the read-only
   * run view) fall back to the slug. `buildDagGraph` always populates it on the
   * resulting node data.
   */
  id?: string;
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
  /** Unique ID within the graph (the step's stable synthetic id, NOT the slug). */
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
  /** Source node ID (the source step's synthetic id). */
  source: string;
  /** Target node ID (the target step's synthetic id). */
  target: string;
  /**
   * Display label rendered on the edge. For branch edges this is the branch
   * name by default, but an `if` node may override it with a custom label. Do
   * NOT use this to identify a branch -- use `branch` (the canonical key) for
   * any routing/matching logic. Undefined for sequential edges.
   */
  label?: string;
  /**
   * Canonical branch routing key ("then"/"else"/case path key/"default") for CF
   * edges; undefined for sequential edges. This is the STABLE identity used by
   * layout to match branches, independent of the (possibly overridden) display
   * `label`.
   */
  branch?: string;
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
 * Builds a flat graph from a DAG workflow's steps and edges.
 *
 * Node identity is the step's stable synthetic `id`. Edge `from`/`to` are node
 * ids (the same id space), so no slug translation happens here -- this keeps the
 * graph correct even when two steps transiently share a slug (e.g. both cleared
 * mid-edit), which a slug-keyed model cannot represent. The slug is carried in
 * `data.slug` for labels/persistence only. Handle ids are derived from the node
 * id so they stay consistent with `ControlFlowNode` (which builds its
 * `<Handle id>` from the node id).
 *
 * Steps are provided as an ORDERED ARRAY (not a slug-keyed map) so that steps
 * with equal or empty slugs each keep a distinct node. Each step must carry a
 * unique `id`; callers that do not mint ids (the read-only run view, where
 * slugs are always valid and unique) may omit it, in which case the slug is
 * used as the identity and edges are expected to be slug-based accordingly.
 *
 * Edges referencing an unknown node id are dropped (transient mid-edit state).
 *
 * @param steps - Ordered array of steps, each carrying `id`, `slug`, `type`.
 * @param edges - Edges whose `from`/`to` are node ids (matching step `id`).
 * @returns A flat graph with all nodes and edges in synthetic-id space.
 */
export function buildDagGraph(steps: StepData[], edges: DagEdge[]): FlatGraph {
  const idToType = new Map<string, string>();
  const knownIds = new Set<string>();
  // Per-if-node override map for branch EDGE display labels. Keyed by node id,
  // holding the (optional) custom "then"/"else" text. The branch routing key on
  // the edge stays canonical; only the rendered edge label is overridden.
  const idToBranchLabels = new Map<string, { then?: string; else?: string }>();

  const nodes: GraphNode[] = steps.map((step) => {
    const id = step.id ?? step.slug;
    idToType.set(id, step.type);
    knownIds.add(id);
    if (step.type === "if" && step.branchLabels && typeof step.branchLabels === "object") {
      idToBranchLabels.set(id, step.branchLabels as { then?: string; else?: string });
    }
    return {
      id,
      data: { ...step, id } as StepData,
      parent: null,
    };
  });

  const graphEdges: GraphEdge[] = [];
  for (const edge of edges) {
    // Edge endpoints are node ids. Drop edges referencing an unknown node.
    if (!knownIds.has(edge.from) || !knownIds.has(edge.to)) continue;

    const isBranch = edge.branch !== undefined;
    graphEdges.push({
      id: edge.branch ? `${edge.from}->${edge.to}:${edge.branch}` : `${edge.from}->${edge.to}`,
      source: edge.from,
      target: edge.to,
      ...(isBranch
        ? {
            // Canonical routing key stays intact for layout matching; the
            // display label may be overridden for if nodes.
            branch: edge.branch,
            label: branchEdgeLabel(idToType.get(edge.from), idToBranchLabels.get(edge.from), edge.branch!),
            sourceHandle: sourceHandleId(idToType.get(edge.from), edge.from, edge.branch!),
          }
        : {}),
    });
  }

  return { nodes, edges: graphEdges };
}

/**
 * Resolves the display label for a branch edge.
 *
 * For `if` nodes, a per-node `branchLabels` override replaces the default
 * "then"/"else" text when a non-empty custom label is set for that branch. The
 * branch routing key (`branch`) is unchanged; this only affects the pill drawn
 * on the edge. All other cases fall back to the raw branch key.
 *
 * @param sourceType - The source step's type ("if" | "case" | ...).
 * @param branchLabels - The if node's optional then/else label overrides.
 * @param branch - The canonical branch key ("then"/"else"/path key/"default").
 * @returns The label text to render on the edge.
 */
function branchEdgeLabel(
  sourceType: string | undefined,
  branchLabels: { then?: string; else?: string } | undefined,
  branch: string,
): string {
  if (sourceType === "if" && branchLabels) {
    const override = branch === "then" ? branchLabels.then : branch === "else" ? branchLabels.else : undefined;
    const trimmed = override?.trim();
    if (trimmed) return trimmed;
  }
  return branch;
}

/**
 * Computes the source handle ID for a branch edge, matching the handle IDs
 * rendered by ControlFlowNode.svelte (which builds them from the node id).
 *
 * - `if` nodes:    `${nodeId}-${branch}`         (e.g. "n3-then")
 * - `case` nodes:  `${nodeId}-path-${branch}`    (e.g. "n3-path-low"),
 *                  except the default branch:     `${nodeId}-default`
 *
 * @param sourceType - The source step's type ("if" | "case" | ...)
 * @param nodeId - The source step's synthetic node id
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
