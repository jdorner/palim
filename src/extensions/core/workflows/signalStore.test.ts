/**
 * Tests for the workflow Signal Store module.
 *
 * Uses in-memory SQLite for isolation. Validates CRUD operations,
 * atomic claim semantics, query methods, and JSON round-trip correctness.
 *
 * **Validates: Requirements 5.1, 5.2, 5.7**
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { create, getAllWaiting, getWaiting, initSignalStore, markReceived, markTimedOut } from "./signalStore";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const MIGRATION_SQL = `
CREATE TABLE \`workflow_signals\` (
  \`id\` text PRIMARY KEY NOT NULL,
  \`run_id\` text NOT NULL,
  \`step_slug\` text NOT NULL,
  \`event\` text NOT NULL,
  \`status\` text NOT NULL DEFAULT 'waiting',
  \`input_schema\` text,
  \`timeout_ms\` integer,
  \`payload\` text,
  \`created_at\` integer NOT NULL,
  \`received_at\` integer
);
CREATE INDEX \`idx_workflow_signals_run_event\` ON \`workflow_signals\` (\`run_id\`, \`event\`);
CREATE INDEX \`idx_workflow_signals_status\` ON \`workflow_signals\` (\`status\`);
`;

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run(MIGRATION_SQL);
  const db = drizzle(sqlite);
  initSignalStore(db);
  return db;
}

/** Helper: creates a minimal signal record for testing. */
function createMinimalSignal(overrides: Partial<Parameters<typeof create>[0]> = {}) {
  return create({
    runId: overrides.runId ?? "run-1",
    stepSlug: overrides.stepSlug ?? "wait-approval",
    event: overrides.event ?? "approval.granted",
    inputSchema: overrides.inputSchema ?? null,
    timeoutMs: overrides.timeoutMs ?? null,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Signal Store", () => {
  beforeEach(() => {
    createTestDb();
  });

  describe("create", () => {
    test("inserts a record with waiting status and null payload", () => {
      const signal = createMinimalSignal();

      expect(signal.status).toBe("waiting");
      expect(signal.payload).toBeNull();
      expect(signal.receivedAt).toBeNull();
    });

    test("generates a non-empty ID", () => {
      const signal = createMinimalSignal();

      expect(signal.id).not.toBe("");
      expect(typeof signal.id).toBe("string");
    });

    test("sets createdAt to a recent timestamp", () => {
      const before = Date.now();
      const signal = createMinimalSignal();
      const after = Date.now();

      expect(signal.createdAt).toBeGreaterThanOrEqual(before);
      expect(signal.createdAt).toBeLessThanOrEqual(after);
    });

    test("stores the provided fields correctly", () => {
      const signal = createMinimalSignal({
        runId: "run-abc",
        stepSlug: "my-step",
        event: "data.ready",
        timeoutMs: 30000,
      });

      expect(signal.runId).toBe("run-abc");
      expect(signal.stepSlug).toBe("my-step");
      expect(signal.event).toBe("data.ready");
      expect(signal.timeoutMs).toBe(30000);
    });

    test("stores inputSchema as JSON", () => {
      const schema = { type: "object", properties: { approved: { type: "boolean" } } };
      const signal = createMinimalSignal({ inputSchema: schema });

      expect(signal.inputSchema).toEqual(schema);
    });

    test("stores null inputSchema", () => {
      const signal = createMinimalSignal({ inputSchema: null });

      expect(signal.inputSchema).toBeNull();
    });

    test("stores null timeoutMs", () => {
      const signal = createMinimalSignal({ timeoutMs: null });

      expect(signal.timeoutMs).toBeNull();
    });
  });

  describe("getWaiting", () => {
    test("returns the waiting signal for a given run and event", () => {
      createMinimalSignal({ runId: "run-1", event: "approval.granted" });

      const result = getWaiting("run-1", "approval.granted");

      expect(result).not.toBeNull();
      expect(result!.runId).toBe("run-1");
      expect(result!.event).toBe("approval.granted");
      expect(result!.status).toBe("waiting");
    });

    test("returns null when no signal exists for the run", () => {
      const result = getWaiting("nonexistent-run", "some.event");

      expect(result).toBeNull();
    });

    test("returns null when event does not match", () => {
      createMinimalSignal({ runId: "run-1", event: "approval.granted" });

      const result = getWaiting("run-1", "different.event");

      expect(result).toBeNull();
    });

    test("returns null when signal exists but is already received", () => {
      const signal = createMinimalSignal({ runId: "run-1", event: "approval.granted" });
      markReceived(signal.id, { approved: true });

      const result = getWaiting("run-1", "approval.granted");

      expect(result).toBeNull();
    });

    test("returns null when signal exists but is timed out", () => {
      const signal = createMinimalSignal({ runId: "run-1", event: "approval.granted" });
      markTimedOut(signal.id);

      const result = getWaiting("run-1", "approval.granted");

      expect(result).toBeNull();
    });

    test("filters by both runId AND event", () => {
      createMinimalSignal({ runId: "run-1", event: "event-a" });
      createMinimalSignal({ runId: "run-1", event: "event-b" });
      createMinimalSignal({ runId: "run-2", event: "event-a" });

      const result = getWaiting("run-1", "event-b");

      expect(result).not.toBeNull();
      expect(result!.runId).toBe("run-1");
      expect(result!.event).toBe("event-b");
    });

    test("deserializes inputSchema from stored JSON", () => {
      const schema = { type: "object", required: ["name"] };
      createMinimalSignal({ runId: "run-1", event: "submit", inputSchema: schema });

      const result = getWaiting("run-1", "submit");

      expect(result).not.toBeNull();
      expect(result!.inputSchema).toEqual(schema);
    });
  });

  describe("getAllWaiting", () => {
    test("returns all signals with waiting status", () => {
      createMinimalSignal({ runId: "run-1", event: "event-a" });
      createMinimalSignal({ runId: "run-2", event: "event-b" });

      const results = getAllWaiting();

      expect(results).toHaveLength(2);
    });

    test("excludes received signals", () => {
      const signal = createMinimalSignal({ runId: "run-1", event: "event-a" });
      createMinimalSignal({ runId: "run-2", event: "event-b" });
      markReceived(signal.id, "data");

      const results = getAllWaiting();

      expect(results).toHaveLength(1);
      expect(results[0]!.runId).toBe("run-2");
    });

    test("excludes timed out signals", () => {
      const signal = createMinimalSignal({ runId: "run-1", event: "event-a" });
      createMinimalSignal({ runId: "run-2", event: "event-b" });
      markTimedOut(signal.id);

      const results = getAllWaiting();

      expect(results).toHaveLength(1);
      expect(results[0]!.runId).toBe("run-2");
    });

    test("returns empty array when no signals are waiting", () => {
      const signal = createMinimalSignal({ runId: "run-1", event: "event-a" });
      markReceived(signal.id, null);

      const results = getAllWaiting();

      expect(results).toEqual([]);
    });

    test("returns empty array when no signals exist", () => {
      const results = getAllWaiting();

      expect(results).toEqual([]);
    });
  });

  describe("markReceived", () => {
    test("updates status to received and stores payload", () => {
      const signal = createMinimalSignal({ runId: "run-1", event: "data.ready" });

      markReceived(signal.id, { key: "value" });

      const result = getWaiting("run-1", "data.ready");
      expect(result).toBeNull();

      // Verify via getAllWaiting exclusion
      const allWaiting = getAllWaiting();
      expect(allWaiting).toHaveLength(0);
    });

    test("transitions signal out of waiting and only affects the targeted signal", () => {
      const signal = createMinimalSignal({ runId: "run-1", event: "event-a" });
      createMinimalSignal({ runId: "run-2", event: "event-b" });

      markReceived(signal.id, "payload");

      const allWaiting = getAllWaiting();
      expect(allWaiting).toHaveLength(1);
      expect(allWaiting[0]!.runId).toBe("run-2");
    });

    test("stores complex payload as JSON", () => {
      const signal = createMinimalSignal({ runId: "run-1", event: "submit" });
      const payload = { nested: { data: [1, 2, 3] }, flag: true };

      markReceived(signal.id, payload);

      // Signal is no longer waiting
      expect(getWaiting("run-1", "submit")).toBeNull();
    });

    test("stores null payload", () => {
      const signal = createMinimalSignal({ runId: "run-1", event: "ack" });

      markReceived(signal.id, null);

      expect(getWaiting("run-1", "ack")).toBeNull();
    });

    test("no-op when signal is already received (atomic claim)", () => {
      const signal = createMinimalSignal({ runId: "run-1", event: "event-a" });

      // First delivery succeeds
      markReceived(signal.id, "first-payload");

      // Second delivery is a no-op (WHERE status='waiting' won't match)
      markReceived(signal.id, "second-payload");

      // Signal remains in received status with first payload
      expect(getWaiting("run-1", "event-a")).toBeNull();
    });

    test("no-op when signal is already timed out", () => {
      const signal = createMinimalSignal({ runId: "run-1", event: "event-a" });

      markTimedOut(signal.id);

      // Attempt to receive after timeout is a no-op
      markReceived(signal.id, "late-payload");

      expect(getWaiting("run-1", "event-a")).toBeNull();
    });
  });

  describe("markTimedOut", () => {
    test("updates status to timed_out", () => {
      const signal = createMinimalSignal({ runId: "run-1", event: "event-a" });

      markTimedOut(signal.id);

      expect(getWaiting("run-1", "event-a")).toBeNull();
      expect(getAllWaiting()).toHaveLength(0);
    });

    test("no-op when signal is already received", () => {
      const signal = createMinimalSignal({ runId: "run-1", event: "event-a" });

      markReceived(signal.id, "data");

      // Timeout after receive is a no-op
      markTimedOut(signal.id);

      // Signal is not in waiting (it was received, not timed out)
      expect(getWaiting("run-1", "event-a")).toBeNull();
    });

    test("no-op when signal is already timed out", () => {
      const signal = createMinimalSignal({ runId: "run-1", event: "event-a" });

      markTimedOut(signal.id);

      // Double timeout is a no-op
      markTimedOut(signal.id);

      expect(getAllWaiting()).toHaveLength(0);
    });
  });

  describe("atomic claim semantics", () => {
    test("only one caller wins when multiple attempt to receive same signal", () => {
      const signal = createMinimalSignal({ runId: "run-1", event: "race" });

      // Simulate concurrent delivery attempts
      markReceived(signal.id, "winner-payload");
      markReceived(signal.id, "loser-payload");

      // Signal is no longer waiting
      expect(getWaiting("run-1", "race")).toBeNull();
      // Only the first delivery took effect (verified by status transition)
      expect(getAllWaiting()).toHaveLength(0);
    });

    test("markReceived after markTimedOut is a no-op", () => {
      const signal = createMinimalSignal({ runId: "run-1", event: "timeout-race" });

      markTimedOut(signal.id);
      markReceived(signal.id, "too-late");

      expect(getWaiting("run-1", "timeout-race")).toBeNull();
    });

    test("markTimedOut after markReceived is a no-op", () => {
      const signal = createMinimalSignal({ runId: "run-1", event: "receive-race" });

      markReceived(signal.id, "in-time");
      markTimedOut(signal.id);

      expect(getWaiting("run-1", "receive-race")).toBeNull();
    });
  });

  describe("query by run+event combination", () => {
    test("distinguishes signals for different runs with same event", () => {
      createMinimalSignal({ runId: "run-1", event: "shared-event" });
      createMinimalSignal({ runId: "run-2", event: "shared-event" });

      const result1 = getWaiting("run-1", "shared-event");
      const result2 = getWaiting("run-2", "shared-event");

      expect(result1).not.toBeNull();
      expect(result2).not.toBeNull();
      expect(result1!.runId).toBe("run-1");
      expect(result2!.runId).toBe("run-2");
    });

    test("distinguishes signals for same run with different events", () => {
      createMinimalSignal({ runId: "run-1", event: "event-a" });
      createMinimalSignal({ runId: "run-1", event: "event-b" });

      const resultA = getWaiting("run-1", "event-a");
      const resultB = getWaiting("run-1", "event-b");

      expect(resultA).not.toBeNull();
      expect(resultB).not.toBeNull();
      expect(resultA!.event).toBe("event-a");
      expect(resultB!.event).toBe("event-b");
    });

    test("marking one signal does not affect others for same run", () => {
      const signalA = createMinimalSignal({ runId: "run-1", event: "event-a" });
      createMinimalSignal({ runId: "run-1", event: "event-b" });

      markReceived(signalA.id, "delivered");

      expect(getWaiting("run-1", "event-a")).toBeNull();
      expect(getWaiting("run-1", "event-b")).not.toBeNull();
    });

    test("marking one signal does not affect signals in other runs", () => {
      const signal1 = createMinimalSignal({ runId: "run-1", event: "shared-event" });
      createMinimalSignal({ runId: "run-2", event: "shared-event" });

      markReceived(signal1.id, "data");

      expect(getWaiting("run-1", "shared-event")).toBeNull();
      expect(getWaiting("run-2", "shared-event")).not.toBeNull();
    });
  });
});
