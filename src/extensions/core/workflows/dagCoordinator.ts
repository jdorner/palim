/**
 * DAG Coordinator - orchestrates step dispatch based on edge state transitions.
 *
 * Called by the queue's `completed` and `failed` event handlers.
 * After a step completes or fails:
 * - Updates edge states and step statuses in the Run Store
 * - Evaluates CF nodes inline when their incoming edges are resolved
 * - Dispatches ready successor steps
 * - Propagates dead edges downstream
 * - Detects run completion or triggers fail-fast
 *
 * @module
 */

import type { Logger } from "@ext/types";
import type { WorkflowWebSocketEvent } from "@shared/workflows";
import type { FlowProducer } from "bunqueue/client";
import { evaluateCondition } from "./condition";
import { buildDagStepJob, buildIncomingEdgeMap, buildOutgoingEdgeMap, type SessionFactory } from "./dagEngine";
import * as dagRunStore from "./dagRunStore";
import { type DagWorkflowRun, edgeId } from "./dagRunStore";
import { computeTerminalSteps } from "./dagValidation";
import type {
  ConditionDef,
  DagAggregatorStep,
  DagCaseStep,
  DagIfStep,
  DagIteratorStep,
  DagStep,
  DagWaitForStep,
  DagWorkflowDefinition,
  Edge,
} from "./schemas";
import { DAG_CF_TYPES } from "./schemas";
import * as signalStore from "./signalStore";
import * as signalTimers from "./signalTimers";
import { resolveTemplates, type TemplateContext } from "./template";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Dependencies injected into the DAG coordinator.
 *
 * Provided once during extension initialization so the coordinator
 * can be called with only the job-specific data at runtime.
 */
export interface DagCoordinatorDeps {
  /** FlowProducer for dispatching step jobs. */
  flowProducer: FlowProducer;
  /** Session factory for creating per-step sessions. */
  sessionFactory: SessionFactory;
  /** Logger for the workflow extension. */
  log: Logger;
  /** Broadcasts a WebSocket event to connected clients. */
  broadcast: (event: WorkflowWebSocketEvent) => void;
  /** Retrieves a DAG workflow definition by name. */
  getWorkflowDefinition: (name: string) => DagWorkflowDefinition | undefined;
  /** Cancels a running job by ID (best-effort). */
  cancelJob?: (jobId: string) => Promise<void>;
}

/**
 * Precomputed graph topology for a workflow definition.
 * Computed once per definition and reused across all coordinator calls for that workflow.
 */
export interface DagGraphTopology {
  /** Map of step slug to incoming edge IDs. */
  incomingEdges: Map<string, string[]>;
  /** Map of step slug to outgoing edges. */
  outgoingEdges: Map<string, Edge[]>;
  /** Terminal step slugs (no outgoing edges). */
  terminalSteps: Set<string>;
}

/**
 * Builds the graph topology for a DAG workflow definition.
 *
 * @param definition - The DAG workflow definition
 * @returns Precomputed graph topology
 */
export function buildGraphTopology(definition: DagWorkflowDefinition): DagGraphTopology {
  return {
    incomingEdges: buildIncomingEdgeMap(definition),
    outgoingEdges: buildOutgoingEdgeMap(definition),
    terminalSteps: new Set(computeTerminalSteps(definition)),
  };
}

// ---------------------------------------------------------------------------
// Step Completion Handler
// ---------------------------------------------------------------------------

/**
 * Handles a completed DAG workflow step.
 *
 * Persists the step result, marks the step completed, satisfies outgoing edges,
 * and checks successor steps for readiness (dispatching them or evaluating
 * CF nodes inline).
 *
 * @param runId - The workflow run ID
 * @param stepSlug - The slug of the completed step
 * @param result - The step's output value
 * @param jobId - The queue job ID (for WebSocket events)
 * @param deps - Injected dependencies
 */
export async function handleDagStepCompletion(
  runId: string,
  stepSlug: string,
  result: unknown,
  jobId: string,
  deps: DagCoordinatorDeps,
): Promise<void> {
  const { log, broadcast, getWorkflowDefinition } = deps;

  // Broadcast step completed
  broadcast({
    type: "workflow_step_completed",
    workflowRunId: runId,
    stepSlug,
    jobId,
  });

  // Read current run state
  const run = dagRunStore.get(runId);
  if (!run) {
    log.error(`DAG coordinator: run ${runId} not found`);
    return;
  }

  // Skip if run is no longer active (already failed/completed). A run paused on
  // a waitFor node (waiting-signal) is still active and must keep processing
  // completions from its other branches.
  if (!dagRunStore.isActiveRunStatus(run.status)) {
    log.warn(`DAG coordinator: run ${runId} is "${run.status}", ignoring completion of step "${stepSlug}"`);
    return;
  }

  // Persist step result and mark step completed
  dagRunStore.updateStepResult(runId, stepSlug, result);
  dagRunStore.updateStepStatus(runId, stepSlug, "completed");

  // Get workflow definition for topology
  const definition = getWorkflowDefinition(run.workflowName);
  if (!definition) {
    failRun(runId, stepSlug, `Workflow definition "${run.workflowName}" no longer available`, deps);
    return;
  }

  const topology = buildGraphTopology(definition);

  // Mark all outgoing edges from this step as "satisfied"
  const outEdges = topology.outgoingEdges.get(stepSlug) ?? [];
  for (const edge of outEdges) {
    const eid = edgeId(edge.from, edge.to, edge.branch);
    dagRunStore.updateEdgeState(runId, eid, "satisfied");
  }

  // Re-read run state after updates
  const updatedRun = dagRunStore.get(runId)!;

  // Check successor steps for readiness
  await checkSuccessors(runId, outEdges, updatedRun, definition, topology, deps);
}

