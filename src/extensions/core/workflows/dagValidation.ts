/**
 * DAG workflow validation.
 *
 * Performs structural and semantic validation on a DAG workflow definition:
 * - Edge reference integrity (from/to exist in steps)
 * - Cycle detection (topological sort)
 * - Root node existence (at least one step with no incoming edges)
 * - Connected graph (all steps reachable from a root)
 *
 * Pure functions — no I/O, deterministic results.
 *
 * @module
 */

import type { DagWorkflowDefinition, Edge } from "./schemas";
import { DAG_CF_TYPES } from "./schemas";

/** Validation error with a human-readable message. */
export interface DagValidationError {
  /** Machine-readable error code. */
  code:
    | "invalid_edge_ref"
    | "cycle_detected"
    | "no_root_nodes"
    | "unreachable_steps"
    | "cf_edge_missing_branch"
    | "non_cf_edge_has_branch"
    | "invalid_if_branch"
    | "invalid_case_branch"
    | "cf_node_unconditional_edge";
  /** Human-readable error message. */
  message: string;
}

/**
 * Validates a DAG workflow definition.
 *
 * Performs all structural checks: edge reference integrity, cycle detection,
 * root node existence, and connected graph validation.
 *
 * @param definition - The parsed DAG workflow definition (already schema-validated)
 * @returns Array of validation errors (empty means valid)
 */
export function validateDag(definition: DagWorkflowDefinition): DagValidationError[] {
  const errors: DagValidationError[] = [];
  const { steps, edges } = definition;
  const slugs = new Set(Object.keys(steps));

  // Single-step workflows with no edges are valid (just a root that's also a terminal)
  if (slugs.size === 1 && edges.length === 0) {
    return [];
  }

  // 1. Edge reference integrity
  for (const edge of edges) {
    if (!slugs.has(edge.from)) {
      errors.push({
        code: "invalid_edge_ref",
        message: `Edge references non-existent step "${edge.from}" in "from" field`,
      });
    }
    if (!slugs.has(edge.to)) {
      errors.push({
        code: "invalid_edge_ref",
        message: `Edge references non-existent step "${edge.to}" in "to" field`,
      });
    }
  }

  // If there are reference errors, skip further validation (graph is malformed)
  if (errors.length > 0) return errors;

  // 2. Cycle detection via topological sort (Kahn's algorithm)
  const cycleErrors = detectCycles(slugs, edges);
  errors.push(...cycleErrors);

  // If there are cycles, skip connectivity check (would be misleading)
  if (cycleErrors.length > 0) return errors;

  // 3. Root node existence
  const incomingEdges = new Map<string, Edge[]>();
  for (const slug of slugs) {
    incomingEdges.set(slug, []);
  }
  for (const edge of edges) {
    incomingEdges.get(edge.to)!.push(edge);
  }

  const rootNodes = [...slugs].filter((slug) => incomingEdges.get(slug)!.length === 0);
  if (rootNodes.length === 0) {
    errors.push({
      code: "no_root_nodes",
      message:
        "Workflow has no root nodes (every step has at least one incoming edge, implying a cycle or missing entry point)",
    });
    return errors;
  }

  // 4. Connected graph (all steps reachable from a root)
  const reachable = new Set<string>();
  const outgoing = new Map<string, string[]>();
  for (const slug of slugs) {
    outgoing.set(slug, []);
  }
  for (const edge of edges) {
    outgoing.get(edge.from)!.push(edge.to);
  }

  const queue = [...rootNodes];
  for (const node of queue) {
    if (reachable.has(node)) continue;
    reachable.add(node);
    for (const successor of outgoing.get(node)!) {
      if (!reachable.has(successor)) {
        queue.push(successor);
      }
    }
  }

  const unreachable = [...slugs].filter((slug) => !reachable.has(slug));
  if (unreachable.length > 0) {
    errors.push({
      code: "unreachable_steps",
      message: `Steps not reachable from any root node: ${unreachable.join(", ")}`,
    });
  }

  return errors;
}

/**
 * Validates control flow edge rules.
 *
 * - CF nodes (`if`/`case`) must have ONLY branch-labeled outgoing edges
 * - Non-CF nodes must NOT have branch-labeled outgoing edges
 * - `if` nodes: branch values restricted to "then" and "else"
 * - `case` nodes: branch values restricted to declared paths keys + "default"
 *
 * @param definition - The parsed DAG workflow definition
 * @returns Array of CF-edge validation errors (empty means valid)
 */
