/**
 * Tests for {@link QueueMonitor}: stale cache entries (jobs that stalled into
 * the DLQ or vanished from their queue), cancelling (one job, which ends
 * failed and stays listed), deleting (finished jobs only), and the clean guard.
 *
 * Since stall detection requires the worker heartbeat to stop (which doesn't
 * happen in a single-process test), we simulate the post-stall state by using
 * a mock ManagedQueuePort that represents the queue after bunqueue has moved
 * jobs to DLQ.
 */

import { describe, expect, test } from "bun:test";
import type { JobInfo, ManagedQueuePort, QueueEventHandler, QueueEventType, QueueJobLogs } from "@src/queue";
import { QueueMonitor } from "./monitor";

/**
 * Helper: extracts the current initial_state snapshot from the monitor.
 * Since addClient sends initial_state, we capture it via a minimal WebSocket fake.
 */
function getMonitorJobs(monitor: QueueMonitor): { id: string; status: string; queue: string }[] {
  let captured: { id: string; status: string; queue: string }[] = [];
  const fakeWs = {
    send(payload: string) {
      const msg = JSON.parse(payload);
      if (msg.type === "initial_state") {
        captured = msg.jobs.map((j: { id: string; status: string; queue: string }) => ({
          id: j.id,
          status: j.status,
          queue: j.queue,
        }));
      }
    },
  };
  monitor.addClient(fakeWs as any);
  monitor.removeClient(fakeWs as any);
  return captured;
}

/** Lets the monitor's async event handlers run. */
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Creates a fake ManagedQueuePort that simulates a queue containing jobs.
 * Event handlers are captured so we can fire them manually to simulate
 * bunqueue's lifecycle events (waiting, active, stalled, etc.).
 */
function createFakeQueue(queueName: string, jobs: JobInfo[] = []) {
  const handlers = new Map<string, QueueEventHandler<any>[]>();
  let currentJobs = [...jobs];

  /** Fire a registered event handler (simulates bunqueue emitting the event). */
  function emit<E extends QueueEventType>(event: E, payload: Parameters<QueueEventHandler<E>>[0]) {
    const list = handlers.get(event) ?? [];
    for (const handler of list) {
      handler(payload);
    }
  }

  const queue: ManagedQueuePort = {
    name: queueName,
    async add() {
      return "";
    },
    async getJob(jobId: string) {
      return currentJobs.find((j) => j.id === jobId) ?? null;
    },
    async getWaiting() {
      return currentJobs.filter((j) => j.state === "waiting");
    },
    async getActive() {
      return currentJobs.filter((j) => j.state === "active");
    },
    async getDelayed() {
      return currentJobs.filter((j) => j.state === "delayed");
    },
    async getAllJobs() {
      return [...currentJobs];
    },
    async getJobLogs(): Promise<QueueJobLogs> {
      return { logs: [], count: 0 };
    },
    async appendJobLog() {},
    onEvent<E extends QueueEventType>(event: E, handler: QueueEventHandler<E>) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    offEvent() {},
    async cancelJob(jobId: string, reason = "Cancelled") {
      // Mirrors ManagedQueue: a cancelled job is failed, never removed.
      const job = currentJobs.find((j) => j.id === jobId);
      if (!job) return "not_found";
      if (job.state === "completed" || job.state === "failed") return "finished";
      job.state = "failed";
      emit("failed", { jobId, failedReason: reason, job });
      return "cancelled";
    },
    async removeJobs(jobIds: string[]) {
      const present = new Set(currentJobs.filter((j) => jobIds.includes(j.id)).map((j) => j.id));
      currentJobs = currentJobs.filter((j) => !present.has(j.id));
      return [...present];
    },
    async retryJob(jobId: string) {
      const job = currentJobs.find((j) => j.id === jobId);
      if (job?.state !== "failed") return false;
      job.state = "waiting";
      return true;
    },
    async clean() {
      return [];
    },
    async close() {},
    async upsertScheduler() {
      return null;
    },
    async removeScheduler() {
      return false;
    },
    async getScheduler() {
      return null;
    },
    async getSchedulers() {
      return [];
    },
  };

  return {
    queue,
    emit,
    /** Mutate a job's state to simulate bunqueue internal transitions (e.g. stall -> DLQ). */
    setJobState(jobId: string, state: JobInfo["state"]) {
      const job = currentJobs.find((j) => j.id === jobId);
      if (job) job.state = state;
    },
    /** Remove a job entirely (simulates bunqueue removing from storage after DLQ purge). */
    removeJob(jobId: string) {
      currentJobs = currentJobs.filter((j) => j.id !== jobId);
    },
  };
}

