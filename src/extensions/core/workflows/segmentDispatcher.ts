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
import type { CaseStep, EmitStep, IfStep, WaitForStep, WorkflowStep } from "./schemas";
import { CONTROL_FLOW_TYPES } from "./segmenter";
import * as signalStore from "./signalStore";
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
  /** Registers a timeout timer for cleanup on shutdown (optional, used by waitFor). */
  registerTimer?: (timer: ReturnType<typeof setTimeout>) => void;
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

    if (nextStep.type === "emit") {
      await handleEmitNode(runId, nextStepIndex, nextStep as EmitStep, run, deps);
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
 * a `__resumeStepIndex` field so the completion handler knows where to continue
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
  const { steps, allStepDefs, flowProducer, sessionFactory, log, broadcast } = deps;

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
    // treat the value as undefined (requirement 3.6)
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
    // Condition is false and no else branch defined (requirement 3.3)
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

  // Broadcast workflow_step_completed with chosenBranch (requirement 10.3)
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

  // Build branch flow steps with __isBranchStep and __resumeStepIndex markers
  const branchFlowSteps = buildFlowSteps(branchSteps, {
    workflowRunId: runId,
    workflowName: run.workflowName,
    totalSteps: steps.length,
    // Use stepIndex for all branch steps so they share the if node's position
    globalIndexOffset: stepIndex,
    allStepDefs,
    fullStepOrder: run.fullStepOrder,
    sessionFactory,
    triggerPayload: run.triggerPayload ?? undefined,
    accumulatedStepResults: updatedRun.stepResults,
  });

  // Mark all branch steps with __isBranchStep, and the last one with __resumeStepIndex
  for (let idx = 0; idx < branchFlowSteps.length; idx++) {
    const flowStep = branchFlowSteps[idx]!;
    (flowStep.data as WorkflowStepJobData).__isBranchStep = true;
    if (idx === branchFlowSteps.length - 1) {
      (flowStep.data as WorkflowStepJobData).__resumeStepIndex = resumeStepIndex;
    }
  }

  // Dispatch the branch chain
  try {
    const { jobIds } = await flowProducer.addChain(branchFlowSteps);
    log.info(
      `If node "${ifStep.slug}" in run ${runId}: dispatched ${branchSteps.length} "${chosenBranch}" branch step(s): ${jobIds.join(", ")}`,
    );
  } catch (err) {
    log.error(`Failed to dispatch "${chosenBranch}" branch for if node "${ifStep.slug}" in run ${runId}:`, err);
    failRun(runId, ifStep.slug, `Branch dispatch failed: ${err instanceof Error ? err.message : String(err)}`, deps);
  }
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
 * a `__resumeStepIndex` field so the completion handler knows where to continue
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
  const { steps, allStepDefs, flowProducer, sessionFactory, log, broadcast } = deps;

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

  // Perform exact, case-sensitive comparison against path keys (Requirement 4.5)
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
    // No match and no default (Requirement 4.3)
    const availableKeys = Object.keys(caseStep.paths).join(", ");
    failRun(
      runId,
      caseStep.slug,
      `Case node "${caseStep.slug}" - no path matched the resolved value "${resolvedMatch}" and no default path is defined. Available path keys: [${availableKeys}]`,
      deps,
    );
    return;
  }

  // Store the case node result in Run Store (Requirement 4.6)
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

  // Broadcast workflow_step_completed with chosenBranch (Requirement 10.3)
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

  // Build branch flow steps with __isBranchStep and __resumeStepIndex markers
  const branchFlowSteps = buildFlowSteps(branchSteps, {
    workflowRunId: runId,
    workflowName: run.workflowName,
    totalSteps: steps.length,
    // Use stepIndex for all branch steps so they share the case node's position
    globalIndexOffset: stepIndex,
    allStepDefs,
    fullStepOrder: run.fullStepOrder,
    sessionFactory,
    triggerPayload: run.triggerPayload ?? undefined,
    accumulatedStepResults: updatedRun.stepResults,
  });

  // Mark all branch steps with __isBranchStep, and the last one with __resumeStepIndex
  for (let idx = 0; idx < branchFlowSteps.length; idx++) {
    const flowStep = branchFlowSteps[idx]!;
    (flowStep.data as WorkflowStepJobData).__isBranchStep = true;
    if (idx === branchFlowSteps.length - 1) {
      (flowStep.data as WorkflowStepJobData).__resumeStepIndex = resumeStepIndex;
    }
  }

  // Dispatch the branch chain
  try {
    const { jobIds } = await flowProducer.addChain(branchFlowSteps);
    log.info(
      `Case node "${caseStep.slug}" in run ${runId}: dispatched ${branchSteps.length} "${resultMatched}" branch step(s): ${jobIds.join(", ")}`,
    );
  } catch (err) {
    log.error(`Failed to dispatch "${resultMatched}" branch for case node "${caseStep.slug}" in run ${runId}:`, err);
    failRun(runId, caseStep.slug, `Branch dispatch failed: ${err instanceof Error ? err.message : String(err)}`, deps);
  }
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

  // Broadcast workflow_step_started (Requirement 10.5)
  try {
    broadcast({
      type: "workflow_step_started",
      workflowRunId: runId,
      stepSlug: waitForStep.slug,
      jobId: runId,
    });
  } catch (err) {
    // Per Requirement 10.5: if workflow_step_started fails, proceed with waiting state
    log.error(`Failed to broadcast workflow_step_started for waitFor node "${waitForStep.slug}" in run ${runId}:`, err);
  }

  // Transition run status to waiting-signal (Requirement 5.1)
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

  // Create signal record in Signal Store (Requirement 5.1)
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

  // Broadcast workflow_step_waiting (Requirement 10.1)
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

  // Arm timeout timer if configured (Requirement 5.3)
  if (waitForStep.timeout != null && waitForStep.timeout > 0) {
    const timer = setTimeout(() => {
      // Mark signal as timed out
      signalStore.markTimedOut(signalRecord.id);

      // Fail the run
      const reason = `Signal "${waitForStep.event}" timed out while waiting`;
      runStore.updateStatus(runId, "failed", reason);

      // Broadcast workflow_step_failed (Requirement 10.6)
      broadcast({
        type: "workflow_step_failed",
        workflowRunId: runId,
        stepSlug: waitForStep.slug,
        jobId: runId,
        error: reason,
      });

      // Broadcast workflow_failed
      broadcast({
        type: "workflow_failed",
        workflowRunId: runId,
        failedStep: waitForStep.slug,
        error: reason,
      });

      log.info(`Signal timeout fired for run ${runId}, event "${waitForStep.event}"`);
    }, waitForStep.timeout);

    // Register timer for cleanup on shutdown
    if (deps.registerTimer) {
      deps.registerTimer(timer);
    }
  }
}

