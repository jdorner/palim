/**
 * Tests for the DAG Coordinator.
 *
 * Uses in-memory SQLite for isolation. Validates fan-out dispatch, join barrier
 * blocking/release, CF evaluation with dead-edge propagation, run completion
 * with dead terminals, and fail-fast cancellation.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { createTestDb } from "@src/test/db";
import { type DagCoordinatorDeps, handleDagStepCompletion, handleDagStepFailure } from "./dagCoordinator";
import * as dagRunStore from "./dagRunStore";
import { edgeId, initDagRunStore } from "./dagRunStore";
import type { DagWorkflowDefinition } from "./schemas";

/** Track dispatched jobs and broadcasts. */
function createTestDeps(definition: DagWorkflowDefinition): DagCoordinatorDeps & {
  dispatched: string[];
  broadcasts: unknown[];
  cancelled: string[];
} {
  const dispatched: string[] = [];
  const broadcasts: unknown[] = [];
  const cancelled: string[] = [];
  let jobCounter = 0;

  return {
    dispatched,
    broadcasts,
    cancelled,
    flowProducer: {
      add: async (job: any) => {
        jobCounter++;
        dispatched.push(job.data.stepSlug);
        return { job: { id: `job-${jobCounter}` } };
      },
    } as any,
    sessionFactory: {
      create: () => ({ id: `sess-${Date.now()}` }),
    },
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as any,
    broadcast: (event: unknown) => broadcasts.push(event),
    getWorkflowDefinition: (name: string) => (name === definition.name ? definition : undefined),
    cancelJob: async (jobId: string) => {
      cancelled.push(jobId);
    },
  };
}

/** Creates a run with all steps pending and all edges pending. */
function initRun(def: DagWorkflowDefinition, triggerPayload?: unknown) {
  const edgeStates: Record<string, dagRunStore.EdgeState> = {};
  for (const edge of def.edges) {
    edgeStates[edgeId(edge.from, edge.to, edge.branch)] = "pending";
  }
  const stepStatuses: Record<string, dagRunStore.StepStatus> = {};
  for (const slug of Object.keys(def.steps)) {
    stepStatuses[slug] = "pending";
  }
  return dagRunStore.create({
    id: crypto.randomUUID(),
    workflowName: def.name,
    status: "running",
    edgeStates,
    stepStatuses,
    stepResults: {},
    triggerPayload: triggerPayload ?? null,
    failureReason: null,
  });
}

beforeEach(() => {
  const db = createTestDb();
  initDagRunStore(db);
});