/** A plain agent job in the given state. */
function agentJob(id: string, state: JobInfo["state"] = "waiting"): JobInfo {
  return { id, name: "test-job", queueName: "agents", data: { prompt: "hello" }, state, timestamp: Date.now() };
}

/** A workflow step job of a run. */
function stepJob(id: string, workflowRunId: string, stepSlug: string, state: JobInfo["state"] = "waiting"): JobInfo {
  return {
    id,
    name: stepSlug,
    queueName: "workflows:steps",
    data: { workflowRunId, workflowName: "test-wf", stepSlug },
    state,
    timestamp: Date.now(),
  };
}

describe("QueueMonitor stale cache", () => {
  test("job that stalls and moves to DLQ shows as failed, not active", async () => {
    const jobId = "job-stalled-001";
    const fake = createFakeQueue("agents", [agentJob(jobId)]);
    const monitor = new QueueMonitor([fake.queue]);
    await tick(50);
    expect(getMonitorJobs(monitor).find((j) => j.id === jobId)?.status).toBe("waiting");

    fake.setJobState(jobId, "active");
    fake.emit("active", { jobId, job: await fake.queue.getJob(jobId) });
    await tick();
    expect(getMonitorJobs(monitor).find((j) => j.id === jobId)?.status).toBe("active");

    // bunqueue moves a stalled job to the DLQ (state "failed") and emits "stalled".
    fake.setJobState(jobId, "failed");
    fake.emit("stalled", { jobId, job: await fake.queue.getJob(jobId) });
    await tick();
    expect(getMonitorJobs(monitor).find((j) => j.id === jobId)?.status).toBe("failed");
  });

  test("workflow step that stalls shows as failed", async () => {
    const fake = createFakeQueue("workflows:steps", [stepJob("s0", "run-1", "fetch"), stepJob("s1", "run-1", "next")]);
    const monitor = new QueueMonitor([fake.queue]);
    await tick(50);

    fake.setJobState("s0", "active");
    fake.emit("active", { jobId: "s0", job: await fake.queue.getJob("s0") });
    await tick();
    fake.setJobState("s0", "failed");
    fake.emit("stalled", { jobId: "s0", job: await fake.queue.getJob("s0") });
    await tick();

    const jobs = getMonitorJobs(monitor);
    expect(jobs.find((j) => j.id === "s0")?.status).toBe("failed");
    expect(jobs.find((j) => j.id === "s1")?.status).toBe("waiting");
  });

  test("deleting a job that is gone from its queue evicts the stale entry", async () => {
    const jobId = "job-gone-003";
    const fake = createFakeQueue("agents", [agentJob(jobId, "active")]);
    const monitor = new QueueMonitor([fake.queue]);
    await tick(50);

    // Removed from bunqueue's storage behind the monitor's back (e.g. a DLQ purge).
    fake.removeJob(jobId);
    expect(await monitor.cancelJob(jobId)).toBe("not_found");
    expect(getMonitorJobs(monitor).find((j) => j.id === jobId)).toBeDefined();

    expect(await monitor.deleteJob(jobId)).toBe("deleted");
    expect(getMonitorJobs(monitor).find((j) => j.id === jobId)).toBeUndefined();
  });
});

