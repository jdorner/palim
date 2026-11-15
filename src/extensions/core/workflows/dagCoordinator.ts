/**
 * DAG Coordinator - the I/O shell around the run kernel.
 *
 * Called to start runs, by the queue's `completed` and `failed` event
 * handlers, by signal delivery and by signal timeouts. Every state change goes through
 * {@link advance} in `runKernel.ts`: the shell loads the run, asks the kernel
 * what the event changes, applies that patch in one statement, then executes
 * the kernel's effects in order: enqueue jobs, resolve control-flow templates
 * (feeding the answer back as the next event), register waits, broadcast, log.
 *
 * Loading, deciding and applying happen without an `await` in between, so no
 * other handler can interleave with a transition. Effects run afterwards and
 * re-load the run when they need its state.
 *
 * @module
 */

import type { HitlApi, Logger, WorkflowDispatchResult } from "@ext/types";
import type { WorkflowWebSocketEvent } from "@shared/workflows";
import type { FlowProducer } from "bunqueue/client";
import { evaluateCondition } from "./condition";
import { buildDagStepJob, type SessionFactory } from "./dagEngine";
import * as dagRunStore from "./dagRunStore";
import { type DagWorkflowRun, edgeId } from "./dagRunStore";
import { definitionTopology } from "./definitionTopology";
import {
  HUMAN_TASK_SIGNAL_EVENT,
  type ResolvedHumanTaskFields,
  resolveHumanTaskFields,
  WORKFLOW_TASK_SOURCE,
} from "./humanTask";
import { advance, type RunEffect, type RunEvent, type RunPatch } from "./runKernel";
import type {
  ConditionDef,
  DagCaseStep,
  DagHumanTaskStep,
  DagIfStep,
  DagIteratorStep,
  DagStep,
  DagWaitForStep,
  DagWorkflowDefinition,
} from "./schemas";
import * as signalStore from "./signalStore";
import * as signalTimers from "./signalTimers";
import { resolveTemplates, type TemplateContext } from "./template";

export type { IterationState } from "./runKernel";

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
  /**
   * Lists a run's queued and active job IDs. With {@link cancelJob}, every
   * transition that fails a run cancels them (fail-fast for all failure paths:
   * job failures, inline evaluation errors, signal timeouts).
   */
  inFlightJobIds?: (runId: string) => Promise<string[]>;
  /** Human task service for `humanTask` nodes (absent when HITL is not configured). */
  hitl?: HitlApi;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Handles a completed DAG workflow step: stores its result, satisfies its
 * outgoing edges and starts every successor whose join barrier is released.
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
  deps.broadcast({ type: "workflow_step_completed", workflowRunId: runId, stepSlug, jobId });
  await processEvent(runId, { type: "stepCompleted", slug: stepSlug, result }, deps);
}

/**
 * Starts a run of a workflow: creates its run record (every step and edge
 * pending), announces it, and lets the kernel activate every root step. Job
 * roots are enqueued; inline roots (control flow, waits) are evaluated or
 * registered right away.
 *
 * @param definition - The validated workflow definition
 * @param triggerPayload - The trigger's input data (webhook body, etc.)
 * @param deps - Injected dependencies
 * @param initiatorUserId - The user the run executes as, if any
 * @returns The run ID and the job IDs of the enqueued root steps
 * @throws When the run record cannot be created, or a root step cannot be enqueued (the run is failed first)
 */
export async function startRun(
  definition: DagWorkflowDefinition,
  triggerPayload: unknown,
  deps: DagCoordinatorDeps,
  initiatorUserId?: string,
): Promise<WorkflowDispatchResult> {
  const workflowRunId = crypto.randomUUID();
  const slugs = Object.keys(definition.steps);
  try {
    dagRunStore.create({
      id: workflowRunId,
      workflowName: definition.name,
      status: "running",
      edgeStates: Object.fromEntries(definition.edges.map((e) => [edgeId(e.from, e.to, e.branch), "pending" as const])),
      stepStatuses: Object.fromEntries(slugs.map((slug) => [slug, "pending" as const])),
      stepResults: {},
      triggerPayload,
      failureReason: null,
      createdByUserId: initiatorUserId ?? null,
    });
  } catch (err) {
    deps.log.error(`Failed to create DAG Run Store record for workflow "${definition.name}":`, err);
    throw new Error(`DAG Run Store unavailable: ${errorMessage(err)}`);
  }

  deps.broadcast({
    type: "workflow_started",
    workflowRunId,
    workflowName: definition.name,
    steps: Object.entries(definition.steps).map(([slug, s]) => ({ slug, type: s.type })),
  });

  const { dispatched } = await processEvent(workflowRunId, { type: "runStarted" }, deps, definition);
  const failedRoot = dispatched.find((d) => "error" in d);
  if (failedRoot && "error" in failedRoot) throw failedRoot.error;

  const jobIds = dispatched.flatMap((d) => ("jobId" in d ? [d.jobId] : []));
  deps.log.info(
    `Started DAG workflow "${definition.name}" run ${workflowRunId} (${slugs.length} steps, ${jobIds.length} root job(s) enqueued)`,
  );
  return { workflowRunId, jobIds };
}

