/**
 * Signal delivery - the single path that resumes a waiting workflow step.
 *
 * The HTTP signal routes, the `emit` step handler, and (later) the HITL
 * service all deliver through {@link deliverSignal}, so validation, the atomic
 * claim, timer cancellation, the resume broadcast, and the coordinator resume
 * exist exactly once. A signal ID addresses one waiting step of one run, which
 * is what makes delivery instance-scoped.
 *
 * @module
 */

import { validateJsonSchema } from "@src/utils/jsonSchema";
import { type DagCoordinatorDeps, resumeWaitForNode } from "./dagCoordinator";
import * as dagRunStore from "./dagRunStore";
import * as signalStore from "./signalStore";
import * as signalTimers from "./signalTimers";

/** Which caller delivers a signal. */
export type SignalDeliveryVia = "route" | "emit" | "hitl";

/** A single payload validation error. */
export interface SignalValidationError {
  /** JSON pointer of the offending value. */
  path: string;
  /** Validation message. */
  message: string;
}

/** Outcome of {@link deliverSignal}. */
export type SignalDeliveryResult =
  | { ok: true; signal: signalStore.SignalRecord }
  | {
      ok: false;
      /** HTTP-style status: 404 unknown signal, 409 not deliverable, 422 invalid payload. */
      status: 404 | 409 | 422;
      /** Human-readable reason. */
      error: string;
      /** Payload validation errors (status 422 only). */
      details?: SignalValidationError[];
    };

/**
 * Delivers a payload to one waiting signal and resumes its run.
 *
 * Steps, in order: load the signal, check it is still waiting and its run is
 * active, enforce the source (signals created by `humanTask` nodes can only be
 * answered through HITL), validate the payload against the signal's input
 * schema, claim the signal atomically, cancel its timeout, broadcast
 * `workflow_step_resumed`, and resume the run. The resume itself is
 * fire-and-forget; failures are logged.
 *
 * @param signalId - The signal record ID
 * @param payload - The payload (becomes the waiting step's result)
 * @param options - The delivering caller and coordinator dependencies
 * @returns Success with the delivered signal, or a failure with an HTTP-style status
 */
export function deliverSignal(
  signalId: string,
  payload: unknown,
  options: { via: SignalDeliveryVia; coordinatorDeps: DagCoordinatorDeps },
): SignalDeliveryResult {
  const { via, coordinatorDeps } = options;

  const signal = signalStore.getById(signalId);
  if (!signal) {
    return { ok: false, status: 404, error: "Signal not found" };
  }
  if (signal.status !== "waiting") {
    return {
      ok: false,
      status: 409,
      error: signal.status === "timed_out" ? "Signal has already timed out" : "Signal has already been delivered",
    };
  }

  const run = dagRunStore.get(signal.runId);
  if (!run || !dagRunStore.isActiveRunStatus(run.status)) {
    return {
      ok: false,
      status: 409,
      error: `Run is not active (current status: "${run?.status ?? "deleted"}")`,
    };
  }

  if (signal.source === "humanTask" && via !== "hitl") {
    return { ok: false, status: 409, error: "This step waits for a human task and can only be answered there" };
  }

  if (signal.inputSchema) {
    const validation = validateJsonSchema(signal.inputSchema, payload);
    if (!validation.valid) {
      return { ok: false, status: 422, error: "Validation failed", details: validation.errors };
    }
  }

  if (!signalStore.markReceived(signal.id, payload)) {
    return { ok: false, status: 409, error: "Signal has already been delivered" };
  }
  signalTimers.cancel(signal.id);

  coordinatorDeps.broadcast({
    type: "workflow_step_resumed",
    workflowRunId: signal.runId,
    stepSlug: signal.stepSlug,
    signalEvent: signal.event,
  });

  resumeWaitForNode(signal.runId, signal.stepSlug, payload, coordinatorDeps).catch((err) => {
    coordinatorDeps.log.error(
      `Failed to resume run ${signal.runId} (step ${signal.stepSlug}) after signal "${signal.event}" (via ${via}):`,
      err,
    );
  });

  return { ok: true, signal };
}