describe("QueueMonitor.cancelJob", () => {
  test("a cancelled job ends failed and stays listed", async () => {
    const jobId = "job-cancel-001";
    const fake = createFakeQueue("agents", [agentJob(jobId)]);
    const monitor = new QueueMonitor([fake.queue]);
    await tick(50);

    expect(await monitor.cancelJob(jobId, "Cancelled by alice")).toBe("cancelled");
    await tick();

    expect(getMonitorJobs(monitor).find((j) => j.id === jobId)?.status).toBe("failed");
    expect((await fake.queue.getJob(jobId))?.state).toBe("failed");
  });

  test("a finished job is reported as finished and left alone", async () => {
    const jobId = "job-stalled-002";
    const fake = createFakeQueue("agents", [agentJob(jobId, "failed")]);
    const monitor = new QueueMonitor([fake.queue]);
    await tick(50);

    expect(await monitor.cancelJob(jobId)).toBe("finished");
    expect(getMonitorJobs(monitor).find((j) => j.id === jobId)?.status).toBe("failed");
  });

  test("cancelling a workflow step leaves the run's other steps alone", async () => {
    const fake = createFakeQueue("workflows:steps", [
      stepJob("s0", "run-2", "fetch", "completed"),
      stepJob("s1", "run-2", "transform"),
      stepJob("s2", "run-2", "notify", "delayed"),
    ]);
    const monitor = new QueueMonitor([fake.queue]);
    await tick(50);

    expect(await monitor.cancelJob("s1")).toBe("cancelled");
    await tick();

    const jobs = getMonitorJobs(monitor);
    expect(jobs.find((j) => j.id === "s0")?.status).toBe("completed");
    expect(jobs.find((j) => j.id === "s1")?.status).toBe("failed");
    expect(jobs.find((j) => j.id === "s2")?.status).toBe("delayed");
  });
});

describe("QueueMonitor.deleteJob", () => {
  test("deletes a finished job, which does not come back after a restart", async () => {
    const jobId = "job-persist-001";
    const fake = createFakeQueue("agents", [agentJob(jobId, "failed")]);
    const monitor = new QueueMonitor([fake.queue]);
    await tick(50);

    expect(await monitor.deleteJob(jobId)).toBe("deleted");
    expect(getMonitorJobs(monitor).find((j) => j.id === jobId)).toBeUndefined();

    // A new monitor backfills from the queue: the job is gone from it.
    const monitor2 = new QueueMonitor([fake.queue]);
    await tick(50);
    expect(getMonitorJobs(monitor2).find((j) => j.id === jobId)).toBeUndefined();
  });

  test("refuses a job that has not finished", async () => {
    const fake = createFakeQueue("agents", [agentJob("j-wait"), agentJob("j-active", "active")]);
    const monitor = new QueueMonitor([fake.queue]);
    await tick(50);

    expect(await monitor.deleteJob("j-wait")).toBe("not_finished");
    expect(await monitor.deleteJob("j-active")).toBe("not_finished");
    expect(
      getMonitorJobs(monitor)
        .map((j) => j.id)
        .sort(),
    ).toEqual(["j-active", "j-wait"]);
  });

  test("refuses a workflow step: the run is deleted as a whole", async () => {
    const fake = createFakeQueue("workflows:steps", [stepJob("s0", "run-3", "fetch", "completed")]);
    const monitor = new QueueMonitor([fake.queue]);
    await tick(50);

    expect(await monitor.deleteJob("s0")).toBe("workflow_step");
    expect((await fake.queue.getJob("s0"))?.state).toBe("completed");
  });

  test("returns not_found for an unknown job", async () => {
    const monitor = new QueueMonitor([createFakeQueue("agents").queue]);
    expect(await monitor.deleteJob("nope")).toBe("not_found");
  });
});

describe("QueueMonitor.retryJob", () => {
  test("moves a failed job back to waiting", async () => {
    const fake = createFakeQueue("agents", [agentJob("j-failed", "failed")]);
    const monitor = new QueueMonitor([fake.queue]);
    await tick(50);

    expect(await monitor.retryJob("j-failed")).toBe("retried");
    expect((await fake.queue.getJob("j-failed"))?.state).toBe("waiting");
    expect(getMonitorJobs(monitor).find((j) => j.id === "j-failed")?.status).toBe("waiting");
  });

  test("refuses a job that has not failed", async () => {
    const fake = createFakeQueue("agents", [agentJob("j-done", "completed")]);
    const monitor = new QueueMonitor([fake.queue]);
    await tick(50);

    expect(await monitor.retryJob("j-done")).toBe("not_failed");
  });

  test("refuses a workflow step: its failed run would ignore the result", async () => {
    const fake = createFakeQueue("workflows:steps", [stepJob("s0", "run-4", "fetch", "failed")]);
    const monitor = new QueueMonitor([fake.queue]);
    await tick(50);

    expect(await monitor.retryJob("s0")).toBe("workflow_step");
    expect((await fake.queue.getJob("s0"))?.state).toBe("failed");
  });

  test("returns not_found for an unknown job", async () => {
    const monitor = new QueueMonitor([createFakeQueue("agents").queue]);
    expect(await monitor.retryJob("nope")).toBe("not_found");
  });
});

