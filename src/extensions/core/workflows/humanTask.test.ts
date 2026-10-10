/**
 * Tests for the `humanTask` workflow node: task creation, answers resuming
 * the run, manager cancellation, timeouts, and the built-in output schema.
 *
 * Uses in-memory SQLite with the real HITL service and the real workflow
 * coordinator.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { HumanTaskUserRef } from "@shared/portal";
import { createHitlService, type HitlDirectory, type HitlService, type HitlViewer, TaskStore } from "@src/hitl";
import { createWorkflowTestDb } from "@src/test/db";
import { type DagCoordinatorDeps, handleDagStepCompletion } from "./dagCoordinator";
import { dispatchDagWorkflow } from "./dagEngine";
import * as dagRunStore from "./dagRunStore";
import { edgeId } from "./dagRunStore";
import { humanTaskOutputSchema } from "./humanTask";
import { cancelRunTasks, installHumanTaskSource } from "./humanTaskSource";
import type { DagHumanTaskStep, DagWorkflowDefinition } from "./schemas";
import { deliverSignal } from "./signalDelivery";
import * as signalStore from "./signalStore";
import * as signalTimers from "./signalTimers";

const USERS: Record<string, HumanTaskUserRef> = {
  "u-alice": { id: "u-alice", username: "alice", displayName: "Alice" },
  "u-admin": { id: "u-admin", username: "admin", displayName: null },
};
const directory: HitlDirectory = {
  findUserIdByUsername: (name) => Object.values(USERS).find((u) => u.username === name)?.id ?? null,
  roleExists: (name) => name === "accounting",
  describeUser: (id) => USERS[id] ?? null,
};
const alice: HitlViewer = { userId: "u-alice", roleNames: [], canManage: false };
const admin: HitlViewer = { userId: "u-admin", roleNames: [], canManage: true };

/** The approval workflow under test. */
function approvalDef(review: Partial<DagHumanTaskStep> = {}): DagWorkflowDefinition {
  return {
    name: "invoice-approval",
    trigger: { type: "manual" },
    steps: {
      extract: { type: "agent", prompt: "extract" },
      review: {
        type: "humanTask",
        title: "Approve invoice {{trigger.payload.number}}",
        body: "Amount: {{steps.extract.result}}",
        context: { invoice: "{{trigger.payload.number}}", run: "{{run.id}}" },
        assignees: { users: ["alice"] },
        form: { type: "object", properties: { costCenter: { type: "string" } }, required: ["costCenter"] },
        ...review,
      } as DagHumanTaskStep,
      book: { type: "agent", prompt: "book" },
    },
    edges: [
      { from: "extract", to: "review" },
      { from: "review", to: "book" },
    ],
  };
}

let service: HitlService;
let uninstall: () => void;

/** Coordinator deps that record dispatched step slugs. */
function createDeps(def: DagWorkflowDefinition): DagCoordinatorDeps & { dispatched: string[] } {
  const dispatched: string[] = [];
  let n = 0;
  return {
    dispatched,
    flowProducer: {
      add: async (job: any) => {
        dispatched.push(job.data.stepSlug);
        return { job: { id: `job-${++n}` } };
      },
    } as any,
    sessionFactory: { create: () => ({ id: `s-${Date.now()}` }) },
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    broadcast: () => {},
    getWorkflowDefinition: (name) => (name === def.name ? def : undefined),
    cancelJob: async () => {},
    hitl: service,
  };
}

/** Creates a run and completes `extract` so `review` is reached. */
async function reachReview(def: DagWorkflowDefinition, deps: DagCoordinatorDeps) {
  const edgeStates: Record<string, dagRunStore.EdgeState> = {};
  for (const e of def.edges) edgeStates[edgeId(e.from, e.to, e.branch)] = "pending";
  const stepStatuses: Record<string, dagRunStore.StepStatus> = {};
  for (const slug of Object.keys(def.steps)) stepStatuses[slug] = "pending";
  const run = dagRunStore.create({
    id: crypto.randomUUID(),
    workflowName: def.name,
    status: "running",
    edgeStates,
    stepStatuses,
    stepResults: {},
    triggerPayload: { number: "INV-42" },
    failureReason: null,
    createdByUserId: "u-admin",
  });
  dagRunStore.updateStepStatus(run.id, "extract", "running");
  await handleDagStepCompletion(run.id, "extract", "120 EUR", "job-extract", deps);
  return run;
}

