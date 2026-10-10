/**
 * Signal Timer Registry - manages timeout timers for waitFor signal records.
 *
 * Provides a centralized, module-level store for armed signal timeout timers.
 * Timers are keyed by signal record ID, allowing any part of the workflow
 * engine (segment dispatcher, signal delivery endpoint, emit handler, crash
 * recovery) to cancel a timer when a signal is delivered or the run completes.
 *
 * The timeout callback re-checks the signal's current status before failing
 * the run, preventing a race condition where a signal is delivered between
 * timer expiration and the callback executing.
 *
 * @module
 */

import type { Logger } from "@ext/types";
import type { WorkflowWebSocketEvent } from "@shared/workflows";
import * as runStore from "./dagRunStore";
import * as signalStore from "./signalStore";

/** Dependencies for arming a signal timeout. */
export interface SignalTimeoutDeps {
  /** Logger for the workflow extension. */
  log: Logger;
  /** Broadcasts a WebSocket event to connected clients. */
  broadcast: (event: WorkflowWebSocketEvent) => void;
}

/** Module-level map of signal ID -> armed timeout timer. */
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** The signal fields a timeout timer needs. */
export type TimedSignal = Pick<signalStore.SignalRecord, "id" | "runId" | "stepSlug" | "event">;

/**
 * Arms a timeout timer for a signal record.
 *
 * When the timer fires, it claims the signal with an atomic
 * `markTimedOut`, so a signal delivered between timer expiry and the
 * callback is left alone. The run is only failed if it is still active.
 *
 * @param signal - The signal record (ID, run, step, and event)
 * @param timeoutMs - Delay until the timeout fires, in milliseconds (0 = next tick)
 * @param deps - Logger and broadcast function
 */
export function arm(signal: TimedSignal, timeoutMs: number, deps: SignalTimeoutDeps): void {
  const { id: signalId, runId, stepSlug, event } = signal;

  // Cancel any existing timer for this signal (defensive, shouldn't happen)
  cancel(signalId);

  const timer = setTimeout(() => {
    // Remove from registry since the timer has fired
    timers.delete(signalId);

    // Claim the signal. Losing the claim means it was delivered (or timed out)
    // by another path in the meantime.
    if (!signalStore.markTimedOut(signalId)) return;

    // A run that already ended (failed by another branch, cancelled) keeps its
    // terminal status; the stale wait just expires.
    const run = runStore.get(runId);
    if (!run || !runStore.isActiveRunStatus(run.status)) return;

    // Fail the run and mark the waitFor step failed. Without the step update the
    // node would linger in "waiting-signal" after the run is already failed,
    // since this path does not route through the coordinator's fail-fast sweep.
    const reason = `Signal "${event}" timed out while waiting`;
    runStore.updateStepStatus(runId, stepSlug, "failed");
    runStore.updateStatus(runId, "failed", reason);

    // Broadcast step failure
    deps.broadcast({
      type: "workflow_step_failed",
      workflowRunId: runId,
      stepSlug,
      jobId: runId,
      error: reason,
    });

    // Broadcast workflow failure
    deps.broadcast({
      type: "workflow_failed",
      workflowRunId: runId,
      failedStep: stepSlug,
      error: reason,
    });

    deps.log.info(`Signal timeout fired for run ${runId}, event "${event}"`);
  }, timeoutMs);

  timers.set(signalId, timer);
}

/**
 * Re-arms the timeout timers of all waiting signals.
 *
 * Timers live in memory, so a restart would otherwise drop every pending
 * timeout. Called once at boot: the deadline is derived from the signal's
 * creation time and timeout, and an already elapsed deadline fires on the
 * next tick.
 *
 * @param deps - Logger and broadcast function
 * @param now - Current time in epoch ms (injectable for tests)
 * @returns The number of timers armed
 */
export function rearmWaiting(deps: SignalTimeoutDeps, now: number = Date.now()): number {
  let armed = 0;
  for (const signal of signalStore.getAllWaiting()) {
    if (signal.timeoutMs == null || signal.timeoutMs <= 0) continue;
    const remaining = Math.max(0, signal.createdAt + signal.timeoutMs - now);
    arm(signal, remaining, deps);
    armed++;
  }
  return armed;
}

/**
 * Cancels and removes the timeout timer for a signal record.
 *
 * Called when a signal is delivered (via the signal delivery endpoint
 * or the emit handler) to prevent the timeout from firing after delivery.
 *
 * No-op if no timer is armed for the given signal ID.
 *
 * @param signalId - The signal record ID to cancel the timer for
 */
export function cancel(signalId: string): void {
  const timer = timers.get(signalId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(signalId);
  }
}

/**
 * Clears all armed timeout timers.
 *
 * Called during extension shutdown to prevent timers from firing
 * after the extension is torn down.
 */
export function cleanup(): void {
  for (const timer of timers.values()) {
    clearTimeout(timer);
  }
  timers.clear();
}

/**
 * Returns the number of currently armed timers (for testing/diagnostics).
 */
export function activeCount(): number {
  return timers.size;
}
