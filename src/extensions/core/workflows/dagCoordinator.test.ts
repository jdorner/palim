/**
 * Tests for the DAG Coordinator.
 *
 * Uses in-memory SQLite for isolation. Validates fan-out dispatch, join barrier
 * blocking/release, CF evaluation with dead-edge propagation, run completion
 * with dead terminals, and fail-fast cancellation.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { createWorkflowTestDb } from "@src/test/db";
import {
  type DagCoordinatorDeps,
  handleDagStepCompletion,
  handleDagStepFailure,
  resumeWaitForNode,
} from "./dagCoordinator";
import * as dagRunStore from "./dagRunStore";
import { edgeId } from "./dagRunStore";
import type { DagWorkflowDefinition } from "./schemas";
import * as signalStore from "./signalStore";

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
  createWorkflowTestDb();
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

  test("fail-fast sweeps a waiting-signal step to dead", async () => {
    const def: DagWorkflowDefinition = {
      name: "fail-with-wait-wf",
      trigger: { type: "manual" },
      steps: {
        a: { type: "agent", prompt: "x" },
        wait: { type: "waitFor", event: "go" },
        b: { type: "agent", prompt: "y" },
      },
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "wait" },
      ],
    };

    const run = initRun(def);
    dagRunStore.updateStepStatus(run.id, "a", "running");
    // Simulate the wait node already paused on a signal.
    dagRunStore.updateStepStatus(run.id, "wait", "waiting-signal");
    const deps = createTestDeps(def);

    await handleDagStepFailure(run.id, "b", "b failed", deps);

    const finalRun = dagRunStore.get(run.id)!;
    expect(finalRun.status).toBe("failed");
    // The paused waitFor step must be swept to dead, not left waiting-signal.
    expect(finalRun.stepStatuses.wait).toBe("dead");
  });
});

describe("waitFor nodes", () => {
  test("registers a successor waitFor node as waiting-signal (step + run)", async () => {
    const def: DagWorkflowDefinition = {
      name: "wait-register-wf",
      trigger: { type: "manual" },
      steps: {
        a: { type: "agent", prompt: "start" },
        wait: { type: "waitFor", event: "approval.granted" },
        b: { type: "agent", prompt: "after wait" },
      },
      edges: [
        { from: "a", to: "wait" },
        { from: "wait", to: "b" },
      ],
    };

    const run = initRun(def);
    dagRunStore.updateStepStatus(run.id, "a", "running");
    const deps = createTestDeps(def);

    await handleDagStepCompletion(run.id, "a", "done", "job-a", deps);

    const afterRun = dagRunStore.get(run.id)!;
    // Both the step and the run are now persisted as waiting-signal.
    expect(afterRun.stepStatuses.wait).toBe("waiting-signal");
    expect(afterRun.status).toBe("waiting-signal");
    // A signal record was created for the wait node.
    const waiting = signalStore.getAllWaiting().filter((s) => s.runId === run.id);
    expect(waiting.length).toBe(1);
    expect(waiting[0]!.stepSlug).toBe("wait");
    // The successor is NOT dispatched while paused.
    expect(deps.dispatched).not.toContain("b");
    // A waiting event was broadcast.
    expect(deps.broadcasts.some((e: any) => e.type === "workflow_step_waiting")).toBe(true);
  });

  test("a parallel branch keeps running while another branch waits", async () => {
    // a fans out to a waitFor node and to an execution branch b -> c.
    // The wait pausing must not freeze the b/c branch.
    const def: DagWorkflowDefinition = {
      name: "wait-parallel-wf",
      trigger: { type: "manual" },
      steps: {
        a: { type: "agent", prompt: "start" },
        wait: { type: "waitFor", event: "go" },
        b: { type: "agent", prompt: "parallel work" },
        c: { type: "agent", prompt: "after b" },
      },
      edges: [
        { from: "a", to: "wait" },
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
    };

    const run = initRun(def);
    dagRunStore.updateStepStatus(run.id, "a", "running");
    const deps = createTestDeps(def);

    // a completes → wait registers (run becomes waiting-signal) AND b dispatches.
    await handleDagStepCompletion(run.id, "a", "done", "job-a", deps);
    expect(dagRunStore.get(run.id)!.status).toBe("waiting-signal");
    expect(deps.dispatched).toContain("b");

    // b completes while the run is still waiting-signal — c must still dispatch.
    await handleDagStepCompletion(run.id, "b", "b-done", "job-b", deps);
    expect(deps.dispatched).toContain("c");
  });

  test("resumeWaitForNode completes the wait step and reverts the run to running", async () => {
    const def: DagWorkflowDefinition = {
      name: "wait-resume-wf",
      trigger: { type: "manual" },
      steps: {
        a: { type: "agent", prompt: "start" },
        wait: { type: "waitFor", event: "go" },
        b: { type: "agent", prompt: "after wait" },
      },
      edges: [
        { from: "a", to: "wait" },
        { from: "wait", to: "b" },
      ],
    };

    const run = initRun(def);
    dagRunStore.updateStepStatus(run.id, "a", "running");
    const deps = createTestDeps(def);

    await handleDagStepCompletion(run.id, "a", "done", "job-a", deps);
    expect(dagRunStore.get(run.id)!.status).toBe("waiting-signal");

    // Deliver the signal.
    await resumeWaitForNode(run.id, "wait", { approved: true }, deps);

    const afterResume = dagRunStore.get(run.id)!;
    expect(afterResume.stepStatuses.wait).toBe("completed");
    expect(afterResume.status).toBe("running");
    expect(afterResume.stepResults.wait).toEqual({ approved: true });
    // The successor is dispatched after resume.
    expect(deps.dispatched).toContain("b");
  });

  test("resumeWaitForNode is ignored when the run has already failed", async () => {
    const def: DagWorkflowDefinition = {
      name: "wait-resume-terminal-wf",
      trigger: { type: "manual" },
      steps: {
        a: { type: "agent", prompt: "start" },
        wait: { type: "waitFor", event: "go" },
        b: { type: "agent", prompt: "after wait" },
      },
      edges: [
        { from: "a", to: "wait" },
        { from: "wait", to: "b" },
      ],
    };

    const run = initRun(def);
    dagRunStore.updateStepStatus(run.id, "a", "running");
    const deps = createTestDeps(def);

    await handleDagStepCompletion(run.id, "a", "done", "job-a", deps);
    // Force the run terminal (as if another branch failed it).
    dagRunStore.updateStatus(run.id, "failed", "unrelated failure");

    await resumeWaitForNode(run.id, "wait", { approved: true }, deps);

    const afterResume = dagRunStore.get(run.id)!;
    // Resume must not revive a failed run or dispatch the successor.
    expect(afterResume.status).toBe("failed");
    expect(deps.dispatched).not.toContain("b");
  });
});
