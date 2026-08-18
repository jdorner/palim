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
import { evaluateCondition } from "./condition";
import { buildFlowSteps, type SessionFactory } from "./engine";
import * as runStore from "./runStore";
import type { CaseStep, IfStep, WaitForStep, WorkflowStep } from "./schemas";
import { CONTROL_FLOW_TYPES, segmentWorkflow } from "./segmenter";
import * as signalStore from "./signalStore";
import * as signalTimers from "./signalTimers";
import { resolveTemplates, type TemplateContext } from "./template";
import type { WorkflowStepJobData } from "./types";

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
  /** Retrieves a workflow definition by name (for emit cross-workflow dispatch). */
  getWorkflowDefinition?: (name: string) => { steps: WorkflowStep[] } | undefined;
}

/**
 * Dispatches the next segment of a workflow run starting at the given step index.
 *
 * Reads the run's accumulated state from the Run Store, validates the step
 * index bounds, and dispatches the appropriate segment:
 * - For execution segments (non-CF steps): builds FlowSteps and dispatches via addChain()
 * - For control flow segments: evaluates inline (if/case/waitFor/emit)
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
    // Control flow nodes are evaluated inline
    if (nextStep.type === "if") {
      await handleIfNode(runId, nextStepIndex, nextStep as IfStep, run, deps);
      return;
    }

    if (nextStep.type === "case") {
      await handleCaseNode(runId, nextStepIndex, nextStep as CaseStep, run, deps);
      return;
    }

    if (nextStep.type === "waitFor") {
      handleWaitForNode(runId, nextStepIndex, nextStep as WaitForStep, run, deps);
      return;
    }

    // Unknown CF type - should not happen with current schema validation
    log.error(
      `Segment dispatch: run ${runId} reached unknown control flow node "${nextStep.slug}" (type: ${nextStep.type}) at index ${nextStepIndex}`,
    );
    failRun(runId, nextStep.slug, `Control flow node type "${nextStep.type}" is not supported`, deps);
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
 * Handles an `if` control flow node inline.
 *
 * Resolves the condition's `ref` template expression using accumulated step results
 * and trigger payload, evaluates the condition, and dispatches the appropriate branch
 * (then/else). If the condition is false and no else branch exists, fails the run.
 *
 * Branch steps are dispatched as a chain via addChain(). The last branch step carries
 * a `resumeStepIndex` field so the completion handler knows where to continue
 * execution after the branch finishes.
 *
 * @param runId - The workflow run ID
 * @param stepIndex - The index of the `if` node in the flat step list
 * @param ifStep - The `if` step definition
 * @param run - The current run state from the Run Store
 * @param deps - Injected dependencies
 */
