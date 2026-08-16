/**
 * Segment Dispatcher - evaluates the next segment and dispatches it.
 *
 * Called by the workflow completion handler when a segment finishes.
 * Reads accumulated state from the Run Store, determines whether the
 * next step is a control flow node or an execution segment, and either
 * dispatches the next chain of steps or evaluates the CF node inline.
 *
 * The `nextStepIndex` parameter supports both forward and backward jumps
 * for extensibility (e.g. future loop constructs).
 *
 * @module
 */

import type { Logger } from "@ext/types";
import type { WorkflowWebSocketEvent } from "@shared/workflows";
import type { FlowProducer } from "bunqueue/client";
import { buildFlowSteps, type SessionFactory, WORKFLOW_STEPS_QUEUE } from "./engine";
import * as runStore from "./runStore";
import type { WorkflowStep } from "./schemas";
import { CONTROL_FLOW_TYPES } from "./segmenter";

/**
 * Dependencies injected into the segment dispatcher.
 *
 * Provided by the completion handler in the workflow extension's
 * event subscription wiring.
 */
export interface SegmentDispatcherDeps {
  /** The full step list from the workflow definition. */
  steps: WorkflowStep[];
  /** All step definitions keyed by slug (for template resolution in jobs). */
  allStepDefs: Record<string, unknown>;
  /** FlowProducer for dispatching step chains. */
  flowProducer: FlowProducer;
  /** Session factory for creating per-step sessions. */
  sessionFactory: SessionFactory;
  /** Logger for the workflow extension. */
  log: Logger;
  /** Broadcasts a WebSocket event to connected clients. */
  broadcast: (event: WorkflowWebSocketEvent) => void;
}

/**
 * Dispatches the next segment of a workflow run starting at the given step index.
 *
 * Reads the run's accumulated state from the Run Store, validates the step
 * index bounds, and dispatches the appropriate segment:
 * - For execution segments (non-CF steps): builds FlowSteps and dispatches via addChain()
 * - For control flow segments: placeholder for Phase 2 (if/case/waitFor/emit)
 *
 * On completion of all steps (nextStepIndex >= total), marks the run as completed
 * and broadcasts a `workflow_completed` event.
 *
 * On Run Store errors, fails the run and broadcasts `workflow_failed`.
 *
 * @param runId - The workflow run ID
 * @param nextStepIndex - Global step index to dispatch from (within fullStepOrder)
 * @param deps - Injected dependencies
 */
