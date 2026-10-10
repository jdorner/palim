/**
 * Tests for instance-scoped signal delivery.
 *
 * Covers the shared delivery path (`deliverSignal`), correlation keys and
 * scopes on `waitFor`, scoped `emit` matching, the `run` template namespace,
 * and re-arming signal timeouts after a restart. Uses in-memory SQLite.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createWorkflowTestDb } from "@src/test/db";
import { type DagCoordinatorDeps, handleDagStepCompletion } from "./dagCoordinator";
import { createDagEmitHandler } from "./dagEmitHandler";
import * as dagRunStore from "./dagRunStore";
import { edgeId } from "./dagRunStore";
import type { DagWorkflowDefinition } from "./schemas";
import { deliverSignal } from "./signalDelivery";
import * as signalStore from "./signalStore";
import * as signalTimers from "./signalTimers";
import { resolveTemplates } from "./template";

/** Coordinator deps that record dispatched step slugs and broadcasts. */
function createTestDeps(definitions: DagWorkflowDefinition[]): DagCoordinatorDeps & {
  dispatched: string[];
  broadcasts: { type: string }[];
} {
  const dispatched: string[] = [];
  const broadcasts: { type: string }[] = [];
  let jobCounter = 0;
  return {
    dispatched,
    broadcasts,
    flowProducer: {
      add: async (job: any) => {
        jobCounter++;
        dispatched.push(job.data.stepSlug);
        return { job: { id: `job-${jobCounter}` } };
      },
    } as any,
    sessionFactory: { create: () => ({ id: `sess-${Date.now()}` }) },
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    broadcast: (event) => broadcasts.push(event),
    getWorkflowDefinition: (name) => definitions.find((d) => d.name === name),
    cancelJob: async () => {},
  };
}

