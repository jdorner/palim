/**
 * Crash Recovery - recovers workflow runs that were interrupted by a process crash.
 *
 * Called during extension initialization after the Run Store and Signal Store
 * are initialized. Handles two recovery scenarios:
 *
 * 1. Runs in `running` status: marked as `failed` (process terminated unexpectedly)
 * 2. Runs in `waiting-signal` status: signal timeouts are re-armed or expired signals are failed
 *
 * Returns a cleanup function that clears any armed timers (for use in extension shutdown).
 *
 * @module
 */

import type { Logger } from "@ext/types";
import type { WorkflowWebSocketEvent } from "@shared/workflows";
import * as runStore from "./runStore";
import * as signalStore from "./signalStore";
import * as signalTimers from "./signalTimers";

/**
 * Dependencies injected into the crash recovery function.
 */
export interface CrashRecoveryDeps {
  /** Logger for the workflow extension. */
  log: Logger;
  /** Broadcasts a WebSocket event to connected clients. */
  broadcast: (event: WorkflowWebSocketEvent) => void;
}

/**
 * Result of crash recovery, including a cleanup function for armed timers.
 */
export interface CrashRecoveryResult {
  /** Number of runs marked as failed (were in `running` status). */
  failedRuns: number;
  /** Number of signals whose timeouts were re-armed. */
  rearmedSignals: number;
  /** Number of signals that had already expired and were failed. */
  expiredSignals: number;
  /** Cleanup function that clears all armed timeout timers. */
  cleanup: () => void;
}

/**
 * Recovers workflow runs interrupted by process termination.
 *
 * - Marks all `running` runs as `failed` with an unexpected termination reason
 * - For `waiting-signal` runs, checks associated signals and either re-arms
 *   timeout timers (if time remains) or fails expired signals and their runs
 *
 * @param deps - Injected dependencies (logger, broadcast)
 * @returns Recovery result with stats and a cleanup function for armed timers
 */
export function recoverFromCrash(deps: CrashRecoveryDeps): CrashRecoveryResult {
  const { log, broadcast } = deps;
  let failedRuns = 0;
  let rearmedSignals = 0;
  let expiredSignals = 0;

  // --- Phase 1: Fail all runs that were in "running" status ---
  const runningRuns = runStore.getByStatus("running");
  for (const run of runningRuns) {
    const reason = "Process terminated unexpectedly";
    runStore.updateStatus(run.id, "failed", reason);
    failedRuns++;

    broadcast({
      type: "workflow_failed",
      workflowRunId: run.id,
      failedStep: "unknown",
      error: reason,
    });
  }

  if (failedRuns > 0) {
    log.info(`Crash recovery: marked ${failedRuns} interrupted run(s) as failed`);
  }

  // --- Phase 2: Re-arm signal timeouts for "waiting-signal" runs ---
  const waitingRuns = runStore.getByStatus("waiting-signal");
  if (waitingRuns.length === 0) {
    return { failedRuns, rearmedSignals, expiredSignals, cleanup: () => signalTimers.cleanup() };
  }

  // Build a set of waiting run IDs for quick lookup
  const waitingRunIds = new Set(waitingRuns.map((r) => r.id));

  // Get all waiting signals and filter to those belonging to waiting-signal runs
  const allWaitingSignals = signalStore.getAllWaiting();
  const relevantSignals = allWaitingSignals.filter((s) => waitingRunIds.has(s.runId));

  const now = Date.now();

  for (const signal of relevantSignals) {
    if (signal.timeoutMs === null) {
      // No timeout configured - signal remains waiting indefinitely, nothing to re-arm
      continue;
    }

    const elapsed = now - signal.createdAt;
    const remaining = signal.timeoutMs - elapsed;

    if (remaining <= 0) {
      // Timeout has already expired - fail the signal and the run
      signalStore.markTimedOut(signal.id);
      expiredSignals++;

      const reason = `Signal "${signal.event}" timed out during process downtime`;
      runStore.updateStatus(signal.runId, "failed", reason);

      broadcast({
        type: "workflow_failed",
        workflowRunId: signal.runId,
        failedStep: signal.stepSlug,
        error: reason,
      });
    } else {
      // Re-arm the timeout timer via the centralized signal timer registry
      signalTimers.arm(signal.id, signal.runId, signal.stepSlug, signal.event, remaining, { log, broadcast });
      rearmedSignals++;
    }
  }

  if (rearmedSignals > 0 || expiredSignals > 0) {
    log.info(`Crash recovery: re-armed ${rearmedSignals} signal timeout(s), expired ${expiredSignals} signal(s)`);
  }

  return { failedRuns, rearmedSignals, expiredSignals, cleanup: () => signalTimers.cleanup() };
}
