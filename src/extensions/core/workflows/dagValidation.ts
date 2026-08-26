/**
 * DAG workflow validation.
 *
 * Performs structural and semantic validation on a DAG workflow definition:
 * - Edge reference integrity (from/to exist in steps)
 * - Orphaned step detection (no incoming or outgoing edges in a multi-step graph)
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
    | "orphaned_step"
    | "cf_edge_missing_branch"
    | "non_cf_edge_has_branch"
    | "invalid_if_branch"
    | "invalid_case_branch"
    | "invalid_iterator_branch"
    | "cf_node_unconditional_edge"
    | "iterator_missing_aggregator"
    | "aggregator_missing_iterator"
    | "iterator_aggregator_mismatch"
    | "aggregator_unreachable";
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

  // 2. Orphaned step detection: in a multi-step workflow every step must
  // participate in at least one edge. A lone orphan technically qualifies as a
  // root node (no incoming edges), so it survives the reachability check below;
  // this explicit pass is what catches it.
  const touched = new Set<string>();
  for (const edge of edges) {
    touched.add(edge.from);
    touched.add(edge.to);
  }
  for (const slug of slugs) {
    if (!touched.has(slug)) {
      errors.push({
        code: "orphaned_step",
        message: `Step "${slug}" is not connected to any other step (no incoming or outgoing edges)`,
      });
    }
  }
  if (errors.length > 0) return errors;

  // 3. Cycle detection via topological sort (Kahn's algorithm)
  const cycleErrors = detectCycles(slugs, edges);
  errors.push(...cycleErrors);

  // If there are cycles, skip connectivity check (would be misleading)
  if (cycleErrors.length > 0) return errors;

  // 4. Root node existence
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

  // 5. Connected graph (all steps reachable from a root)
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
      } else if (stepDef.type === "iterator") {
        const validBranches = new Set(["each"]);
        for (const edge of outEdges) {
          if (edge.branch && !validBranches.has(edge.branch)) {
            errors.push({
              code: "invalid_iterator_branch",
              message: `Iterator node "${slug}" has edge to "${edge.to}" with invalid branch "${edge.branch}" (must be "each")`,
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

/**
 * Validates iterator/aggregator pairing rules.
 *
 * Checks:
 * - Every iterator references an existing aggregator slug
 * - Every aggregator references an existing iterator slug
 * - Mutual references are consistent (iterator.aggregator == aggregator slug AND aggregator.iterator == iterator slug)
 * - The aggregator is reachable from the iterator's `each` branch (connected via body path)
 *
 * @param definition - The parsed DAG workflow definition
 * @returns Array of pairing validation errors (empty means valid)
 */
export function validateIteratorPairing(definition: DagWorkflowDefinition): DagValidationError[] {
  const errors: DagValidationError[] = [];
  const { steps, edges } = definition;

  // Build forward adjacency for reachability checks
  const adjacency = new Map<string, string[]>();
  for (const slug of Object.keys(steps)) {
    adjacency.set(slug, []);
  }
  for (const edge of edges) {
    if (adjacency.has(edge.from)) {
      adjacency.get(edge.from)!.push(edge.to);
    }
  }

  // Collect iterators and aggregators
  const iterators = new Map<string, { aggregator: string }>();
  const aggregators = new Map<string, { iterator: string }>();

  for (const [slug, stepDef] of Object.entries(steps)) {
    if (stepDef.type === "iterator") {
      const iter = stepDef as { type: "iterator"; aggregator: string };
      iterators.set(slug, { aggregator: iter.aggregator });
    } else if (stepDef.type === "aggregator") {
      const agg = stepDef as { type: "aggregator"; iterator: string };
      aggregators.set(slug, { iterator: agg.iterator });
    }
  }

  // Validate each iterator
  for (const [iterSlug, iterDef] of iterators) {
    const aggSlug = iterDef.aggregator;

    // Aggregator must exist
    if (!steps[aggSlug]) {
      errors.push({
        code: "iterator_missing_aggregator",
        message: `Iterator "${iterSlug}" references aggregator "${aggSlug}" which does not exist`,
      });
      continue;
    }

    // Must be an aggregator type
    if (steps[aggSlug]!.type !== "aggregator") {
      errors.push({
        code: "iterator_missing_aggregator",
        message: `Iterator "${iterSlug}" references "${aggSlug}" which is not an aggregator (type: ${steps[aggSlug]!.type})`,
      });
      continue;
    }

    // Mutual reference check
    const aggDef = aggregators.get(aggSlug);
    if (!aggDef || aggDef.iterator !== iterSlug) {
      errors.push({
        code: "iterator_aggregator_mismatch",
        message: `Iterator "${iterSlug}" references aggregator "${aggSlug}" but the aggregator's iterator field points to "${aggDef?.iterator ?? "(none)"}"`,
      });
    }

    // Reachability: aggregator must be reachable from iterator via forward edges
    const reachable = new Set<string>();
    const queue = [iterSlug];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const neighbor of adjacency.get(current) ?? []) {
        if (!reachable.has(neighbor)) {
          reachable.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    if (!reachable.has(aggSlug)) {
      errors.push({
        code: "aggregator_unreachable",
        message: `Aggregator "${aggSlug}" is not reachable from its paired iterator "${iterSlug}"`,
      });
    }
  }

  // Validate each aggregator references a valid iterator
  for (const [aggSlug, aggDef] of aggregators) {
    const iterSlug = aggDef.iterator;

    if (!steps[iterSlug]) {
      errors.push({
        code: "aggregator_missing_iterator",
        message: `Aggregator "${aggSlug}" references iterator "${iterSlug}" which does not exist`,
      });
      continue;
    }

    if (steps[iterSlug]!.type !== "iterator") {
      errors.push({
        code: "aggregator_missing_iterator",
        message: `Aggregator "${aggSlug}" references "${iterSlug}" which is not an iterator (type: ${steps[iterSlug]!.type})`,
      });
      continue;
    }

    // Check if this aggregator is referenced by its iterator (orphan detection)
    const iterDef = iterators.get(iterSlug);
    if (!iterDef || iterDef.aggregator !== aggSlug) {
      errors.push({
        code: "iterator_aggregator_mismatch",
        message: `Aggregator "${aggSlug}" references iterator "${iterSlug}" but the iterator's aggregator field points to "${iterDef?.aggregator ?? "(none)"}"`,
      });
    }
  }

  return errors;
}