export function validateCfEdges(definition: DagWorkflowDefinition): DagValidationError[] {
  const errors: DagValidationError[] = [];
  const { steps, edges } = definition;

  // Group outgoing edges by source step
  const outgoingEdges = new Map<string, Edge[]>();
  for (const slug of Object.keys(steps)) {
    outgoingEdges.set(slug, []);
  }
  for (const edge of edges) {
    if (outgoingEdges.has(edge.from)) {
      outgoingEdges.get(edge.from)!.push(edge);
    }
  }

  for (const [slug, stepDef] of Object.entries(steps)) {
    const isCf = DAG_CF_TYPES.has(stepDef.type);
    const outEdges = outgoingEdges.get(slug) ?? [];

    if (isCf) {
      // CF nodes must have only branch-labeled edges
      for (const edge of outEdges) {
        if (!edge.branch) {
          errors.push({
            code: "cf_node_unconditional_edge",
            message: `CF node "${slug}" (type: ${stepDef.type}) has an outgoing edge to "${edge.to}" without a "branch" property`,
          });
        }
      }

      // Validate branch values
      if (stepDef.type === "if") {
        const validBranches = new Set(["then", "else"]);
        for (const edge of outEdges) {
          if (edge.branch && !validBranches.has(edge.branch)) {
            errors.push({
              code: "invalid_if_branch",
              message: `If node "${slug}" has edge to "${edge.to}" with invalid branch "${edge.branch}" (must be "then" or "else")`,
            });
          }
        }
      } else if (stepDef.type === "case") {
        const caseStep = stepDef as { type: "case"; paths: string[]; default?: string };
        const validBranches = new Set([...caseStep.paths, "default"]);
        for (const edge of outEdges) {
          if (edge.branch && !validBranches.has(edge.branch)) {
            errors.push({
              code: "invalid_case_branch",
              message: `Case node "${slug}" has edge to "${edge.to}" with invalid branch "${edge.branch}" (valid: ${[...validBranches].join(", ")})`,
            });
          }
        }
      }
    } else {
      // Non-CF nodes must not have branch-labeled edges
      for (const edge of outEdges) {
        if (edge.branch) {
          errors.push({
            code: "non_cf_edge_has_branch",
            message: `Non-CF step "${slug}" (type: ${stepDef.type}) has an outgoing edge to "${edge.to}" with a "branch" property (only CF nodes may use branch edges)`,
          });
        }
      }
    }
  }

  return errors;
}

/**
 * Detects cycles in the graph using Kahn's algorithm (topological sort).
 *
 * @param slugs - Set of all step slugs
 * @param edges - Array of edges
 * @returns Array of validation errors (empty if no cycles)
 */
function detectCycles(slugs: Set<string>, edges: Edge[]): DagValidationError[] {
  // Build in-degree map and adjacency list
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const slug of slugs) {
    inDegree.set(slug, 0);
    adjacency.set(slug, []);
  }
  for (const edge of edges) {
    adjacency.get(edge.from)!.push(edge.to);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [slug, degree] of inDegree) {
    if (degree === 0) queue.push(slug);
  }

  let processed = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    processed++;
    for (const neighbor of adjacency.get(current)!) {
      const newDegree = inDegree.get(neighbor)! - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }

  if (processed < slugs.size) {
    // Find the nodes involved in cycles (those with remaining in-degree > 0)
    const cycleNodes = [...inDegree.entries()].filter(([, degree]) => degree > 0).map(([slug]) => slug);
    return [
      {
        code: "cycle_detected",
        message: `Workflow graph contains a cycle involving steps: ${cycleNodes.join(", ")}`,
      },
    ];
  }

  return [];
}

/**
 * Computes root steps (steps with no incoming edges).
 *
 * @param definition - The DAG workflow definition
 * @returns Array of slugs that are root steps
 */
export function computeRootSteps(definition: DagWorkflowDefinition): string[] {
  const incoming = new Set<string>();
  for (const edge of definition.edges) {
    incoming.add(edge.to);
  }
  return Object.keys(definition.steps).filter((slug) => !incoming.has(slug));
}

/**
 * Computes terminal steps (steps with no outgoing edges).
 *
 * @param definition - The DAG workflow definition
 * @returns Array of slugs that are terminal steps
 */
export function computeTerminalSteps(definition: DagWorkflowDefinition): string[] {
  const outgoing = new Set<string>();
  for (const edge of definition.edges) {
    outgoing.add(edge.from);
  }
  return Object.keys(definition.steps).filter((slug) => !outgoing.has(slug));
}
