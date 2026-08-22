/**
 * Pure helpers for overlaying workflow run execution status onto the graph.
 *
 * These functions bridge two status vocabularies:
 * - The DAG backend (`dagRunStore`) reports step statuses as
 *   "pending" | "running" | "completed" | "failed" | "dead".
 * - The graph renderer (WorkflowStepNode + edge animation) expects
 *   "waiting" | "active" | "completed" | "failed" | "waiting-signal" | "skipped".
 *
 * Keeping the mapping here (instead of inline in the Svelte components) makes it
 * unit-testable and ensures both the node highlight and the edge animation use
 * the exact same rules.
 */

/** Status vocabulary understood by the graph renderer. */
export type GraphStepStatus = "waiting" | "active" | "completed" | "failed" | "waiting-signal" | "skipped";

/**
 * Normalizes a backend DAG step status into the graph's status vocabulary.
 *
 * Without this mapping a running step is never rendered as active (no highlight,
 * no incoming-edge animation) and pending steps are not rendered as waiting.
 *
 * @param status - The raw status string from the run detail API or WS store.
 * @returns The corresponding graph status ("waiting" for unknown inputs).
 */
export function normalizeStepStatus(status: string): GraphStepStatus {
  switch (status) {
    case "running":
      return "active";
    case "pending":
      return "waiting";
    case "dead":
      return "skipped";
    case "active":
    case "waiting":
    case "completed":
    case "failed":
    case "waiting-signal":
    case "skipped":
      return status;
    default:
      return "waiting";
  }
}

/** Minimal shape of a run step for building a status map. */
export interface RunStepStatus {
  slug: string;
  status: string;
}

/** A DAG edge from the workflow definition. */
export interface DefinitionEdge {
  from: string;
  to: string;
  branch?: string;
}

/**
 * Computes the set of steps that are "dead" (on a branch that was not taken)
 * given the branches chosen so far by control-flow nodes.
 *
 * This mirrors the backend's dead-edge propagation so the graph can render the
 * ghost/skipped appearance live during a run, rather than only after reload:
 * - For a decided CF node, edges whose branch != the chosen branch are dead.
 * - A node becomes dead when ALL of its incoming edges are dead (it is no
 *   longer reachable). Deadness then propagates through its outgoing edges.
 * - Nodes reachable via at least one non-dead edge (e.g. a join node fed by a
 *   live branch) are NOT marked dead.
 *
 * @param edges - The workflow definition edges.
 * @param chosenBranches - Map of CF step slug to the branch it selected.
 * @returns Set of step slugs that are dead.
 */
export function computeDeadSteps(edges: DefinitionEdge[], chosenBranches: Record<string, string>): Set<string> {
  // An edge is dead if it leaves a decided CF node on a non-chosen branch.
  const deadEdge = (e: DefinitionEdge): boolean => {
    const chosen = chosenBranches[e.from];
    return chosen !== undefined && e.branch !== undefined && e.branch !== chosen;
  };

  const dead = new Set<string>();
  let changed = true;

  // Fixed-point: a node is dead when it has incoming edges and every one of them
  // is either a dead branch edge or comes from an already-dead node.
  while (changed) {
    changed = false;
    for (const edge of edges) {
      // Skip targets already known dead.
      if (dead.has(edge.to)) continue;

      const incoming = edges.filter((e) => e.to === edge.to);
      if (incoming.length === 0) continue;

      const allIncomingDead = incoming.every((e) => deadEdge(e) || dead.has(e.from));
      if (allIncomingDead) {
        dead.add(edge.to);
        changed = true;
      }
    }
  }

  return dead;
}

/**
 * Builds a slug -> graph-status map from a run's steps, normalizing each status.
 *
 * Steps present in the definition but absent from the run are:
 * - "skipped" if they are on a branch that was not taken (derived from
 *   `chosenBranches`), so the ghost appearance shows live during the run;
 * - "skipped" if the run has finished (completed/failed) and they never ran;
 * - otherwise left absent so the renderer falls back to "waiting".
 *
 * @param runSteps - The executed steps reported by the run.
 * @param runStatus - The overall run status (e.g. "running", "completed", "failed").
 * @param definitionSlugs - All step slugs present in the workflow definition.
 * @param edges - The workflow definition edges (for dead-branch derivation).
 * @param chosenBranches - Branches chosen by CF nodes so far.
 * @returns A map of slug to normalized graph status.
 */
export function buildStatusMap(
  runSteps: RunStepStatus[],
  runStatus: string,
  definitionSlugs: string[],
  edges: DefinitionEdge[] = [],
  chosenBranches: Record<string, string> = {},
): Record<string, GraphStepStatus> {
  const map: Record<string, GraphStepStatus> = {};

  for (const step of runSteps) {
    map[step.slug] = normalizeStepStatus(step.status);
  }

  const deadSteps = computeDeadSteps(edges, chosenBranches);
  const runFinished = runStatus === "completed" || runStatus === "failed";

  for (const slug of definitionSlugs) {
    if (map[slug] !== undefined) continue;
    // Skipped if on a not-taken branch (live), or if the run ended without it.
    if (deadSteps.has(slug) || runFinished) {
      map[slug] = "skipped";
    }
  }

  return map;
}

/** Minimal node shape needed to resolve edge animation. */
export interface StatusNode {
  id: string;
  status: GraphStepStatus | undefined;
}

/** Minimal edge shape needed to resolve edge animation. */
export interface AnimatableEdge {
  source: string;
  target: string;
  animated?: boolean;
}

/**
 * Determines whether an edge should be animated (rendered as a moving dashed
 * line).
 *
 * An edge animates when its target node is active AND its source node is on the
 * live path (not skipped/dead). Requiring a live source is what stops every
 * incoming edge of a join node from animating: when several branches converge
 * on an active follow-up node, only the edge from the branch that actually ran
 * (a completed/active source) animates, not the edges from skipped branches.
 *
 * Edges already explicitly flagged animated (e.g. dashed add-step edges in edit
 * mode) stay animated regardless.
 *
 * @param edge - The edge under consideration.
 * @param nodes - All nodes, used to resolve the source and target statuses.
 * @returns true if the edge should be animated.
 */
export function isEdgeAnimated(edge: AnimatableEdge, nodes: StatusNode[]): boolean {
  if (edge.animated === true) return true;

  const targetNode = nodes.find((n) => n.id === edge.target);
  if (targetNode?.status !== "active") return false;

  const sourceNode = nodes.find((n) => n.id === edge.source);
  // A missing source (e.g. the trigger node) or a live source keeps the edge
  // animated; a skipped/dead source does not.
  const sourceStatus = sourceNode?.status;
  return sourceStatus !== "skipped" && sourceStatus !== "failed";
}
