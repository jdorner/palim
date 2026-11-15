/**
 * Tests for the run lifecycle: queue events driving the coordinator, the one
 * teardown sequence (remove / forget), clean decisions, and rerun.
 *
 * Uses an in-memory database and a fake steps queue whose jobs are created by
 * a fake flow producer.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { HitlApi, Logger } from "@ext/types";
import { createWorkflowTestDb } from "@src/test/db";
import type { DagStepJobData } from "./dagEngine";
import * as dagRunStore from "./dagRunStore";
import type { DagWorkflowDefinition } from "./schemas";
import * as signalStore from "./signalStore";
import * as signalTimers from "./signalTimers";
import { createWorkflowRuns, type StepsQueue, type WorkflowRuns, type WorkflowRunsMessage } from "./workflowRuns";

interface FakeJob {
  id: string;
  data: DagStepJobData;
  state: string;
  returnvalue?: unknown;
}

type Handler = (args: { jobId: string; job?: FakeJob; failedReason?: string }) => unknown;

/** A fake steps queue plus the recordings a test inspects. */
function createHarness(definitions: DagWorkflowDefinition[], withHitl = true) {
  const jobs: FakeJob[] = [];
  const handlers = new Map<string, Handler>();
  const broadcasts: WorkflowRunsMessage[] = [];
  const events: { type: string; context?: Record<string, unknown> }[] = [];
  const cancelledJobs: string[] = [];
  const cancelledTasks: { runId: string; reason: string }[] = [];
  let counter = 0;

  const stepsQueue = {
    getAllJobs: async () => jobs,
    cancelJob: async (id: string) => {
      cancelledJobs.push(id);
      const job = jobs.find((j) => j.id === id);
      if (job) job.state = "cancelled";
      return true;
    },
    // Like the real queue: returns only the IDs it removed; unknown IDs are skipped.
    removeJobs: async (ids: string[]) => {
      const removed: string[] = [];
      for (const id of ids) {
        const index = jobs.findIndex((j) => j.id === id);
        if (index === -1) continue;
        jobs.splice(index, 1);
        removed.push(id);
      }
      return removed;
    },
    getJobLogs: async () => ({ logs: [], count: 0 }),
    onEvent: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
  } as unknown as StepsQueue;

  const hitl = {
    registerSourceHandler: () => () => {},
    cancelBySource: (_source: string, runId: string, reason: string) => {
      cancelledTasks.push({ runId, reason });
      return 0;
    },
    listOpenBySource: () => [],
  } as unknown as HitlApi;

  const runs: WorkflowRuns = createWorkflowRuns({
    stepsQueue,
    flowProducer: {
      add: async (job: { data: DagStepJobData }) => {
        const id = `job-${++counter}`;
        jobs.push({ id, data: job.data, state: "waiting" });
        return { job: { id } };
      },
    } as never,
    sessionFactory: { create: () => ({ id: `sess-${++counter}` }) } as never,
    log: { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger,
    broadcast: (m) => broadcasts.push(m),
    emitEvent: (e) => events.push(e),
    getWorkflowDefinition: (name) => definitions.find((d) => d.name === name),
    hitl: withHitl ? hitl : undefined,
  });

  /** Fires a queue event for the job of a step, setting its state first. */
  async function fire(event: "completed" | "failed", slug: string, extra: Partial<FakeJob> = {}, reason?: string) {
    const job = jobs.find((j) => j.data.stepSlug === slug);
    if (!job) throw new Error(`no job for ${slug}`);
    Object.assign(job, { state: event, ...extra });
    await handlers.get(event)?.({ jobId: job.id, job, failedReason: reason });
  }

  return { runs, jobs, broadcasts, events, cancelledJobs, cancelledTasks, fire };
}

const fanOut: DagWorkflowDefinition = {
  name: "fan-out",
  trigger: { type: "manual" },
  steps: {
    a: { type: "agent", prompt: "start" },
    b: { type: "agent", prompt: "left" },
    c: { type: "agent", prompt: "right" },
  },
  edges: [
    { from: "a", to: "b" },
    { from: "a", to: "c" },
  ],
};

const waiting: DagWorkflowDefinition = {
  name: "waiting",
  trigger: { type: "manual" },
  steps: { wait: { type: "waitFor", event: "go", timeout: 60_000 } },
  edges: [],
};

let harness: ReturnType<typeof createHarness> | null = null;

beforeEach(() => {
  createWorkflowTestDb();
});

afterEach(() => {
  harness?.runs.dispose();
  harness = null;
});

describe("queue events", () => {
  test("a failed step cancels its siblings and open tasks and fails the run", async () => {
    harness = createHarness([fanOut]);
    const { runs, fire } = harness;
    const { workflowRunId } = await runs.start(fanOut, { x: 1 });
    await fire("completed", "a", { returnvalue: "ok" });
    expect(harness.jobs.map((j) => j.data.stepSlug).sort()).toEqual(["a", "b", "c"]);

    await fire("failed", "b", {}, "boom");

    const cJob = harness.jobs.find((j) => j.data.stepSlug === "c");
    expect(harness.cancelledJobs).toEqual([cJob?.id ?? ""]);
    expect(harness.cancelledTasks).toEqual([{ runId: workflowRunId, reason: "Workflow run failed: boom" }]);
    expect(dagRunStore.get(workflowRunId)?.status).toBe("failed");
    expect(harness.events.map((e) => e.type)).toContain("workflow:step_failed");
    expect(harness.broadcasts.map((b) => b.type)).toContain("workflow_failed");
  });

  test("a failed attempt that will be retried does not fail the run", async () => {
    harness = createHarness([fanOut]);
    const { workflowRunId } = await harness.runs.start(fanOut, null);
    // The handler reads the job's state: a retry delay is not a terminal failure.
    await harness.fire("failed", "a", { state: "delayed" }, "flaky");
    expect(dagRunStore.get(workflowRunId)?.status).toBe("running");
    expect(harness.broadcasts.some((b) => b.type === "workflow_step_failed")).toBe(true);
  });
});

describe("remove", () => {
  test("removes the jobs and releases timers, tasks, signals, and the run record", async () => {
    harness = createHarness([waiting]);
    const { workflowRunId } = await harness.runs.start(waiting, null);
    expect(signalStore.listWaitingForRun(workflowRunId)).toHaveLength(1);
    expect(signalTimers.activeCount()).toBe(1);

    const removed = await harness.runs.remove(workflowRunId);

    expect(removed).toEqual({ cancelled: [], total: 0 });
    expect(signalTimers.activeCount()).toBe(0);
    expect(signalStore.listWaitingForRun(workflowRunId)).toHaveLength(0);
    expect(dagRunStore.get(workflowRunId)).toBeNull();
    expect(harness.cancelledTasks).toEqual([{ runId: workflowRunId, reason: "Workflow run deleted" }]);
    expect(harness.broadcasts.at(-1)).toEqual({
      type: "workflow_run_removed",
      workflowRunId,
      workflowName: "waiting",
    });
  });

  test("broadcasts job_removed for every job before the run removal", async () => {
    harness = createHarness([fanOut]);
    const { workflowRunId, jobIds } = await harness.runs.start(fanOut, null);
    const removed = await harness.runs.remove(workflowRunId);
    expect(removed).toEqual({ cancelled: jobIds, total: 1 });
    expect(harness.jobs).toHaveLength(0);
    expect(harness.broadcasts.slice(-2).map((b) => b.type)).toEqual(["job_removed", "workflow_run_removed"]);
  });

  test("answers null for an unknown run", async () => {
    harness = createHarness([]);
    expect(await harness.runs.remove("nope")).toBeNull();
  });
});

describe("forget", () => {
  test("the queue clean's teardown releases the same resources as remove", async () => {
    harness = createHarness([waiting]);
    const { workflowRunId } = await harness.runs.start(waiting, null);
    const jobsBefore = harness.jobs.length;

    harness.runs.forget(new Map([[workflowRunId, "waiting"]]));

    expect(signalTimers.activeCount()).toBe(0);
    expect(signalStore.listWaitingForRun(workflowRunId)).toHaveLength(0);
    expect(dagRunStore.get(workflowRunId)).toBeNull();
    expect(harness.cancelledTasks).toEqual([{ runId: workflowRunId, reason: "Workflow run deleted" }]);
    expect(harness.broadcasts.at(-1)).toEqual({
      type: "workflow_run_removed",
      workflowRunId,
      workflowName: "waiting",
    });
    // The queue's jobs are the caller's to remove (the monitor already did).
    expect(harness.jobs).toHaveLength(jobsBefore);
  });

  test("announces runs whose record is already gone under the given workflow name", () => {
    harness = createHarness([]);
    harness.runs.forget(
      new Map([
        ["orphan-1", "wf-a"],
        ["orphan-2", undefined],
      ]),
    );
    expect(harness.broadcasts).toEqual([
      { type: "workflow_run_removed", workflowRunId: "orphan-1", workflowName: "wf-a" },
      { type: "workflow_run_removed", workflowRunId: "orphan-2", workflowName: undefined },
    ]);
  });

  test("does nothing for an empty map", () => {
    harness = createHarness([]);
    harness.runs.forget(new Map());
    expect(harness.broadcasts).toEqual([]);
    expect(harness.cancelledTasks).toEqual([]);
  });
});

describe("cleanDecision", () => {
  test("keeps active runs, removes matching terminal runs, keeps mismatches", async () => {
    harness = createHarness([fanOut]);
    const { workflowRunId } = await harness.runs.start(fanOut, null);
    expect(harness.runs.cleanDecision(workflowRunId, "completed")).toBe("keep");
    dagRunStore.updateStatus(workflowRunId, "failed", "x");
    expect(harness.runs.cleanDecision(workflowRunId, "failed")).toBe("remove");
    expect(harness.runs.cleanDecision(workflowRunId, "completed")).toBe("keep");
    expect(harness.runs.cleanDecision("orphan", "completed")).toBe("default");
  });
});

describe("rerun", () => {
  test("starts a new run with the failed run's payload", async () => {
    harness = createHarness([fanOut]);
    const first = await harness.runs.start(fanOut, { x: 1 });
    expect(await harness.runs.rerun(first.workflowRunId)).toEqual({ ok: false, reason: "not_failed" });
    dagRunStore.updateStatus(first.workflowRunId, "failed", "x");

    const result = await harness.runs.rerun(first.workflowRunId, "u1");

    if (!result.ok) throw new Error(result.reason);
    expect(result.workflowRunId).not.toBe(first.workflowRunId);
    expect(dagRunStore.get(result.workflowRunId)?.triggerPayload).toEqual({ x: 1 });
    expect(dagRunStore.get(first.workflowRunId)?.status).toBe("failed");
  });

  test("refuses unknown runs", async () => {
    harness = createHarness([]);
    expect(await harness.runs.rerun("nope")).toEqual({ ok: false, reason: "run_not_found" });
  });
});