// ---------------------------------------------------------------------------
// CF Node Inline Evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluates a CF node inline (if/case) and marks edges accordingly.
 *
 * @param runId - The workflow run ID
 * @param stepSlug - The CF node slug
 * @param run - Current run state
 * @param definition - The workflow definition
 * @param topology - Precomputed graph topology
 * @param deps - Injected dependencies
 */
async function evaluateCfNode(
  runId: string,
  stepSlug: string,
  run: DagWorkflowRun,
  definition: DagWorkflowDefinition,
  topology: DagGraphTopology,
  deps: DagCoordinatorDeps,
): Promise<void> {
  const { log } = deps;
  const stepDef = definition.steps[stepSlug]!;

  if (stepDef.type === "if") {
    await evaluateIfNode(runId, stepSlug, stepDef as DagIfStep, run, definition, topology, deps);
  } else if (stepDef.type === "case") {
    await evaluateCaseNode(runId, stepSlug, stepDef as DagCaseStep, run, definition, topology, deps);
  } else if (stepDef.type === "iterator") {
    await evaluateIteratorNode(runId, stepSlug, stepDef as DagIteratorStep, run, definition, topology, deps);
  } else {
    log.error(`DAG coordinator: unknown CF node type "${stepDef.type}" for step "${stepSlug}"`);
    failRun(runId, stepSlug, `Unknown CF node type: ${stepDef.type}`, deps);
  }
}

/**
 * Evaluates an `if` node: resolves condition, marks chosen/dead edges, checks successors.
 */
async function evaluateIfNode(
  runId: string,
  stepSlug: string,
  stepDef: DagIfStep,
  run: DagWorkflowRun,
  definition: DagWorkflowDefinition,
  topology: DagGraphTopology,
  deps: DagCoordinatorDeps,
): Promise<void> {
  const { log, broadcast } = deps;

  // Build template context from accumulated results
  const templateCtx: TemplateContext = {
    triggerPayload: run.triggerPayload ?? undefined,
    stepResults: run.stepResults,
    stepConfigs: buildStepConfigs(definition),
  };

  // Resolve the ref template
  let resolvedValue: unknown;
  try {
    const { resolved, warnings } = await resolveTemplates(stepDef.condition.ref, templateCtx);
    const hasUnresolvable = warnings.some((w) => w.includes("Unresolvable") || w.includes("Unknown step slug"));
    if (hasUnresolvable || resolved.includes("{{")) {
      resolvedValue = undefined;
    } else {
      resolvedValue = resolved;
    }
  } catch (err) {
    log.error(`DAG coordinator: template resolution failed for if node "${stepSlug}" in run ${runId}:`, err);
    failRun(runId, stepSlug, `Template resolution failed: ${err instanceof Error ? err.message : String(err)}`, deps);
    return;
  }

  // Evaluate condition
  let conditionResult: boolean;
  try {
    conditionResult = evaluateCondition(resolvedValue, stepDef.condition as ConditionDef);
  } catch (err) {
    log.error(`DAG coordinator: condition evaluation failed for if node "${stepSlug}" in run ${runId}:`, err);
    failRun(runId, stepSlug, `Condition evaluation failed: ${err instanceof Error ? err.message : String(err)}`, deps);
    return;
  }

  const chosenBranch = conditionResult ? "then" : "else";

  // Mark step completed with result
  const ifResult = { condition: conditionResult, chosenBranch };
  dagRunStore.updateStepResult(runId, stepSlug, ifResult);
  dagRunStore.updateStepStatus(runId, stepSlug, "completed");

  // Mark edges: chosen branch = satisfied, others = dead
  const outEdges = topology.outgoingEdges.get(stepSlug) ?? [];
  for (const edge of outEdges) {
    const eid = edgeId(edge.from, edge.to, edge.branch);
    if (edge.branch === chosenBranch) {
      dagRunStore.updateEdgeState(runId, eid, "satisfied");
    } else {
      dagRunStore.updateEdgeState(runId, eid, "dead");
    }
  }

  // Broadcast
  broadcast({
    type: "workflow_step_completed",
    workflowRunId: runId,
    stepSlug,
    jobId: runId,
    chosenBranch,
  });

  log.info(`DAG if node "${stepSlug}" in run ${runId}: condition=${conditionResult}, branch="${chosenBranch}"`);

  // Re-read run state and check successors
  const updatedRun = dagRunStore.get(runId)!;
  await checkSuccessors(runId, outEdges, updatedRun, definition, topology, deps);
}

/**
 * Evaluates a `case` node: resolves match, marks chosen/dead edges, checks successors.
 */
