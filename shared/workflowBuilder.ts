/**
 * WorkflowBuilder - Deterministic graph mutation engine for DAG workflows.
 *
 * Provides pure, rule-based operations for inserting, appending, removing,
 * and connecting steps in a workflow draft. Behavior is driven by a step type
 * registry that declares branching semantics for each step type.
 *
 * Lives in `shared/` so both frontend and backend can use identical mutation logic.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * An edge in a DAG workflow draft.
 *
 * `from`/`to` reference the steps' synthetic IDs (stable node identity).
 */
export interface EdgeDraft {
  from: string;
  to: string;
  branch?: string;
}

/**
 * A step in a DAG workflow draft.
 *
 * Carries a stable synthetic `id` for graph identity and a user-editable `slug`
 * for persistence. Additional fields depend on the step type.
 */
export interface StepDraft {
  [key: string]: unknown;
  /** Stable synthetic node identity. */
  id?: string;
  slug: string;
  type: string;
}

/**
 * The workflow draft data model: an ordered array of steps plus DAG edges.
 *
 * This is a minimal subset of the full WorkflowDraft (which also carries name,
 * trigger, description, etc.). The builder only operates on steps and edges.
 */
export interface BuilderDraft {
  steps: StepDraft[];
  edges: EdgeDraft[];
}

/**
 * Describes the branching semantics of a step type.
 *
 * The builder consults this descriptor for every mutation operation to determine
 * how edges should be wired on insert/remove.
 */
export interface StepTypeDescriptor {
  /** The step type identifier (e.g. "if", "agent", "iterator"). */
  type: string;
  /** Branch labels this type can produce. Empty array for pass-through nodes. */
  branches: string[];
  /** The branch that carries "main flow" when this type is inserted between nodes. */
  defaultBranch?: string;
  /** Describes a paired step type that is always created/deleted together. */
  paired?: {
    /** The paired step's type (e.g. "aggregator"). */
    type: string;
    /** The field on the paired step that references back (e.g. "iterator"). */
    ref: string;
    /** The branch edge connecting this step to its pair (e.g. "each"). */
    branch: string;
  };
  /** When true, this step type cannot have outgoing edges. */
  terminal?: boolean;
}

/**
 * Configuration for the WorkflowBuilder.
 */
export interface BuilderConfig {
  /** Step type descriptors (built-in + extension-registered). */
  stepTypes: StepTypeDescriptor[];
  /** Factory that returns a unique synthetic node ID. */
  idFactory: () => string;
  /** Factory that returns a unique step slug. */
  slugFactory: () => string;
}

// ---------------------------------------------------------------------------
// Built-in step type descriptors
// ---------------------------------------------------------------------------

/** Built-in step type descriptors for all core workflow step types. */
export const BUILTIN_STEP_TYPES: StepTypeDescriptor[] = [
  { type: "agent", branches: [] },
  { type: "if", branches: ["then", "else"], defaultBranch: "then" },
  { type: "case", branches: [], defaultBranch: "default" },
  {
    type: "iterator",
    branches: ["each"],
    defaultBranch: "each",
    paired: { type: "aggregator", ref: "iterator", branch: "each" },
  },
  { type: "aggregator", branches: [] },
  { type: "waitFor", branches: [] },
  { type: "emit", branches: [] },
  { type: "fail", branches: [], terminal: true },
];

/** Default pass-through descriptor used for unknown step types. */
const PASSTHROUGH_DESCRIPTOR: Omit<StepTypeDescriptor, "type"> = {
  branches: [],
};

// ---------------------------------------------------------------------------
// Descriptor lookup
// ---------------------------------------------------------------------------

/**
 * Looks up the descriptor for a given step type from the registry.
 * Returns a default pass-through descriptor for unknown types.
 *
 * @param type - The step type string to look up.
 * @param registry - Array of known step type descriptors.
 * @returns The matching descriptor, or a pass-through default.
 */
