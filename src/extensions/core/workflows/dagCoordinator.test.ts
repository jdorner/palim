/**
 * Tests for the DAG Coordinator.
 *
 * Uses in-memory SQLite for isolation. Validates fan-out dispatch, join barrier
 * blocking/release, CF evaluation with dead-edge propagation, run completion
 * with dead terminals, and fail-fast cancellation.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { createWorkflowTestDb } from "@src/test/db";
import { createSetVariablesHandler } from "../../core-wf-steps/setVariables";
import {
  type DagCoordinatorDeps,
  evaluateInlineRoot,
  handleDagStepCompletion,
  handleDagStepFailure,
  resumeWaitForNode,
} from "./dagCoordinator";
import * as dagRunStore from "./dagRunStore";
import { edgeId } from "./dagRunStore";
import { createDagStepProcessor } from "./dagWorker";
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

describe("inline node failure (failRun)", () => {
  // Regression: an iterator whose `items` expression resolves to invalid JSON
  // used to fail the RUN while leaving the iterator step stuck at "running".
  // The UI then showed a spinning/active dot next to a "failed" badge. failRun
  // must mark the offending step "failed" and sweep siblings to "dead", exactly
  // like the queue-job failure path (handleDagStepFailure).
  test("iterator with invalid-JSON items marks the iterator step failed", async () => {
    const def: DagWorkflowDefinition = {
      name: "iter-fail-wf",
      trigger: { type: "manual" },
      steps: {
        images: { type: "iterator", items: "{{trigger.payload}}", as: "image" },
        body: { type: "agent", prompt: "{{image}}" },
        collect: { type: "aggregator", iterator: "images" },
      },
      edges: [
        { from: "images", to: "body", branch: "each" },
        { from: "body", to: "collect" },
      ],
    };

    // No trigger payload -> the items expression resolves to an empty string,
    // which is not valid JSON (JSON.parse throws "Unexpected EOF").
    const run = initRun(def);
    const deps = createTestDeps(def);

    await evaluateInlineRoot(run.id, "images", deps);

    const finalRun = dagRunStore.get(run.id)!;
    expect(finalRun.status).toBe("failed");
    // The iterator step itself must be terminal, not left "running".
    expect(finalRun.stepStatuses.images).toBe("failed");
    // Remaining non-terminal steps are swept to dead so nothing shows as active.
    expect(finalRun.stepStatuses.body).toBe("dead");
    expect(finalRun.stepStatuses.collect).toBe("dead");
    expect(finalRun.failureReason).toContain("Iterator items is not valid JSON");
  });

  test("failRun sweeps pending/running siblings to dead", async () => {
    const def: DagWorkflowDefinition = {
      name: "iter-fail-siblings-wf",
      trigger: { type: "manual" },
      steps: {
        images: { type: "iterator", items: "not-json", as: "image" },
        other: { type: "agent", prompt: "sibling" },
      },
      edges: [],
    };

    const run = initRun(def);
    // Simulate a sibling branch already running when the iterator fails.
    dagRunStore.updateStepStatus(run.id, "other", "running");
    const deps = createTestDeps(def);

    await evaluateInlineRoot(run.id, "images", deps);

    const finalRun = dagRunStore.get(run.id)!;
    expect(finalRun.status).toBe("failed");
    expect(finalRun.stepStatuses.images).toBe("failed");
    expect(finalRun.stepStatuses.other).toBe("dead");
    // The failing step and each swept step broadcast their terminal transition.
    expect(deps.broadcasts.some((e: any) => e.type === "workflow_failed")).toBe(true);
    expect(deps.broadcasts.some((e: any) => e.type === "workflow_step_dead" && e.stepSlug === "other")).toBe(true);
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

describe("set-variables accumulation inside an iterator", () => {
  // End-to-end through coordinator + worker: a set-variables step in the body
  // sees its own previous-iteration result (body results survive the reset),
  // and a step after the aggregator sees the final accumulated value.
  test("accumulates across iterations and exposes the final value downstream", async () => {
    const def: DagWorkflowDefinition = {
      name: "acc-wf",
      trigger: { type: "manual" },
      steps: {
        letters: { type: "iterator", items: "{{trigger.payload}}", as: "letter" },
        acc: {
          type: "set-variables",
          variables: [
            { name: "text", value: "{{steps.acc.result.text}}{{letter}}, " },
            { name: "count", value: "{{itemIndex}}", type: "number" },
          ],
        },
        collect: { type: "aggregator", iterator: "letters" },
        after: { type: "set-variables", variables: [{ name: "final", value: "{{steps.acc.result.text}}" }] },
      } as unknown as DagWorkflowDefinition["steps"],
      edges: [
        { from: "letters", to: "acc", branch: "each" },
        { from: "acc", to: "collect" },
        { from: "collect", to: "after" },
      ],
    };

    const queued: { data: { stepSlug: string } & Record<string, unknown> }[] = [];
    const deps = createTestDeps(def);
    deps.flowProducer = {
      add: async (job: any) => {
        queued.push(job);
        return { job: { id: `job-${queued.length}` } };
      },
    } as any;

    const handler = createSetVariablesHandler();
    const processor = createDagStepProcessor({
      ctx: {
        paths: { work: "/tmp/work" },
        internal: undefined,
        skills: { resolve: () => undefined, names: () => [] },
      } as any,
      emitEvent: () => {},
      log: deps.log,
      getStepHandler: () => handler,
    });

    const run = initRun(def, ["a", "b", "c"]);
    await evaluateInlineRoot(run.id, "letters", deps);

    // Drain the queue: execute each dispatched job and report its completion.
    for (let i = 0; i < queued.length; i++) {
      const job = queued[i]!;
      const result = await processor({ id: `job-${i + 1}`, data: job.data, log: async () => {} } as any);
      await handleDagStepCompletion(run.id, job.data.stepSlug, result, `job-${i + 1}`, deps);
    }

    const finalRun = dagRunStore.get(run.id)!;
    expect(queued.map((j) => j.data.stepSlug)).toEqual(["acc", "acc", "acc", "after"]);
    expect(finalRun.status).toBe("completed");
    expect(finalRun.stepResults.acc).toEqual({ text: "a, b, c, ", count: 2 });
    expect(finalRun.stepResults.after).toEqual({ final: "a, b, c, " });
  });
});

describe("dead-edge propagation into inline nodes", () => {
  // Regression: when an `if` kills one branch and satisfies another that joins
  // at an inline node, and the dead branch is propagated first, propagateDead
  // found the join ready and dispatched it as a queue job. The worker has no
  // handler for inline types ("No handler registered for step type aggregator").
  test("aggregator reached via a dead branch + satisfied branch is evaluated inline", async () => {
    const def: DagWorkflowDefinition = {
      name: "dead-into-aggregator-wf",
      trigger: { type: "manual" },
      steps: {
        mails: { type: "iterator", items: "{{trigger.payload}}", as: "mail" },
        "has-attachments": { type: "if", condition: { ref: "{{mail}}", gt: "5" } },
        attachments: { type: "iterator", items: "[1, 2]", as: "attachment" },
        download: { type: "agent", prompt: "{{attachment}}" },
        "collect-attachments": { type: "aggregator", iterator: "attachments" },
        "collect-mails": { type: "aggregator", iterator: "mails" },
        done: { type: "agent", prompt: "finished" },
      },
      // `then` is listed before `else` so the dead branch is propagated first.
      edges: [
        { from: "mails", to: "has-attachments", branch: "each" },
        { from: "has-attachments", to: "attachments", branch: "then" },
        { from: "has-attachments", to: "collect-mails", branch: "else" },
        { from: "attachments", to: "download", branch: "each" },
        { from: "download", to: "collect-attachments" },
        { from: "collect-attachments", to: "collect-mails" },
        { from: "collect-mails", to: "done" },
      ],
    };

    const run = initRun(def, [1]);
    const deps = createTestDeps(def);

    await evaluateInlineRoot(run.id, "mails", deps);

    const afterRun = dagRunStore.get(run.id)!;
    expect(deps.dispatched).toEqual(["done"]);
    expect(afterRun.status).toBe("running");
    expect(afterRun.stepStatuses.attachments).toBe("dead");
    expect(afterRun.stepStatuses["collect-attachments"]).toBe("dead");
    expect(afterRun.stepStatuses["collect-mails"]).toBe("completed");

    await handleDagStepCompletion(run.id, "done", "ok", "job-1", deps);
    expect(dagRunStore.get(run.id)!.status).toBe("completed");
  });

  test("waitFor reached via a dead branch + satisfied branch registers a signal", async () => {
    const def: DagWorkflowDefinition = {
      name: "dead-into-waitfor-wf",
      trigger: { type: "manual" },
      steps: {
        a: { type: "agent", prompt: "start" },
        gate: { type: "if", condition: { ref: "{{steps.a.result}}", eq: "yes" } },
        skipped: { type: "agent", prompt: "only on yes" },
        wait: { type: "waitFor", event: "approval.granted" },
      },
      edges: [
        { from: "a", to: "gate" },
        { from: "gate", to: "skipped", branch: "then" },
        { from: "gate", to: "wait", branch: "else" },
        { from: "skipped", to: "wait" },
      ],
    };

    const run = initRun(def);
    dagRunStore.updateStepStatus(run.id, "a", "running");
    const deps = createTestDeps(def);

    await handleDagStepCompletion(run.id, "a", "no", "job-a", deps);

    const afterRun = dagRunStore.get(run.id)!;
    expect(deps.dispatched).not.toContain("wait");
    expect(afterRun.stepStatuses.skipped).toBe("dead");
    expect(afterRun.stepStatuses.wait).toBe("waiting-signal");
    expect(signalStore.getAllWaiting().filter((s) => s.runId === run.id).length).toBe(1);
  });
});
