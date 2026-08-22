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

/**
 * Arms a timeout timer for a signal record.
 *
 * When the timer fires, it re-checks the signal's current status
 * to prevent a race condition with concurrent signal delivery.
 * Only fails the run if the signal is still in `waiting` status.
 *
 * @param signalId - The signal record ID (from Signal Store)
 * @param runId - The workflow run ID
 * @param stepSlug - The waitFor step's slug
 * @param event - The signal event name
 * @param timeoutMs - Timeout duration in milliseconds
 * @param deps - Logger and broadcast function
 */
export function arm(
  signalId: string,
  runId: string,
  stepSlug: string,
  event: string,
  timeoutMs: number,
  deps: SignalTimeoutDeps,
): void {
  // Cancel any existing timer for this signal (defensive, shouldn't happen)
  cancel(signalId);

  const timer = setTimeout(() => {
    // Remove from registry since the timer has fired
    timers.delete(signalId);

    // Re-check signal status to prevent race with concurrent delivery
    const signal = signalStore.getWaiting(runId, event);
    if (!signal || signal.id !== signalId) {
      // Signal was already received or timed out by another path
      return;
    }

    // Mark signal as timed out
    signalStore.markTimedOut(signalId);

    // Fail the run
    const reason = `Signal "${event}" timed out while waiting`;
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
