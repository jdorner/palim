/**
 * Workflow step completion handler.
 *
 * Handles the logic that runs after a workflow step job completes successfully:
 *
 * 1. Broadcasts `workflow_step_completed`
 * 2. Persists the step result to the Run Store
 * 3. Determines whether to dispatch the next segment, continue a branch,
 *    or mark the run as completed
 *
 * @module
 */

import type { Logger } from "@ext/types";
import type { WorkflowWebSocketEvent } from "@shared/workflows";
import type { FlowProducer } from "bunqueue/client";
import type { SessionFactory } from "./engine";
import * as runStore from "./runStore";
import type { WorkflowStep } from "./schemas";
import { dispatchBranchSteps, dispatchNextSegment, failRun } from "./segmentDispatcher";
import { CONTROL_FLOW_TYPES, segmentWorkflow } from "./segmenter";
import type { WorkflowStepJobData } from "./types";
import type { StepResult } from "./worker";

/**
 * Dependencies injected into the completion handler.
 *
 * Provided once during extension initialization so the handler
 * can be called with only the job-specific data at runtime.
 */
export interface CompletionHandlerDeps {
  /** FlowProducer for dispatching step chains. */
  flowProducer: FlowProducer;
  /** Session factory for creating per-step sessions. */
  sessionFactory: SessionFactory;
  /** Logger for the workflow extension. */
  log: Logger;
  /** Broadcasts a WebSocket event to connected clients. */
  broadcast: (event: WorkflowWebSocketEvent) => void;
  /** Retrieves a workflow definition by name from the in-memory store. */
  getWorkflowDefinition: (name: string) => { steps: WorkflowStep[] } | undefined;
}

/**
 * The shape of a completed job as received from the queue event.
 *
 * Combines the job metadata with the step data extracted by `stepData()`.
 */
export interface CompletedStepJob {
  /** Unique job identifier. */
  id: string;
  /** The step job data payload. */
  data: WorkflowStepJobData;
  /** The step's return value (carried by bunqueue at runtime). */
  returnvalue?: StepResult;
}

/**
 * Handles a completed workflow step job.
 *
 * Broadcasts the completion event, persists results, and determines
 * whether to dispatch the next segment, continue a branch, or mark
 * the workflow run as completed.
 *
 * @param job - The completed step job with its data and return value
 * @param deps - Injected dependencies (shared across all completions)
 */
