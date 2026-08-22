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

/**
 * Builds a slug -> graph-status map from a run's steps, normalizing each status.
 *
 * Steps present in the definition but absent from the run are marked "skipped"
 * once the run has finished (completed/failed); otherwise they are left absent
 * so the graph renderer falls back to "waiting".
 *
 * @param runSteps - The executed steps reported by the run.
 * @param runStatus - The overall run status (e.g. "running", "completed", "failed").
 * @param definitionSlugs - All step slugs present in the workflow definition.
 * @returns A map of slug to normalized graph status.
 */
export function buildStatusMap(
  runSteps: RunStepStatus[],
  runStatus: string,
  definitionSlugs: string[],
): Record<string, GraphStepStatus> {
  const map: Record<string, GraphStepStatus> = {};

  for (const step of runSteps) {
    map[step.slug] = normalizeStepStatus(step.status);
  }

  const runFinished = runStatus === "completed" || runStatus === "failed";
  for (const slug of definitionSlugs) {
    if (map[slug] === undefined && runFinished) {
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
  target: string;
  animated?: boolean;
}

/**
 * Determines whether an edge should be animated (rendered as a moving dashed
 * line). An edge animates when its target node is currently active, or when it
 * was already flagged animated (e.g. dashed add-step edges in edit mode).
 *
 * This is the rule that makes the trigger -> first-step edge animate while the
 * first step is running.
 *
 * @param edge - The edge under consideration.
 * @param nodes - All nodes, used to resolve the edge target's status.
 * @returns true if the edge should be animated.
 */
export function isEdgeAnimated(edge: AnimatableEdge, nodes: StatusNode[]): boolean {
  const targetNode = nodes.find((n) => n.id === edge.target);
  return targetNode?.status === "active" || edge.animated === true;
}
