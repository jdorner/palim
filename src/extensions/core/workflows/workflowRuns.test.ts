/**
 * Tests for the run lifecycle: queue events driving the coordinator, cancel,
 * the one teardown sequence (remove / forget), clean decisions, and rerun.
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
  timestamp?: number;
}

type Handler = (args: { jobId: string; job?: FakeJob; failedReason?: string }) => unknown;

/** A fake steps queue plus the recordings a test inspects. */
function createHarness(definitions: DagWorkflowDefinition[], withHitl = true) {
  const jobs: FakeJob[] = [];
  const handlers = new Map<string, Handler>();
  const broadcasts: WorkflowRunsMessage[] = [];
  const events: { type: string; context?: Record<string, unknown> }[] = [];
  const cancelledJobs: string[] = [];
  const cancelReasons: (string | undefined)[] = [];
  const cancelledTasks: { runId: string; reason: string }[] = [];
  const appendedLogs: { jobId: string; message: string }[] = [];
  let counter = 0;

  const stepsQueue = {
    getAllJobs: async () => jobs,
    cancelJob: async (id: string, reason?: string) => {
      cancelledJobs.push(id);
      cancelReasons.push(reason);
      const job = jobs.find((j) => j.id === id);
      if (job?.state === "active") {
        // Like the real worker: the aborted processor throws, the job fails with the reason.
        setTimeout(() => {
          job.state = "failed";
          void handlers.get("failed")?.({ jobId: id, job, failedReason: reason });
        }, 10);
      } else if (job) {
        // Like the real queue: a job that has not started is failed at once.
        job.state = "failed";
        void handlers.get("failed")?.({ jobId: id, job, failedReason: reason });
      }
      return job ? "cancelled" : "not_found";
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
    appendJobLog: async (jobId: string, message: string) => {
      appendedLogs.push({ jobId, message });
    },
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

  return { runs, jobs, broadcasts, events, cancelledJobs, cancelReasons, cancelledTasks, appendedLogs, fire };
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

  test("a cancelled step fails the run and cancels its siblings, without a step_failed event", async () => {
    harness = createHarness([fanOut]);
    const { workflowRunId } = await harness.runs.start(fanOut, null);
    await harness.fire("completed", "a", { returnvalue: "ok" });

    await harness.fire("failed", "b", {}, "Cancelled by alice");

    const cJob = harness.jobs.find((j) => j.data.stepSlug === "c");
    expect(harness.cancelledJobs).toEqual([cJob?.id ?? ""]);
    expect(harness.cancelReasons).toEqual(["Cancelled: the workflow run failed"]);
    expect(dagRunStore.get(workflowRunId)?.status).toBe("failed");
    expect(dagRunStore.get(workflowRunId)?.failureReason).toContain("Cancelled by alice");
    // A deliberate stop is no error for the error-analyzer.
    expect(harness.events.map((e) => e.type)).not.toContain("workflow:step_failed");
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

describe("cancel", () => {
  test("fails a running run and cancels its in-flight steps with the user's reason; run and jobs stay", async () => {
    harness = createHarness([fanOut]);
    const { workflowRunId, jobIds } = await harness.runs.start(fanOut, null);

    expect(await harness.runs.cancel(workflowRunId, "alice")).toEqual({ ok: true });

    const run = dagRunStore.get(workflowRunId);
    expect(run?.status).toBe("failed");
    expect(run?.failureReason).toBe("Cancelled by alice");
    // The running step's job fails once cancelled, so the step fails; the others never started.
    expect(run?.stepStatuses).toEqual({ a: "failed", b: "dead", c: "dead" });
    expect(harness.cancelledJobs).toEqual(jobIds);
    expect(harness.cancelReasons).toEqual(["Cancelled by alice"]);
    // Cancelling never deletes: the step job is failed and still listed.
    expect(harness.jobs.map((j) => [j.id, j.state])).toEqual([[jobIds[0] ?? "", "failed"]]);
    expect(harness.cancelledTasks).toEqual([
      { runId: workflowRunId, reason: "Workflow run failed: Cancelled by alice" },
    ]);
    expect(harness.broadcasts).toContainEqual({
      type: "workflow_failed",
      workflowRunId,
      failedStep: "",
      error: "Cancelled by alice",
    });
    // A deliberate stop is no error for the error-analyzer.
    expect(harness.events.map((e) => e.type)).not.toContain("workflow:step_failed");
  });

  test("cancels a run waiting on a signal: withdraws the signal and clears its timer", async () => {
    harness = createHarness([waiting]);
    const { workflowRunId } = await harness.runs.start(waiting, null);
    const [signal] = signalStore.listWaitingForRun(workflowRunId);
    expect(signalTimers.activeCount()).toBe(1);

    expect(await harness.runs.cancel(workflowRunId)).toEqual({ ok: true });

    const run = dagRunStore.get(workflowRunId);
    expect(run?.status).toBe("failed");
    expect(run?.failureReason).toBe("Cancelled");
    expect(run?.stepStatuses.wait).toBe("failed");
    expect(signalTimers.activeCount()).toBe(0);
    expect(signalStore.getById(signal?.id ?? "")?.status).toBe("cancelled");
  });

  test("refuses finished and unknown runs", async () => {
    harness = createHarness([fanOut]);
    const { workflowRunId } = await harness.runs.start(fanOut, null);
    await harness.runs.cancel(workflowRunId);

    expect(await harness.runs.cancel(workflowRunId)).toEqual({ ok: false, reason: "not_active" });
    expect(await harness.runs.cancel("nope")).toEqual({ ok: false, reason: "run_not_found" });
  });
});

describe("remove", () => {
  test("refuses an active run and leaves it untouched", async () => {
    harness = createHarness([waiting]);
    const { workflowRunId } = await harness.runs.start(waiting, null);

    expect(await harness.runs.remove(workflowRunId)).toEqual({ ok: false, reason: "not_finished" });

    expect(dagRunStore.get(workflowRunId)?.status).toBe("waiting-signal");
    expect(signalStore.listWaitingForRun(workflowRunId)).toHaveLength(1);
    expect(signalTimers.activeCount()).toBe(1);
  });

  test("deletes a finished run and releases its tasks, signals, and record", async () => {
    harness = createHarness([waiting]);
    const { workflowRunId } = await harness.runs.start(waiting, null);
    const signalId = signalStore.listWaitingForRun(workflowRunId)[0]?.id ?? "";
    await harness.runs.cancel(workflowRunId);

    expect(await harness.runs.remove(workflowRunId)).toEqual({ ok: true, removed: [], total: 0 });

    expect(signalStore.getById(signalId)).toBeNull();
    expect(dagRunStore.get(workflowRunId)).toBeNull();
    expect(harness.cancelledTasks.at(-1)).toEqual({ runId: workflowRunId, reason: "Workflow run deleted" });
    expect(harness.broadcasts.at(-1)).toEqual({
      type: "workflow_run_removed",
      workflowRunId,
      workflowName: "waiting",
    });
  });

  test("removes every job and broadcasts job_removed before the run removal", async () => {
    harness = createHarness([fanOut]);
    const { workflowRunId, jobIds } = await harness.runs.start(fanOut, null);
    await harness.runs.cancel(workflowRunId);

    expect(await harness.runs.remove(workflowRunId)).toEqual({ ok: true, removed: jobIds, total: 1 });
    expect(harness.jobs).toHaveLength(0);
    expect(harness.broadcasts.slice(-2).map((b) => b.type)).toEqual(["job_removed", "workflow_run_removed"]);
  });

  test("refuses while a cancelled step is still stopping, then deletes once it has ended", async () => {
    harness = createHarness([fanOut]);
    const { workflowRunId, jobIds } = await harness.runs.start(fanOut, null);
    const aJob = harness.jobs.find((j) => j.id === jobIds[0]);
    if (!aJob) throw new Error("no job for a");
    aJob.state = "active";
    await harness.runs.cancel(workflowRunId);

    expect(await harness.runs.remove(workflowRunId)).toEqual({ ok: false, reason: "jobs_live" });
    expect(harness.jobs).toHaveLength(1);

    await Bun.sleep(30);
    expect(aJob.state).toBe("failed");
    expect(await harness.runs.remove(workflowRunId)).toEqual({ ok: true, removed: [aJob.id], total: 1 });
  });

  test("answers run_not_found for an unknown run", async () => {
    harness = createHarness([]);
    expect(await harness.runs.remove("nope")).toEqual({ ok: false, reason: "run_not_found" });
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

describe("stepLogs", () => {
  const review: DagWorkflowDefinition = {
    name: "review",
    trigger: { type: "manual" },
    steps: {
      extract: { type: "agent", prompt: "extract" },
      review: { type: "humanTask", title: "Check it" },
    },
    edges: [{ from: "extract", to: "review" }],
  } as DagWorkflowDefinition;

  test("lists inline steps from the run record, with the inline failure as a log line", async () => {
    harness = createHarness([review], false);
    const { workflowRunId } = await harness.runs.start(review, null);
    await harness.fire("completed", "extract", { returnvalue: { text: "ok" } });

    const logs = await harness.runs.stepLogs(workflowRunId);

    expect(logs?.steps.map((s) => [s.slug, s.type, s.status])).toEqual([
      ["extract", "agent", "completed"],
      ["review", "humanTask", "failed"],
    ]);
    expect(logs?.steps[1]?.logs.map((l) => l.message)).toEqual([
      "Error: Human tasks are disabled (set HITL_ENABLED=true)",
    ]);
  });

  test("lists a waiting signal step that never had a job", async () => {
    harness = createHarness([waiting]);
    const { workflowRunId } = await harness.runs.start(waiting, null);
    const logs = await harness.runs.stepLogs(workflowRunId);
    expect(logs?.steps).toEqual([{ slug: "wait", type: "waitFor", status: "waiting-signal", logs: [], count: 0 }]);
  });

  test("answers null for an unknown run", async () => {
    harness = createHarness([]);
    expect(await harness.runs.stepLogs("nope")).toBeNull();
  });
});

describe("recoverInterrupted", () => {
  /** A cutoff after every write of the test: the runs count as written by an earlier process. */
  const afterAllWrites = () => Date.now() + 1000;

  test("fails a run whose active step job was moved to the DLQ by a restart", async () => {
    harness = createHarness([fanOut]);
    const { workflowRunId, jobIds } = await harness.runs.start(fanOut, null);
    // bunqueue's startup recovery: the job lands in the DLQ without a queue event.
    const job = harness.jobs.find((j) => j.id === jobIds[0]);
    if (job) job.state = "failed";

    expect(await harness.runs.recoverInterrupted(afterAllWrites())).toBe(1);

    const run = dagRunStore.get(workflowRunId);
    expect(run?.status).toBe("failed");
    expect(run?.stepStatuses.a).toBe("failed");
    expect(run?.failureReason).toBe(`Step was interrupted by a server restart (job ${jobIds[0]} is failed)`);
    // The step panel shows the job's logs, so the reason ends them.
    expect(harness.appendedLogs).toEqual([
      { jobId: jobIds[0] ?? "", message: `Step "a" failed: ${run?.failureReason}` },
    ]);
    expect(harness.events.map((e) => e.type)).toContain("workflow:step_failed");
    expect(harness.broadcasts.map((b) => b.type)).toContain("workflow_step_failed");
  });

  test("fails a running step that has no job at all", async () => {
    harness = createHarness([fanOut]);
    const { workflowRunId } = await harness.runs.start(fanOut, null);
    harness.jobs.length = 0;

    expect(await harness.runs.recoverInterrupted(afterAllWrites())).toBe(1);

    expect(dagRunStore.get(workflowRunId)?.failureReason).toBe("Step was interrupted by a server restart");
    // Without a job there is no job failure to report to other extensions.
    expect(harness.events.map((e) => e.type)).not.toContain("workflow:step_failed");
    expect(harness.appendedLogs).toEqual([]);
  });

  test("leaves steps whose job is still queued or active", async () => {
    harness = createHarness([fanOut]);
    const { workflowRunId } = await harness.runs.start(fanOut, null);
    expect(await harness.runs.recoverInterrupted(afterAllWrites())).toBe(0);
    const job = harness.jobs[0];
    if (job) job.state = "active";
    expect(await harness.runs.recoverInterrupted(afterAllWrites())).toBe(0);
    expect(dagRunStore.get(workflowRunId)?.status).toBe("running");
  });

  test("judges a step by its newest job", async () => {
    harness = createHarness([fanOut]);
    const { workflowRunId } = await harness.runs.start(fanOut, null);
    const first = harness.jobs[0];
    if (!first) throw new Error("no job");
    Object.assign(first, { state: "failed", timestamp: 1 });
    harness.jobs.push({ id: "job-newer", data: first.data, state: "active", timestamp: 2 });

    expect(await harness.runs.recoverInterrupted(afterAllWrites())).toBe(0);
    expect(dagRunStore.get(workflowRunId)?.status).toBe("running");
  });

  test("leaves runs written by this process", async () => {
    harness = createHarness([fanOut]);
    const { workflowRunId } = await harness.runs.start(fanOut, null);
    harness.jobs.length = 0;

    expect(await harness.runs.recoverInterrupted(0)).toBe(0);
    expect(dagRunStore.get(workflowRunId)?.status).toBe("running");
  });

  test("leaves runs parked on a signal", async () => {
    harness = createHarness([waiting]);
    const { workflowRunId } = await harness.runs.start(waiting, null);

    expect(await harness.runs.recoverInterrupted(afterAllWrites())).toBe(0);
    expect(dagRunStore.get(workflowRunId)?.status).toBe("waiting-signal");
  });
});
