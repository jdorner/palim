/**
 * Tests for the DAG workflow Run Store module.
 *
 * Uses in-memory SQLite for isolation. Validates run records and key-by-key
 * patch application. The join barrier and status rules are tested with the
 * run kernel.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { createTestDb } from "@src/test/db";
import {
  applyPatch,
  create,
  type DagWorkflowRun,
  edgeId,
  get,
  getAll,
  initDagRunStore,
  updateStatus,
  updateStepStatus,
} from "./dagRunStore";

beforeEach(() => {
  const db = createTestDb();
  initDagRunStore(db);
});

/** Creates a minimal DAG run for testing. */
function makeRun(overrides: Partial<Omit<DagWorkflowRun, "createdAt" | "updatedAt">> = {}) {
  return create({
    id: crypto.randomUUID(),
    workflowName: "test-wf",
    status: "running",
    edgeStates: {},
    stepStatuses: {},
    stepResults: {},
    triggerPayload: null,
    failureReason: null,
    ...overrides,
  });
}

describe("dagRunStore", () => {
  describe("create and get", () => {
    test("creates and retrieves a run", () => {
      const run = makeRun({
        edgeStates: { "a:b": "pending", "b:c": "pending" },
        stepStatuses: { a: "pending", b: "pending", c: "pending" },
      });

      const retrieved = get(run.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.workflowName).toBe("test-wf");
      expect(retrieved!.edgeStates).toEqual({ "a:b": "pending", "b:c": "pending" });
      expect(retrieved!.stepStatuses).toEqual({ a: "pending", b: "pending", c: "pending" });
    });

    test("returns null for non-existent run", () => {
      expect(get("nonexistent")).toBeNull();
    });

    test("persists trigger payload", () => {
      const run = makeRun({ triggerPayload: { event: "test", data: [1, 2, 3] } });
      const retrieved = get(run.id)!;
      expect(retrieved.triggerPayload).toEqual({ event: "test", data: [1, 2, 3] });
    });
  });

  describe("applyPatch", () => {
    test("writes step statuses, edge states and results key by key", () => {
      const run = makeRun({
        stepStatuses: { a: "running", b: "pending" },
        edgeStates: { "a:b": "pending", "x:y": "pending" },
        stepResults: { keep: "old" },
      });
      applyPatch(run.id, {
        stepStatuses: { a: "completed" },
        edgeStates: { "a:b": "satisfied" },
        stepResults: { a: { count: 5 } },
      });
      const after = get(run.id)!;
      expect(after.stepStatuses).toEqual({ a: "completed", b: "pending" });
      expect(after.edgeStates).toEqual({ "a:b": "satisfied", "x:y": "pending" });
      expect(after.stepResults).toEqual({ keep: "old", a: { count: 5 } });
      expect(after.status).toBe("running");
    });

    test("sets the run status with its failure reason", () => {
      const run = makeRun();
      applyPatch(run.id, {
        status: "failed",
        failureReason: "boom",
        stepStatuses: {},
        edgeStates: {},
        stepResults: {},
      });
      expect(get(run.id)!).toMatchObject({ status: "failed", failureReason: "boom" });
    });

    test("writes more keys than one json_set batch holds", () => {
      const slugs = Array.from({ length: 150 }, (_, i) => `s${i}`);
      const run = makeRun({ stepStatuses: Object.fromEntries(slugs.map((s) => [s, "pending"])) });
      applyPatch(run.id, {
        stepStatuses: Object.fromEntries(slugs.map((s) => [s, "dead"])),
        edgeStates: {},
        stepResults: {},
      });
      expect(Object.values(get(run.id)!.stepStatuses).every((st) => st === "dead")).toBe(true);
    });

    test("stores an undefined result as null", () => {
      const run = makeRun();
      applyPatch(run.id, { stepStatuses: {}, edgeStates: {}, stepResults: { a: undefined } });
      expect(get(run.id)!.stepResults.a).toBeNull();
    });
  });

  describe("updateStepStatus", () => {
    test("transitions step from pending to running", () => {
      const run = makeRun({ stepStatuses: { a: "pending" } });
      updateStepStatus(run.id, "a", "running");
      const retrieved = get(run.id)!;
      expect(retrieved.stepStatuses.a).toBe("running");
    });

    test("transitions step to completed", () => {
      const run = makeRun({ stepStatuses: { a: "running" } });
      updateStepStatus(run.id, "a", "completed");
      const retrieved = get(run.id)!;
      expect(retrieved.stepStatuses.a).toBe("completed");
    });

    test("transitions step to dead", () => {
      const run = makeRun({ stepStatuses: { a: "pending" } });
      updateStepStatus(run.id, "a", "dead");
      const retrieved = get(run.id)!;
      expect(retrieved.stepStatuses.a).toBe("dead");
    });

    test("round-trips a waiting-signal step status", () => {
      const run = makeRun({ stepStatuses: { a: "running" } });
      updateStepStatus(run.id, "a", "waiting-signal");
      const retrieved = get(run.id)!;
      expect(retrieved.stepStatuses.a).toBe("waiting-signal");
    });
  });

  describe("updateStatus", () => {
    test("marks run as completed", () => {
      const run = makeRun();
      updateStatus(run.id, "completed");
      const retrieved = get(run.id)!;
      expect(retrieved.status).toBe("completed");
    });

    test("marks run as failed with reason", () => {
      const run = makeRun();
      updateStatus(run.id, "failed", "step X blew up");
      const retrieved = get(run.id)!;
      expect(retrieved.status).toBe("failed");
      expect(retrieved.failureReason).toBe("step X blew up");
    });
  });

  describe("edgeId helper", () => {
    test("creates ID without branch", () => {
      expect(edgeId("a", "b")).toBe("a:b");
    });

    test("creates ID with branch", () => {
      expect(edgeId("decide", "path-a", "then")).toBe("decide:path-a:then");
    });
  });

  describe("getAll", () => {
    test("returns an empty array when no runs exist", () => {
      expect(getAll()).toEqual([]);
    });

    test("returns runs across multiple workflow names", () => {
      makeRun({ workflowName: "wf-a", status: "running" });
      makeRun({ workflowName: "wf-b", status: "completed" });
      makeRun({ workflowName: "wf-b", status: "failed" });

      const all = getAll();
      expect(all).toHaveLength(3);

      const names = all.map((r) => r.workflowName).sort();
      expect(names).toEqual(["wf-a", "wf-b", "wf-b"]);

      const statuses = all.map((r) => r.status).sort();
      expect(statuses).toEqual(["completed", "failed", "running"]);
    });
  });
});