export async function handleStepCompletion(job: CompletedStepJob, deps: CompletionHandlerDeps): Promise<void> {
  const { log, broadcast, getWorkflowDefinition } = deps;
  const d = job.data;

  // Always broadcast workflow_step_completed
  broadcast({
    type: "workflow_step_completed",
    workflowRunId: d.workflowRunId,
    stepSlug: d.stepSlug,
    jobId: job.id,
  });

  // Persist step result to Run Store
  if (job.returnvalue) {
    try {
      runStore.updateStepResult(d.workflowRunId, d.stepSlug, job.returnvalue.value);
    } catch (err) {
      log.error(`Failed to persist step result for run ${d.workflowRunId}, step ${d.stepSlug}:`, err);
    }
  }

  // Determine if this is a multi-segment workflow
  const wf = getWorkflowDefinition(d.workflowName);
  const isMultiSegment = wf ? segmentWorkflow(wf.steps).length > 1 : false;

  if (!isMultiSegment && !d.isBranchStep) {
    // Single-segment without branch steps: mark completed on last step
    if (d.stepIndex === d.totalSteps - 1) {
      try {
        runStore.updateStatus(d.workflowRunId, "completed");
      } catch {
        // best effort
      }
      broadcast({ type: "workflow_completed", workflowRunId: d.workflowRunId });
    }
    return;
  }

  // --- Multi-segment / branch handling ---

  // Guard: workflow definition must be available for dispatch decisions.
  // Can be null if the definition was deleted/hot-reloaded between dispatch and completion.
  if (!wf) {
    failRun(d.workflowRunId, d.stepSlug, `Workflow definition "${d.workflowName}" no longer available`, deps);
    return;
  }

  // Non-last branch step: chain continues via bunqueue, no dispatch needed.
  if (d.isBranchStep && d.resumeStepIndex === undefined && !d.branchContext) {
    return;
  }

  // Last step of a branch segment with remaining branch steps (possibly CF).
  if (d.branchContext) {
    await handleBranchContinuation(job, wf, deps);
    return;
  }

  // Last branch step with a resume index: dispatch next segment after the CF node.
  if (d.resumeStepIndex !== undefined) {
    await handleBranchResume(job, wf, deps);
    return;
  }

  // Regular segment boundary: next step is CF or beyond the workflow.
  await handleSegmentBoundary(job, wf, deps);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Handles the case where a branch segment completes and there are
 * remaining branch steps to dispatch (possibly containing CF nodes).
 */
async function handleBranchContinuation(
  job: CompletedStepJob,
  wf: { steps: WorkflowStep[] },
  deps: CompletionHandlerDeps,
): Promise<void> {
  const { flowProducer, sessionFactory, log, broadcast, getWorkflowDefinition } = deps;
  const d = job.data;
  const { remainingSteps, resumeStepIndex: branchResumeIdx } = d.branchContext!;

  try {
    const run = runStore.get(d.workflowRunId);
    if (run) {
      await dispatchBranchSteps(d.workflowRunId, remainingSteps as WorkflowStep[], branchResumeIdx, d.stepSlug, run, {
        steps: wf.steps,
        allStepDefs: d.allStepDefs ?? {},
        flowProducer,
        sessionFactory,
        log,
        broadcast,
        getWorkflowDefinition,
      });
    } else {
      log.error(`Run ${d.workflowRunId} not found for branch continuation`);
    }
  } catch (err) {
    log.error(`Failed to dispatch branch continuation for run ${d.workflowRunId}:`, err);
    failRun(d.workflowRunId, d.stepSlug, `Branch continuation failed: ${errorMessage(err)}`, deps);
  }
}

/**
 * Handles the case where the last branch step completes and needs
 * to resume main-flow execution at a specific step index.
 */
async function handleBranchResume(
  job: CompletedStepJob,
  wf: { steps: WorkflowStep[] },
  deps: CompletionHandlerDeps,
): Promise<void> {
  const { flowProducer, sessionFactory, log, broadcast } = deps;
  const d = job.data;

  try {
    await dispatchNextSegment(d.workflowRunId, d.resumeStepIndex!, {
      steps: wf.steps,
      allStepDefs: d.allStepDefs ?? {},
      flowProducer,
      sessionFactory,
      log,
      broadcast,
    });
  } catch (err) {
    log.error(`Failed to dispatch next segment after branch for run ${d.workflowRunId}:`, err);
    failRun(d.workflowRunId, d.stepSlug, `Segment dispatch failed: ${errorMessage(err)}`, deps);
  }
}

/**
 * Handles the case where a step completes at a segment boundary
 * (next step is a CF node or the workflow has no more steps).
 */
async function handleSegmentBoundary(
  job: CompletedStepJob,
  wf: { steps: WorkflowStep[] },
  deps: CompletionHandlerDeps,
): Promise<void> {
  const { flowProducer, sessionFactory, log, broadcast } = deps;
  const d = job.data;

  const nextStepIndex = d.stepIndex + 1;
  const nextStep = wf.steps[nextStepIndex];
  const isLastInSegment = !nextStep || CONTROL_FLOW_TYPES.has(nextStep.type);

  if (!isLastInSegment) {
    // Not at a segment boundary: next step is already queued by addChain().
    return;
  }

  // Dispatch next segment (handles completion when nextStepIndex >= steps.length)
  try {
    await dispatchNextSegment(d.workflowRunId, nextStepIndex, {
      steps: wf.steps,
      allStepDefs: d.allStepDefs ?? {},
      flowProducer,
      sessionFactory,
      log,
      broadcast,
    });
  } catch (err) {
    log.error(`Failed to dispatch next segment for run ${d.workflowRunId}:`, err);
    failRun(d.workflowRunId, d.stepSlug, `Segment dispatch failed: ${errorMessage(err)}`, deps);
  }
}

/**
 * Extracts a human-readable message from an unknown error value.
 */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
