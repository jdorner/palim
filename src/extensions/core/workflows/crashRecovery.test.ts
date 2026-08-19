/**
 * Tests for the workflow crash recovery module.
 *
 * Uses in-memory SQLite for isolation. Validates that:
 * - Runs in "running" status are marked as failed on recovery
 * - Runs in "waiting-signal" status have their signal timeouts re-armed or expired
 * - Broadcasts are emitted for failed runs
 * - Cleanup function clears armed timers
 *
 * **Validates: Requirements 2.3, 2.4**
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { WorkflowWebSocketEvent } from "@shared/workflows";
import { createWorkflowTestDb } from "@src/test/db";
import { recoverFromCrash } from "./crashRecovery";
import { create as createRun, get as getRun, initRunStore } from "./runStore";
import { create as createSignal, getAllWaiting, initSignalStore } from "./signalStore";

/** Fake logger that captures log calls. */
function createFakeLogger() {
  const logs: { level: string; args: unknown[] }[] = [];
  return {
    logger: {
      info: (...args: unknown[]) => logs.push({ level: "info", args }),
      warn: (...args: unknown[]) => logs.push({ level: "warn", args }),
      error: (...args: unknown[]) => logs.push({ level: "error", args }),
      debug: (...args: unknown[]) => logs.push({ level: "debug", args }),
    },
    logs,
  };
}

/** Captures broadcast events. */
function createFakeBroadcast() {
  const events: WorkflowWebSocketEvent[] = [];
  return {
    broadcast: (event: WorkflowWebSocketEvent) => events.push(event),
    events,
  };
}

