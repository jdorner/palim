/**
 * Tests for the DAG workflow Run Store module.
 *
 * Uses in-memory SQLite for isolation. Validates edge state transitions,
 * step status tracking, and ready-step detection with mixed satisfied/dead edges.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { createTestDb } from "@src/test/db";
import {
  create,
  type DagWorkflowRun,
  edgeId,
  get,
  getReadySteps,
  initDagRunStore,
  isActiveRunStatus,
  updateEdgeState,
  updateEdgeStates,
  updateStatus,
  updateStepResult,
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

  describe("updateEdgeState", () => {
    test("transitions edge from pending to satisfied", () => {
      const run = makeRun({ edgeStates: { "a:b": "pending" } });
      updateEdgeState(run.id, "a:b", "satisfied");
      const retrieved = get(run.id)!;
      expect(retrieved.edgeStates["a:b"]).toBe("satisfied");
    });

    test("transitions edge to dead", () => {
      const run = makeRun({ edgeStates: { "decide:x:then": "pending" } });
      updateEdgeState(run.id, "decide:x:then", "dead");
      const retrieved = get(run.id)!;
      expect(retrieved.edgeStates["decide:x:then"]).toBe("dead");
    });
  });

  describe("updateEdgeStates (batch)", () => {
    test("updates multiple edges atomically", () => {
      const run = makeRun({
        edgeStates: { "a:b": "pending", "a:c": "pending", "b:d": "pending" },
      });
      updateEdgeStates(run.id, { "a:b": "satisfied", "a:c": "satisfied" });
      const retrieved = get(run.id)!;
      expect(retrieved.edgeStates["a:b"]).toBe("satisfied");
      expect(retrieved.edgeStates["a:c"]).toBe("satisfied");
      expect(retrieved.edgeStates["b:d"]).toBe("pending");
    });

    test("no-op for empty updates", () => {
      const run = makeRun({ edgeStates: { "a:b": "pending" } });
      updateEdgeStates(run.id, {});
      const retrieved = get(run.id)!;
      expect(retrieved.edgeStates["a:b"]).toBe("pending");
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

  describe("updateStepResult", () => {
    test("persists a string result", () => {
      const run = makeRun();
      updateStepResult(run.id, "fetch", "some output text");
      const retrieved = get(run.id)!;
      expect(retrieved.stepResults.fetch).toBe("some output text");
    });

    test("persists an object result", () => {
      const run = makeRun();
      updateStepResult(run.id, "parse", { valid: true, count: 5 });
      const retrieved = get(run.id)!;
      expect(retrieved.stepResults.parse).toEqual({ valid: true, count: 5 });
    });

    test("does not clobber other step results", () => {
      const run = makeRun();
      updateStepResult(run.id, "a", "result-a");
      updateStepResult(run.id, "b", "result-b");
      const retrieved = get(run.id)!;
      expect(retrieved.stepResults.a).toBe("result-a");
      expect(retrieved.stepResults.b).toBe("result-b");
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

  describe("getReadySteps", () => {
    test("identifies step with all incoming edges satisfied", () => {
      const run = makeRun({
        edgeStates: { "a:c": "satisfied", "b:c": "satisfied" },
        stepStatuses: { a: "completed", b: "completed", c: "pending" },
      });

      const incomingMap = new Map<string, string[]>([
        ["a", []],
        ["b", []],
        ["c", ["a:c", "b:c"]],
      ]);

      const ready = getReadySteps(run, incomingMap);
      expect(ready).toEqual(["c"]);
    });

    test("identifies step with mixed satisfied and dead edges as ready", () => {
      const run = makeRun({
        edgeStates: { "approve:combine": "satisfied", "reject:combine": "dead" },
        stepStatuses: { approve: "completed", reject: "dead", combine: "pending" },
      });

      const incomingMap = new Map<string, string[]>([
        ["approve", []],
        ["reject", []],
        ["combine", ["approve:combine", "reject:combine"]],
      ]);

      const ready = getReadySteps(run, incomingMap);
      expect(ready).toEqual(["combine"]);
    });

    test("does not dispatch step with pending incoming edges", () => {
      const run = makeRun({
        edgeStates: { "a:c": "satisfied", "b:c": "pending" },
        stepStatuses: { a: "completed", b: "running", c: "pending" },
      });

      const incomingMap = new Map<string, string[]>([
        ["a", []],
        ["b", []],
        ["c", ["a:c", "b:c"]],
      ]);

      const ready = getReadySteps(run, incomingMap);
      expect(ready).toEqual([]);
    });

    test("does not dispatch step when all incoming edges are dead", () => {
      const run = makeRun({
        edgeStates: { "x:z": "dead", "y:z": "dead" },
        stepStatuses: { x: "dead", y: "dead", z: "pending" },
      });

      const incomingMap = new Map<string, string[]>([
        ["x", []],
        ["y", []],
        ["z", ["x:z", "y:z"]],
      ]);

      const ready = getReadySteps(run, incomingMap);
      expect(ready).toEqual([]);
    });

    test("skips steps that are not pending", () => {
      const run = makeRun({
        edgeStates: { "a:b": "satisfied" },
        stepStatuses: { a: "completed", b: "running" }, // b is already running
      });

      const incomingMap = new Map<string, string[]>([
        ["a", []],
        ["b", ["a:b"]],
      ]);

      const ready = getReadySteps(run, incomingMap);
      expect(ready).toEqual([]);
    });

    test("identifies root nodes as ready if pending", () => {
      const run = makeRun({
        edgeStates: {},
        stepStatuses: { root: "pending" },
      });

      const incomingMap = new Map<string, string[]>([["root", []]]);

      const ready = getReadySteps(run, incomingMap);
      expect(ready).toEqual(["root"]);
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

  describe("isActiveRunStatus", () => {
    test("running is active", () => {
      expect(isActiveRunStatus("running")).toBe(true);
    });

    test("waiting-signal is active", () => {
      expect(isActiveRunStatus("waiting-signal")).toBe(true);
    });

    test("completed is not active", () => {
      expect(isActiveRunStatus("completed")).toBe(false);
    });

    test("failed is not active", () => {
      expect(isActiveRunStatus("failed")).toBe(false);
    });
  });
});