describe("QueueMonitor clean guard - protected jobs", () => {
  /**
   * Creates a fake queue whose `clean` mimics bunqueue's real semantics: it
   * removes jobs in the target state that completed before the grace cutoff
   * (`now - grace`), oldest-first, up to `limit`. `cancelJob` never removes
   * a job (matching ManagedQueue), so the guarded clean path is exercised
   * through `clean`.
   */
  function createCleanableQueue(queueName: string, jobs: JobInfo[]) {
    let currentJobs = [...jobs];
    const queue: ManagedQueuePort = {
      name: queueName,
      async add() {
        return "";
      },
      async getJob(jobId: string) {
        return currentJobs.find((j) => j.id === jobId) ?? null;
      },
      async getWaiting() {
        return currentJobs.filter((j) => j.state === "waiting");
      },
      async getActive() {
        return currentJobs.filter((j) => j.state === "active");
      },
      async getDelayed() {
        return currentJobs.filter((j) => j.state === "delayed");
      },
      async getAllJobs() {
        return [...currentJobs];
      },
      async getJobLogs(): Promise<QueueJobLogs> {
        return { logs: [], count: 0 };
      },
      async appendJobLog() {},
      onEvent() {},
      offEvent() {},
      async cancelJob(jobId: string) {
        const job = currentJobs.find((j) => j.id === jobId);
        if (!job) return "not_found" as const;
        if (job.state === "completed" || job.state === "failed") return "finished" as const;
        job.state = "failed";
        return "cancelled" as const;
      },
      async removeJobs(jobIds: string[]) {
        // Batch removal handles every state, including completed.
        const present = new Set(currentJobs.filter((j) => jobIds.includes(j.id)).map((j) => j.id));
        currentJobs = currentJobs.filter((j) => !present.has(j.id));
        return [...present];
      },
      async retryJob() {
        return false;
      },
      async clean(grace: number, limit: number, type?: string) {
        const state = type ?? "completed";
        const cutoff = Date.now() - grace;
        const eligible = currentJobs
          .filter((j) => j.state === state && (j.finishedOn ?? j.timestamp) <= cutoff)
          .sort((a, b) => (a.finishedOn ?? a.timestamp) - (b.finishedOn ?? b.timestamp))
          .slice(0, limit);
        const ids = new Set(eligible.map((j) => j.id));
        currentJobs = currentJobs.filter((j) => !ids.has(j.id));
        return [...ids];
      },
      async close() {},
      async upsertScheduler() {
        return null;
      },
      async removeScheduler() {
        return false;
      },
      async getScheduler() {
        return null;
      },
      async getSchedulers() {
        return [];
      },
    };
    return { queue, remaining: () => currentJobs.map((j) => j.id) };
  }

  test("keeps completed step jobs of an active run and removes those of a terminal run", async () => {
    const activeRunId = "run-active";
    const doneRunId = "run-done";
    // Guarded clean selects the exact non-protected job IDs and removes them via
    // removeJobs, so the active run's step is kept and the terminal run's step
    // is removed regardless of their relative completion order.
    const { queue, remaining } = createCleanableQueue("workflows:steps", [
      {
        id: "active-step-0",
        name: "step-0",
        queueName: "workflows:steps",
        data: { workflowRunId: activeRunId },
        state: "completed",
        timestamp: 5_000,
        finishedOn: 5_000,
      },
      {
        id: "done-step-0",
        name: "step-0",
        queueName: "workflows:steps",
        data: { workflowRunId: doneRunId },
        state: "completed",
        timestamp: 1_000,
        finishedOn: 1_000,
      },
    ]);

    const monitor = new QueueMonitor([queue]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Keep the active run's step; the terminal run's step cleans by default.
    monitor.setCleanGuard((job) => (job.workflowRunId === activeRunId ? "keep" : "default"));

    const removed = await monitor.cleanAllQueues(0, 100, "completed");

    expect(removed).toContain("done-step-0");
    expect(removed).not.toContain("active-step-0");
    expect(remaining()).toContain("active-step-0");
    expect(remaining()).not.toContain("done-step-0");

    // The active run's step must still be visible in the monitor snapshot.
    const snapshot = getMonitorJobs(monitor);
    expect(snapshot.find((j) => j.id === "active-step-0")).not.toBeUndefined();
    expect(snapshot.find((j) => j.id === "done-step-0")).toBeUndefined();
  });

  test("cleans completed jobs via bulk clean when nothing is protected", async () => {
    const { queue, remaining } = createCleanableQueue("agents", [
      {
        id: "done-a",
        name: "job",
        queueName: "agents",
        data: {},
        state: "completed",
        timestamp: 1_000,
        finishedOn: 1_000,
      },
      {
        id: "done-b",
        name: "job",
        queueName: "agents",
        data: {},
        state: "completed",
        timestamp: 2_000,
        finishedOn: 2_000,
      },
    ]);

    const monitor = new QueueMonitor([queue]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // A guard is registered but decides "default" for these agents-queue jobs,
    // so they clean by the normal rule (own state === clean type).
    monitor.setCleanGuard((job) => (job.queue === "workflows:steps" ? "keep" : "default"));
    const removed = await monitor.cleanAllQueues(0, 1000, "completed");

    expect(removed).toContain("done-a");
    expect(removed).toContain("done-b");
    expect(remaining()).toHaveLength(0);
  });

  test("respects the grace period for eligible jobs", async () => {
    const { queue, remaining } = createCleanableQueue("agents", [
      {
        id: "fresh",
        name: "job",
        queueName: "agents",
        data: {},
        state: "completed",
        timestamp: Date.now(),
        finishedOn: Date.now(),
      },
    ]);

    const monitor = new QueueMonitor([queue]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Guard defers to the default rule, but a large grace window keeps the fresh job.
    monitor.setCleanGuard(() => "default");
    const removed = await monitor.cleanAllQueues(60_000, 100, "completed");

    expect(removed).not.toContain("fresh");
    expect(remaining()).toContain("fresh");
  });

  test("cleans a run's steps only when the parent run status matches the clean type", async () => {
    // The step job is "completed" at the queue level, but its parent run FAILED.
    // The boot-time rule cleans the run's steps only when the run status matches
    // the requested clean type, regardless of the step's own queue state.
    const failedRunId = "run-failed";
    const parentStatus: Record<string, string> = { [failedRunId]: "failed" };

    function makeQueue() {
      return createCleanableQueue("workflows:steps", [
        {
          id: "failed-run-step",
          name: "step-0",
          queueName: "workflows:steps",
          data: { workflowRunId: failedRunId },
          state: "completed", // a successful step of a run that later failed
          timestamp: 1_000,
          finishedOn: 1_000,
        },
      ]);
    }

    // Guard mirroring boot.ts: remove the run's steps when the parent status
    // matches the clean type, keep them otherwise, default for non-workflow jobs.
    const guard = (job: { workflowRunId?: string }, cleanType: string): "keep" | "remove" | "default" => {
      if (!job.workflowRunId) return "default";
      const status = parentStatus[job.workflowRunId];
      if (!status) return "default";
      return status === cleanType ? "remove" : "keep";
    };

    // "clean completed" must NOT remove the (completed) step of a failed run.
    {
      const { queue, remaining } = makeQueue();
      const monitor = new QueueMonitor([queue]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      monitor.setCleanGuard(guard);

      const removed = await monitor.cleanAllQueues(0, 100, "completed");
      expect(removed).not.toContain("failed-run-step");
      expect(remaining()).toContain("failed-run-step");
    }

    // "clean failed" must remove the step of a failed run even though the step
    // job's own queue state is "completed" (the "remove" verdict ignores it).
    {
      const { queue, remaining } = makeQueue();
      const monitor = new QueueMonitor([queue]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      monitor.setCleanGuard(guard);

      const removed = await monitor.cleanAllQueues(0, 100, "failed");
      expect(removed).toContain("failed-run-step");
      expect(remaining()).not.toContain("failed-run-step");
    }
  });
});