/** Creates a run with all steps and edges pending. */
function initRun(def: DagWorkflowDefinition, triggerPayload?: unknown) {
  const edgeStates: Record<string, dagRunStore.EdgeState> = {};
  for (const edge of def.edges) edgeStates[edgeId(edge.from, edge.to, edge.branch)] = "pending";
  const stepStatuses: Record<string, dagRunStore.StepStatus> = {};
  for (const slug of Object.keys(def.steps)) stepStatuses[slug] = "pending";
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

/** Waits for fire-and-forget resumes and zero-delay timers to settle. */
const settle = () => Bun.sleep(5);

/** A workflow whose `start` step fans out to two waits on the same event. */
const twoWaitsDef: DagWorkflowDefinition = {
  name: "two-waits",
  trigger: { type: "manual" },
  steps: {
    start: { type: "agent", prompt: "start" },
    left: { type: "waitFor", event: "go", scope: "broadcast" },
    right: { type: "waitFor", event: "go", scope: "broadcast" },
    afterLeft: { type: "agent", prompt: "left done" },
    afterRight: { type: "agent", prompt: "right done" },
  },
  edges: [
    { from: "start", to: "left" },
    { from: "start", to: "right" },
    { from: "left", to: "afterLeft" },
    { from: "right", to: "afterRight" },
  ],
};

/** A workflow that waits for `order.paid`, correlated by the trigger's order ID. */
const correlatedDef: DagWorkflowDefinition = {
  name: "correlated",
  trigger: { type: "manual" },
  steps: {
    start: { type: "agent", prompt: "start" },
    paid: { type: "waitFor", event: "order.paid", scope: "broadcast", correlate: "{{trigger.payload.orderId}}" },
    ship: { type: "agent", prompt: "ship" },
  },
  edges: [
    { from: "start", to: "paid" },
    { from: "paid", to: "ship" },
  ],
};

/** Starts a run and completes its `start` step so the waits register. */
async function startAndPark(def: DagWorkflowDefinition, deps: DagCoordinatorDeps, triggerPayload?: unknown) {
  const run = initRun(def, triggerPayload);
  dagRunStore.updateStepStatus(run.id, "start", "running");
  await handleDagStepCompletion(run.id, "start", "ok", "job-start", deps);
  return run;
}

/** Runs the emit handler with the given step definition from a separate run. */
async function runEmit(deps: DagCoordinatorDeps, stepDef: Record<string, unknown>) {
  const handler = createDagEmitHandler({ coordinatorDeps: deps });
  const logs: string[] = [];
  const ctx = {
    workflowRunId: "emitter-run",
    resolveTemplate: (t: string) => resolveTemplates(t, { stepResults: {} }),
    jobLog: async (line: string) => {
      logs.push(line);
    },
  } as any;
  const result = (await handler.execute({ type: "emit", ...stepDef }, ctx)) as { delivered: number };
  await settle();
  return { ...result, logs };
}

beforeEach(() => {
  createWorkflowTestDb();
});

afterEach(() => {
  signalTimers.cleanup();
});

describe("deliverSignal", () => {
  test("resumes exactly the addressed step when two steps wait on the same event", async () => {
    const deps = createTestDeps([twoWaitsDef]);
    const run = await startAndPark(twoWaitsDef, deps);

    const left = signalStore.getWaitingForStep(run.id, "left")!;
    const result = deliverSignal(left.id, { side: "left" }, { via: "route", coordinatorDeps: deps });
    await settle();

    expect(result.ok).toBe(true);
    const after = dagRunStore.get(run.id)!;
    expect(after.stepStatuses.left).toBe("completed");
    expect(after.stepResults.left).toEqual({ side: "left" });
    expect(after.stepStatuses.right).toBe("waiting-signal");
    expect(after.status).toBe("waiting-signal");
    expect(deps.dispatched).toContain("afterLeft");
    expect(deps.dispatched).not.toContain("afterRight");
    expect(deps.broadcasts.some((b) => b.type === "workflow_step_resumed")).toBe(true);
  });

  test("a second delivery to the same signal is rejected with 409", async () => {
    const deps = createTestDeps([twoWaitsDef]);
    const run = await startAndPark(twoWaitsDef, deps);
    const left = signalStore.getWaitingForStep(run.id, "left")!;

    deliverSignal(left.id, null, { via: "route", coordinatorDeps: deps });
    const second = deliverSignal(left.id, null, { via: "route", coordinatorDeps: deps });
    await settle();

    expect(second).toMatchObject({ ok: false, status: 409 });
  });

  test("returns 404 for an unknown signal", () => {
    const deps = createTestDeps([]);
    expect(deliverSignal("missing", null, { via: "route", coordinatorDeps: deps })).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  test("validates the payload against the input schema without claiming the signal", async () => {
    const def: DagWorkflowDefinition = {
      name: "schema-wait",
      trigger: { type: "manual" },
      steps: {
        start: { type: "agent", prompt: "start" },
        approve: {
          type: "waitFor",
          event: "approval",
          inputSchema: {
            type: "object",
            properties: { approved: { type: "boolean" } },
            required: ["approved"],
          },
        },
      },
      edges: [{ from: "start", to: "approve" }],
    };
    const deps = createTestDeps([def]);
    const run = await startAndPark(def, deps);
    const signal = signalStore.getWaitingForStep(run.id, "approve")!;

    const invalid = deliverSignal(signal.id, { approved: "yes" }, { via: "route", coordinatorDeps: deps });
    expect(invalid).toMatchObject({ ok: false, status: 422 });
    expect(signalStore.getById(signal.id)!.status).toBe("waiting");

    const valid = deliverSignal(signal.id, { approved: true }, { via: "route", coordinatorDeps: deps });
    expect(valid.ok).toBe(true);
  });

  test("rejects delivery when the run is no longer active", async () => {
    const deps = createTestDeps([twoWaitsDef]);
    const run = await startAndPark(twoWaitsDef, deps);
    dagRunStore.updateStatus(run.id, "failed", "boom");
    const left = signalStore.getWaitingForStep(run.id, "left")!;

    const result = deliverSignal(left.id, null, { via: "route", coordinatorDeps: deps });

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(signalStore.getById(left.id)!.status).toBe("waiting");
  });

  test("signals created by humanTask nodes can only be delivered via hitl", async () => {
    const deps = createTestDeps([twoWaitsDef]);
    const run = await startAndPark(twoWaitsDef, deps);
    const task = signalStore.create({
      runId: run.id,
      stepSlug: "review",
      event: "hitl.task",
      inputSchema: null,
      timeoutMs: null,
      scope: "instance",
      source: "humanTask",
    });

    expect(deliverSignal(task.id, null, { via: "route", coordinatorDeps: deps })).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(deliverSignal(task.id, null, { via: "emit", coordinatorDeps: deps })).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(signalStore.getById(task.id)!.status).toBe("waiting");
  });
});

describe("waitFor correlation and scope", () => {
  test("resolves the correlation key from the run state when the wait registers", async () => {
    const deps = createTestDeps([correlatedDef]);
    const run = await startAndPark(correlatedDef, deps, { orderId: "A-1" });

    const signal = signalStore.getWaitingForStep(run.id, "paid")!;
    expect(signal.correlationKey).toBe("A-1");
    expect(signal.scope).toBe("broadcast");
  });

  test("fails the run when the correlation key cannot be resolved", async () => {
    const deps = createTestDeps([correlatedDef]);
    const run = await startAndPark(correlatedDef, deps, { somethingElse: true });

    const after = dagRunStore.get(run.id)!;
    expect(after.status).toBe("failed");
    expect(after.failureReason).toContain("Correlation key");
    expect(signalStore.listWaitingForRun(run.id)).toHaveLength(0);
  });

  test("defaults to the instance scope", async () => {
    const def: DagWorkflowDefinition = {
      ...twoWaitsDef,
      name: "instance-waits",
      steps: { ...twoWaitsDef.steps, left: { type: "waitFor", event: "go" } },
    };
    const deps = createTestDeps([def]);
    const run = await startAndPark(def, deps);

    expect(signalStore.getWaitingForStep(run.id, "left")!.scope).toBe("instance");
    expect(signalStore.getWaitingForStep(run.id, "right")!.scope).toBe("broadcast");
  });
});

describe("emit scoping", () => {
  test("a correlated emit resumes only the run with the matching key", async () => {
    const deps = createTestDeps([correlatedDef]);
    const runA = await startAndPark(correlatedDef, deps, { orderId: "A-1" });
    const runB = await startAndPark(correlatedDef, deps, { orderId: "B-2" });

    const result = await runEmit(deps, { event: "order.paid", correlate: "A-1", payload: '{"amount":5}' });

    expect(result.delivered).toBe(1);
    expect(dagRunStore.get(runA.id)!.stepStatuses.paid).toBe("completed");
    expect(dagRunStore.get(runA.id)!.stepResults.paid).toEqual({ amount: 5 });
    expect(dagRunStore.get(runB.id)!.stepStatuses.paid).toBe("waiting-signal");
  });

  test("an emit without a key does not reach correlated waits", async () => {
    const deps = createTestDeps([correlatedDef]);
    const run = await startAndPark(correlatedDef, deps, { orderId: "A-1" });

    const result = await runEmit(deps, { event: "order.paid" });

    expect(result.delivered).toBe(0);
    expect(dagRunStore.get(run.id)!.stepStatuses.paid).toBe("waiting-signal");
  });

  test("targetRun narrows delivery to one run", async () => {
    const deps = createTestDeps([twoWaitsDef]);
    const runA = await startAndPark(twoWaitsDef, deps);
    const runB = await startAndPark(twoWaitsDef, deps);

    const result = await runEmit(deps, { event: "go", targetRun: runB.id });

    expect(result.delivered).toBe(2);
    expect(dagRunStore.get(runA.id)!.status).toBe("waiting-signal");
    expect(dagRunStore.get(runB.id)!.stepStatuses.left).toBe("completed");
    expect(dagRunStore.get(runB.id)!.stepStatuses.right).toBe("completed");
  });

  test("instance-scoped waits (the default) are never reached by emit", async () => {
    const def: DagWorkflowDefinition = {
      ...twoWaitsDef,
      name: "instance-emit",
      steps: { ...twoWaitsDef.steps, left: { type: "waitFor", event: "go" } },
    };
    const deps = createTestDeps([def]);
    const run = await startAndPark(def, deps);

    const result = await runEmit(deps, { event: "go" });

    expect(result.delivered).toBe(1);
    const after = dagRunStore.get(run.id)!;
    expect(after.stepStatuses.left).toBe("waiting-signal");
    expect(after.stepStatuses.right).toBe("completed");
  });

  test("an uncorrelated emit reaches every unkeyed broadcast wait", async () => {
    const deps = createTestDeps([twoWaitsDef]);
    const runA = await startAndPark(twoWaitsDef, deps);
    const runB = await startAndPark(twoWaitsDef, deps);

    const result = await runEmit(deps, { event: "go" });

    expect(result.delivered).toBe(4);
    expect(dagRunStore.get(runA.id)!.status).toBe("running");
    expect(dagRunStore.get(runB.id)!.status).toBe("running");
  });

  test("skips waits whose input schema rejects the payload and logs why", async () => {
    const def: DagWorkflowDefinition = {
      name: "typed-wait",
      trigger: { type: "manual" },
      steps: {
        start: { type: "agent", prompt: "start" },
        wait: { type: "waitFor", event: "typed", scope: "broadcast", inputSchema: { type: "object", required: ["n"] } },
      },
      edges: [{ from: "start", to: "wait" }],
    };
    const deps = createTestDeps([def]);
    const run = await startAndPark(def, deps);

    const result = await runEmit(deps, { event: "typed", payload: '{"x":1}' });

    expect(result.delivered).toBe(0);
    expect(result.logs.some((l) => l.includes("Validation failed"))).toBe(true);
    expect(dagRunStore.get(run.id)!.stepStatuses.wait).toBe("waiting-signal");
  });
});

describe("run template namespace", () => {
  test("resolves run.id, run.workflow and run.createdBy", async () => {
    const ctx = {
      stepResults: {},
      run: { id: "run-42", workflow: "orders", createdBy: "user-1" },
    };

    const { resolved, warnings } = await resolveTemplates(
      "/runs/{{run.id}}/steps/x/signal {{run.workflow}} {{run.createdBy}}",
      ctx,
    );

    expect(warnings).toEqual([]);
    expect(resolved).toBe("/runs/run-42/steps/x/signal orders user-1");
  });

  test("is available to function-call expressions", async () => {
    const { resolved } = await resolveTemplates("{{ trim(run.id) }}", {
      stepResults: {},
      run: { id: "run-7", workflow: "w", createdBy: null },
    });

    expect(resolved).toBe("run-7");
  });

  test("an unknown run field is left literal with a warning", async () => {
    const { resolved, warnings } = await resolveTemplates("{{run.nope}}", {
      stepResults: {},
      run: { id: "r", workflow: "w", createdBy: null },
    });

    expect(resolved).toBe("{{run.nope}}");
    expect(warnings).toHaveLength(1);
  });

  test("waitFor correlation keys can use the run namespace", async () => {
    const def: DagWorkflowDefinition = {
      ...correlatedDef,
      name: "run-keyed",
      steps: { ...correlatedDef.steps, paid: { type: "waitFor", event: "order.paid", correlate: "{{run.id}}" } },
    };
    const deps = createTestDeps([def]);
    const run = await startAndPark(def, deps);

    expect(signalStore.getWaitingForStep(run.id, "paid")!.correlationKey).toBe(run.id);
  });
});

describe("signal timeouts", () => {
  test("rearmWaiting fires an elapsed timeout and fails the run", async () => {
    const def: DagWorkflowDefinition = {
      name: "timeout-wf",
      trigger: { type: "manual" },
      steps: {
        start: { type: "agent", prompt: "start" },
        wait: { type: "waitFor", event: "late", timeout: 60_000 },
      },
      edges: [{ from: "start", to: "wait" }],
    };
    const deps = createTestDeps([def]);
    const run = await startAndPark(def, deps);
    const signal = signalStore.getWaitingForStep(run.id, "wait")!;

    // Simulate a restart: the in-memory timer is gone.
    signalTimers.cleanup();
    const armed = signalTimers.rearmWaiting({ log: deps.log, broadcast: deps.broadcast }, signal.createdAt + 120_000);
    await settle();

    expect(armed).toBe(1);
    expect(signalStore.getById(signal.id)!.status).toBe("timed_out");
    expect(dagRunStore.get(run.id)!.status).toBe("failed");
    expect(dagRunStore.get(run.id)!.stepStatuses.wait).toBe("failed");
  });

  test("rearmWaiting arms the remaining time of a pending timeout", async () => {
    const def: DagWorkflowDefinition = {
      name: "timeout-pending-wf",
      trigger: { type: "manual" },
      steps: {
        start: { type: "agent", prompt: "start" },
        wait: { type: "waitFor", event: "late", timeout: 60_000 },
      },
      edges: [{ from: "start", to: "wait" }],
    };
    const deps = createTestDeps([def]);
    const run = await startAndPark(def, deps);
    const signal = signalStore.getWaitingForStep(run.id, "wait")!;

    signalTimers.cleanup();
    const armed = signalTimers.rearmWaiting({ log: deps.log, broadcast: deps.broadcast }, signal.createdAt + 1_000);
    await settle();

    expect(armed).toBe(1);
    expect(signalTimers.activeCount()).toBe(1);
    expect(signalStore.getById(signal.id)!.status).toBe("waiting");
  });

  test("a timeout after the run ended leaves the run status alone", async () => {
    const def: DagWorkflowDefinition = {
      name: "timeout-ended-wf",
      trigger: { type: "manual" },
      steps: {
        start: { type: "agent", prompt: "start" },
        wait: { type: "waitFor", event: "late", timeout: 60_000 },
      },
      edges: [{ from: "start", to: "wait" }],
    };
    const deps = createTestDeps([def]);
    const run = await startAndPark(def, deps);
    const signal = signalStore.getWaitingForStep(run.id, "wait")!;
    dagRunStore.updateStatus(run.id, "failed", "other branch failed");

    signalTimers.arm(signal, 0, { log: deps.log, broadcast: deps.broadcast });
    await settle();

    expect(signalStore.getById(signal.id)!.status).toBe("timed_out");
    expect(dagRunStore.get(run.id)!.failureReason).toBe("other branch failed");
    expect(deps.broadcasts.some((b) => b.type === "workflow_failed")).toBe(false);
  });
});