export function getDescriptor(type: string, registry: StepTypeDescriptor[]): StepTypeDescriptor {
  const found = registry.find((d) => d.type === type);
  if (found) return found;
  return { ...PASSTHROUGH_DESCRIPTOR, type };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Creates a minimal step template for a given type.
 * Uses the provided factories for id and slug generation.
 */
function createStep(type: string, config: BuilderConfig): StepDraft {
  const step: StepDraft = {
    id: config.idFactory(),
    slug: config.slugFactory(),
    type,
  };

  // Type-specific initialization
  switch (type) {
    case "agent":
      step.prompt = "";
      break;
    case "if":
      step.condition = { ref: "" };
      break;
    case "case":
      step.match = "";
      step.paths = [];
      step.default = "default";
      break;
    case "iterator":
      step.items = "";
      step.as = "item";
      break;
    case "aggregator":
      step.iterator = "";
      break;
    case "waitFor":
      step.event = "";
      break;
    case "emit":
      step.event = "";
      break;
    // For unknown/custom types, no extra fields
  }

  return step;
}

/**
 * Finds the edge index matching source, target, and optional branch.
 * If branch is provided, matches that specific branch.
 * If branch is undefined, matches any edge from source to target.
 */
function findEdgeIndex(edges: EdgeDraft[], from: string, to: string, branch?: string): number {
  if (branch !== undefined) {
    return edges.findIndex((e) => e.from === from && e.to === to && e.branch === branch);
  }
  return edges.findIndex((e) => e.from === from && e.to === to);
}

/**
 * Gets all incoming edges for a node.
 */
function incomingEdges(edges: EdgeDraft[], nodeId: string): EdgeDraft[] {
  return edges.filter((e) => e.to === nodeId);
}

/**
 * Gets all outgoing edges for a node.
 */
function outgoingEdges(edges: EdgeDraft[], nodeId: string): EdgeDraft[] {
  return edges.filter((e) => e.from === nodeId);
}

/**
 * Finds the paired iterator for a given aggregator step, or the paired
 * aggregator for a given iterator step.
 */
function findPairedStep(
  steps: StepDraft[],
  nodeId: string,
  registry: StepTypeDescriptor[],
): { iteratorStep: StepDraft; aggregatorStep: StepDraft } | null {
  const step = steps.find((s) => s.id === nodeId);
  if (!step) return null;

  const descriptor = getDescriptor(step.type, registry);

  if (descriptor.paired) {
    // This is the primary (e.g. iterator) - find its pair (e.g. aggregator)
    const pairedStep = steps.find((s) => s.type === descriptor.paired!.type && s[descriptor.paired!.ref] === step.slug);
    if (pairedStep) {
      return { iteratorStep: step, aggregatorStep: pairedStep };
    }
  }

  // Check if this is the paired type (e.g. aggregator) - find its primary (e.g. iterator)
  for (const desc of registry) {
    if (desc.paired && desc.paired.type === step.type) {
      // This step is the paired type. Find the primary by checking the ref field.
      const refValue = step[desc.paired.ref] as string | undefined;
      if (refValue) {
        const primary = steps.find((s) => s.slug === refValue && s.type === desc.type);
        if (primary) {
          return { iteratorStep: primary, aggregatorStep: step };
        }
      }
    }
  }

  return null;
}

/**
 * Computes the body subgraph between an iterator and its aggregator.
 * Returns the set of node IDs that are reachable from the iterator's
 * paired branch edge target, stopping at (not including) the aggregator.
 */
function computeBodyNodes(edges: EdgeDraft[], iteratorId: string, aggregatorId: string, branch: string): Set<string> {
  const body = new Set<string>();

  // Find the first node in the body (target of the branch edge from iterator)
  const branchEdge = edges.find((e) => e.from === iteratorId && e.branch === branch);
  if (!branchEdge || branchEdge.to === aggregatorId) return body;

  // BFS from the branch target, excluding the aggregator
  const queue = [branchEdge.to];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === aggregatorId || body.has(current)) continue;
    body.add(current);

    // Follow outgoing edges from nodes already in the body set
    for (const edge of edges) {
      if (edge.from === current && !body.has(edge.to) && edge.to !== aggregatorId) {
        queue.push(edge.to);
      }
    }
  }

  return body;
}

