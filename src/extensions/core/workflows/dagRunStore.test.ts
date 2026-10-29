/**
 * Tests for the DAG workflow Run Store module.
 *
 * Uses in-memory SQLite for isolation. Validates edge state transitions,
 * step status tracking, and the join-barrier rule with mixed satisfied/dead edges.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { createTestDb } from "@src/test/db";
import {
  classifyIncomingEdges,
  create,
  type DagWorkflowRun,
  edgeId,
  get,
  getAll,
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

  describe("classifyIncomingEdges", () => {
    test("is ready when all incoming edges are satisfied", () => {
      const states = { "a:c": "satisfied", "b:c": "satisfied" } as const;
      expect(classifyIncomingEdges(states, ["a:c", "b:c"])).toBe("ready");
    });

    test("is ready when satisfied and dead edges are mixed", () => {
      const states = { "approve:combine": "satisfied", "reject:combine": "dead" } as const;
      expect(classifyIncomingEdges(states, ["approve:combine", "reject:combine"])).toBe("ready");
    });

    test("is waiting while any incoming edge is pending", () => {
      const states = { "a:c": "satisfied", "b:c": "pending" } as const;
      expect(classifyIncomingEdges(states, ["a:c", "b:c"])).toBe("waiting");
    });

    test("is waiting when an incoming edge has no recorded state", () => {
      const states = { "a:c": "dead" } as const;
      expect(classifyIncomingEdges(states, ["a:c", "b:c"])).toBe("waiting");
    });

    test("is dead when all incoming edges are dead", () => {
      const states = { "x:z": "dead", "y:z": "dead" } as const;
      expect(classifyIncomingEdges(states, ["x:z", "y:z"])).toBe("dead");
    });

    test("is dead for an empty edge list", () => {
      expect(classifyIncomingEdges({}, [])).toBe("dead");
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
