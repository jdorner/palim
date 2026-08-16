/**
 * Tests for the workflow Run Store module.
 *
 * Uses in-memory SQLite for isolation. Validates CRUD operations,
 * query methods, JSON round-trip correctness, and the last-write-wins
 * property for step results.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import fc from "fast-check";
import {
  create,
  get,
  getByStatus,
  getByWorkflowName,
  initRunStore,
  updateStatus,
  updateStepIndex,
  updateStepResult,
} from "./runStore";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const MIGRATION_SQL = `
CREATE TABLE \`workflow_runs\` (
  \`id\` text PRIMARY KEY NOT NULL,
  \`workflow_name\` text NOT NULL,
  \`status\` text NOT NULL DEFAULT 'running',
  \`step_results\` text NOT NULL DEFAULT '{}',
  \`trigger_payload\` text,
  \`current_step_index\` integer NOT NULL DEFAULT 0,
  \`full_step_order\` text NOT NULL,
  \`failure_reason\` text,
  \`created_at\` integer NOT NULL,
  \`updated_at\` integer NOT NULL
);
CREATE INDEX \`idx_workflow_runs_name\` ON \`workflow_runs\` (\`workflow_name\`);
CREATE INDEX \`idx_workflow_runs_status\` ON \`workflow_runs\` (\`status\`);
`;

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run(MIGRATION_SQL);
  const db = drizzle(sqlite);
  initRunStore(db);
  return db;
}

/** Helper: creates a minimal run record for testing. */
function createMinimalRun(overrides: Partial<Parameters<typeof create>[0]> = {}) {
  return create({
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

describe("Run Store", () => {
  beforeEach(() => {
    createTestDb();
  });

  describe("create", () => {
    test("inserts a record and returns it with timestamps", () => {
      const before = Date.now();
      const run = createMinimalRun();
      const after = Date.now();

      expect(run.id).toBe("run-1");
      expect(run.workflowName).toBe("test-workflow");
      expect(run.status).toBe("running");
      expect(run.stepResults).toEqual({});
      expect(run.triggerPayload).toBeNull();
      expect(run.currentStepIndex).toBe(0);
      expect(run.fullStepOrder).toEqual(["step-a", "step-b"]);
      expect(run.failureReason).toBeNull();
      expect(run.createdAt).toBeGreaterThanOrEqual(before);
      expect(run.createdAt).toBeLessThanOrEqual(after);
      expect(run.updatedAt).toBe(run.createdAt);
    });

    test("stores trigger payload as JSON", () => {
      const payload = { source: "webhook", data: { key: "value" } };
      createMinimalRun({ id: "run-payload", triggerPayload: payload });

      const retrieved = get("run-payload");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.triggerPayload).toEqual(payload);
    });

    test("stores step results as JSON", () => {
      const results = { "step-a": { output: "hello" }, "step-b": 42 };
      createMinimalRun({ id: "run-results", stepResults: results });

      const retrieved = get("run-results");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.stepResults).toEqual(results);
    });
  });

  describe("get", () => {
    test("returns the record when found", () => {
      createMinimalRun({ id: "lookup-1" });

      const result = get("lookup-1");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("lookup-1");
      expect(result!.workflowName).toBe("test-workflow");
    });

    test("returns null when not found", () => {
      const result = get("nonexistent");
      expect(result).toBeNull();
    });

    test("deserializes fullStepOrder correctly", () => {
      createMinimalRun({ id: "order-1", fullStepOrder: ["a", "b", "c", "d"] });

      const result = get("order-1");
      expect(result!.fullStepOrder).toEqual(["a", "b", "c", "d"]);
    });
  });

  describe("updateStatus", () => {
    test("updates status to completed", () => {
      createMinimalRun({ id: "status-1" });

      updateStatus("status-1", "completed");

      const result = get("status-1");
      expect(result!.status).toBe("completed");
      expect(result!.failureReason).toBeNull();
    });

    test("updates status to failed with reason", () => {
      createMinimalRun({ id: "status-2" });

      updateStatus("status-2", "failed", "Something broke");

      const result = get("status-2");
      expect(result!.status).toBe("failed");
      expect(result!.failureReason).toBe("Something broke");
    });

    test("updates status to waiting-signal", () => {
      createMinimalRun({ id: "status-3" });

      updateStatus("status-3", "waiting-signal");

      const result = get("status-3");
      expect(result!.status).toBe("waiting-signal");
    });

    test("clears failure reason when switching to non-failed status", () => {
      createMinimalRun({ id: "status-4" });
      updateStatus("status-4", "failed", "error");
      updateStatus("status-4", "running");

      const result = get("status-4");
      expect(result!.status).toBe("running");
      expect(result!.failureReason).toBeNull();
    });

    test("updates the updatedAt timestamp", () => {
      createMinimalRun({ id: "status-5" });
      const before = get("status-5")!.updatedAt;

      // Small delay to ensure time progresses
      updateStatus("status-5", "completed");

      const after = get("status-5")!.updatedAt;
      expect(after).toBeGreaterThanOrEqual(before);
    });
  });

  describe("updateStepResult", () => {
    test("adds a new step result to empty results", () => {
      createMinimalRun({ id: "result-1" });

      updateStepResult("result-1", "step-a", { output: "hello" });

      const result = get("result-1");
      expect(result!.stepResults).toEqual({ "step-a": { output: "hello" } });
    });

    test("adds a step result alongside existing results", () => {
      createMinimalRun({ id: "result-2", stepResults: { "step-a": "first" } });

      updateStepResult("result-2", "step-b", "second");

      const result = get("result-2");
      expect(result!.stepResults).toEqual({ "step-a": "first", "step-b": "second" });
    });

    test("overwrites an existing step result (last-write-wins)", () => {
      createMinimalRun({ id: "result-3" });

      updateStepResult("result-3", "step-a", "old-value");
      updateStepResult("result-3", "step-a", "new-value");

      const result = get("result-3");
      expect(result!.stepResults["step-a"]).toBe("new-value");
    });

    test("does nothing for a nonexistent run", () => {
      // Should not throw
      updateStepResult("nonexistent", "step-a", "value");
      expect(get("nonexistent")).toBeNull();
    });

    test("handles complex nested objects as results", () => {
      createMinimalRun({ id: "result-4" });
      const complex = {
        nested: { deeply: { value: [1, 2, 3] } },
        array: [{ key: "val" }],
        bool: true,
        num: 3.14,
      };

      updateStepResult("result-4", "step-a", complex);

      const result = get("result-4");
      expect(result!.stepResults["step-a"]).toEqual(complex);
    });
  });

  describe("updateStepIndex", () => {
    test("updates the current step index", () => {
      createMinimalRun({ id: "index-1" });

      updateStepIndex("index-1", 3);

      const result = get("index-1");
      expect(result!.currentStepIndex).toBe(3);
    });

    test("can set index to zero", () => {
      createMinimalRun({ id: "index-2", currentStepIndex: 5 });

      updateStepIndex("index-2", 0);

      const result = get("index-2");
      expect(result!.currentStepIndex).toBe(0);
    });

    test("updates the updatedAt timestamp", () => {
      createMinimalRun({ id: "index-3" });
      const before = get("index-3")!.updatedAt;

      updateStepIndex("index-3", 2);

      const after = get("index-3")!.updatedAt;
      expect(after).toBeGreaterThanOrEqual(before);
    });
  });

  describe("getByStatus", () => {
    test("returns all runs matching the status", () => {
      createMinimalRun({ id: "s-1", status: "running" });
      createMinimalRun({ id: "s-2", status: "running" });
      createMinimalRun({ id: "s-3", status: "completed" });

      const running = getByStatus("running");
      expect(running).toHaveLength(2);
      expect(running.map((r) => r.id).sort()).toEqual(["s-1", "s-2"]);
    });

    test("returns empty array when no runs match", () => {
      createMinimalRun({ id: "s-4", status: "running" });

      const waiting = getByStatus("waiting-signal");
      expect(waiting).toEqual([]);
    });

    test("returns waiting-signal runs for crash recovery", () => {
      createMinimalRun({ id: "s-5", status: "waiting-signal" });
      createMinimalRun({ id: "s-6", status: "waiting-signal" });
      createMinimalRun({ id: "s-7", status: "failed" });

      const waiting = getByStatus("waiting-signal");
      expect(waiting).toHaveLength(2);
    });
  });

  describe("getByWorkflowName", () => {
    test("returns all runs for a given workflow name", () => {
      createMinimalRun({ id: "w-1", workflowName: "daily-report" });
      createMinimalRun({ id: "w-2", workflowName: "daily-report" });
      createMinimalRun({ id: "w-3", workflowName: "backup-check" });

      const results = getByWorkflowName("daily-report");
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.id).sort()).toEqual(["w-1", "w-2"]);
    });

    test("returns empty array when no runs match the name", () => {
      createMinimalRun({ id: "w-4", workflowName: "some-workflow" });

      const results = getByWorkflowName("nonexistent-workflow");
      expect(results).toEqual([]);
    });
  });

  describe("JSON round-trip", () => {
    test("preserves nested objects in stepResults", () => {
      const complex = {
        "extract-data": {
          items: [{ name: "Widget", price: 9.99 }],
          metadata: { pages: 3, format: "pdf" },
        },
      };
      createMinimalRun({ id: "json-1", stepResults: complex });

      const result = get("json-1");
      expect(result!.stepResults).toEqual(complex);
    });

    test("preserves arrays in triggerPayload", () => {
      const payload = { files: ["a.pdf", "b.pdf"], count: 2 };
      createMinimalRun({ id: "json-2", triggerPayload: payload });

      const result = get("json-2");
      expect(result!.triggerPayload).toEqual(payload);
    });

    test("preserves null trigger payload", () => {
      createMinimalRun({ id: "json-3", triggerPayload: null });

      const result = get("json-3");
      expect(result!.triggerPayload).toBeNull();
    });

    test("preserves boolean and numeric values in step results", () => {
      createMinimalRun({ id: "json-4" });
      updateStepResult("json-4", "bool-step", true);
      updateStepResult("json-4", "num-step", 0);
      updateStepResult("json-4", "float-step", -3.14);

      const result = get("json-4");
      expect(result!.stepResults["bool-step"]).toBe(true);
      expect(result!.stepResults["num-step"]).toBe(0);
      expect(result!.stepResults["float-step"]).toBe(-3.14);
    });

    test("preserves null values in step results", () => {
      createMinimalRun({ id: "json-5" });
      updateStepResult("json-5", "null-step", null);

      const result = get("json-5");
      expect(result!.stepResults["null-step"]).toBeNull();
    });

    test("preserves empty string trigger payload as string", () => {
      createMinimalRun({ id: "json-6", triggerPayload: "" });

      const result = get("json-6");
      expect(result!.triggerPayload).toBe("");
    });
  });

  describe("property tests", () => {
    /**
     * **Validates: Requirements 2.1, 2.5, 2.7, 14.3**
     *
     * Property 15: Last-write-wins
     *
     * For any step slug and sequence of result writes, reading the result
     * for that slug from the Run Store SHALL always return the value from
     * the most recent write, regardless of how many prior writes occurred.
     */
    test("Property 15: Last-write-wins - sequential writes to same slug, read returns most recent", () => {
      /** Arbitrary for a valid step slug. */
      const slugArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/).filter((s) => s.length >= 1);

      /** Arbitrary for a JSON-serializable value (step result). */
      const resultValueArb = fc.oneof(
        fc.string(),
        fc.integer(),
        fc.double({ noNaN: true, noDefaultInfinity: true }),
        fc.boolean(),
        fc.constant(null),
        fc.dictionary(fc.string(), fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null))),
        fc.array(fc.oneof(fc.string(), fc.integer(), fc.boolean())),
      );

      fc.assert(
        fc.property(slugArb, fc.array(resultValueArb, { minLength: 2, maxLength: 10 }), (slug, values) => {
          // Fresh DB for each property iteration
          createTestDb();

          create({
            id: `prop-run-${slug}`,
            workflowName: "prop-test",
            status: "running",
            stepResults: {},
            triggerPayload: null,
            currentStepIndex: 0,
            fullStepOrder: [slug],
            failureReason: null,
          });

          // Write all values sequentially
          for (const value of values) {
            updateStepResult(`prop-run-${slug}`, slug, value);
          }

          // Read should return the last value written
          const run = get(`prop-run-${slug}`);
          expect(run).not.toBeNull();

          const lastValue = values[values.length - 1];
          expect(run!.stepResults[slug]).toEqual(lastValue);
        }),
        { numRuns: 100 },
      );
    });
  });
});