// ---------------------------------------------------------------------------
// WorkflowBuilder class
// ---------------------------------------------------------------------------

/**
 * Deterministic graph mutation engine for DAG workflows.
 *
 * Instantiated with a configuration (step type registry + factories).
 * Each method accepts a draft and returns a new draft (immutable).
 */
export class WorkflowBuilder {
  private readonly registry: StepTypeDescriptor[];
  private readonly config: BuilderConfig;

  /**
   * Creates a new WorkflowBuilder.
   *
   * @param config - Builder configuration with step type registry and factories.
   */
  constructor(config: BuilderConfig) {
    this.config = config;
    this.registry = config.stepTypes;
  }

  /**
   * Looks up the descriptor for a step type.
   *
   * @param type - The step type string.
   * @returns The matching descriptor or a pass-through default.
   */
  getDescriptor(type: string): StepTypeDescriptor {
    return getDescriptor(type, this.registry);
  }

  /**
   * Inserts a new step between two existing nodes by splitting an edge.
   *
   * The original edge is removed and replaced with:
   * - An edge from source to the new node (preserving the original branch)
   * - An edge from the new node to the target (using the new type's defaultBranch)
   *
   * For paired types (iterator), both steps are created atomically.
   * For terminal types, no outgoing edge to the target is created.
   *
   * @param draft - The current workflow draft.
   * @param sourceId - The source node ID of the edge to split.
   * @param targetId - The target node ID of the edge to split.
   * @param type - The step type to insert.
   * @param branch - Optional branch to match on the edge being split.
   * @returns A new draft with the step inserted, or the original draft if edge not found.
   */
  insertBetween(draft: BuilderDraft, sourceId: string, targetId: string, type: string, branch?: string): BuilderDraft {
    // Find the edge to split
    const edgeIdx = findEdgeIndex(draft.edges, sourceId, targetId, branch);
    if (edgeIdx === -1) return draft;

    const originalEdge = draft.edges[edgeIdx]!;
    const descriptor = getDescriptor(type, this.registry);
    const newStep = createStep(type, this.config);
    const newStepId = newStep.id!;

    // Build new edges (remove original, add replacements)
    const newEdges = draft.edges.filter((_, i) => i !== edgeIdx);

    // Edge from source to new step (preserve original branch)
    const inEdge: EdgeDraft =
      originalEdge.branch !== undefined
        ? { from: sourceId, to: newStepId, branch: originalEdge.branch }
        : { from: sourceId, to: newStepId };
    newEdges.push(inEdge);

    let newSteps = [...draft.steps, newStep];

    if (descriptor.terminal) {
      // Terminal node: no outgoing edge to target (target becomes disconnected)
    } else if (descriptor.paired) {
      // Paired type: create both steps, aggregator connects to original target
      const pairedStep = createStep(descriptor.paired.type, this.config);
      pairedStep[descriptor.paired.ref] = newStep.slug;
      const pairedStepId = pairedStep.id!;

      // iterator --each--> aggregator
      newEdges.push({ from: newStepId, to: pairedStepId, branch: descriptor.paired.branch });
      // aggregator --> original target
      newEdges.push({ from: pairedStepId, to: targetId });

      newSteps = [...draft.steps, newStep, pairedStep];
    } else {
      // Regular or CF node: outgoing edge uses defaultBranch
      const outEdge: EdgeDraft = descriptor.defaultBranch
        ? { from: newStepId, to: targetId, branch: descriptor.defaultBranch }
        : { from: newStepId, to: targetId };
      newEdges.push(outEdge);
    }

    return { steps: newSteps, edges: newEdges };
  }

