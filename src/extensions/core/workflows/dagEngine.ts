/**
 * DAG Workflow Engine - dispatches workflow executions using DAG-based dispatch.
 *
 * Computes root steps, creates a Run Store record with all edges in
 * pending state and all steps in pending state, then dispatches each
 * root step as an individual job via `flow.add()`.
 *
 * @module
 */

import type { Logger, WorkflowDispatchResult } from "@ext/types";
import type { FlowJob, FlowProducer } from "bunqueue/client";
import * as dagRunStore from "./dagRunStore";
import { type EdgeState, edgeId, type StepStatus } from "./dagRunStore";
import { computeRootSteps } from "./dagValidation";
import type { DagStep, DagWorkflowDefinition, Edge } from "./schemas";
import { DAG_CF_TYPES } from "./schemas";

/**
 * Minimal session factory interface - only the `create` method is needed
 * by the workflow engine to create per-step sessions.
 */
export interface SessionFactory {
  create(opts: { source: string; sourceId?: string; metadata?: Record<string, unknown> }): { id: string };
}

/** Queue name used for all workflow step jobs. */
export const DAG_WORKFLOW_STEPS_QUEUE = "workflows:steps";

/** Data payload carried by each DAG workflow step job. */
export interface DagStepJobData {
  /** Unique identifier for this workflow run. */
  workflowRunId: string;
  /** Name of the workflow definition. */
  workflowName: string;
  /** Slug of this step. */
  stepSlug: string;
  /** The step definition. */
  stepDef: DagStep;
  /** All step definitions in the workflow, keyed by slug. Used for `{{steps.<slug>.config}}` resolution. */
  allStepDefs: Record<string, unknown>;
  /** Session ID for persisting conversation context for this step. */
  sessionId: string;
  /** Trigger payload (available to all steps via template resolution from Run Store). */
  triggerPayload?: unknown;
}

/**
 * Builds a single FlowStep for an individual DAG step dispatch.
 *
 * @param slug - The step slug
 * @param opts - Context for building the job
 * @returns A FlowStep ready for `flow.add()`
 */
export function buildDagStepJob(
  slug: string,
  opts: {
    workflowRunId: string;
    workflowName: string;
    stepDef: DagStep;
    allStepDefs: Record<string, unknown>;
    sessionFactory: SessionFactory;
    triggerPayload?: unknown;
  },
): FlowJob<DagStepJobData> {
  const session = opts.sessionFactory.create({
    source: "workflow",
    metadata: {
      workflowName: opts.workflowName,
      workflowRunId: opts.workflowRunId,
      stepSlug: slug,
    },
  });

  const data: DagStepJobData = {
    workflowRunId: opts.workflowRunId,
    workflowName: opts.workflowName,
    stepSlug: slug,
    stepDef: opts.stepDef,
    allStepDefs: opts.allStepDefs,
    sessionId: session.id,
    triggerPayload: opts.triggerPayload,
  };

  return {
    name: DAG_WORKFLOW_STEPS_QUEUE,
    queueName: DAG_WORKFLOW_STEPS_QUEUE,
    data,
    opts: { attempts: 1 },
  };
}

/**
 * Dispatches a DAG workflow execution.
 *
 * Creates a Run Store record with all edges in `pending` state and all
 * steps in `pending` state, computes root steps, and dispatches each
 * root as an individual job via `flow.add()`.
 *
 * @param flow - The shared FlowProducer instance
 * @param definition - The validated DAG workflow definition
 * @param triggerPayload - The trigger's input data (webhook body, etc.)
 * @param log - Logger for reporting dispatch details
 * @param sessionStore - Session factory for creating per-step sessions
 * @returns The run ID and dispatched job IDs
 */