describe("handleDagStepCompletion", () => {
  test("fan-out: dispatches two successors when single step completes", async () => {
    const def: DagWorkflowDefinition = {
      name: "fan-out-wf",
      trigger: { type: "manual" },
      steps: {
        a: { type: "agent", prompt: "start" },
        b: { type: "agent", prompt: "branch 1" },
        c: { type: "agent", prompt: "branch 2" },
      },
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
      ],
    };

    const run = initRun(def);
    dagRunStore.updateStepStatus(run.id, "a", "running");
    const deps = createTestDeps(def);

    await handleDagStepCompletion(run.id, "a", "done", "job-a", deps);

    expect(deps.dispatched.sort()).toEqual(["b", "c"]);
    const updatedRun = dagRunStore.get(run.id)!;
    expect(updatedRun.stepStatuses.a).toBe("completed");
    expect(updatedRun.stepStatuses.b).toBe("running");
    expect(updatedRun.stepStatuses.c).toBe("running");
  });

  test("join: blocks until all predecessors complete", async () => {
    const def: DagWorkflowDefinition = {
      name: "join-wf",
      trigger: { type: "manual" },
      steps: {
        a: { type: "agent", prompt: "x" },
        b: { type: "agent", prompt: "y" },
        c: { type: "agent", prompt: "join" },
      },
      edges: [
        { from: "a", to: "c" },
        { from: "b", to: "c" },
      ],
    };

    const run = initRun(def);
    dagRunStore.updateStepStatus(run.id, "a", "running");
    dagRunStore.updateStepStatus(run.id, "b", "running");
    const deps = createTestDeps(def);

    // First predecessor completes — join should NOT fire yet
    await handleDagStepCompletion(run.id, "a", "result-a", "job-a", deps);
    expect(deps.dispatched).toEqual([]);

    // Second predecessor completes — join SHOULD fire
    await handleDagStepCompletion(run.id, "b", "result-b", "job-b", deps);
    expect(deps.dispatched).toEqual(["c"]);
  });

  test("join: releases when satisfied + dead edges (exclusive branch convergence)", async () => {
    // Case node with two branches converging into a single step
    const def: DagWorkflowDefinition = {
      name: "case-join-wf",
      trigger: { type: "manual" },
      steps: {
        classify: { type: "agent", prompt: "classify input" },
        route: { type: "case", match: "{{steps.classify.result}}", paths: ["low", "high"] },
        handle_low: { type: "agent", prompt: "low path" },
        handle_high: { type: "agent", prompt: "high path" },
        done: { type: "agent", prompt: "finish" },
      },
      edges: [
        { from: "classify", to: "route" },
        { from: "route", to: "handle_low", branch: "low" },
        { from: "route", to: "handle_high", branch: "high" },
        { from: "handle_low", to: "done" },
        { from: "handle_high", to: "done" },
      ],
    };

    const run = initRun(def);
    dagRunStore.updateStepStatus(run.id, "classify", "running");
    const deps = createTestDeps(def);

    // classify completes → route (CF) should evaluate inline
    await handleDagStepCompletion(run.id, "classify", "low", "job-classify", deps);

    // route should have been evaluated: "low" branch satisfied, "high" branch dead
    const afterRoute = dagRunStore.get(run.id)!;
    expect(afterRoute.stepStatuses.route).toBe("completed");
    expect(afterRoute.edgeStates["route:handle_low:low"]).toBe("satisfied");
    expect(afterRoute.edgeStates["route:handle_high:high"]).toBe("dead");

    // handle_low should be dispatched, handle_high should be dead
    expect(deps.dispatched).toContain("handle_low");
    expect(afterRoute.stepStatuses.handle_high).toBe("dead");

    // handle_low completes → done should fire (one edge satisfied, one edge dead)
    deps.dispatched.length = 0;
    await handleDagStepCompletion(run.id, "handle_low", "low-result", "job-low", deps);

    expect(deps.dispatched).toEqual(["done"]);
  });

  test("run completes when all terminal steps finish", async () => {
    const def: DagWorkflowDefinition = {
      name: "complete-wf",
      trigger: { type: "manual" },
      steps: {
        a: { type: "agent", prompt: "x" },
        b: { type: "agent", prompt: "y" },
      },
      edges: [{ from: "a", to: "b" }],
    };

    const run = initRun(def);
    dagRunStore.updateStepStatus(run.id, "a", "running");
    const deps = createTestDeps(def);

    await handleDagStepCompletion(run.id, "a", "result-a", "job-a", deps);
    // b is dispatched
    expect(deps.dispatched).toEqual(["b"]);

    // Simulate b completing
    dagRunStore.updateStepStatus(run.id, "b", "running");
    await handleDagStepCompletion(run.id, "b", "result-b", "job-b", deps);

    const finalRun = dagRunStore.get(run.id)!;
    expect(finalRun.status).toBe("completed");
    expect(deps.broadcasts.some((e: any) => e.type === "workflow_completed")).toBe(true);
  });

  test("run completes with dead terminal steps", async () => {
    const def: DagWorkflowDefinition = {
      name: "dead-terminal-wf",
      trigger: { type: "manual" },
      steps: {
        a: { type: "agent", prompt: "start" },
        decide: { type: "if", condition: { ref: "{{steps.a.result}}", eq: "yes" } },
        path_then: { type: "agent", prompt: "then" },
        path_else: { type: "agent", prompt: "else" },
      },
      edges: [
        { from: "a", to: "decide" },
        { from: "decide", to: "path_then", branch: "then" },
        { from: "decide", to: "path_else", branch: "else" },
      ],
    };

    const run = initRun(def);
    dagRunStore.updateStepStatus(run.id, "a", "running");
    const deps = createTestDeps(def);

    // a completes with "yes" → decide picks "then"
    await handleDagStepCompletion(run.id, "a", "yes", "job-a", deps);

    // path_then should be dispatched, path_else should be dead
    expect(deps.dispatched).toContain("path_then");
    const midRun = dagRunStore.get(run.id)!;
    expect(midRun.stepStatuses.path_else).toBe("dead");

    // path_then completes → run should be complete (path_else is dead terminal but that's OK)
    dagRunStore.updateStepStatus(run.id, "path_then", "running");
    await handleDagStepCompletion(run.id, "path_then", "then-done", "job-then", deps);

    const finalRun = dagRunStore.get(run.id)!;
    expect(finalRun.status).toBe("completed");
  });

  test("dead-edge propagation cascades through chain", async () => {
    const def: DagWorkflowDefinition = {
      name: "cascade-dead-wf",
      trigger: { type: "manual" },
      steps: {
        a: { type: "agent", prompt: "start" },
        decide: { type: "if", condition: { ref: "{{steps.a.result}}", eq: "yes" } },
        b: { type: "agent", prompt: "then path" },
        c: { type: "agent", prompt: "else chain 1" },
        d: { type: "agent", prompt: "else chain 2" },
      },
      edges: [
        { from: "a", to: "decide" },
        { from: "decide", to: "b", branch: "then" },
        { from: "decide", to: "c", branch: "else" },
        { from: "c", to: "d" },
      ],
    };

    const run = initRun(def);
    dagRunStore.updateStepStatus(run.id, "a", "running");
    const deps = createTestDeps(def);

    // a completes with "yes" → picks "then" → c and d should cascade to dead
    await handleDagStepCompletion(run.id, "a", "yes", "job-a", deps);

    const afterRun = dagRunStore.get(run.id)!;
    expect(afterRun.stepStatuses.c).toBe("dead");
    expect(afterRun.stepStatuses.d).toBe("dead");
    expect(afterRun.edgeStates["c:d"]).toBe("dead");
  });
});