/** Helper: creates a minimal run record. */
function makeRun(overrides: Partial<Parameters<typeof createRun>[0]> = {}) {
  return createRun({
    id: overrides.id ?? "run-1",
    workflowName: overrides.workflowName ?? "test-workflow",
    status: overrides.status ?? "running",
    stepResults: overrides.stepResults ?? {},
    triggerPayload: overrides.triggerPayload ?? null,
    currentStepIndex: overrides.currentStepIndex ?? 0,
    fullStepOrder: overrides.fullStepOrder ?? ["step-a", "step-b"],
    failureReason: overrides.failureReason ?? null,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Crash Recovery", () => {
  let cleanup: (() => void) | null = null;

  beforeEach(() => {
    // Clear any pending timers from previous test
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
    createWorkflowTestDb();
  });

  describe("running runs", () => {
    test("marks running runs as failed with unexpected termination reason", () => {
      makeRun({ id: "run-1", status: "running" });
      makeRun({ id: "run-2", status: "running" });

      const { logger } = createFakeLogger();
      const { broadcast } = createFakeBroadcast();

      const result = recoverFromCrash({ log: logger as never, broadcast });
      cleanup = result.cleanup;

      const run1 = getRun("run-1");
      const run2 = getRun("run-2");

      expect(run1!.status).toBe("failed");
      expect(run1!.failureReason).toBe("Process terminated unexpectedly");
      expect(run2!.status).toBe("failed");
      expect(run2!.failureReason).toBe("Process terminated unexpectedly");
      expect(result.failedRuns).toBe(2);
    });

    test("broadcasts workflow_failed for each running run", () => {
      makeRun({ id: "run-1", status: "running" });
      makeRun({ id: "run-2", status: "running" });

      const { logger } = createFakeLogger();
      const { broadcast, events } = createFakeBroadcast();

      const result = recoverFromCrash({ log: logger as never, broadcast });
      cleanup = result.cleanup;

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({
        type: "workflow_failed",
        workflowRunId: "run-1",
        failedStep: "unknown",
        error: "Process terminated unexpectedly",
      });
      expect(events[1]).toEqual({
        type: "workflow_failed",
        workflowRunId: "run-2",
        failedStep: "unknown",
        error: "Process terminated unexpectedly",
      });
    });

    test("does not affect completed or failed runs", () => {
      makeRun({ id: "run-completed", status: "completed" });
      makeRun({ id: "run-failed", status: "failed", failureReason: "previous error" });

      const { logger } = createFakeLogger();
      const { broadcast } = createFakeBroadcast();

      const result = recoverFromCrash({ log: logger as never, broadcast });
      cleanup = result.cleanup;

      expect(result.failedRuns).toBe(0);
      expect(getRun("run-completed")!.status).toBe("completed");
      expect(getRun("run-failed")!.status).toBe("failed");
      expect(getRun("run-failed")!.failureReason).toBe("previous error");
    });
  });

  describe("waiting-signal runs with expired timeouts", () => {
    test("fails signals whose timeout has already expired", () => {
      makeRun({ id: "run-expired", status: "waiting-signal" });

      // Create signal with 1ms timeout - guaranteed to be expired by the time recovery runs
      createSignal({
        runId: "run-expired",
        stepSlug: "wait-step",
        event: "approval.granted",
        inputSchema: null,
        timeoutMs: 1,
      });

      // Wait a tiny bit to ensure the 1ms has elapsed
      const start = Date.now();
      while (Date.now() - start < 5) {
        // busy wait 5ms to ensure 1ms timeout has passed
      }

      const { logger } = createFakeLogger();
      const { broadcast } = createFakeBroadcast();

      const result = recoverFromCrash({ log: logger as never, broadcast });
      cleanup = result.cleanup;

      expect(result.expiredSignals).toBe(1);
      expect(getRun("run-expired")!.status).toBe("failed");
      expect(getRun("run-expired")!.failureReason).toContain("timed out during process downtime");
      expect(getAllWaiting()).toHaveLength(0);
    });

    test("broadcasts workflow_failed for expired signals", () => {
      makeRun({ id: "run-expired", status: "waiting-signal" });

      createSignal({
        runId: "run-expired",
        stepSlug: "wait-step",
        event: "data.ready",
        inputSchema: null,
        timeoutMs: 1,
      });

      // Wait for timeout to expire
      const start = Date.now();
      while (Date.now() - start < 5) {
        // busy wait
      }

      const { logger } = createFakeLogger();
      const { broadcast, events } = createFakeBroadcast();

      const result = recoverFromCrash({ log: logger as never, broadcast });
      cleanup = result.cleanup;

      const failedEvents = events.filter((e) => e.type === "workflow_failed");
      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0]).toEqual({
        type: "workflow_failed",
        workflowRunId: "run-expired",
        failedStep: "wait-step",
        error: 'Signal "data.ready" timed out during process downtime',
      });
    });
  });

  describe("waiting-signal runs with remaining timeout", () => {
    test("re-arms timeout timers for signals with time remaining", () => {
      makeRun({ id: "run-wait", status: "waiting-signal" });

      // Create signal with a long timeout (definitely not expired)
      createSignal({
        runId: "run-wait",
        stepSlug: "wait-step",
        event: "approval.granted",
        inputSchema: null,
        timeoutMs: 600000, // 10 minutes
      });

      const { logger } = createFakeLogger();
      const { broadcast } = createFakeBroadcast();

      const result = recoverFromCrash({ log: logger as never, broadcast });
      cleanup = result.cleanup;

      expect(result.rearmedSignals).toBe(1);
      expect(result.expiredSignals).toBe(0);
      // Run should still be in waiting-signal status
      expect(getRun("run-wait")!.status).toBe("waiting-signal");
    });

    test("cleanup function clears armed timers", () => {
      makeRun({ id: "run-wait", status: "waiting-signal" });

      createSignal({
        runId: "run-wait",
        stepSlug: "wait-step",
        event: "approval.granted",
        inputSchema: null,
        timeoutMs: 600000,
      });

      const { logger } = createFakeLogger();
      const { broadcast } = createFakeBroadcast();

      const result = recoverFromCrash({ log: logger as never, broadcast });

      // Cleanup should not throw
      result.cleanup();
      // Run remains waiting-signal (timer was cleared before firing)
      expect(getRun("run-wait")!.status).toBe("waiting-signal");
    });

    test("timer fires and fails the run after remaining time elapses", async () => {
      makeRun({ id: "run-timeout", status: "waiting-signal" });

      // Create signal with a very short timeout (50ms) - will fire quickly in test
      createSignal({
        runId: "run-timeout",
        stepSlug: "wait-step",
        event: "approval.granted",
        inputSchema: null,
        timeoutMs: 50,
      });

      const { logger } = createFakeLogger();
      const { broadcast, events } = createFakeBroadcast();

      const result = recoverFromCrash({ log: logger as never, broadcast });
      cleanup = result.cleanup;

      // Timer should have been re-armed with ~50ms remaining
      expect(result.rearmedSignals).toBe(1);

      // Wait for the timer to fire
      await new Promise((resolve) => setTimeout(resolve, 100));

      // After timer fires, run should be failed
      expect(getRun("run-timeout")!.status).toBe("failed");
      expect(getRun("run-timeout")!.failureReason).toContain("timed out while waiting");
      expect(getAllWaiting()).toHaveLength(0);

      const failedEvents = events.filter((e) => e.type === "workflow_failed");
      expect(failedEvents).toHaveLength(1);
    });
  });

  describe("signals without timeout", () => {
    test("does not re-arm or fail signals without a timeout configured", () => {
      makeRun({ id: "run-no-timeout", status: "waiting-signal" });

      createSignal({
        runId: "run-no-timeout",
        stepSlug: "wait-step",
        event: "manual.approval",
        inputSchema: null,
        timeoutMs: null,
      });

      const { logger } = createFakeLogger();
      const { broadcast } = createFakeBroadcast();

      const result = recoverFromCrash({ log: logger as never, broadcast });
      cleanup = result.cleanup;

      expect(result.rearmedSignals).toBe(0);
      expect(result.expiredSignals).toBe(0);
      // Run stays waiting
      expect(getRun("run-no-timeout")!.status).toBe("waiting-signal");
      // Signal stays waiting
      expect(getAllWaiting()).toHaveLength(1);
    });
  });

  describe("no recovery needed", () => {
    test("returns zeros when no runs need recovery", () => {
      makeRun({ id: "run-completed", status: "completed" });
      makeRun({ id: "run-failed", status: "failed", failureReason: "old error" });

      const { logger } = createFakeLogger();
      const { broadcast, events } = createFakeBroadcast();

      const result = recoverFromCrash({ log: logger as never, broadcast });
      cleanup = result.cleanup;

      expect(result.failedRuns).toBe(0);
      expect(result.rearmedSignals).toBe(0);
      expect(result.expiredSignals).toBe(0);
      expect(events).toHaveLength(0);
    });

    test("returns zeros when database is empty", () => {
      const { logger } = createFakeLogger();
      const { broadcast, events } = createFakeBroadcast();

      const result = recoverFromCrash({ log: logger as never, broadcast });
      cleanup = result.cleanup;

      expect(result.failedRuns).toBe(0);
      expect(result.rearmedSignals).toBe(0);
      expect(result.expiredSignals).toBe(0);
      expect(events).toHaveLength(0);
    });
  });

  describe("mixed scenarios", () => {
    test("handles both running and waiting-signal runs together", () => {
      makeRun({ id: "run-running", status: "running" });
      makeRun({ id: "run-waiting", status: "waiting-signal" });

      createSignal({
        runId: "run-waiting",
        stepSlug: "wait-step",
        event: "data.ready",
        inputSchema: null,
        timeoutMs: 600000,
      });

      const { logger } = createFakeLogger();
      const { broadcast, events } = createFakeBroadcast();

      const result = recoverFromCrash({ log: logger as never, broadcast });
      cleanup = result.cleanup;

      expect(result.failedRuns).toBe(1);
      expect(result.rearmedSignals).toBe(1);

      expect(getRun("run-running")!.status).toBe("failed");
      expect(getRun("run-waiting")!.status).toBe("waiting-signal");

      // Only the running run should have a workflow_failed broadcast
      const failedEvents = events.filter((e) => e.type === "workflow_failed");
      expect(failedEvents).toHaveLength(1);
      expect((failedEvents[0] as { workflowRunId: string }).workflowRunId).toBe("run-running");
    });

    test("handles waiting-signal run without matching signals in signal store", () => {
      // A waiting-signal run exists but no signal records (edge case - data inconsistency)
      makeRun({ id: "run-orphan", status: "waiting-signal" });

      const { logger } = createFakeLogger();
      const { broadcast } = createFakeBroadcast();

      const result = recoverFromCrash({ log: logger as never, broadcast });
      cleanup = result.cleanup;

      // No signals to re-arm or expire
      expect(result.rearmedSignals).toBe(0);
      expect(result.expiredSignals).toBe(0);
      // Run stays in waiting-signal (no action taken without a signal record)
      expect(getRun("run-orphan")!.status).toBe("waiting-signal");
    });
  });
});