async function handleIfNode(
  runId: string,
  stepIndex: number,
  ifStep: IfStep,
  run: runStore.WorkflowRun,
  deps: SegmentDispatcherDeps,
): Promise<void> {
  const { allStepDefs, log, broadcast } = deps;

  // Build template context from accumulated state
  const templateCtx: TemplateContext = {
    triggerPayload: run.triggerPayload ?? undefined,
    stepResults: run.stepResults,
    stepConfigs: allStepDefs,
  };

  // Resolve the ref template expression
  let resolvedValue: unknown;
  try {
    const { resolved, warnings } = await resolveTemplates(ifStep.condition.ref, templateCtx);
    // If the template could not be resolved (warnings about unresolvable path,
    // or the resolved string still contains unresolved template expressions),
    // treat the value as undefined
    const hasUnresolvableWarning = warnings.some((w) => w.includes("Unresolvable") || w.includes("Unknown step slug"));
    if (hasUnresolvableWarning || resolved.includes("{{")) {
      resolvedValue = undefined;
    } else {
      resolvedValue = resolved;
    }
  } catch (err) {
    log.error(`Template resolution failed for if node "${ifStep.slug}" in run ${runId}:`, err);
    failRun(
      runId,
      ifStep.slug,
      `Template resolution failed: ${err instanceof Error ? err.message : String(err)}`,
      deps,
    );
    return;
  }

  // Evaluate the condition
  let conditionResult: boolean;
  try {
    conditionResult = evaluateCondition(resolvedValue, ifStep.condition);
  } catch (err) {
    log.error(`Condition evaluation failed for if node "${ifStep.slug}" in run ${runId}:`, err);
    failRun(
      runId,
      ifStep.slug,
      `Condition evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
      deps,
    );
    return;
  }

  // Determine which branch to execute
  const chosenBranch = conditionResult ? "then" : "else";
  const branchSteps = conditionResult ? ifStep.then : ifStep.else;

  if (!branchSteps || branchSteps.length === 0) {
    // Condition is false and no else branch defined
    failRun(
      runId,
      ifStep.slug,
      `Condition evaluated to false and no "else" branch is defined for if node "${ifStep.slug}"`,
      deps,
    );
    return;
  }

  // Store the if node result in Run Store
  const ifResult = { condition: conditionResult, chosenBranch };
  try {
    runStore.updateStepResult(runId, ifStep.slug, ifResult);
  } catch (err) {
    log.error(`Run Store error storing if result for run ${runId}, step ${ifStep.slug}:`, err);
    failRun(runId, ifStep.slug, `Run Store unavailable: ${err instanceof Error ? err.message : String(err)}`, deps);
    return;
  }

  // Update execution cursor past the if node
  try {
    runStore.updateStepIndex(runId, stepIndex);
  } catch (err) {
    log.error(`Run Store error updating step index for run ${runId}:`, err);
    failRun(runId, ifStep.slug, `Run Store unavailable: ${err instanceof Error ? err.message : String(err)}`, deps);
    return;
  }

  // Broadcast workflow_step_completed with chosenBranch
  // The if node itself doesn't have a jobId since it's evaluated inline, use run ID as identifier
  broadcast({
    type: "workflow_step_completed",
    workflowRunId: runId,
    stepSlug: ifStep.slug,
    jobId: runId,
    chosenBranch,
  });

  log.info(
    `If node "${ifStep.slug}" in run ${runId}: condition=${conditionResult}, dispatching "${chosenBranch}" branch (${branchSteps.length} step(s))`,
  );

  // Dispatch branch steps as a chain
  // The resume index is the step AFTER the if node in the flat list
  const resumeStepIndex = stepIndex + 1;

  // Re-read run state to get latest accumulated results (including the if node result we just stored)
  let updatedRun: runStore.WorkflowRun | null;
  try {
    updatedRun = runStore.get(runId);
  } catch (err) {
    log.error(`Run Store error re-reading run ${runId}:`, err);
    failRun(runId, ifStep.slug, `Run Store unavailable: ${err instanceof Error ? err.message : String(err)}`, deps);
    return;
  }

  if (!updatedRun) {
    log.error(`Segment dispatch: run ${runId} not found in Run Store after if evaluation`);
    return;
  }

  // Dispatch branch with segmentation awareness (handles nested CF nodes)
  await dispatchBranchSteps(runId, branchSteps as WorkflowStep[], resumeStepIndex, ifStep.slug, updatedRun, deps);
}

/**
 * Handles a `case` control flow node inline.
 *
 * Resolves the `match` template expression using accumulated step results
 * and trigger payload, performs exact case-sensitive comparison against
 * path keys, and dispatches the matched path's steps. Falls back to
 * `default` if no path key matches. Fails the run if no match and no default.
 *
 * Branch steps are dispatched as a chain via addChain(). The last branch step carries
 * a `resumeStepIndex` field so the completion handler knows where to continue
 * execution after the branch finishes.
 *
 * @param runId - The workflow run ID
 * @param stepIndex - The index of the `case` node in the flat step list
 * @param caseStep - The `case` step definition
 * @param run - The current run state from the Run Store
 * @param deps - Injected dependencies
 */
async function handleCaseNode(
  runId: string,
  stepIndex: number,
  caseStep: CaseStep,
  run: runStore.WorkflowRun,
  deps: SegmentDispatcherDeps,
): Promise<void> {
  const { allStepDefs, log, broadcast } = deps;

  // Build template context from accumulated state
  const templateCtx: TemplateContext = {
    triggerPayload: run.triggerPayload ?? undefined,
    stepResults: run.stepResults,
    stepConfigs: allStepDefs,
  };

  // Resolve the match template expression
  let resolvedMatch: string;
  try {
    const { resolved } = await resolveTemplates(caseStep.match, templateCtx);
    // For case nodes, the resolved string is used as-is for matching,
    // even if it contains unresolved template expressions or had warnings.
    // If no path matches, the default/fail behavior applies naturally.
    resolvedMatch = resolved;
  } catch (err) {
    log.error(`Template resolution failed for case node "${caseStep.slug}" in run ${runId}:`, err);
    failRun(
      runId,
      caseStep.slug,
      `Template resolution failed: ${err instanceof Error ? err.message : String(err)}`,
      deps,
    );
    return;
  }

  // Perform exact, case-sensitive comparison against path keys
  let matchedKey: string | null = null;
  for (const key of Object.keys(caseStep.paths)) {
    if (resolvedMatch === key) {
      matchedKey = key;
      break;
    }
  }

  // Determine which branch to execute
  let branchSteps: WorkflowStep[];
  let resultMatched: string;

  if (matchedKey !== null) {
    branchSteps = caseStep.paths[matchedKey]!;
    resultMatched = matchedKey;
  } else if (caseStep.default && caseStep.default.length > 0) {
    branchSteps = caseStep.default;
    resultMatched = "__default";
  } else {
    // No match and no default
    const availableKeys = Object.keys(caseStep.paths).join(", ");
    failRun(
      runId,
      caseStep.slug,
      `Case node "${caseStep.slug}" - no path matched the resolved value "${resolvedMatch}" and no default path is defined. Available path keys: [${availableKeys}]`,
      deps,
    );
    return;
  }

  // Store the case node result in Run Store
  const caseResult = { matched: resultMatched };
  try {
    runStore.updateStepResult(runId, caseStep.slug, caseResult);
  } catch (err) {
    log.error(`Run Store error storing case result for run ${runId}, step ${caseStep.slug}:`, err);
    failRun(runId, caseStep.slug, `Run Store unavailable: ${err instanceof Error ? err.message : String(err)}`, deps);
    return;
  }

  // Update execution cursor past the case node
  try {
    runStore.updateStepIndex(runId, stepIndex);
  } catch (err) {
    log.error(`Run Store error updating step index for run ${runId}:`, err);
    failRun(runId, caseStep.slug, `Run Store unavailable: ${err instanceof Error ? err.message : String(err)}`, deps);
    return;
  }

  // Broadcast workflow_step_completed with chosenBranch
  broadcast({
    type: "workflow_step_completed",
    workflowRunId: runId,
    stepSlug: caseStep.slug,
    jobId: runId,
    chosenBranch: resultMatched,
  });

  log.info(
    `Case node "${caseStep.slug}" in run ${runId}: matched="${resultMatched}", dispatching ${branchSteps.length} step(s)`,
  );

  // Dispatch branch steps as a chain
  // The resume index is the step AFTER the case node in the flat list
  const resumeStepIndex = stepIndex + 1;

  // Re-read run state to get latest accumulated results (including the case node result we just stored)
  let updatedRun: runStore.WorkflowRun | null;
  try {
    updatedRun = runStore.get(runId);
  } catch (err) {
    log.error(`Run Store error re-reading run ${runId}:`, err);
    failRun(runId, caseStep.slug, `Run Store unavailable: ${err instanceof Error ? err.message : String(err)}`, deps);
    return;
  }

  if (!updatedRun) {
    log.error(`Segment dispatch: run ${runId} not found in Run Store after case evaluation`);
    return;
  }

  // Dispatch branch with segmentation awareness (handles nested CF nodes)
  await dispatchBranchSteps(runId, branchSteps, resumeStepIndex, caseStep.slug, updatedRun, deps);
}

/**
 * Handles a `waitFor` control flow node inline.
 *
 * Persists run state, transitions the run to `waiting-signal`, creates a signal
 * record in the Signal Store, broadcasts `workflow_step_started` then
 * `workflow_step_waiting` events, and arms a timeout timer if configured.
 *
 * This handler does NOT dispatch any further segment. Execution resumes only
 * when a signal is delivered via the signal delivery API endpoint (task 3.8).
 *
 * @param runId - The workflow run ID
 * @param stepIndex - The index of the `waitFor` node in the flat step list
 * @param waitForStep - The `waitFor` step definition
 * @param _run - The current run state from the Run Store (unused, kept for handler signature consistency)
 * @param deps - Injected dependencies
 */
function handleWaitForNode(
  runId: string,
  stepIndex: number,
  waitForStep: WaitForStep,
  _run: runStore.WorkflowRun,
  deps: SegmentDispatcherDeps,
): void {
  const { log, broadcast } = deps;

  // Update execution cursor to the waitFor node
  try {
    runStore.updateStepIndex(runId, stepIndex);
  } catch (err) {
    log.error(`Run Store error updating step index for run ${runId}:`, err);
    failRun(
      runId,
      waitForStep.slug,
      `Run Store unavailable: ${err instanceof Error ? err.message : String(err)}`,
      deps,
    );
    return;
  }

  // Broadcast workflow_step_started
  try {
    broadcast({
      type: "workflow_step_started",
      workflowRunId: runId,
      stepSlug: waitForStep.slug,
      jobId: runId,
    });
  } catch (err) {
    // If workflow_step_started fails, proceed with waiting state
    log.error(`Failed to broadcast workflow_step_started for waitFor node "${waitForStep.slug}" in run ${runId}:`, err);
  }

  // Transition run status to waiting-signal
  try {
    runStore.updateStatus(runId, "waiting-signal");
  } catch (err) {
    log.error(`Run Store error transitioning run ${runId} to waiting-signal:`, err);
    failRun(
      runId,
      waitForStep.slug,
      `Run Store unavailable: ${err instanceof Error ? err.message : String(err)}`,
      deps,
    );
    return;
  }

  // Create signal record in Signal Store
  let signalRecord: signalStore.SignalRecord;
  try {
    signalRecord = signalStore.create({
      runId,
      stepSlug: waitForStep.slug,
      event: waitForStep.event,
      timeoutMs: waitForStep.timeout ?? null,
      inputSchema: waitForStep.inputSchema ?? null,
    });
  } catch (err) {
    log.error(`Signal Store error creating signal for run ${runId}, step ${waitForStep.slug}:`, err);
    failRun(
      runId,
      waitForStep.slug,
      `Signal Store unavailable: ${err instanceof Error ? err.message : String(err)}`,
      deps,
    );
    return;
  }

  // Broadcast workflow_step_waiting
  broadcast({
    type: "workflow_step_waiting",
    workflowRunId: runId,
    stepSlug: waitForStep.slug,
    event: waitForStep.event,
    inputSchema: waitForStep.inputSchema ?? null,
  });

  log.info(
    `WaitFor node "${waitForStep.slug}" in run ${runId}: waiting for signal "${waitForStep.event}"${waitForStep.timeout ? ` (timeout: ${waitForStep.timeout}ms)` : ""}`,
  );

  // Arm timeout timer if configured
  if (waitForStep.timeout != null && waitForStep.timeout > 0) {
    signalTimers.arm(signalRecord.id, runId, waitForStep.slug, waitForStep.event, waitForStep.timeout, {
      log,
      broadcast,
    });
  }
}

/**
 * Dispatches branch steps with segmentation awareness.
 *
 * Segments the branch steps at control flow boundaries. If the first
 * branch segment is a CF node, handles it inline (recursively via the
 * appropriate handler). Otherwise dispatches the first non-CF segment
 * as a chain, tagging the last step with `branchContext` so the
 * completion handler can dispatch remaining branch segments.
 *
 * @param runId - The workflow run ID
 * @param branchSteps - The steps in the chosen branch (then/else/path)
 * @param resumeStepIndex - Main-flow step index to resume at after the entire branch
 * @param parentStepSlug - Slug of the parent CF node (for error reporting)
 * @param run - Current run state from Run Store
 * @param deps - Segment dispatcher dependencies
 */
export async function dispatchBranchSteps(
  runId: string,
  branchSteps: WorkflowStep[],
  resumeStepIndex: number,
  parentStepSlug: string,
  run: runStore.WorkflowRun,
  deps: SegmentDispatcherDeps,
): Promise<void> {
  const { allStepDefs, flowProducer, sessionFactory, log } = deps;

  if (branchSteps.length === 0) {
    // Empty branch — skip directly to resume
    await dispatchNextSegment(runId, resumeStepIndex, deps);
    return;
  }

  const segments = segmentWorkflow(branchSteps);
  const firstSegment = segments[0]!;

  if (firstSegment.isControlFlow) {
    // First branch step is a CF node — handle inline
    const cfStep = firstSegment.steps[0]!;
    const remainingBranchSteps = branchSteps.slice(1);

    if (cfStep.type === "if") {
      // After the nested if completes its own branch, it needs to continue
      // with the remaining branch steps. We achieve this by treating the
      // remaining branch steps as if they were a continuation: store them
      // in Run Store as a pending branch continuation.
      storeBranchContinuation(runId, remainingBranchSteps, resumeStepIndex, log);
      await handleIfNode(runId, run.currentStepIndex, cfStep as IfStep, run, deps);
    } else if (cfStep.type === "case") {
      storeBranchContinuation(runId, remainingBranchSteps, resumeStepIndex, log);
      await handleCaseNode(runId, run.currentStepIndex, cfStep as CaseStep, run, deps);
    } else if (cfStep.type === "waitFor") {
      storeBranchContinuation(runId, remainingBranchSteps, resumeStepIndex, log);
      handleWaitForNode(runId, run.currentStepIndex, cfStep as WaitForStep, run, deps);
    } else {
      log.error(`Unknown CF type "${cfStep.type}" in branch for run ${runId}`);
      failRun(runId, parentStepSlug, `Unknown control flow type "${cfStep.type}" in branch`, deps);
    }
    return;
  }

  // First segment is non-CF — dispatch it as a chain
  const firstSegmentSteps = firstSegment.steps;
  const remainingBranchSteps = branchSteps.slice(firstSegmentSteps.length);

  // Re-read run for latest accumulated results
  let updatedRun: runStore.WorkflowRun | null;
  try {
    updatedRun = runStore.get(runId);
  } catch (err) {
    log.error(`Run Store error re-reading run ${runId}:`, err);
    failRun(runId, parentStepSlug, `Run Store unavailable: ${err instanceof Error ? err.message : String(err)}`, deps);
    return;
  }
  if (!updatedRun) {
    log.error(`dispatchBranchSteps: run ${runId} not found in Run Store`);
    return;
  }

  const branchFlowSteps = buildFlowSteps(firstSegmentSteps, {
    workflowRunId: runId,
    workflowName: run.workflowName,
    totalSteps: deps.steps.length,
    globalIndexOffset: run.currentStepIndex,
    allStepDefs,
    fullStepOrder: run.fullStepOrder,
    sessionFactory,
    triggerPayload: run.triggerPayload ?? undefined,
    accumulatedStepResults: updatedRun.stepResults,
  });

  // Tag all steps as branch steps
  for (let idx = 0; idx < branchFlowSteps.length; idx++) {
    const flowStep = branchFlowSteps[idx]!;
    (flowStep.data as WorkflowStepJobData).isBranchStep = true;

    if (idx === branchFlowSteps.length - 1) {
      // Last step of this branch segment
      if (remainingBranchSteps.length > 0) {
        // More branch steps follow (possibly CF) — carry them as branchContext
        (flowStep.data as WorkflowStepJobData).branchContext = {
          remainingSteps: remainingBranchSteps,
          resumeStepIndex,
        };
      } else {
        // No more branch steps — resume main flow
        (flowStep.data as WorkflowStepJobData).resumeStepIndex = resumeStepIndex;
      }
    }
  }

  try {
    const { jobIds } = await flowProducer.addChain(branchFlowSteps);
    log.info(
      `Branch dispatch for run ${runId}: dispatched ${firstSegmentSteps.length} step(s), ${remainingBranchSteps.length} remaining: ${jobIds.join(", ")}`,
    );
  } catch (err) {
    log.error(`Failed to dispatch branch for run ${runId}:`, err);
    failRun(runId, parentStepSlug, `Branch dispatch failed: ${err instanceof Error ? err.message : String(err)}`, deps);
  }
}

/**
 * Stores a branch continuation in the Run Store so that after a nested CF node
 * completes its own branch, the completion handler can pick up the remaining
 * branch steps.
 *
 * This is stored as a special step result keyed by `__branchContinuation`.
 */
function storeBranchContinuation(
  runId: string,
  remainingSteps: WorkflowStep[],
  resumeStepIndex: number,
  log: Logger,
): void {
  if (remainingSteps.length === 0) return;
  try {
    runStore.updateStepResult(runId, "__branchContinuation", {
      remainingSteps,
      resumeStepIndex,
    });
  } catch (err) {
    log.error(`Failed to store branch continuation for run ${runId}:`, err);
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