/**
 * Resumes a workflow run after a `waitFor` or `humanTask` node receives its
 * signal: the payload becomes the step's result and its successors start.
 * Called by `deliverSignal` after it has claimed the signal.
 *
 * @param runId - The workflow run ID
 * @param stepSlug - The waiting node slug
 * @param payload - The signal payload (becomes the step's result)
 * @param deps - Injected dependencies
 */
export async function resumeWaitForNode(
  runId: string,
  stepSlug: string,
  payload: unknown,
  deps: DagCoordinatorDeps,
): Promise<void> {
  // With several concurrent waits the run stays waiting-signal until the last
  // signal is delivered, matching the signal-delivery guard.
  const otherSignalsPending = signalStore.listWaitingForRun(runId).some((s) => s.stepSlug !== stepSlug);
  await processEvent(runId, { type: "signalReceived", slug: stepSlug, payload, otherSignalsPending }, deps);
}

/**
 * Handles a failed DAG workflow step: fails the run, sweeps every open step
 * to dead and cancels the given in-flight jobs.
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
  const { cancelled } = await processEvent(runId, { type: "stepFailed", slug: stepSlug, reason: error }, deps);
  await cancelJobs(
    (jobIdsToCancel ?? []).filter((id) => !cancelled.includes(id)),
    deps,
  );
}

/**
 * Cancels jobs, best effort.
 *
 * @param jobIds - The jobs to cancel
 * @param deps - Injected dependencies (no-op without `cancelJob`)
 */