  /**
   * Inserts a new step at the start of the workflow, before the first root step.
   *
   * This is the "insert between trigger and first step" operation. The trigger is
   * implicit (not a real node in the draft), so there is no edge to split: the new
   * step simply becomes the new root (no incoming edges) and an edge is added from
   * it to the original first root.
   *
   * Mirrors {@link insertBetween} but without an incoming edge.
   *
   * @param draft - The current workflow draft.
   * @param type - The step type to insert.
   * @returns A new draft with the step prepended, or the original draft if there is no root.
   */
  insertAtStart(draft: BuilderDraft, type: string): BuilderDraft {
    if (draft.steps.length === 0) return draft;

    // Find the first root step (no incoming edges) — the trigger's target
    const hasIncoming = new Set(draft.edges.map((e) => e.to));
    const root = draft.steps.find((s) => s.id && !hasIncoming.has(s.id));
    if (!root?.id) return draft;

    const descriptor = getDescriptor(type, this.registry);
    const newStep = createStep(type, this.config);
    const newStepId = newStep.id!;

    const newEdges = [...draft.edges];
    let newSteps = [...draft.steps, newStep];

    if (descriptor.terminal) {
      // Terminal node: no outgoing edge (original root becomes disconnected)
    } else if (descriptor.paired) {
      // Paired type: create both steps, aggregator connects to the original root
      const pairedStep = createStep(descriptor.paired.type, this.config);
      pairedStep[descriptor.paired.ref] = newStep.slug;
      const pairedStepId = pairedStep.id!;
      newEdges.push({ from: newStepId, to: pairedStepId, branch: descriptor.paired.branch });
      newEdges.push({ from: pairedStepId, to: root.id! });
      newSteps = [...draft.steps, newStep, pairedStep];
    } else {
      // Regular or CF node: outgoing edge uses defaultBranch
      const outEdge: EdgeDraft = descriptor.defaultBranch
        ? { from: newStepId, to: root.id!, branch: descriptor.defaultBranch }
        : { from: newStepId, to: root.id! };
      newEdges.push(outEdge);
    }

    return { steps: newSteps, edges: newEdges };
  }

  /**
   * Appends a new step after an existing node.
   *
   * Creates a new step and connects it via an edge from the source node.
   * If a branch is specified, the edge carries that branch label.
   *
   * For paired types (iterator), both steps are created atomically.
   * No-op if the source node is of a terminal type.
   *
   * @param draft - The current workflow draft.
   * @param nodeId - The node to append after.
   * @param type - The step type to create.
   * @param branch - Optional branch label for the connecting edge.
   * @returns A new draft with the step appended, or the original draft for terminal sources.
   */
  appendAfter(draft: BuilderDraft, nodeId: string, type: string, branch?: string): BuilderDraft {
    // Check if source node is terminal
    const sourceStep = draft.steps.find((s) => s.id === nodeId);
    if (sourceStep) {
      const sourceDescriptor = getDescriptor(sourceStep.type, this.registry);
      if (sourceDescriptor.terminal) return draft;
    }

    const descriptor = getDescriptor(type, this.registry);
    const newStep = createStep(type, this.config);
    const newStepId = newStep.id!;

    const newEdges = [...draft.edges];

    // Edge from source to new step
    const edge: EdgeDraft =
      branch !== undefined ? { from: nodeId, to: newStepId, branch } : { from: nodeId, to: newStepId };
    newEdges.push(edge);

    let newSteps = [...draft.steps, newStep];

    if (descriptor.paired) {
      // Paired type: create both steps with connecting edge
      const pairedStep = createStep(descriptor.paired.type, this.config);
      pairedStep[descriptor.paired.ref] = newStep.slug;
      const pairedStepId = pairedStep.id!;

      newEdges.push({ from: newStepId, to: pairedStepId, branch: descriptor.paired.branch });
      newSteps = [...draft.steps, newStep, pairedStep];
    }

    return { steps: newSteps, edges: newEdges };
  }