async function evaluateCaseNode(
  runId: string,
  stepSlug: string,
  stepDef: DagCaseStep,
  run: DagWorkflowRun,
  definition: DagWorkflowDefinition,
  topology: DagGraphTopology,
  deps: DagCoordinatorDeps,
): Promise<void> {
  const { log, broadcast } = deps;

  // Build template context from accumulated results
  const templateCtx: TemplateContext = {
    triggerPayload: run.triggerPayload ?? undefined,
    stepResults: run.stepResults,
    stepConfigs: buildStepConfigs(definition),
  };

  // Resolve the match expression
  let resolvedMatch: string;
  try {
    const { resolved } = await resolveTemplates(stepDef.match, templateCtx);
    resolvedMatch = resolved;
  } catch (err) {
    log.error(`DAG coordinator: template resolution failed for case node "${stepSlug}" in run ${runId}:`, err);
    failRun(runId, stepSlug, `Template resolution failed: ${err instanceof Error ? err.message : String(err)}`, deps);
    return;
  }

  // Match against path keys
  let matchedBranch: string | null = null;
  for (const key of stepDef.paths) {
    if (resolvedMatch === key) {
      matchedBranch = key;
      break;
    }
  }

  // Fall back to default
  if (matchedBranch === null && stepDef.default) {
    matchedBranch = "default";
  }

  if (matchedBranch === null) {
    failRun(
      runId,
      stepSlug,
      `Case node "${stepSlug}" - no path matched "${resolvedMatch}" and no default defined. Paths: [${stepDef.paths.join(", ")}]`,
      deps,
    );
    return;
  }

  // Mark step completed with result
  const caseResult = { matched: matchedBranch };
  dagRunStore.updateStepResult(runId, stepSlug, caseResult);
  dagRunStore.updateStepStatus(runId, stepSlug, "completed");

  // Mark edges: matched branch = satisfied, others = dead
  const outEdges = topology.outgoingEdges.get(stepSlug) ?? [];
  for (const edge of outEdges) {
    const eid = edgeId(edge.from, edge.to, edge.branch);
    if (edge.branch === matchedBranch) {
      dagRunStore.updateEdgeState(runId, eid, "satisfied");
    } else {
      dagRunStore.updateEdgeState(runId, eid, "dead");
    }
  }

  // Broadcast
  broadcast({
    type: "workflow_step_completed",
    workflowRunId: runId,
    stepSlug,
    jobId: runId,
    chosenBranch: matchedBranch,
  });

  log.info(`DAG case node "${stepSlug}" in run ${runId}: matched="${matchedBranch}"`);

  // Re-read run state and check successors
  const updatedRun = dagRunStore.get(runId)!;
  await checkSuccessors(runId, outEdges, updatedRun, definition, topology, deps);
}

// ---------------------------------------------------------------------------
// Iterator/Aggregator Evaluation
// ---------------------------------------------------------------------------

/**
 * Iteration state stored in the iterator's step result.
 * Persisted in dagRunStore via updateStepResult.
 */
export interface IterationState {
  /** The full array of items to iterate over. */
  items: unknown[];
  /** Zero-based index of the current iteration. */
  cursor: number;
  /** Collected results from completed iterations. */
  iterationResults: unknown[];
  /** The variable name for the current item in templates. */
  as: string;
}

/**
 * Evaluates an `iterator` node: resolves items, initializes iteration state,
 * and satisfies the `each` branch edge to kick off the first iteration.
 *
 * If the items array is empty, the iterator short-circuits: it directly
 * marks the paired aggregator as completed with empty results.
 */
