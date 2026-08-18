/**
 * Flatten/unflatten utilities for converting recursive WorkflowStep[]
 * into a flat node/edge representation suitable for SvelteFlow rendering,
 * and reconstructing the nested structure from the graph.
 *
 * The flat graph model makes branches explicit as edges with labels,
 * enabling visual editing of control flow in the workflow graph.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal step shape matching the backend WorkflowStep union. */
export interface StepData {
  slug: string;
  type: string;
  [key: string]: unknown;
}

/** A node in the flat graph representation. */
export interface GraphNode {
  /** Unique ID within the graph (e.g. "step-0", "step-0.then-0"). */
  id: string;
  /** The step data (without nested branch arrays for CF nodes). */
  data: StepData;
  /**
   * Parent branch info. Null for top-level steps.
   * Describes which CF node and branch this step belongs to.
   */
  parent: BranchRef | null;
}

/** Identifies a branch on a control flow node. */
export interface BranchRef {
  /** ID of the parent CF node. */
  nodeId: string;
  /** Branch label (e.g. "then", "else", "success", "default"). */
  branch: string;
}

/** An edge connecting two nodes in the flat graph. */
export interface GraphEdge {
  /** Unique edge ID. */
  id: string;
  /** Source node ID. */
  source: string;
  /** Target node ID. */
  target: string;
  /** Label for the edge (branch name for CF edges, undefined for sequential). */
  label?: string;
  /** Source handle ID (for CF nodes with multiple outputs). */
  sourceHandle?: string;
}

/** Result of flattening a workflow step tree. */
export interface FlatGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ---------------------------------------------------------------------------
// Flatten
// ---------------------------------------------------------------------------

/**
 * Flattens a recursive WorkflowStep[] into a flat graph of nodes and edges.
 *
 * Sequential steps are connected with simple edges.
 * Control flow nodes (if, case) have their branch steps extracted as separate
 * nodes, connected via labeled edges from source handles.
 *
 * @param steps - The top-level step array from the workflow definition
 * @returns A flat graph with all nodes and edges
 */
export function flattenWorkflow(steps: StepData[]): FlatGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  flattenSteps(steps, null, "step", nodes, edges);
  connectSequentialSteps(nodes, edges);

  return { nodes, edges };
}

/**
 * Recursively processes steps, adding nodes and branch edges.
 *
 * @param steps - Steps to process
 * @param parent - Parent branch reference (null for top-level)
 * @param prefix - ID prefix for generating unique node IDs
 * @param nodes - Accumulator for nodes
 * @param edges - Accumulator for edges
 */
function flattenSteps(
  steps: StepData[],
  parent: BranchRef | null,
  prefix: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
): void {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const nodeId = `${prefix}-${i}`;

    // Extract CF-specific data (strip branch arrays from node data)
    const nodeData = extractNodeData(step);
    nodes.push({ id: nodeId, data: nodeData, parent });

    // Process branches for control flow nodes
    if (step.type === "if") {
      const thenSteps = (step as { then?: StepData[] }).then ?? [];
      const elseSteps = (step as { else?: StepData[] }).else;

      flattenSteps(thenSteps, { nodeId, branch: "then" }, `${nodeId}.then`, nodes, edges);

      // Connect CF node to first step of each branch
      if (thenSteps.length > 0) {
        edges.push({
          id: `${nodeId}->then`,
          source: nodeId,
          target: `${nodeId}.then-0`,
          label: "then",
          sourceHandle: `${nodeId}-then`,
        });
      }

      if (elseSteps && elseSteps.length > 0) {
        flattenSteps(elseSteps, { nodeId, branch: "else" }, `${nodeId}.else`, nodes, edges);
        edges.push({
          id: `${nodeId}->else`,
          source: nodeId,
          target: `${nodeId}.else-0`,
          label: "else",
          sourceHandle: `${nodeId}-else`,
        });
      }
    } else if (step.type === "case") {
      const paths = (step as { paths?: Record<string, StepData[]> }).paths ?? {};
      const defaultSteps = (step as { default?: StepData[] }).default;

      for (const [pathKey, pathSteps] of Object.entries(paths)) {
        if (pathSteps.length === 0) continue;
        const branchPrefix = `${nodeId}.path-${pathKey}`;
        flattenSteps(pathSteps, { nodeId, branch: pathKey }, branchPrefix, nodes, edges);
        edges.push({
          id: `${nodeId}->path-${pathKey}`,
          source: nodeId,
          target: `${branchPrefix}-0`,
          label: pathKey,
          sourceHandle: `${nodeId}-path-${pathKey}`,
        });
      }

      if (defaultSteps && defaultSteps.length > 0) {
        const branchPrefix = `${nodeId}.default`;
        flattenSteps(defaultSteps, { nodeId, branch: "default" }, branchPrefix, nodes, edges);
        edges.push({
          id: `${nodeId}->default`,
          source: nodeId,
          target: `${branchPrefix}-0`,
          label: "default",
          sourceHandle: `${nodeId}-default`,
        });
      }
    }
  }
}

