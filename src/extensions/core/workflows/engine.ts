/**
 * Workflow engine - dispatches workflow executions using segment-based dispatch.
 *
 * The engine segments the workflow definition at control flow boundaries,
 * creates a Run Store record, and dispatches the first segment via
 * {@link FlowProducer.addChain}. For single-segment workflows (no control
 * flow nodes), this produces identical behavior to the previous implementation.
 *
 * Subsequent segments are dispatched by the Segment Dispatcher (triggered by
 * the queue `completed` event handler) after the current segment finishes.
 */

import type { Logger, WorkflowDispatchResult } from "@ext/types";
import type { FlowProducer, FlowStep } from "bunqueue/client";
import * as runStore from "./runStore";
import type { WorkflowDefinition } from "./schemas";
import { segmentWorkflow } from "./segmenter";
import type { WorkflowStepJobData } from "./types";

/**
 * Minimal session factory interface - only the `create` method is needed
 * by the workflow engine to create per-step sessions.
 */
export interface SessionFactory {
  create(opts: { source: string; sourceId?: string; metadata?: Record<string, unknown> }): { id: string };
}

/** Queue name used for all workflow step jobs. */
export const WORKFLOW_STEPS_QUEUE = "workflows:steps";

/**
 * Builds a FlowStep array from a list of workflow steps for dispatch via addChain.
 *
 * Creates sessions, assembles job data with all required fields, and returns
 * the FlowStep array ready for dispatch.
 *
 * @param steps - The steps to convert into FlowStep objects
 * @param opts - Context for building the steps (run ID, workflow name, session factory, etc.)
 * @returns Array of FlowStep objects ready for addChain
 */
export function buildFlowSteps(
  steps: WorkflowDefinition["steps"],
  opts: {
    workflowRunId: string;
    workflowName: string;
    totalSteps: number;
    globalIndexOffset: number;
    allStepDefs: Record<string, unknown>;
    fullStepOrder: string[];
    sessionFactory: SessionFactory;
    triggerPayload?: unknown;
    accumulatedStepResults?: Record<string, unknown>;
  },
): FlowStep<WorkflowStepJobData>[] {
  return steps.map((stepDef, localIndex) => {
    const globalIndex = opts.globalIndexOffset + localIndex;

    const session = opts.sessionFactory.create({
      source: "workflow",
      metadata: {
        workflowName: opts.workflowName,
        workflowRunId: opts.workflowRunId,
        stepSlug: stepDef.slug,
        stepIndex: globalIndex,
      },
    });

    const data: WorkflowStepJobData = {
      workflowRunId: opts.workflowRunId,
      workflowName: opts.workflowName,
      stepSlug: stepDef.slug,
      stepIndex: globalIndex,
      totalSteps: opts.totalSteps,
      stepDef,
      allStepDefs: opts.allStepDefs,
      stepOrder: opts.fullStepOrder,
      sessionId: session.id,
    };

    // Inject trigger payload into the first job of the segment
    if (localIndex === 0 && opts.triggerPayload !== undefined) {
      data.triggerPayload = opts.triggerPayload;
    }

    // Inject accumulated step results into the first job of non-first segments
    if (localIndex === 0 && opts.accumulatedStepResults && Object.keys(opts.accumulatedStepResults).length > 0) {
      data.accumulatedStepResults = opts.accumulatedStepResults;
    }

    return {
      name: stepDef.slug,
      queueName: WORKFLOW_STEPS_QUEUE,
      data,
      opts: {
        attempts: 1,
      },
    };
  });
}

/**
 * Dispatch a workflow execution using segment-based dispatch.
 *
 * Segments the workflow definition at control flow boundaries, creates a
 * Run Store record, and dispatches either:
 * - All steps in a single addChain() call for single-segment workflows
 * - Only the first segment's steps for multi-segment workflows
 *
 * For single-segment workflows, this produces behavior identical to the
 * previous implementation.
 *
 * @param flow - The shared FlowProducer instance
 * @param definition - The validated workflow definition
 * @param triggerPayload - The trigger's input data (webhook body, etc.)
 * @param log - Logger for reporting dispatch details
 * @param sessionStore - Session factory for creating per-step sessions
 * @returns The run ID and step job IDs (only includes jobs dispatched now)
 */
export async function dispatchWorkflow(
  flow: FlowProducer,
  definition: WorkflowDefinition,
  triggerPayload: unknown,
  log: Logger,
  sessionStore: SessionFactory,
): Promise<WorkflowDispatchResult> {
  const workflowRunId = crypto.randomUUID();
  const totalSteps = definition.steps.length;
  const fullStepOrder = definition.steps.map((s) => s.slug);

  // Build a lookup of all step definitions by slug for config template resolution
  const allStepDefs: Record<string, unknown> = {};
  for (const s of definition.steps) {
    allStepDefs[s.slug] = s;
  }

  // Segment the workflow
  const segments = segmentWorkflow(definition.steps);

  // Create a Run Store record for all runs (requirement 1.5)
  try {
    runStore.create({
      id: workflowRunId,
      workflowName: definition.name,
      status: "running",
      stepResults: {},
      triggerPayload,
      currentStepIndex: 0,
      fullStepOrder,
      failureReason: null,
    });
  } catch (err) {
    log.error(`Failed to create Run Store record for workflow "${definition.name}":`, err);
    throw new Error(`Run Store unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Determine dispatch strategy based on segment count
  const isSingleSegment = segments.length <= 1;

  if (isSingleSegment) {
    // Single-segment (no control flow nodes): dispatch all steps as one addChain() call
    // This path is functionally identical to the pre-refactor behavior
    const steps = buildFlowSteps(definition.steps, {
      workflowRunId,
      workflowName: definition.name,
      totalSteps,
      globalIndexOffset: 0,
      allStepDefs,
      fullStepOrder,
      sessionFactory: sessionStore,
      triggerPayload: triggerPayload ?? undefined,
    });

    log.info(`Dispatching workflow "${definition.name}" run ${workflowRunId} (${totalSteps} steps, single segment)`);

    const { jobIds } = await flow.addChain(steps);

    log.info(`Workflow "${definition.name}" run ${workflowRunId} dispatched: ${jobIds.join(", ")}`);

    return { workflowRunId, jobIds };
  }

  // Multi-segment: dispatch only the first segment
  const firstSegment = segments[0]!;

  // Calculate the global index offset for the first segment (always 0)
  const firstSegmentSteps = buildFlowSteps(firstSegment.steps, {
    workflowRunId,
    workflowName: definition.name,
    totalSteps,
    globalIndexOffset: 0,
    allStepDefs,
    fullStepOrder,
    sessionFactory: sessionStore,
    triggerPayload: triggerPayload ?? undefined,
  });

  log.info(
    `Dispatching workflow "${definition.name}" run ${workflowRunId} (${totalSteps} steps, ${segments.length} segments, dispatching first segment with ${firstSegment.steps.length} step(s))`,
  );

  const { jobIds } = await flow.addChain(firstSegmentSteps);

  log.info(`Workflow "${definition.name}" run ${workflowRunId} first segment dispatched: ${jobIds.join(", ")}`);

  return { workflowRunId, jobIds };
}