async function evaluateIteratorNode(
  runId: string,
  stepSlug: string,
  stepDef: DagIteratorStep,
  run: DagWorkflowRun,
  definition: DagWorkflowDefinition,
  topology: DagGraphTopology,
  deps: DagCoordinatorDeps,
): Promise<void> {
  const { log, broadcast } = deps;

  // Build template context for resolving the items expression
  const templateCtx: TemplateContext = {
    triggerPayload: run.triggerPayload ?? undefined,
    stepResults: run.stepResults,
    stepConfigs: buildStepConfigs(definition),
  };

  // Resolve the items template expression
  let itemsJson: string;
  try {
    const { resolved } = await resolveTemplates(stepDef.items, templateCtx);
    itemsJson = resolved;
  } catch (err) {
    failRun(runId, stepSlug, `Iterator items template resolution failed: ${err instanceof Error ? err.message : String(err)}`, deps);
    return;
  }

  // Parse as JSON array
  let items: unknown[];
  try {
    const parsed = JSON.parse(itemsJson);
    if (!Array.isArray(parsed)) {
      failRun(runId, stepSlug, `Iterator items resolved to ${typeof parsed}, expected array`, deps);
      return;
    }
    items = parsed;
  } catch (err) {
    failRun(runId, stepSlug, `Iterator items is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, deps);
    return;
  }

  const asName = stepDef.as ?? "item";

  // Initialize iteration state
  const iterState: IterationState = { items, cursor: 0, iterationResults: [], as: asName };
  dagRunStore.updateStepResult(runId, stepSlug, iterState);

  // Handle empty array: short-circuit to aggregator completion
  if (items.length === 0) {
    dagRunStore.updateStepStatus(runId, stepSlug, "completed");
    broadcast({ type: "workflow_step_completed", workflowRunId: runId, stepSlug, jobId: runId });
    log.info(`Iterator "${stepSlug}" in run ${runId}: empty items array, short-circuiting`);

    // Mark aggregator completed with empty results
    const aggSlug = stepDef.aggregator;
    const aggResult = { results: [], totalItems: 0, succeeded: 0, failed: 0 };
    dagRunStore.updateStepResult(runId, aggSlug, aggResult);
    dagRunStore.updateStepStatus(runId, aggSlug, "completed");
    broadcast({ type: "workflow_step_completed", workflowRunId: runId, stepSlug: aggSlug, jobId: runId });

    // Satisfy aggregator's outgoing edges and check its successors
    const aggOutEdges = topology.outgoingEdges.get(aggSlug) ?? [];
    for (const edge of aggOutEdges) {
      const eid = edgeId(edge.from, edge.to, edge.branch);
      dagRunStore.updateEdgeState(runId, eid, "satisfied");
    }
    const updatedRun = dagRunStore.get(runId)!;
    await checkSuccessors(runId, aggOutEdges, updatedRun, definition, topology, deps);
    return;
  }

  // Mark iterator completed (it only evaluates once)
  dagRunStore.updateStepStatus(runId, stepSlug, "completed");
  broadcast({ type: "workflow_step_completed", workflowRunId: runId, stepSlug, jobId: runId });

  // Satisfy the "each" branch edge to dispatch the body
  const outEdges = topology.outgoingEdges.get(stepSlug) ?? [];
  for (const edge of outEdges) {
    const eid = edgeId(edge.from, edge.to, edge.branch);
    if (edge.branch === "each") {
      dagRunStore.updateEdgeState(runId, eid, "satisfied");
    }
  }

  log.info(`Iterator "${stepSlug}" in run ${runId}: ${items.length} items, starting iteration 0`);

  // Re-read run state and check successors (dispatch body steps)
  const updatedRun = dagRunStore.get(runId)!;
  await checkSuccessors(runId, outEdges, updatedRun, definition, topology, deps);
}

/**
 * Computes the set of body step slugs between an iterator and its aggregator.
 *
 * Body = all nodes reachable from the iterator's `each` branch target
 * that are also backwards-reachable from the aggregator, excluding the
 * aggregator itself.
 *
 * @param definition - The workflow definition
 * @param iteratorSlug - The iterator step slug
 * @param aggregatorSlug - The aggregator step slug
 * @returns Set of body step slugs
 */
export function computeBodySubgraph(
  definition: DagWorkflowDefinition,
  iteratorSlug: string,
  aggregatorSlug: string,
): { bodySlugs: Set<string>; bodyEdgeIds: Set<string> } {
  const { edges } = definition;

  // Build forward adjacency
  const forward = new Map<string, Edge[]>();
  for (const slug of Object.keys(definition.steps)) {
    forward.set(slug, []);
  }
  for (const edge of edges) {
    forward.get(edge.from)?.push(edge);
  }

  // Build backward adjacency
  const backward = new Map<string, string[]>();
  for (const slug of Object.keys(definition.steps)) {
    backward.set(slug, []);
  }
  for (const edge of edges) {
    backward.get(edge.to)?.push(edge.from);
  }

  // Forward-reachable from iterator's "each" target(s)
  const forwardReachable = new Set<string>();
  const fwQueue: string[] = [];
  for (const edge of forward.get(iteratorSlug) ?? []) {
    if (edge.branch === "each" && !forwardReachable.has(edge.to)) {
      forwardReachable.add(edge.to);
      fwQueue.push(edge.to);
    }
  }
  while (fwQueue.length > 0) {
    const current = fwQueue.shift()!;
    if (current === aggregatorSlug) continue; // Don't traverse past aggregator
    for (const edge of forward.get(current) ?? []) {
      if (!forwardReachable.has(edge.to)) {
        forwardReachable.add(edge.to);
        fwQueue.push(edge.to);
      }
    }
  }

  // Backward-reachable from aggregator (stopping at iterator)
  const backwardReachable = new Set<string>();
  const bwQueue: string[] = [];
  for (const source of backward.get(aggregatorSlug) ?? []) {
    if (source !== iteratorSlug && !backwardReachable.has(source)) {
      backwardReachable.add(source);
      bwQueue.push(source);
    }
  }
  while (bwQueue.length > 0) {
    const current = bwQueue.shift()!;
    if (current === iteratorSlug) continue;
    for (const source of backward.get(current) ?? []) {
      if (source !== iteratorSlug && !backwardReachable.has(source)) {
        backwardReachable.add(source);
        bwQueue.push(source);
      }
    }
  }

  // Body = intersection of forward-reachable and backward-reachable, minus aggregator
  const bodySlugs = new Set<string>();
  for (const slug of forwardReachable) {
    if (slug !== aggregatorSlug && backwardReachable.has(slug)) {
      bodySlugs.add(slug);
    }
  }

  // Collect body edge IDs (edges where both from and to are body steps, or from iterator each to body, or body to aggregator)
  const bodyEdgeIds = new Set<string>();
  for (const edge of edges) {
    const fromIsBody = bodySlugs.has(edge.from);
    const toIsBody = bodySlugs.has(edge.to);
    const fromIsIterator = edge.from === iteratorSlug && edge.branch === "each";
    const toIsAggregator = edge.to === aggregatorSlug;

    if ((fromIsBody && toIsBody) || (fromIsIterator && toIsBody) || (fromIsBody && toIsAggregator)) {
      bodyEdgeIds.add(edgeId(edge.from, edge.to, edge.branch));
    }
  }

  return { bodySlugs, bodyEdgeIds };
}

/**
 * Resets all body step statuses and body edges to `pending`.
 * Called by the aggregator between iterations to allow re-execution.
 *
 * @param runId - The workflow run ID
 * @param bodySlugs - Set of body step slugs to reset
 * @param bodyEdgeIds - Set of body edge IDs to reset
 */
export function resetBodySubgraph(runId: string, bodySlugs: Set<string>, bodyEdgeIds: Set<string>): void {
  for (const slug of bodySlugs) {
    dagRunStore.updateStepStatus(runId, slug, "pending");
  }
  const edgeUpdates: Record<string, "pending"> = {};
  for (const eid of bodyEdgeIds) {
    edgeUpdates[eid] = "pending";
  }
  if (Object.keys(edgeUpdates).length > 0) {
    dagRunStore.updateEdgeStates(runId, edgeUpdates);
  }
}

/**
 * Evaluates an `aggregator` node: collects the current iteration's result,
 * advances the cursor, and either resets the body for the next iteration
 * or completes with collected results.
 */
export async function evaluateAggregatorNode(
  runId: string,
  stepSlug: string,
  _stepDef: DagAggregatorStep,
  run: DagWorkflowRun,
  definition: DagWorkflowDefinition,
  topology: DagGraphTopology,
  deps: DagCoordinatorDeps,
): Promise<void> {
  const { log, broadcast } = deps;

  const iterSlug = _stepDef.iterator;
  const iterState = run.stepResults[iterSlug] as IterationState | undefined;

  if (!iterState) {
    failRun(runId, stepSlug, `Aggregator "${stepSlug}" cannot read iterator state from "${iterSlug}"`, deps);
    return;
  }

  // Compute body subgraph
  const { bodySlugs, bodyEdgeIds } = computeBodySubgraph(definition, iterSlug, stepSlug);

  // Collect the body's terminal step results for this iteration
  // Terminal body steps = body steps with no outgoing edge to another body step (only to aggregator)
  const bodyTerminalSlugs: string[] = [];
  const bodyOutgoing = new Map<string, string[]>();
  for (const slug of bodySlugs) {
    bodyOutgoing.set(slug, []);
  }
  for (const edge of definition.edges) {
    if (bodySlugs.has(edge.from) && bodySlugs.has(edge.to)) {
      bodyOutgoing.get(edge.from)!.push(edge.to);
    }
  }
  for (const slug of bodySlugs) {
    if ((bodyOutgoing.get(slug) ?? []).length === 0) {
      bodyTerminalSlugs.push(slug);
    }
  }

  // Collect results from body terminal steps
  const iterationResult: Record<string, unknown> = {};
  for (const slug of bodyTerminalSlugs) {
    iterationResult[slug] = run.stepResults[slug];
  }

  // Append to iteration results and advance cursor
  iterState.iterationResults.push(iterationResult);
  iterState.cursor += 1;

  // Persist updated iteration state on the iterator
  dagRunStore.updateStepResult(runId, iterSlug, iterState);

  if (iterState.cursor < iterState.items.length) {
    // More items: reset body and re-dispatch
    log.info(
      `Aggregator "${stepSlug}" in run ${runId}: iteration ${iterState.cursor - 1} complete, advancing to ${iterState.cursor}/${iterState.items.length}`,
    );

    // Reset body subgraph
    resetBodySubgraph(runId, bodySlugs, bodyEdgeIds);

    // Reset aggregator itself to pending so it can be re-triggered
    dagRunStore.updateStepStatus(runId, stepSlug, "pending");

    // Re-satisfy the iterator's "each" edge to re-dispatch body
    const iterOutEdges = topology.outgoingEdges.get(iterSlug) ?? [];
    for (const edge of iterOutEdges) {
      if (edge.branch === "each") {
        const eid = edgeId(edge.from, edge.to, edge.branch);
        dagRunStore.updateEdgeState(runId, eid, "satisfied");
      }
    }

    // Check successors to dispatch the body again
    const updatedRun = dagRunStore.get(runId)!;
    await checkSuccessors(runId, iterOutEdges, updatedRun, definition, topology, deps);
  } else {
    // All items processed: complete the aggregator
    const aggResult = {
      results: iterState.iterationResults,
      totalItems: iterState.items.length,
      succeeded: iterState.iterationResults.length,
      failed: 0,
    };

    dagRunStore.updateStepResult(runId, stepSlug, aggResult);
    dagRunStore.updateStepStatus(runId, stepSlug, "completed");

    broadcast({ type: "workflow_step_completed", workflowRunId: runId, stepSlug, jobId: runId });

    log.info(`Aggregator "${stepSlug}" in run ${runId}: all ${iterState.items.length} iterations complete`);

    // Satisfy outgoing edges and check downstream successors
    const outEdges = topology.outgoingEdges.get(stepSlug) ?? [];
    for (const edge of outEdges) {
      const eid = edgeId(edge.from, edge.to, edge.branch);
      dagRunStore.updateEdgeState(runId, eid, "satisfied");
    }

    const updatedRun = dagRunStore.get(runId)!;
    await checkSuccessors(runId, outEdges, updatedRun, definition, topology, deps);
  }
}

// ---------------------------------------------------------------------------
// Successor Dispatch Logic
// ---------------------------------------------------------------------------

/**
 * Checks successors of recently-resolved edges for readiness.
 *
 * For each unique successor step referenced by the edges:
 * - If the step is a CF node and all its incoming edges are resolved: evaluate inline
 * - If the step is an execution node and all its incoming edges are resolved: dispatch
 * - If all incoming edges are dead (no satisfied): propagate deadness
 * - Otherwise: do nothing (wait for more edges to resolve)
 */
async function checkSuccessors(
  runId: string,
  edges: Edge[],
  run: DagWorkflowRun,
  definition: DagWorkflowDefinition,
  topology: DagGraphTopology,
  deps: DagCoordinatorDeps,
): Promise<void> {
  // Collect unique successor slugs from the edges
  const successorSlugs = new Set(edges.map((e) => e.to));

  for (const slug of successorSlugs) {
    // Skip if step is not pending (already running/completed/dead)
    if (run.stepStatuses[slug] !== "pending") continue;

    const incomingEdgeIds = topology.incomingEdges.get(slug) ?? [];
    if (incomingEdgeIds.length === 0) continue; // root node — shouldn't happen here

    // Check edge states for this successor
    let allResolved = true;
    let allDead = true;

    for (const eid of incomingEdgeIds) {
      const state = run.edgeStates[eid];
      if (state === "satisfied") {
        allDead = false;
      } else if (state === "dead") {
        // resolved but not satisfied
      } else {
        // pending
        allResolved = false;
        allDead = false;
        break;
      }
    }

    if (!allResolved) continue;

    if (allDead) {
      // All incoming edges are dead — propagate deadness
      await propagateDead(runId, slug, definition, topology, deps);
      // Re-read run state after propagation
      const freshRun = dagRunStore.get(runId);
      if (!freshRun || !dagRunStore.isActiveRunStatus(freshRun.status)) return;
      // Update local run reference for subsequent iterations
      Object.assign(run, freshRun);
      continue;
    }

    // Step is ready (all edges resolved, at least one satisfied)
    const stepDef = definition.steps[slug]!;

    if (DAG_CF_TYPES.has(stepDef.type)) {
      // CF node: evaluate inline
      dagRunStore.updateStepStatus(runId, slug, "running");
      const freshRun = dagRunStore.get(runId)!;
      await evaluateCfNode(runId, slug, freshRun, definition, topology, deps);
      // Re-read after CF evaluation
      const postCfRun = dagRunStore.get(runId);
      if (!postCfRun || !dagRunStore.isActiveRunStatus(postCfRun.status)) return;
      Object.assign(run, postCfRun);
    } else if (stepDef.type === "waitFor") {
      // WaitFor node: register a signal and pause this branch (no queue job)
      registerWaitForNode(runId, slug, stepDef as DagWaitForStep, deps);
      const freshRun = dagRunStore.get(runId)!;
      Object.assign(run, freshRun);
    } else if (stepDef.type === "aggregator") {
      // Aggregator node: evaluate inline (collect results, advance iteration or complete)
      dagRunStore.updateStepStatus(runId, slug, "running");
      const freshRun = dagRunStore.get(runId)!;
      await evaluateAggregatorNode(runId, slug, stepDef as DagAggregatorStep, freshRun, definition, topology, deps);
      const postAggRun = dagRunStore.get(runId);
      if (!postAggRun || !dagRunStore.isActiveRunStatus(postAggRun.status)) return;
      Object.assign(run, postAggRun);
    } else {
      // Execution node: dispatch as a job
      await dispatchStep(runId, slug, stepDef as DagStep, run, definition, deps);
      // Re-read after dispatch
      const freshRun = dagRunStore.get(runId)!;
      Object.assign(run, freshRun);
    }
  }

  // After processing all successors, check for run completion
  await checkRunCompletion(runId, topology, deps);
}

/**
 * Finds the iterator slug that owns the body containing a given step.
 * Returns undefined if the step is not inside any iteration body.
 */
function findIteratorForBodyStep(slug: string, definition: DagWorkflowDefinition): string | undefined {
  for (const [iterSlug, stepDef] of Object.entries(definition.steps)) {
    if (stepDef.type !== "iterator") continue;
    const iterDef = stepDef as DagIteratorStep;
    const { bodySlugs } = computeBodySubgraph(definition, iterSlug, iterDef.aggregator);
    if (bodySlugs.has(slug)) return iterSlug;
  }
  return undefined;
}

/**
 * Dispatches a single step as a queue job.
 */
async function dispatchStep(
  runId: string,
  slug: string,
  stepDef: DagStep,
  run: DagWorkflowRun,
  definition: DagWorkflowDefinition,
  deps: DagCoordinatorDeps,
): Promise<void> {
  const { flowProducer, sessionFactory, log, broadcast } = deps;

  const allStepDefs: Record<string, unknown> = {};
  for (const [s, d] of Object.entries(definition.steps)) {
    allStepDefs[s] = { slug: s, ...d };
  }

  const job = buildDagStepJob(slug, {
    workflowRunId: runId,
    workflowName: run.workflowName,
    stepDef,
    allStepDefs,
    sessionFactory,
    triggerPayload: run.triggerPayload ?? undefined,
    iteratorSlug: findIteratorForBodyStep(slug, definition),
  });

  try {
    const result = await flowProducer.add(job);
    dagRunStore.updateStepStatus(runId, slug, "running");

    broadcast({
      type: "workflow_step_started",
      workflowRunId: runId,
      stepSlug: slug,
      jobId: result.job.id,
    });

    log.debug(`DAG coordinator: dispatched step "${slug}" for run ${runId} (job ${result.job.id})`);
  } catch (err) {
    log.error(`DAG coordinator: failed to dispatch step "${slug}" for run ${runId}:`, err);
    failRun(runId, slug, `Failed to dispatch step: ${err instanceof Error ? err.message : String(err)}`, deps);
  }
}

// ---------------------------------------------------------------------------
// Dead Edge Propagation
// ---------------------------------------------------------------------------

/**
 * Propagates dead state through a step and all its downstream successors.
 *
 * When all incoming edges to a step are dead, the step becomes unreachable.
 * Its outgoing edges are marked dead, and successors are recursively checked.
 */
async function propagateDead(
  runId: string,
  slug: string,
  definition: DagWorkflowDefinition,
  topology: DagGraphTopology,
  deps: DagCoordinatorDeps,
): Promise<void> {
  const { log, broadcast } = deps;

  // Mark step as dead
  dagRunStore.updateStepStatus(runId, slug, "dead");
  broadcast({ type: "workflow_step_dead", workflowRunId: runId, stepSlug: slug });
  log.debug(`DAG coordinator: step "${slug}" in run ${runId} is dead (all incoming edges dead)`);

  // Mark all outgoing edges as dead
  const outEdges = topology.outgoingEdges.get(slug) ?? [];
  for (const edge of outEdges) {
    const eid = edgeId(edge.from, edge.to, edge.branch);
    dagRunStore.updateEdgeState(runId, eid, "dead");
  }

  // Recursively check successors
  if (outEdges.length > 0) {
    const updatedRun = dagRunStore.get(runId)!;
    if (!dagRunStore.isActiveRunStatus(updatedRun.status)) return;

    for (const edge of outEdges) {
      const successorSlug = edge.to;
      if (updatedRun.stepStatuses[successorSlug] !== "pending") continue;

      const incomingEdgeIds = topology.incomingEdges.get(successorSlug) ?? [];
      let allDead = true;
      let allResolved = true;
      let hasSatisfied = false;

      for (const eid of incomingEdgeIds) {
        const state = updatedRun.edgeStates[eid];
        if (state === "satisfied") {
          hasSatisfied = true;
          allDead = false;
        } else if (state === "dead") {
          // resolved
        } else {
          allResolved = false;
          allDead = false;
          break;
        }
      }

      if (allResolved && allDead) {
        await propagateDead(runId, successorSlug, definition, topology, deps);
      } else if (allResolved && hasSatisfied) {
        // This successor just became ready (dead edges from this step + satisfied from others)
        const stepDef = definition.steps[successorSlug]!;
        const freshRun = dagRunStore.get(runId)!;
        if (!dagRunStore.isActiveRunStatus(freshRun.status)) return;

        if (DAG_CF_TYPES.has(stepDef.type)) {
          dagRunStore.updateStepStatus(runId, successorSlug, "running");
          await evaluateCfNode(runId, successorSlug, dagRunStore.get(runId)!, definition, topology, deps);
        } else {
          await dispatchStep(runId, successorSlug, stepDef as DagStep, freshRun, definition, deps);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Run Completion Detection
// ---------------------------------------------------------------------------

/**
 * Checks if the workflow run is complete.
 *
 * A run is complete when all terminal steps (no outgoing edges) are in a
 * terminal state (completed or dead), with at least one completed.
 */
async function checkRunCompletion(runId: string, topology: DagGraphTopology, deps: DagCoordinatorDeps): Promise<void> {
  const { log, broadcast } = deps;

  const run = dagRunStore.get(runId);
  if (!run || !dagRunStore.isActiveRunStatus(run.status)) return;

  let allTerminalsDone = true;
  let hasCompleted = false;

  for (const slug of topology.terminalSteps) {
    const status = run.stepStatuses[slug];
    if (status === "completed") {
      hasCompleted = true;
    } else if (status === "dead") {
      // Dead terminal doesn't block completion
    } else {
      allTerminalsDone = false;
      break;
    }
  }

  if (allTerminalsDone && hasCompleted) {
    dagRunStore.updateStatus(runId, "completed");
    broadcast({ type: "workflow_completed", workflowRunId: runId });
    log.info(`DAG workflow run ${runId} completed`);
  }
}

// ---------------------------------------------------------------------------
// Inline Root Evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluates an inline root node (a CF or waitFor node with no incoming edges).
 *
 * Called by the engine when a workflow's root steps are all inline nodes that
 * cannot be dispatched as queue jobs. Marks the node running and evaluates it
 * inline (CF) or registers it (waitFor).
 *
 * @param runId - The workflow run ID
 * @param slug - The inline root node slug
 * @param deps - Injected dependencies
 */
export async function evaluateInlineRoot(runId: string, slug: string, deps: DagCoordinatorDeps): Promise<void> {
  const { log, getWorkflowDefinition } = deps;

  const run = dagRunStore.get(runId);
  if (!run || !dagRunStore.isActiveRunStatus(run.status)) return;

  const definition = getWorkflowDefinition(run.workflowName);
  if (!definition) {
    failRun(runId, slug, `Workflow definition "${run.workflowName}" no longer available`, deps);
    return;
  }

  const stepDef = definition.steps[slug];
  if (!stepDef) return;

  const topology = buildGraphTopology(definition);

  if (DAG_CF_TYPES.has(stepDef.type)) {
    dagRunStore.updateStepStatus(runId, slug, "running");
    await evaluateCfNode(runId, slug, dagRunStore.get(runId)!, definition, topology, deps);
  } else if (stepDef.type === "waitFor") {
    registerWaitForNode(runId, slug, stepDef as DagWaitForStep, deps);
  } else {
    log.warn(`DAG coordinator: evaluateInlineRoot called for non-inline step "${slug}" (type: ${stepDef.type})`);
  }
}

// ---------------------------------------------------------------------------
// WaitFor Registration
// ---------------------------------------------------------------------------

/**
 * Registers a `waitFor` node: marks the step running, creates a signal record,
 * broadcasts a waiting event, and arms a timeout timer if configured.
 *
 * The waitFor node does NOT run as a queue job. It pauses its branch until a
 * signal is delivered (via the signal endpoint or emit handler), at which point
 * {@link resumeWaitForNode} advances execution.
 *
 * @param runId - The workflow run ID
 * @param slug - The waitFor node slug
 * @param stepDef - The waitFor step definition
 * @param deps - Injected dependencies
 */
function registerWaitForNode(runId: string, slug: string, stepDef: DagWaitForStep, deps: DagCoordinatorDeps): void {
  const { log, broadcast } = deps;

  // Create a signal record so the delivery endpoint can find this waiting step.
  // Do this before flipping any status so a store failure leaves the run intact
  // for failRun to mark failed.
  let signalRecord: signalStore.SignalRecord;
  try {
    signalRecord = signalStore.create({
      runId,
      stepSlug: slug,
      event: stepDef.event,
      timeoutMs: stepDef.timeout ?? null,
      inputSchema: stepDef.inputSchema ?? null,
    });
  } catch (err) {
    log.error(`DAG coordinator: signal store error for waitFor "${slug}" in run ${runId}:`, err);
    failRun(runId, slug, `Signal Store unavailable: ${err instanceof Error ? err.message : String(err)}`, deps);
    return;
  }

  // Mark the step and the run as paused on a signal. Both are non-terminal:
  // resumeWaitForNode reverts them (step -> completed, run -> running) and the
  // timeout path fails the run. The run status is what the signal-delivery
  // endpoint checks to accept an incoming signal, and the coordinator's guards
  // treat waiting-signal as active so other branches keep running.
  dagRunStore.updateStepStatus(runId, slug, "waiting-signal");
  dagRunStore.updateStatus(runId, "waiting-signal");

  broadcast({
    type: "workflow_step_waiting",
    workflowRunId: runId,
    stepSlug: slug,
    event: stepDef.event,
    inputSchema: stepDef.inputSchema ?? null,
  });

  log.info(
    `DAG waitFor node "${slug}" in run ${runId}: waiting for signal "${stepDef.event}"${stepDef.timeout ? ` (timeout: ${stepDef.timeout}ms)` : ""}`,
  );

  // Arm timeout timer if configured
  if (stepDef.timeout != null && stepDef.timeout > 0) {
    signalTimers.arm(signalRecord.id, runId, slug, stepDef.event, stepDef.timeout, { log, broadcast });
  }
}

// ---------------------------------------------------------------------------
// WaitFor Resume
// ---------------------------------------------------------------------------

/**
 * Resumes a workflow run after a `waitFor` node receives its signal.
 *
 * Marks the waitFor node completed with the signal payload as its result,
 * satisfies its outgoing edges, and dispatches ready successors. This is
 * called by the signal delivery endpoint and the emit handler.
 *
 * @param runId - The workflow run ID
 * @param stepSlug - The waitFor node slug
 * @param payload - The signal payload (becomes the step's result)
 * @param deps - Injected dependencies
 */
export async function resumeWaitForNode(
  runId: string,
  stepSlug: string,
  payload: unknown,
  deps: DagCoordinatorDeps,
): Promise<void> {
  const { log, getWorkflowDefinition } = deps;

  const run = dagRunStore.get(runId);
  if (!run) {
    log.error(`DAG coordinator: run ${runId} not found for waitFor resume`);
    return;
  }

  // Do not resume a run that has already terminated (e.g. another branch failed
  // it, or a timeout fired). Reviving it to running would clobber the terminal
  // status and dispatch successors of an already-dead run.
  if (!dagRunStore.isActiveRunStatus(run.status)) {
    log.warn(`DAG coordinator: run ${runId} is "${run.status}", ignoring waitFor resume for step "${stepSlug}"`);
    return;
  }

  const definition = getWorkflowDefinition(run.workflowName);
  if (!definition) {
    failRun(runId, stepSlug, `Workflow definition "${run.workflowName}" no longer available`, deps);
    return;
  }

  const topology = buildGraphTopology(definition);

  // Persist payload as the waitFor step result and mark completed
  dagRunStore.updateStepResult(runId, stepSlug, payload);
  dagRunStore.updateStepStatus(runId, stepSlug, "completed");

  // Revert the run to running only when no other waitFor node is still paused.
  // With multiple concurrent waits, the run stays waiting-signal until the last
  // signal is delivered, keeping the run status and the signal-delivery guard
  // consistent with the remaining pending signals.
  const otherSignalsPending = signalStore.getAllWaiting().some((s) => s.runId === runId && s.stepSlug !== stepSlug);
  dagRunStore.updateStatus(runId, otherSignalsPending ? "waiting-signal" : "running");

  // Satisfy outgoing edges
  const outEdges = topology.outgoingEdges.get(stepSlug) ?? [];
  for (const edge of outEdges) {
    const eid = edgeId(edge.from, edge.to, edge.branch);
    dagRunStore.updateEdgeState(runId, eid, "satisfied");
  }

  // Check successors
  const updatedRun = dagRunStore.get(runId)!;
  await checkSuccessors(runId, outEdges, updatedRun, definition, topology, deps);
}

// ---------------------------------------------------------------------------
// Fail-Fast
// ---------------------------------------------------------------------------

/**
 * Handles a failed DAG workflow step.
 *
 * Marks the run as failed, cancels all in-flight jobs, and marks
 * remaining pending steps as dead.
 *
 * @param runId - The workflow run ID
 * @param stepSlug - The slug of the failed step
 * @param error - Error message or description
 * @param deps - Injected dependencies
 * @param jobIdsToCancel - Optional list of in-flight job IDs to cancel
 */
export async function handleDagStepFailure(
  runId: string,
  stepSlug: string,
  error: string,
  deps: DagCoordinatorDeps,
  jobIdsToCancel?: string[],
): Promise<void> {
  const { log, broadcast, cancelJob } = deps;

  log.error(`DAG coordinator: step "${stepSlug}" failed in run ${runId}: ${error}`);

  // Mark step as failed
  dagRunStore.updateStepStatus(runId, stepSlug, "failed");

  // Mark run as failed
  dagRunStore.updateStatus(runId, "failed", `Step "${stepSlug}" failed: ${error}`);

  // Broadcast failure
  broadcast({
    type: "workflow_failed",
    workflowRunId: runId,
    failedStep: stepSlug,
    error,
  });

  // Cancel in-flight jobs if cancellation function is available
  if (cancelJob && jobIdsToCancel) {
    for (const jid of jobIdsToCancel) {
      try {
        await cancelJob(jid);
      } catch {
        // Best effort
      }
    }
  }

  // Mark remaining non-terminal steps as dead. This includes waitFor nodes
  // paused on a signal (waiting-signal): when the run fails, a paused branch is
  // no longer reachable and must be swept like pending/running steps.
  const run = dagRunStore.get(runId);
  if (run) {
    for (const [slug, status] of Object.entries(run.stepStatuses)) {
      if (status === "pending" || status === "running" || status === "waiting-signal") {
        dagRunStore.updateStepStatus(runId, slug, "dead");
        broadcast({ type: "workflow_step_dead", workflowRunId: runId, stepSlug: slug });
      }
    }
  }
}

/**
 * Marks a run as failed (convenience wrapper used by other modules).
 *
 * @param runId - The run ID
 * @param stepSlug - The step that caused failure
 * @param reason - Failure reason
 * @param deps - Dependencies (only log and broadcast needed)
 */
export function failRun(
  runId: string,
  stepSlug: string,
  reason: string,
  deps: Pick<DagCoordinatorDeps, "log" | "broadcast">,
): void {
  const { log, broadcast } = deps;
  log.error(`DAG run ${runId} failed at step "${stepSlug}": ${reason}`);

  try {
    dagRunStore.updateStatus(runId, "failed", reason);
  } catch {
    // best effort
  }

  broadcast({
    type: "workflow_failed",
    workflowRunId: runId,
    failedStep: stepSlug,
    error: reason,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds step configs lookup from a DAG definition.
 */
function buildStepConfigs(definition: DagWorkflowDefinition): Record<string, unknown> {
  const configs: Record<string, unknown> = {};
  for (const [slug, stepDef] of Object.entries(definition.steps)) {
    configs[slug] = { slug, ...stepDef };
  }
  return configs;
}