/**
 * Handles an `emit` control flow node inline.
 *
 * Resolves the `event` name and optional `payload` via the template engine,
 * queries the Signal Store for all runs waiting on the resolved event, and
 * delivers the payload to each matching run (fire-and-forget). Stores the
 * emit node result as `{ event, delivered }` and continues to the next segment.
 *
 * Partial delivery failures are logged and excluded from the delivered count,
 * but do not fail the emit step itself (Requirement 7.6).
 *
 * @param runId - The workflow run ID
 * @param stepIndex - The index of the `emit` node in the flat step list
 * @param emitStep - The `emit` step definition
 * @param run - The current run state from the Run Store
 * @param deps - Injected dependencies
 */
async function handleEmitNode(
  runId: string,
  stepIndex: number,
  emitStep: EmitStep,
  run: runStore.WorkflowRun,
  deps: SegmentDispatcherDeps,
): Promise<void> {
  const { allStepDefs, flowProducer, sessionFactory, log, broadcast } = deps;

  // Build template context from accumulated state
  const templateCtx: TemplateContext = {
    triggerPayload: run.triggerPayload ?? undefined,
    stepResults: run.stepResults,
    stepConfigs: allStepDefs,
  };

  // Resolve the event name template expression (Requirement 7.4)
  let resolvedEvent: string;
  try {
    const { resolved, warnings } = await resolveTemplates(emitStep.event, templateCtx);
    const hasUnresolvableWarning = warnings.some((w) => w.includes("Unresolvable") || w.includes("Unknown step slug"));
    if (hasUnresolvableWarning || resolved.includes("{{")) {
      failRun(
        runId,
        emitStep.slug,
        `Template resolution failed for emit event: unresolvable expression in "${emitStep.event}"`,
        deps,
      );
      return;
    }
    resolvedEvent = resolved;
  } catch (err) {
    log.error(`Template resolution failed for emit node "${emitStep.slug}" in run ${runId}:`, err);
    failRun(
      runId,
      emitStep.slug,
      `Template resolution failed for event: ${err instanceof Error ? err.message : String(err)}`,
      deps,
    );
    return;
  }

  // Resolve the optional payload template expression (Requirement 7.4)
  let resolvedPayload: unknown = null;
  if (emitStep.payload) {
    try {
      const { resolved, warnings } = await resolveTemplates(emitStep.payload, templateCtx);
      const hasUnresolvableWarning = warnings.some(
        (w) => w.includes("Unresolvable") || w.includes("Unknown step slug"),
      );
      if (hasUnresolvableWarning || resolved.includes("{{")) {
        failRun(
          runId,
          emitStep.slug,
          `Template resolution failed for emit payload: unresolvable expression in "${emitStep.payload}"`,
          deps,
        );
        return;
      }
      // Try to parse as JSON, fall back to raw string
      try {
        resolvedPayload = JSON.parse(resolved);
      } catch {
        resolvedPayload = resolved;
      }
    } catch (err) {
      log.error(`Template resolution failed for emit payload in node "${emitStep.slug}" in run ${runId}:`, err);
      failRun(
        runId,
        emitStep.slug,
        `Template resolution failed for payload: ${err instanceof Error ? err.message : String(err)}`,
        deps,
      );
      return;
    }
  }

  // Query Signal Store for all runs waiting on the resolved event (Requirement 7.1)
  let waitingSignals: signalStore.SignalRecord[];
  try {
    waitingSignals = signalStore.getAllWaitingByEvent(resolvedEvent);
  } catch (err) {
    log.error(`Signal Store error querying waiting signals for event "${resolvedEvent}" in run ${runId}:`, err);
    failRun(
      runId,
      emitStep.slug,
      `Signal Store unavailable: ${err instanceof Error ? err.message : String(err)}`,
      deps,
    );
    return;
  }

  // Deliver to each matching run (Requirement 7.2, 7.6)
  let deliveredCount = 0;

  for (const signal of waitingSignals) {
    // Skip signals belonging to the current run (don't self-signal)
    if (signal.runId === runId) {
      continue;
    }

    try {
      // Mark signal as received with the resolved payload
      signalStore.markReceived(signal.id, resolvedPayload);

      // Store payload as the waitFor step's result in Run Store
      runStore.updateStepResult(signal.runId, signal.stepSlug, resolvedPayload);

      // Transition the waiting run to "running" status
      runStore.updateStatus(signal.runId, "running");

      // Broadcast workflow_step_resumed for that run
      broadcast({
        type: "workflow_step_resumed",
        workflowRunId: signal.runId,
        stepSlug: signal.stepSlug,
        signalEvent: resolvedEvent,
      });

      // Dispatch the next segment for the waiting run (fire-and-forget, Requirement 7.5)
      const waitingRun = runStore.get(signal.runId);
      if (waitingRun) {
        const nextIndex = waitingRun.currentStepIndex + 1;

        // Look up workflow definition for the waiting run
        let waitingWfSteps: WorkflowStep[] | undefined;
        if (deps.getWorkflowDefinition) {
          const wfDef = deps.getWorkflowDefinition(waitingRun.workflowName);
          if (wfDef) {
            waitingWfSteps = wfDef.steps;
          }
        }

        if (waitingWfSteps) {
          // Fire-and-forget: don't await the dispatch of notified runs
          dispatchNextSegment(signal.runId, nextIndex, {
            steps: waitingWfSteps,
            allStepDefs: Object.fromEntries(waitingWfSteps.map((s) => [s.slug, s])),
            flowProducer,
            sessionFactory,
            log,
            broadcast,
            getWorkflowDefinition: deps.getWorkflowDefinition,
          }).catch((err) => {
            log.error(
              `Failed to dispatch next segment for notified run ${signal.runId} after emit "${emitStep.slug}":`,
              err,
            );
            try {
              runStore.updateStatus(
                signal.runId,
                "failed",
                `Segment dispatch failed after emit signal: ${err instanceof Error ? err.message : String(err)}`,
              );
            } catch {
              // best effort
            }
            broadcast({
              type: "workflow_failed",
              workflowRunId: signal.runId,
              failedStep: signal.stepSlug,
              error: `Segment dispatch failed after emit signal: ${err instanceof Error ? err.message : String(err)}`,
            });
          });
        } else {
          // Workflow definition not found - log error but count as delivered
          // since the signal was already marked received
          log.warn(
            `Workflow definition "${waitingRun.workflowName}" not found for notified run ${signal.runId} after emit "${emitStep.slug}"`,
          );
        }
      }

      deliveredCount++;
    } catch (err) {
      // Partial failure: log error, exclude from count, continue (Requirement 7.6)
      log.error(
        `Failed to deliver emit signal "${resolvedEvent}" to run ${signal.runId} (step ${signal.stepSlug}):`,
        err,
      );
    }
  }

  // Store emit node result (Requirement 7.1)
  const emitResult = { event: resolvedEvent, delivered: deliveredCount };
  try {
    runStore.updateStepResult(runId, emitStep.slug, emitResult);
  } catch (err) {
    log.error(`Run Store error storing emit result for run ${runId}, step ${emitStep.slug}:`, err);
    failRun(runId, emitStep.slug, `Run Store unavailable: ${err instanceof Error ? err.message : String(err)}`, deps);
    return;
  }

  // Update execution cursor past the emit node
  try {
    runStore.updateStepIndex(runId, stepIndex);
  } catch (err) {
    log.error(`Run Store error updating step index for run ${runId}:`, err);
    failRun(runId, emitStep.slug, `Run Store unavailable: ${err instanceof Error ? err.message : String(err)}`, deps);
    return;
  }

  // Broadcast workflow_step_completed for the emit node
  broadcast({
    type: "workflow_step_completed",
    workflowRunId: runId,
    stepSlug: emitStep.slug,
    jobId: runId,
  });

  log.info(
    `Emit node "${emitStep.slug}" in run ${runId}: emitted event "${resolvedEvent}", delivered to ${deliveredCount} run(s)`,
  );

  // Continue to next segment for the emitting run (Requirement 7.5)
  const resumeStepIndex = stepIndex + 1;
  await dispatchNextSegment(runId, resumeStepIndex, deps);
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