  /**
   * Removes a step and adjusts edges according to rule-based semantics.
   *
   * - 0-1 wired outputs: splice out (reconnect predecessors to the single successor)
   * - 2+ wired outputs: reconnect predecessors to defaultBranch target, orphan others
   * - Iterator/aggregator pair: cascade delete (remove pair + body, reconnect around)
   *
   * @param draft - The current workflow draft.
   * @param nodeId - The node ID to remove.
   * @returns A new draft with the node removed and edges adjusted.
   */
  remove(draft: BuilderDraft, nodeId: string): BuilderDraft {
    const step = draft.steps.find((s) => s.id === nodeId);
    if (!step) return draft;

    // Check for iterator/aggregator pair - cascade delete
    const pair = findPairedStep(draft.steps, nodeId, this.registry);
    if (pair) {
      return this.removePair(draft, pair.iteratorStep, pair.aggregatorStep);
    }

    const incoming = incomingEdges(draft.edges, nodeId);
    const outgoing = outgoingEdges(draft.edges, nodeId);

    // Determine reconnection target based on wired output count
    let reconnectTargetId: string | undefined;

    if (outgoing.length === 0) {
      // Tail node: no reconnection
      reconnectTargetId = undefined;
    } else if (outgoing.length === 1) {
      // Single output: splice out
      reconnectTargetId = outgoing[0]!.to;
    } else {
      // Multiple outputs: reconnect through defaultBranch
      const descriptor = getDescriptor(step.type, this.registry);
      const defaultTarget = outgoing.find((e) => e.branch === descriptor.defaultBranch);
      reconnectTargetId = defaultTarget?.to;
    }

    // Build new edges: remove all edges touching this node, add reconnections
    const newEdges = draft.edges.filter((e) => e.from !== nodeId && e.to !== nodeId);

    if (reconnectTargetId !== undefined) {
      // Reconnect each predecessor to the target
      for (const inEdge of incoming) {
        const reconnection: EdgeDraft =
          inEdge.branch !== undefined
            ? { from: inEdge.from, to: reconnectTargetId, branch: inEdge.branch }
            : { from: inEdge.from, to: reconnectTargetId };
        newEdges.push(reconnection);
      }
    }

    // Remove the step
    const newSteps = draft.steps.filter((s) => s.id !== nodeId);

    return { steps: newSteps, edges: newEdges };
  }

  /**
   * Adds a new step as the first node on an empty branch of a CF node.
   *
   * No-op if the branch is already wired (has an existing edge with that branch label).
   *
   * @param draft - The current workflow draft.
   * @param cfNodeId - The CF node whose branch to populate.
   * @param branch - The branch label to wire.
   * @param type - The step type to create.
   * @returns A new draft with the step added to the branch, or unchanged if branch is wired.
   */
  addToBranch(draft: BuilderDraft, cfNodeId: string, branch: string, type: string): BuilderDraft {
    // Check if branch is already wired
    const existingEdge = draft.edges.find((e) => e.from === cfNodeId && e.branch === branch);
    if (existingEdge) return draft;

    const descriptor = getDescriptor(type, this.registry);
    const newStep = createStep(type, this.config);
    const newStepId = newStep.id!;

    const newEdges = [...draft.edges];
    newEdges.push({ from: cfNodeId, to: newStepId, branch });

    let newSteps = [...draft.steps, newStep];

    if (descriptor.paired) {
      // Paired type: create both steps with connecting edge
      const pairedStep = createStep(descriptor.paired.type, this.config);
      pairedStep[descriptor.paired.ref] = newStep.slug;
      const pairedStepId = pairedStep.id!;

      newEdges.push({ from: newStepId, to: pairedStepId, branch: descriptor.paired.branch });
      newSteps = [...draft.steps, newStep, pairedStep];
    }

    return { steps: newSteps, edges: newEdges };
  }