/**
 * Connects sequential steps within the same scope (same parent) with edges.
 * Siblings in the same branch are connected in order.
 */
function connectSequentialSteps(nodes: GraphNode[], edges: GraphEdge[]): void {
  // Group nodes by their parent scope
  const scopes = new Map<string, GraphNode[]>();

  for (const node of nodes) {
    const scopeKey = node.parent ? `${node.parent.nodeId}:${node.parent.branch}` : "__root__";
    const group = scopes.get(scopeKey) ?? [];
    group.push(node);
    scopes.set(scopeKey, group);
  }

  // Within each scope, connect consecutive nodes
  for (const group of scopes.values()) {
    for (let i = 0; i < group.length - 1; i++) {
      const source = group[i];
      const target = group[i + 1];
      edges.push({
        id: `${source.id}->${target.id}`,
        source: source.id,
        target: target.id,
      });
    }
  }
}

/**
 * Extracts node-level data from a step, stripping branch arrays
 * that are represented as edges in the graph.
 */
function extractNodeData(step: StepData): StepData {
  if (step.type === "if") {
    const { then: _then, else: _else, ...rest } = step as StepData & { then?: unknown; else?: unknown };
    return rest as StepData;
  }
  if (step.type === "case") {
    const {
      paths: _paths,
      default: _default,
      ...rest
    } = step as StepData & {
      paths?: unknown;
      default?: unknown;
    };
    return rest as StepData;
  }
  return step;
}

// ---------------------------------------------------------------------------
// Unflatten
// ---------------------------------------------------------------------------

/**
 * Reconstructs a recursive WorkflowStep[] from a flat graph.
 *
 * Traverses nodes grouped by scope, and for CF nodes, recursively
 * collects their branch children to rebuild the nested structure.
 *
 * @param graph - The flat graph (nodes + edges)
 * @returns The reconstructed top-level step array
 */
export function unflattenWorkflow(graph: FlatGraph): StepData[] {
  return buildStepsForScope(graph, null);
}

/**
 * Builds the step array for a given scope (parent reference).
 * For CF nodes, recursively rebuilds branch arrays from child scopes.
 */
function buildStepsForScope(graph: FlatGraph, parent: BranchRef | null): StepData[] {
  // Find all nodes in this scope, maintaining order
  const scopeNodes = graph.nodes.filter((n) => branchRefEquals(n.parent, parent));

  return scopeNodes.map((node) => {
    const step = { ...node.data };

    if (step.type === "if") {
      // Rebuild then/else branches from child scopes
      const thenSteps = buildStepsForScope(graph, { nodeId: node.id, branch: "then" });
      const elseSteps = buildStepsForScope(graph, { nodeId: node.id, branch: "else" });

      // biome-ignore lint/suspicious/noThenProperty: "then" is the workflow branch keyword, not a thenable
      (step as StepData & { then: StepData[] }).then = thenSteps;
      if (elseSteps.length > 0) {
        (step as StepData & { else: StepData[] }).else = elseSteps;
      }
    } else if (step.type === "case") {
      // Discover all path branches from edges
      const pathEdges = graph.edges.filter(
        (e) => e.source === node.id && e.sourceHandle?.startsWith(`${node.id}-path-`),
      );
      const paths: Record<string, StepData[]> = {};

      for (const edge of pathEdges) {
        const pathKey = edge.label!;
        paths[pathKey] = buildStepsForScope(graph, { nodeId: node.id, branch: pathKey });
      }

      const defaultSteps = buildStepsForScope(graph, { nodeId: node.id, branch: "default" });

      (step as StepData & { paths: Record<string, StepData[]> }).paths = paths;
      if (defaultSteps.length > 0) {
        (step as StepData & { default: StepData[] }).default = defaultSteps;
      }
    }

    return step;
  });
}

/** Compares two BranchRef values for equality (both null, or same nodeId + branch). */
function branchRefEquals(a: BranchRef | null, b: BranchRef | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.nodeId === b.nodeId && a.branch === b.branch;
}