export async function dispatchNextSegment(
  runId: string,
  nextStepIndex: number,
  deps: SegmentDispatcherDeps,
): Promise<void> {
  const { steps, allStepDefs, flowProducer, sessionFactory, log, broadcast } = deps;

  // Read run state from Run Store
  let run: runStore.WorkflowRun | null;
  try {
    run = runStore.get(runId);
  } catch (err) {
    log.error(`Run Store error reading run ${runId}:`, err);
    failRun(
      runId,
      "segment-dispatch",
      `Run Store unavailable: ${err instanceof Error ? err.message : String(err)}`,
      deps,
    );
    return;
  }

  if (!run) {
    log.error(`Segment dispatch: run ${runId} not found in Run Store`);
    return;
  }

  // Only dispatch for runs in "running" status
  if (run.status !== "running") {
    log.warn(`Segment dispatch: run ${runId} is in status "${run.status}", skipping dispatch`);
    return;
  }

  // Workflow complete: nextStepIndex is beyond the step list
  if (nextStepIndex >= steps.length) {
    try {
      runStore.updateStatus(runId, "completed");
    } catch (err) {
      log.error(`Run Store error completing run ${runId}:`, err);
      failRun(runId, "completion", `Run Store unavailable: ${err instanceof Error ? err.message : String(err)}`, deps);
      return;
    }
    broadcast({ type: "workflow_completed", workflowRunId: runId });
    log.info(`Workflow run ${runId} completed (all segments dispatched)`);
    return;
  }

  // Validate index bounds: reject negative or out-of-range
  if (nextStepIndex < 0 || !Number.isInteger(nextStepIndex)) {
    log.error(`Segment dispatch: invalid nextStepIndex ${nextStepIndex} for run ${runId}`);
    failRun(runId, "segment-dispatch", `Invalid step index: ${nextStepIndex}`, deps);
    return;
  }

  // Determine next step type
  const nextStep = steps[nextStepIndex]!;
  const isControlFlow = CONTROL_FLOW_TYPES.has(nextStep.type);

  if (isControlFlow) {
    // Control flow nodes are evaluated inline (Phase 2 will implement if/case/waitFor/emit)
    log.info(
      `Segment dispatch: run ${runId} reached control flow node "${nextStep.slug}" (type: ${nextStep.type}) at index ${nextStepIndex} - Phase 2 handler`,
    );
    // Phase 2 placeholder: for now, fail the run with a descriptive message.
    // This code path should not be reached in Phase 1 since single-segment
    // workflows (no CF nodes) never trigger the segment dispatcher with a CF step.
    failRun(runId, nextStep.slug, `Control flow node type "${nextStep.type}" is not yet implemented`, deps);
    return;
  }

  // Execution segment: collect consecutive non-CF steps starting from nextStepIndex
  const segmentSteps: WorkflowStep[] = [];
  let i = nextStepIndex;
  while (i < steps.length && !CONTROL_FLOW_TYPES.has(steps[i]!.type)) {
    segmentSteps.push(steps[i]!);
    i++;
  }

  // Update execution cursor in Run Store
  try {
    runStore.updateStepIndex(runId, nextStepIndex);
  } catch (err) {
    log.error(`Run Store error updating step index for run ${runId}:`, err);
    failRun(
      runId,
      "segment-dispatch",
      `Run Store unavailable: ${err instanceof Error ? err.message : String(err)}`,
      deps,
    );
    return;
  }

  // Build FlowSteps with accumulated context from Run Store
  const fullStepOrder = run.fullStepOrder;
  const totalSteps = steps.length;

  const flowSteps = buildFlowSteps(segmentSteps, {
    workflowRunId: runId,
    workflowName: run.workflowName,
    totalSteps,
    globalIndexOffset: nextStepIndex,
    allStepDefs,
    fullStepOrder,
    sessionFactory,
    triggerPayload: run.triggerPayload ?? undefined,
    accumulatedStepResults: run.stepResults,
  });

  // Dispatch the segment via addChain
  try {
    const { jobIds } = await flowProducer.addChain(flowSteps);
    log.info(
      `Segment dispatch: run ${runId} dispatched ${segmentSteps.length} step(s) starting at index ${nextStepIndex}: ${jobIds.join(", ")}`,
    );
  } catch (err) {
    log.error(`Failed to dispatch segment for run ${runId}:`, err);
    failRun(
      runId,
      segmentSteps[0]?.slug ?? "unknown",
      `Segment dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
      deps,
    );
  }
}

/**
 * Marks a workflow run as failed and broadcasts the failure event.
 *
 * Attempts a best-effort Run Store status update. If the store write
 * itself fails, only the broadcast is emitted.
 *
 * @param runId - The workflow run ID
 * @param failedStep - The step slug or phase that caused the failure
 * @param error - Human-readable error description
 * @param deps - Dependencies (for logging and broadcasting)
 */
function failRun(
  runId: string,
  failedStep: string,
  error: string,
  deps: Pick<SegmentDispatcherDeps, "log" | "broadcast">,
): void {
  // Best-effort status update
  try {
    runStore.updateStatus(runId, "failed", error);
  } catch (storeErr) {
    deps.log.error(`Run Store error while failing run ${runId}:`, storeErr);
  }

  deps.broadcast({
    type: "workflow_failed",
    workflowRunId: runId,
    failedStep,
    error,
  });
}