async function cancelJobs(jobIds: readonly string[], deps: DagCoordinatorDeps): Promise<void> {
  if (!deps.cancelJob) return;
  for (const jobId of jobIds) {
    try {
      await deps.cancelJob(jobId);
    } catch {
      // Best effort
    }
  }
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

/**
 * Applies one event: load the run, let the kernel decide, apply the patch,
 * then execute the effects in order.
 *
 * @param runId - The workflow run ID
 * @param event - The event
 * @param deps - Injected dependencies
 */
async function processEvent(
  runId: string,
  event: RunEvent,
  deps: DagCoordinatorDeps,
  definitionOverride?: DagWorkflowDefinition,
): Promise<ProcessedEvent> {
  const outcome: ProcessedEvent = {
    patch: { stepStatuses: {}, edgeStates: {}, stepResults: {} },
    dispatched: [],
    cancelled: [],
  };
  const run = dagRunStore.get(runId);
  if (!run) {
    deps.log.error(`DAG coordinator: run ${runId} not found (${event.type})`);
    return outcome;
  }
  const definition = definitionOverride ?? deps.getWorkflowDefinition(run.workflowName);
  const { patch, effects } = advance(run, definition, event);
  dagRunStore.applyPatch(runId, patch);
  outcome.patch = patch;
  for (const effect of effects) {
    const dispatched = await runEffect(run, definition, effect, deps);
    if (dispatched) outcome.dispatched.push(dispatched);
  }
  // Fail-fast: a transition that failed the run stops its in-flight jobs.
  // Their failure events then reach an ended run and change nothing.
  if (patch.status === "failed" && deps.cancelJob && deps.inFlightJobIds) {
    outcome.cancelled = await deps.inFlightJobIds(runId);
    await cancelJobs(outcome.cancelled, deps);
  }
  return outcome;
}

/** What {@link processEvent} did. */
interface ProcessedEvent {
  /** The patch the kernel produced (empty when the run was not found). */
  patch: RunPatch;
  /** The outcome of each `dispatch` effect of this transition (not of follow-up events). */
  dispatched: DispatchOutcome[];
  /** Jobs cancelled because this transition failed the run. */
  cancelled: string[];
}

/** The outcome of enqueueing one step. */
type DispatchOutcome = { slug: string; jobId: string } | { slug: string; error: unknown };

/**
 * Fails the run at a step (through the kernel's fail-fast rule).
 *
 * @param runId - The workflow run ID
 * @param slug - The failing step
 * @param reason - Failure reason
 * @param deps - Injected dependencies
 */
async function failStep(runId: string, slug: string, reason: string, deps: DagCoordinatorDeps): Promise<void> {
  await processEvent(runId, { type: "stepFailed", slug, reason }, deps);
}

/**
 * Executes one kernel effect.
 *
 * @param run - The run as loaded before the transition (identity fields only are read)
 * @param definition - The run's workflow definition
 * @param effect - The effect
 * @param deps - Injected dependencies
 * @returns The dispatch outcome for a `dispatch` effect that ran, otherwise undefined
 */
async function runEffect(
  run: DagWorkflowRun,
  definition: DagWorkflowDefinition | undefined,
  effect: RunEffect,
  deps: DagCoordinatorDeps,
): Promise<DispatchOutcome | undefined> {
  switch (effect.type) {
    case "broadcast":
      deps.broadcast(effect.event);
      return;
    case "log":
      deps.log[effect.level](effect.message);
      return;
  }

  // Work effects are only emitted with a definition.
  const stepDef = definition?.steps[effect.slug];
  if (!definition || !stepDef) return;

  // The kernel marked the step running. An earlier effect's await may have let
  // another handler fail the run (sweeping the step to dead) in the meantime;
  // then the work must not start, or a wait would revive the failed run.
  if (dagRunStore.get(run.id)?.stepStatuses[effect.slug] !== "running") return;

  switch (effect.type) {
    case "dispatch":
      return dispatchStep(run, effect.slug, stepDef as DagStep, definition, deps);
    case "evaluate": {
      const event = await evaluateControlFlow(run.id, effect.slug, stepDef as DagStep, definition, deps);
      if (event) await processEvent(run.id, event, deps);
      return;
    }
    case "register":
      if (stepDef.type === "waitFor") {
        await registerWaitForNode(run.id, effect.slug, stepDef as DagWaitForStep, definition, deps);
      } else {
        await registerHumanTaskNode(run.id, effect.slug, stepDef as DagHumanTaskStep, definition, deps);
      }
      return;
  }
}

/**
 * Enqueues a step as a job. The kernel has already marked it running: the
 * in-process worker can finish a fast job before `add()` resolves, and a status
 * write after the await would clobber its "completed" (or "failed") state.
 */
async function dispatchStep(
  run: DagWorkflowRun,
  slug: string,
  stepDef: DagStep,
  definition: DagWorkflowDefinition,
  deps: DagCoordinatorDeps,
): Promise<DispatchOutcome> {
  const { flowProducer, sessionFactory, log, broadcast } = deps;

  const job = buildDagStepJob(slug, {
    workflowRunId: run.id,
    workflowName: run.workflowName,
    stepDef,
    allStepDefs: buildStepConfigs(definition),
    sessionFactory,
    triggerPayload: run.triggerPayload ?? undefined,
    iteratorSlug: definitionTopology(definition).enclosingIterator(slug),
    ...(run.createdByUserId ? { initiatorUserId: run.createdByUserId } : {}),
  });

  try {
    const result = await flowProducer.add(job);

    // Only announce the start while the step is still running; a late
    // started event after its completion would show it active again.
    if (dagRunStore.get(run.id)?.stepStatuses[slug] === "running") {
      broadcast({ type: "workflow_step_started", workflowRunId: run.id, stepSlug: slug, jobId: result.job.id });
    }
    log.debug(`DAG coordinator: dispatched step "${slug}" for run ${run.id} (job ${result.job.id})`);
    return { slug, jobId: result.job.id };
  } catch (err) {
    log.error(`DAG coordinator: failed to dispatch step "${slug}" for run ${run.id}:`, err);
    await failStep(run.id, slug, `Failed to dispatch step: ${errorMessage(err)}`, deps);
    return { slug, error: err };
  }
}

/**
 * Resolves an if/case/iterator node's templates against the current run state
 * and turns the answer into the event the kernel needs. A resolution error
 * fails the step instead.
 *
 * @returns The evaluation event, or null when the run is gone or the step failed
 */
async function evaluateControlFlow(
  runId: string,
  slug: string,
  stepDef: DagStep,
  definition: DagWorkflowDefinition,
  deps: DagCoordinatorDeps,
): Promise<RunEvent | null> {
  const run = dagRunStore.get(runId);
  if (!run || !dagRunStore.isActiveRunStatus(run.status)) return null;
  const ctx = templateContext(run, definition);

  const fail = async (reason: string, err?: unknown): Promise<null> => {
    if (err !== undefined) deps.log.error(`DAG coordinator: ${reason} for "${slug}" in run ${runId}:`, err);
    await failStep(runId, slug, err === undefined ? reason : `${reason}: ${errorMessage(err)}`, deps);
    return null;
  };

  if (stepDef.type === "if") {
    const { condition } = stepDef as DagIfStep;
    let value: unknown;
    try {
      const { resolved, warnings } = await resolveTemplates(condition.ref, ctx);
      const unresolvable = warnings.some((w) => w.includes("Unresolvable") || w.includes("Unknown step slug"));
      value = unresolvable || resolved.includes("{{") ? undefined : resolved;
    } catch (err) {
      return fail("Template resolution failed", err);
    }
    try {
      const result = evaluateCondition(value, condition as ConditionDef);
      return { type: "ifEvaluated", slug, condition: result, value: typeof value === "string" ? value : null };
    } catch (err) {
      return fail("Condition evaluation failed", err);
    }
  }

  if (stepDef.type === "case") {
    try {
      const { resolved } = await resolveTemplates((stepDef as DagCaseStep).match, ctx);
      return { type: "caseEvaluated", slug, value: resolved };
    } catch (err) {
      return fail("Template resolution failed", err);
    }
  }

  if (stepDef.type === "iterator") {
    let itemsJson: string;
    try {
      itemsJson = (await resolveTemplates((stepDef as DagIteratorStep).items, ctx)).resolved;
    } catch (err) {
      return fail(`Iterator items template resolution failed: ${errorMessage(err)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(itemsJson);
    } catch (err) {
      return fail(`Iterator items is not valid JSON: ${errorMessage(err)}`);
    }
    if (!Array.isArray(parsed)) return fail(`Iterator items resolved to ${typeof parsed}, expected array`);
    return { type: "iteratorEvaluated", slug, items: parsed };
  }

  return fail(`Unknown CF node type: ${stepDef.type}`);
}

// ---------------------------------------------------------------------------
// WaitFor Registration
// ---------------------------------------------------------------------------

/**
 * Registers a `waitFor` node: resolves its correlation key, creates a signal
 * record, marks the step and run as waiting, broadcasts a waiting event, and
 * arms a timeout timer if configured.
 *
 * The waitFor node does NOT run as a queue job. It pauses its branch until a
 * signal is delivered (via the signal endpoints or emit handler, all through
 * `deliverSignal`), at which point {@link resumeWaitForNode} advances execution.
 *
 * @param runId - The workflow run ID
 * @param slug - The waitFor node slug
 * @param stepDef - The waitFor step definition
 * @param definition - The workflow definition (for template step configs)
 * @param deps - Injected dependencies
 */
async function registerWaitForNode(
  runId: string,
  slug: string,
  stepDef: DagWaitForStep,
  definition: DagWorkflowDefinition,
  deps: DagCoordinatorDeps,
): Promise<void> {
  const { log } = deps;

  // Resolve the correlation key against the run state at the time the wait is
  // reached. An unresolvable key would never match an emit, so fail instead.
  let correlationKey: string | null = null;
  if (stepDef.correlate) {
    const run = dagRunStore.get(runId);
    if (!run) return;
    const templateCtx: TemplateContext = {
      triggerPayload: run.triggerPayload ?? undefined,
      stepResults: run.stepResults,
      stepConfigs: buildStepConfigs(definition),
      run: dagRunStore.toRunTemplateInfo(run),
    };
    try {
      const { resolved, warnings } = await resolveTemplates(stepDef.correlate, templateCtx);
      if (warnings.length > 0 || resolved.includes("{{")) {
        await failStep(runId, slug, `Correlation key could not be resolved: ${warnings.join("; ") || resolved}`, deps);
        return;
      }
      correlationKey = resolved;
    } catch (err) {
      await failStep(
        runId,
        slug,
        `Correlation key resolution failed: ${err instanceof Error ? err.message : String(err)}`,
        deps,
      );
      return;
    }
  }

  // The resolution above awaited: re-check before creating anything. From here
  // to the kernel's waitRegistered transition nothing awaits, so the check holds.
  if (!stillRunning(runId, slug)) return;

  // Create a signal record so the delivery endpoints can find this waiting step.
  // Do this before the step pauses so a store failure leaves the run intact
  // for failStep to mark failed.
  let signalRecord: signalStore.SignalRecord;
  try {
    signalRecord = signalStore.create({
      runId,
      stepSlug: slug,
      event: stepDef.event,
      timeoutMs: stepDef.timeout ?? null,
      inputSchema: stepDef.inputSchema ?? null,
      scope: stepDef.scope ?? "instance",
      correlationKey,
      source: "waitFor",
    });
  } catch (err) {
    log.error(`DAG coordinator: signal store error for waitFor "${slug}" in run ${runId}:`, err);
    await failStep(runId, slug, `Signal Store unavailable: ${err instanceof Error ? err.message : String(err)}`, deps);
    return;
  }

  // The kernel pauses the step and the run (waiting-signal). Both are
  // non-terminal: a delivered signal resumes them, a timeout fails the run.
  if (!(await pauseOnSignal(runId, slug, signalRecord.id, deps))) return;

  log.info(
    `DAG waitFor node "${slug}" in run ${runId}: waiting for signal "${stepDef.event}" (${signalRecord.scope}${
      correlationKey !== null ? `, key "${correlationKey}"` : ""
    })${stepDef.timeout ? ` (timeout: ${stepDef.timeout}ms)` : ""}`,
  );

  // Arm timeout timer if configured
  if (stepDef.timeout != null && stepDef.timeout > 0) {
    signalTimers.arm(signalRecord, stepDef.timeout, signalTimeoutDeps(deps));
  }
}

// ---------------------------------------------------------------------------
// Human Task Registration
// ---------------------------------------------------------------------------

/**
 * Registers a `humanTask` node: resolves its templated fields, creates an
 * instance-scoped signal that only the HITL service may deliver, creates the
 * portal task pointing at that signal, and pauses the branch like `waitFor`.
 *
 * The task's answer arrives through the workflow source handler (see the
 * workflows extension), which delivers it to the signal and resumes the run.
 *
 * @param runId - The workflow run ID
 * @param slug - The humanTask node slug
 * @param stepDef - The humanTask step definition
 * @param definition - The workflow definition (for template step configs)
 * @param deps - Injected dependencies
 */
async function registerHumanTaskNode(
  runId: string,
  slug: string,
  stepDef: DagHumanTaskStep,
  definition: DagWorkflowDefinition,
  deps: DagCoordinatorDeps,
): Promise<void> {
  const { log, hitl } = deps;
  if (!hitl) {
    await failStep(runId, slug, "Human tasks are disabled (set HITL_ENABLED=true)", deps);
    return;
  }

  const run = dagRunStore.get(runId);
  if (!run) return;

  let fields: ResolvedHumanTaskFields;
  try {
    fields = await resolveHumanTaskFields(stepDef, {
      triggerPayload: run.triggerPayload ?? undefined,
      stepResults: run.stepResults,
      stepConfigs: buildStepConfigs(definition),
      run: dagRunStore.toRunTemplateInfo(run),
    });
  } catch (err) {
    await failStep(
      runId,
      slug,
      `Human task could not be prepared: ${err instanceof Error ? err.message : String(err)}`,
      deps,
    );
    return;
  }

  // As for waitFor: no await from this check to the kernel's transition.
  if (!stillRunning(runId, slug)) return;

  let signalRecord: signalStore.SignalRecord;
  try {
    signalRecord = signalStore.create({
      runId,
      stepSlug: slug,
      event: HUMAN_TASK_SIGNAL_EVENT,
      timeoutMs: stepDef.timeout ?? null,
      inputSchema: null,
      scope: "instance",
      source: "humanTask",
    });
  } catch (err) {
    log.error(`DAG coordinator: signal store error for humanTask "${slug}" in run ${runId}:`, err);
    await failStep(runId, slug, `Signal Store unavailable: ${err instanceof Error ? err.message : String(err)}`, deps);
    return;
  }

  // Pause first, then create the task: a declined pause leaves no task behind.
  if (!(await pauseOnSignal(runId, slug, signalRecord.id, deps))) return;

  // The pause's effects awaited. Check again right before creating the task
  // (createTask is synchronous), so a run failed in the meantime gets no task.
  const current = dagRunStore.get(runId);
  if (!current || !dagRunStore.isActiveRunStatus(current.status) || current.stepStatuses[slug] !== "waiting-signal") {
    signalStore.markCancelled(signalRecord.id);
    return;
  }

  let taskId: string;
  try {
    const task = hitl.createTask({
      source: {
        kind: WORKFLOW_TASK_SOURCE,
        id: runId,
        ref: { runId, stepSlug: slug, signalId: signalRecord.id, workflow: run.workflowName },
      },
      title: fields.title,
      body: fields.body,
      context: fields.context,
      ...(stepDef.outcomes ? { outcomes: stepDef.outcomes } : {}),
      form: stepDef.form ?? null,
      requireComment: stepDef.requireComment ?? false,
      priority: stepDef.priority ?? "normal",
      dueAt: stepDef.timeout ? signalRecord.createdAt + stepDef.timeout : null,
      assignees: fields.assignees,
      createdBy: run.createdByUserId,
    });
    taskId = task.id;
  } catch (err) {
    // The signal must not linger as deliverable without a task behind it.
    signalStore.markCancelled(signalRecord.id);
    await failStep(runId, slug, `Human task could not be created: ${errorMessage(err)}`, deps);
    return;
  }

  log.info(
    `DAG humanTask node "${slug}" in run ${runId}: waiting for task ${taskId}${stepDef.timeout ? ` (timeout: ${stepDef.timeout}ms)` : ""}`,
  );

  if (stepDef.timeout != null && stepDef.timeout > 0) {
    signalTimers.arm(signalRecord, stepDef.timeout, signalTimeoutDeps(deps));
  }
}

/**
 * Whether a step the kernel activated may still start its work: the run is
 * active and the step was not swept in the meantime.
 *
 * @param runId - The workflow run ID
 * @param slug - The step slug
 * @returns True while the step is running
 */
function stillRunning(runId: string, slug: string): boolean {
  const run = dagRunStore.get(runId);
  return !!run && dagRunStore.isActiveRunStatus(run.status) && run.stepStatuses[slug] === "running";
}

/**
 * Hands a created signal to the kernel, which pauses the step and the run.
 * When the kernel declines (the step is no longer running), the signal is
 * withdrawn so it cannot be delivered.
 *
 * @param runId - The workflow run ID
 * @param slug - The waiting step
 * @param signalId - The signal just created for it
 * @param deps - Injected dependencies
 * @returns Whether the step now waits on the signal
 */
async function pauseOnSignal(
  runId: string,
  slug: string,
  signalId: string,
  deps: DagCoordinatorDeps,
): Promise<boolean> {
  const { patch } = await processEvent(runId, { type: "waitRegistered", slug }, deps);
  if (patch.stepStatuses[slug] === "waiting-signal") return true;
  signalStore.markCancelled(signalId);
  return false;
}

/**
 * Timer dependencies that fail a timed-out wait through the kernel.
 *
 * @param deps - Injected dependencies
 * @returns Logger and a failure callback for {@link signalTimers.arm}
 */
export function signalTimeoutDeps(deps: DagCoordinatorDeps): signalTimers.SignalTimeoutDeps {
  return {
    log: deps.log,
    failStep: (runId, slug, reason) => failStep(runId, slug, reason, deps),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds the template context of a run.
 *
 * @param run - The run
 * @param definition - Its workflow definition
 * @returns Trigger payload, step results and configs, and run info
 */
function templateContext(run: DagWorkflowRun, definition: DagWorkflowDefinition): TemplateContext {
  return {
    triggerPayload: run.triggerPayload ?? undefined,
    stepResults: run.stepResults,
    stepConfigs: buildStepConfigs(definition),
    run: dagRunStore.toRunTemplateInfo(run),
  };
}

/**
 * Builds the step configs lookup (each step definition with its slug) from a DAG definition.
 */
function buildStepConfigs(definition: DagWorkflowDefinition): Record<string, unknown> {
  const configs: Record<string, unknown> = {};
  for (const [slug, stepDef] of Object.entries(definition.steps)) {
    configs[slug] = { slug, ...stepDef };
  }
  return configs;
}

/** The message of a thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
