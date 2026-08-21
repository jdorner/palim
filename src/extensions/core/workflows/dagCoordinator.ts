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
import { type DagWorkflowRun, type EdgeState, edgeId, getReadySteps, type StepStatus } from "./dagRunStore";
import { computeTerminalSteps } from "./dagValidation";
import type { ConditionDef, DagCaseStep, DagIfStep, DagStep, DagWorkflowDefinition, Edge } from "./schemas";
import { DAG_CF_TYPES } from "./schemas";
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

  // Skip if run is no longer running (already failed/completed)
  if (run.status !== "running") {
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
  const { log, broadcast } = deps;
  const stepDef = definition.steps[stepSlug]!;

  if (stepDef.type === "if") {
    await evaluateIfNode(runId, stepSlug, stepDef as DagIfStep, run, definition, topology, deps);
  } else if (stepDef.type === "case") {
    await evaluateCaseNode(runId, stepSlug, stepDef as DagCaseStep, run, definition, topology, deps);
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
    let hasSatisfied = false;
    let allDead = true;

    for (const eid of incomingEdgeIds) {
      const state = run.edgeStates[eid];
      if (state === "satisfied") {
        hasSatisfied = true;
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
      if (!freshRun || freshRun.status !== "running") return;
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
      if (!postCfRun || postCfRun.status !== "running") return;
      Object.assign(run, postCfRun);
    } else {
      // Execution node: dispatch as a job
      await dispatchStep(runId, slug, stepDef as DagStep, run, definition, deps);
      // Re-read after dispatch
      const freshRun = dagRunStore.get(runId)!;
      Object.assign(run, freshRun);
    }
  }

  // After processing all successors, check for run completion
  await checkRunCompletion(runId, definition, topology, deps);
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

    log.info(`DAG coordinator: dispatched step "${slug}" for run ${runId} (job ${result.job.id})`);
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
  const { log } = deps;

  // Mark step as dead
  dagRunStore.updateStepStatus(runId, slug, "dead");
  log.info(`DAG coordinator: step "${slug}" in run ${runId} is dead (all incoming edges dead)`);

  // Mark all outgoing edges as dead
  const outEdges = topology.outgoingEdges.get(slug) ?? [];
  for (const edge of outEdges) {
    const eid = edgeId(edge.from, edge.to, edge.branch);
    dagRunStore.updateEdgeState(runId, eid, "dead");
  }

  // Recursively check successors
  if (outEdges.length > 0) {
    const updatedRun = dagRunStore.get(runId)!;
    if (updatedRun.status !== "running") return;

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
        if (freshRun.status !== "running") return;

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
async function checkRunCompletion(
  runId: string,
  definition: DagWorkflowDefinition,
  topology: DagGraphTopology,
  deps: DagCoordinatorDeps,
): Promise<void> {
  const { log, broadcast } = deps;

  const run = dagRunStore.get(runId);
  if (!run || run.status !== "running") return;

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

  // Mark remaining pending/running steps as dead
  const run = dagRunStore.get(runId);
  if (run) {
    for (const [slug, status] of Object.entries(run.stepStatuses)) {
      if (status === "pending" || status === "running") {
        dagRunStore.updateStepStatus(runId, slug, "dead");
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