export async function dispatchDagWorkflow(
  flow: FlowProducer,
  definition: DagWorkflowDefinition,
  triggerPayload: unknown,
  log: Logger,
  sessionStore: SessionFactory,
  onInlineRoots?: (runId: string, rootSlugs: string[]) => Promise<void>,
): Promise<WorkflowDispatchResult> {
  const workflowRunId = crypto.randomUUID();
  const { steps, edges } = definition;

  // Build allStepDefs lookup for template resolution
  const allStepDefs: Record<string, unknown> = {};
  for (const [slug, stepDef] of Object.entries(steps)) {
    allStepDefs[slug] = { slug, ...stepDef };
  }

  // Initialize edge states (all pending)
  const edgeStates: Record<string, EdgeState> = {};
  for (const edge of edges) {
    const eid = edgeId(edge.from, edge.to, edge.branch);
    edgeStates[eid] = "pending";
  }

  // Initialize step statuses (all pending)
  const stepStatuses: Record<string, StepStatus> = {};
  for (const slug of Object.keys(steps)) {
    stepStatuses[slug] = "pending";
  }

  // Create Run Store record
  try {
    dagRunStore.create({
      id: workflowRunId,
      workflowName: definition.name,
      status: "running",
      edgeStates,
      stepStatuses,
      stepResults: {},
      triggerPayload,
      failureReason: null,
    });
  } catch (err) {
    log.error(`Failed to create DAG Run Store record for workflow "${definition.name}":`, err);
    throw new Error(`DAG Run Store unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Compute root steps (no incoming edges)
  const rootSlugs = computeRootSteps(definition);

  // Filter out non-dispatchable root nodes (CF and waitFor are handled inline,
  // not dispatched as queue jobs).
  const dispatchableRoots = rootSlugs.filter((slug) => {
    const t = steps[slug]!.type;
    return !DAG_CF_TYPES.has(t) && t !== "waitFor";
  });

  if (dispatchableRoots.length === 0 && rootSlugs.length > 0) {
    // All roots are inline nodes (CF/waitFor) — the coordinator handles them.
    // Kick off inline evaluation for each inline root via the provided callback.
    log.info(
      `Dispatching DAG workflow "${definition.name}" run ${workflowRunId} (${Object.keys(steps).length} steps, all roots are inline nodes - deferring to coordinator)`,
    );
    if (onInlineRoots) {
      await onInlineRoots(workflowRunId, rootSlugs);
    }
    return { workflowRunId, jobIds: [] };
  }

  // Dispatch each root step individually
  const jobIds: string[] = [];
  for (const slug of dispatchableRoots) {
    const stepDef = steps[slug]!;
    const job = buildDagStepJob(slug, {
      workflowRunId,
      workflowName: definition.name,
      stepDef: stepDef as DagStep,
      allStepDefs,
      sessionFactory: sessionStore,
      triggerPayload: triggerPayload ?? undefined,
    });

    try {
      const result = await flow.add(job);
      jobIds.push(result.job.id);
      dagRunStore.updateStepStatus(workflowRunId, slug, "running");
    } catch (err) {
      log.error(`Failed to dispatch root step "${slug}" for run ${workflowRunId}:`, err);
      dagRunStore.updateStatus(
        workflowRunId,
        "failed",
        `Failed to dispatch root step "${slug}": ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  log.info(
    `Dispatched DAG workflow "${definition.name}" run ${workflowRunId} (${Object.keys(steps).length} steps, ${rootSlugs.length} root(s) dispatched: ${jobIds.join(", ")})`,
  );

  return { workflowRunId, jobIds };
}

/**
 * Builds the incoming-edge map for a DAG workflow definition.
 *
 * Maps each step slug to the list of edge IDs that target it.
 * Used by the coordinator for join-barrier checks.
 *
 * @param definition - The DAG workflow definition
 * @returns Map of step slug to array of incoming edge IDs
 */
export function buildIncomingEdgeMap(definition: DagWorkflowDefinition): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const slug of Object.keys(definition.steps)) {
    map.set(slug, []);
  }
  for (const edge of definition.edges) {
    const eid = edgeId(edge.from, edge.to, edge.branch);
    map.get(edge.to)!.push(eid);
  }
  return map;
}

/**
 * Builds the outgoing-edge map for a DAG workflow definition.
 *
 * Maps each step slug to the list of edges originating from it.
 * Used by the coordinator to determine successors after step completion.
 *
 * @param definition - The DAG workflow definition
 * @returns Map of step slug to array of outgoing edges
 */
export function buildOutgoingEdgeMap(definition: DagWorkflowDefinition): Map<string, Edge[]> {
  const map = new Map<string, Edge[]>();
  for (const slug of Object.keys(definition.steps)) {
    map.set(slug, []);
  }
  for (const edge of definition.edges) {
    map.get(edge.from)!.push(edge);
  }
  return map;
}