describe("handleDagStepFailure", () => {
  test("marks run failed and remaining steps as dead", async () => {
    const def: DagWorkflowDefinition = {
      name: "fail-wf",
      trigger: { type: "manual" },
      steps: {
        a: { type: "agent", prompt: "x" },
        b: { type: "agent", prompt: "y" },
        c: { type: "agent", prompt: "z" },
      },
      edges: [
        { from: "a", to: "c" },
        { from: "b", to: "c" },
      ],
    };

    const run = initRun(def);
    dagRunStore.updateStepStatus(run.id, "a", "running");
    dagRunStore.updateStepStatus(run.id, "b", "running");
    const deps = createTestDeps(def);

    await handleDagStepFailure(run.id, "a", "something broke", deps, ["job-b"]);

    const finalRun = dagRunStore.get(run.id)!;
    expect(finalRun.status).toBe("failed");
    expect(finalRun.failureReason).toContain("something broke");
    expect(finalRun.stepStatuses.a).toBe("failed");
    expect(finalRun.stepStatuses.b).toBe("dead"); // was running, now dead
    expect(finalRun.stepStatuses.c).toBe("dead"); // was pending, now dead
    expect(deps.cancelled).toEqual(["job-b"]);
  });

  test("broadcasts workflow_failed event", async () => {
    const def: DagWorkflowDefinition = {
      name: "fail-broadcast-wf",
      trigger: { type: "manual" },
      steps: {
        a: { type: "agent", prompt: "x" },
        b: { type: "agent", prompt: "y" },
      },
      edges: [{ from: "a", to: "b" }],
    };

    const run = initRun(def);
    dagRunStore.updateStepStatus(run.id, "a", "running");
    const deps = createTestDeps(def);

    await handleDagStepFailure(run.id, "a", "timeout", deps);

    const failEvent = deps.broadcasts.find((e: any) => e.type === "workflow_failed") as any;
    expect(failEvent).not.toBeUndefined();
    expect(failEvent.failedStep).toBe("a");
    expect(failEvent.error).toBe("timeout");
  });
});