  /**
   * Adds a raw edge between two existing nodes.
   *
   * Idempotent: returns the draft unchanged if an identical edge already exists.
   *
   * @param draft - The current workflow draft.
   * @param sourceId - The source node ID.
   * @param targetId - The target node ID.
   * @param branch - Optional branch label for the edge.
   * @returns A new draft with the edge added, or unchanged if duplicate.
   */
  connect(draft: BuilderDraft, sourceId: string, targetId: string, branch?: string): BuilderDraft {
    // Check for duplicate
    const exists = draft.edges.some((e) => {
      if (e.from !== sourceId || e.to !== targetId) return false;
      if (branch !== undefined) return e.branch === branch;
      return e.branch === undefined;
    });
    if (exists) return draft;

    const newEdge: EdgeDraft =
      branch !== undefined ? { from: sourceId, to: targetId, branch } : { from: sourceId, to: targetId };

    return { steps: draft.steps, edges: [...draft.edges, newEdge] };
  }

  /**
   * Removes an edge between two nodes.
   *
   * Returns the draft unchanged if no matching edge is found.
   *
   * @param draft - The current workflow draft.
   * @param sourceId - The source node ID.
   * @param targetId - The target node ID.
   * @param branch - Optional branch label to match.
   * @returns A new draft without the matching edge, or unchanged if not found.
   */
  disconnect(draft: BuilderDraft, sourceId: string, targetId: string, branch?: string): BuilderDraft {
    const idx = draft.edges.findIndex((e) => {
      if (e.from !== sourceId || e.to !== targetId) return false;
      if (branch !== undefined) return e.branch === branch;
      return e.branch === undefined;
    });
    if (idx === -1) return draft;

    const newEdges = draft.edges.filter((_, i) => i !== idx);
    return { steps: draft.steps, edges: newEdges };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Removes an iterator+aggregator pair and all body nodes between them.
   * Reconnects the iterator's predecessors to the aggregator's successors.
   */
  private removePair(draft: BuilderDraft, iteratorStep: StepDraft, aggregatorStep: StepDraft): BuilderDraft {
    const iteratorId = iteratorStep.id!;
    const aggregatorId = aggregatorStep.id!;

    // Find the paired descriptor to know the branch
    const iterDescriptor = getDescriptor(iteratorStep.type, this.registry);
    const pairBranch = iterDescriptor.paired?.branch ?? "each";

    // Compute body nodes (between iterator and aggregator)
    const bodyNodeIds = computeBodyNodes(draft.edges, iteratorId, aggregatorId, pairBranch);

    // All nodes to remove: iterator + aggregator + body
    const removeIds = new Set([iteratorId, aggregatorId, ...bodyNodeIds]);

    // Find predecessors of iterator and successors of aggregator
    const iterPredecessors = incomingEdges(draft.edges, iteratorId);
    const aggSuccessors = outgoingEdges(draft.edges, aggregatorId);

    // Build new edges: remove all edges touching removed nodes, add reconnections
    const newEdges = draft.edges.filter((e) => !removeIds.has(e.from) && !removeIds.has(e.to));

    // Reconnect: each predecessor of iterator connects to each successor of aggregator
    for (const predEdge of iterPredecessors) {
      for (const succEdge of aggSuccessors) {
        const reconnection: EdgeDraft =
          predEdge.branch !== undefined
            ? { from: predEdge.from, to: succEdge.to, branch: predEdge.branch }
            : { from: predEdge.from, to: succEdge.to };
        newEdges.push(reconnection);
      }
    }

    // Remove all steps in the removal set
    const newSteps = draft.steps.filter((s) => !removeIds.has(s.id!));

    return { steps: newSteps, edges: newEdges };
  }
}