const settle = () => Bun.sleep(5);

beforeEach(() => {
  const db = createWorkflowTestDb();
  service = createHitlService({ store: new TaskStore(db as never), directory });
});

afterEach(() => {
  uninstall?.();
  signalTimers.cleanup();
});

function install(deps: DagCoordinatorDeps) {
  uninstall = installHumanTaskSource({
    hitl: service,
    coordinatorDeps: deps,
    inFlightJobIds: async () => [],
    log: deps.log,
  });
}

describe("humanTask node", () => {
  test("creates a task with resolved templates and parks the step on an instance signal", async () => {
    const def = approvalDef();
    const deps = createDeps(def);
    install(deps);

    const run = await reachReview(def, deps);

    const after = dagRunStore.get(run.id)!;
    expect(after.stepStatuses.review).toBe("waiting-signal");
    expect(after.status).toBe("waiting-signal");
    const signal = signalStore.getWaitingForStep(run.id, "review")!;
    expect(signal).toMatchObject({ scope: "instance", source: "humanTask", event: "hitl.task" });

    const [task] = service.listOpenBySource("workflow", run.id);
    expect(task).toMatchObject({
      title: "Approve invoice INV-42",
      body: "Amount: 120 EUR",
      context: { invoice: "INV-42", run: run.id },
      createdBy: "u-admin",
      assignees: { users: ["u-alice"], roles: [] },
      source: { kind: "workflow", id: run.id, ref: { runId: run.id, stepSlug: "review", signalId: signal.id } },
    });
    expect(deps.dispatched).not.toContain("book");
  });

  test("an answer resumes the run with the answer as the step result", async () => {
    const def = approvalDef();
    const deps = createDeps(def);
    install(deps);
    const run = await reachReview(def, deps);
    const [task] = service.listOpenBySource("workflow", run.id);

    await service.completeTask(task!.id, alice, { outcome: "approve", data: { costCenter: "CC-7" }, comment: "ok" });
    await settle();

    const after = dagRunStore.get(run.id)!;
    expect(after.stepStatuses.review).toBe("completed");
    expect(after.stepResults.review).toMatchObject({
      outcome: "approve",
      data: { costCenter: "CC-7" },
      comment: "ok",
      respondedBy: { username: "alice" },
      taskId: task!.id,
    });
    expect(deps.dispatched).toContain("book");
  });

  test("the signal cannot be delivered outside the HITL service", async () => {
    const def = approvalDef();
    const deps = createDeps(def);
    install(deps);
    const run = await reachReview(def, deps);
    const signal = signalStore.getWaitingForStep(run.id, "review")!;

    expect(deliverSignal(signal.id, { outcome: "approve" }, { via: "route", coordinatorDeps: deps })).toMatchObject({
      ok: false,
      status: 409,
    });
  });

  test("a manager cancelling the task fails the run", async () => {
    const def = approvalDef();
    const deps = createDeps(def);
    install(deps);
    const run = await reachReview(def, deps);
    const [task] = service.listOpenBySource("workflow", run.id);
    const signal = signalStore.getWaitingForStep(run.id, "review")!;

    await service.cancelTask(task!.id, admin, "wrong vendor");

    const after = dagRunStore.get(run.id)!;
    expect(after.status).toBe("failed");
    expect(after.failureReason).toContain("wrong vendor");
    expect(signalStore.getById(signal.id)!.status).toBe("cancelled");
  });

  test("unknown assignees fail the run without leaving a deliverable signal", async () => {
    const def = approvalDef({ assignees: { users: ["nobody"] } });
    const deps = createDeps(def);
    install(deps);

    const run = await reachReview(def, deps);

    const after = dagRunStore.get(run.id)!;
    expect(after.status).toBe("failed");
    expect(after.failureReason).toContain("nobody");
    expect(signalStore.listWaitingForRun(run.id)).toEqual([]);
    expect(service.listOpenBySource("workflow", run.id)).toEqual([]);
  });

  test("unresolvable templates fail the run before anything is created", async () => {
    const def = approvalDef({ title: "Approve {{trigger.payload.missing}}" });
    const deps = createDeps(def);
    install(deps);

    const run = await reachReview(def, deps);

    expect(dagRunStore.get(run.id)!.failureReason).toContain("could not be prepared");
    expect(signalStore.listWaitingForRun(run.id)).toEqual([]);
  });

  test("without the HITL service the run fails", async () => {
    const def = approvalDef();
    const deps = { ...createDeps(def), hitl: undefined };

    const run = await reachReview(def, deps);

    expect(dagRunStore.get(run.id)!.failureReason).toContain("not available");
  });

  test("onTimeout expire resumes the run with outcome expired", async () => {
    const def = approvalDef({ timeout: 60_000, onTimeout: "expire" });
    const deps = createDeps(def);
    install(deps);
    const run = await reachReview(def, deps);
    const [task] = service.listOpenBySource("workflow", run.id);
    const signal = signalStore.getWaitingForStep(run.id, "review")!;

    signalTimers.arm(signal, 0, { log: deps.log, broadcast: deps.broadcast });
    await settle();

    expect(service.getRecord(task!.id)!.status).toBe("expired");
    const after = dagRunStore.get(run.id)!;
    expect(after.stepResults.review).toMatchObject({ outcome: "expired", respondedBy: null, taskId: task!.id });
    expect(deps.dispatched).toContain("book");
  });

  test("a timeout without onTimeout expires the task and fails the run", async () => {
    const def = approvalDef({ timeout: 60_000 });
    const deps = createDeps(def);
    install(deps);
    const run = await reachReview(def, deps);
    const [task] = service.listOpenBySource("workflow", run.id);
    const signal = signalStore.getWaitingForStep(run.id, "review")!;

    signalTimers.arm(signal, 0, { log: deps.log, broadcast: deps.broadcast });
    await settle();

    expect(service.getRecord(task!.id)!.status).toBe("expired");
    expect(dagRunStore.get(run.id)!.status).toBe("failed");
  });

  test("the task is due when the timeout elapses", async () => {
    const def = approvalDef({ timeout: 60_000 });
    const deps = createDeps(def);
    install(deps);
    const run = await reachReview(def, deps);

    const [task] = service.listOpenBySource("workflow", run.id);
    const signal = signalStore.getWaitingForStep(run.id, "review")!;
    expect(task!.dueAt).toBe(signal.createdAt + 60_000);
  });

  test("cancelRunTasks cancels the open tasks of a run", async () => {
    const def = approvalDef();
    const deps = createDeps(def);
    install(deps);
    const run = await reachReview(def, deps);

    expect(cancelRunTasks(service, run.id, "Workflow run deleted")).toBe(1);
    expect(service.listOpenBySource("workflow", run.id)).toEqual([]);
    expect(cancelRunTasks(undefined, run.id, "x")).toBe(0);
  });

  test("a humanTask root runs next to dispatched roots", async () => {
    const def: DagWorkflowDefinition = {
      name: "parallel-review",
      trigger: { type: "manual" },
      steps: {
        work: { type: "agent", prompt: "work" },
        review: { type: "humanTask", title: "Check", assignees: { users: ["alice"] } } as DagHumanTaskStep,
      },
      edges: [],
    };
    const deps = createDeps(def);
    const inline: string[] = [];

    await dispatchDagWorkflow(deps.flowProducer, def, null, deps.log, deps.sessionFactory, async (_runId, slugs) => {
      inline.push(...slugs);
    });

    expect(deps.dispatched).toEqual(["work"]);
    expect(inline).toEqual(["review"]);
  });
});

describe("humanTaskOutputSchema", () => {
  test("enumerates outcomes, adds expired, and uses the form as data", () => {
    const schema = humanTaskOutputSchema({
      type: "humanTask",
      title: "t",
      assignees: { users: ["alice"] },
      outcomes: [
        { id: "ok", label: "OK" },
        { id: "no", label: "No" },
      ],
      onTimeout: "expire",
      form: { type: "object", properties: { n: { type: "number" } } },
    }) as { properties: Record<string, any> };

    expect(schema.properties.outcome.enum).toEqual(["ok", "no", "expired"]);
    expect(schema.properties.data).toEqual({ type: "object", properties: { n: { type: "number" } } });
    expect(schema.properties.respondedBy.properties.username).toEqual({ type: "string" });
  });

  test("defaults to approve and reject", () => {
    const schema = humanTaskOutputSchema({ type: "humanTask", title: "t", assignees: {} }) as {
      properties: Record<string, any>;
    };
    expect(schema.properties.outcome.enum).toEqual(["approve", "reject"]);
  });
});
