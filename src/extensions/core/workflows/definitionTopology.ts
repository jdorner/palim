/**
 * Topology of a validated DAG workflow definition, memoized per definition object.
 *
 * Thin backend adapter over {@link analyzeWorkflowGraph} from
 * `shared/workflowTopology.ts`, the one place graph rules are implemented.
 *
 * @module
 */

import { analyzeWorkflowGraph, type WorkflowTopology } from "@shared/workflowTopology";
import type { DagWorkflowDefinition } from "./schemas";

const cache = new WeakMap<DagWorkflowDefinition, WorkflowTopology>();

/**
 * Returns the graph analysis of a workflow definition. The definition must not
 * be mutated afterwards: the analysis is cached by object identity.
 *
 * @param definition - The DAG workflow definition
 * @returns The definition's topology
 */
export function definitionTopology(definition: DagWorkflowDefinition): WorkflowTopology {
  let topology = cache.get(definition);
  if (!topology) {
    topology = analyzeWorkflowGraph(definition.steps, definition.edges);
    cache.set(definition, topology);
  }
  return topology;
}
