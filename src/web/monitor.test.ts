/**
 * Tests for {@link QueueMonitor} - verifies that stale job entries are properly
 * evicted from the in-memory cache when jobs move to DLQ via stall detection.
 *
 * These tests reproduce the bug where:
 * 1. A job stalls and bunqueue moves it to DLQ
 * 2. The monitor's "stalled" handler only logs (doesn't update cache)
 * 3. The job remains in initial_state with its old "active" status
 * 4. cancelJob returns false (404) because bunqueue's cancelJob doesn't handle
 *    DLQ state — it only handles queue-state jobs
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

/**
 * Creates a fake ManagedQueuePort that simulates a queue containing jobs.
 * Event handlers are captured so we can fire them manually to simulate
 * bunqueue's lifecycle events (waiting, active, stalled, etc.).
 */
function createFakeQueue(queueName: string, jobs: JobInfo[] = []) {
  const handlers = new Map<string, QueueEventHandler<any>[]>();
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
    onEvent<E extends QueueEventType>(event: E, handler: QueueEventHandler<E>) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    offEvent() {},
    async cancelJob(jobId: string) {
      const job = currentJobs.find((j) => j.id === jobId);
      if (!job) return false;
      // Simulate updated ManagedQueue behavior: cancelJob now handles DLQ jobs
      // by retrying (moving to waiting) then removing. All non-active states succeed.
      if (job.state === "waiting" || job.state === "delayed" || job.state === "failed") {
        currentJobs = currentJobs.filter((j) => j.id !== jobId);
        return true;
      }
      // Active jobs would be signalled via worker — not simulated here
      return false;
    },
    async retryJob() {
      return false;
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
    /** Fire a registered event handler (simulates bunqueue emitting the event). */
    emit<E extends QueueEventType>(event: E, payload: Parameters<QueueEventHandler<E>>[0]) {
      const list = handlers.get(event) ?? [];
      for (const handler of list) {
        handler(payload);
      }
    },
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

describe("QueueMonitor stale cache - simple jobs", () => {
  test("job that stalls and moves to DLQ should not remain in cache with active status", async () => {
    const jobId = "job-stalled-001";

    // Start with a job in waiting state (as it would be when first added)
    const fake = createFakeQueue("agents", [
      {
        id: jobId,
        name: "test-job",
        queueName: "agents",
        data: { prompt: "hello" },
        state: "waiting",
        timestamp: Date.now(),
      },
    ]);

    const monitor = new QueueMonitor([fake.queue]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Simulate the job lifecycle: waiting -> active -> stalled -> DLQ
    // Step 1: Job enters waiting (already in getAllJobs at boot, so it's cached)
    let jobs = getMonitorJobs(monitor);
    expect(jobs.find((j) => j.id === jobId)?.status).toBe("waiting");

    // Step 2: Job becomes active
    fake.setJobState(jobId, "active");
    fake.emit("active", { jobId, job: await fake.queue.getJob(jobId) });
    await new Promise((resolve) => setTimeout(resolve, 20));

    jobs = getMonitorJobs(monitor);
    expect(jobs.find((j) => j.id === jobId)?.status).toBe("active");

    // Step 3: Job stalls — bunqueue moves it to DLQ and emits "stalled" event.
    // Internally, the job's state becomes "failed" (DLQ maps to failed).
    fake.setJobState(jobId, "failed");
    fake.emit("stalled", { jobId, job: await fake.queue.getJob(jobId) });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // BUG: The monitor's stalled handler only logs — it doesn't update the cache.
    // The job should now show as "failed" in the cache (or be evicted).
    jobs = getMonitorJobs(monitor);
    const staleJob = jobs.find((j) => j.id === jobId);

    // Expected CORRECT behavior: status should be "failed" (reflecting DLQ state)
    if (staleJob) {
      expect(staleJob.status).toBe("failed");
    }
    // If undefined: evicted (also acceptable)
  });

  test("cancelJob returns false for a DLQ'd job and the stale entry persists in cache", async () => {
    const jobId = "job-stalled-002";

    const fake = createFakeQueue("agents", [
      {
        id: jobId,
        name: "test-job",
        queueName: "agents",
        data: { prompt: "hello" },
        state: "waiting",
        timestamp: Date.now(),
      },
    ]);

    const monitor = new QueueMonitor([fake.queue]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Simulate: waiting -> active -> stalled (DLQ)
    fake.setJobState(jobId, "active");
    fake.emit("active", { jobId, job: await fake.queue.getJob(jobId) });
    await new Promise((resolve) => setTimeout(resolve, 20));

    fake.setJobState(jobId, "failed");
    fake.emit("stalled", { jobId, job: await fake.queue.getJob(jobId) });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Attempt to cancel the job (same path as POST /api/jobs/:id/cancel).
    // bunqueue's cancelJob returns false for DLQ jobs, but the monitor should
    // still evict the stale entry and report success (the user's intent is fulfilled).
    const cancelled = await monitor.cancelJob(jobId);
    expect(cancelled).toBe(true);

    // BUG: The job remains in the cache with stale "active" status after failed cancel.
    // Expected CORRECT behavior: the job should be evicted from cache (or show "failed").
    const jobs = getMonitorJobs(monitor);
    const staleJob = jobs.find((j) => j.id === jobId);
    expect(staleJob).toBeUndefined();
  });

  test("cancelJob returns false when job is completely gone from queue but still in cache", async () => {
    const jobId = "job-gone-003";

    const fake = createFakeQueue("agents", [
      {
        id: jobId,
        name: "test-job",
        queueName: "agents",
        data: { prompt: "hello" },
        state: "waiting",
        timestamp: Date.now(),
      },
    ]);

    const monitor = new QueueMonitor([fake.queue]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Simulate: waiting -> active
    fake.setJobState(jobId, "active");
    fake.emit("active", { jobId, job: await fake.queue.getJob(jobId) });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Now simulate the job being fully removed from bunqueue (e.g. after DLQ purge
    // or after a server restart where the storage was cleaned externally).
    // The monitor cache still has it, but getJob returns null.
    fake.removeJob(jobId);

    // Attempt cancel — job is gone from the queue entirely.
    // The monitor should evict the stale cache entry and report success.
    const cancelled = await monitor.cancelJob(jobId);
    expect(cancelled).toBe(true);

    // BUG: The job remains in the cache even though it no longer exists anywhere.
    // Expected CORRECT behavior: evict from cache.
    const jobs = getMonitorJobs(monitor);
    expect(jobs.find((j) => j.id === jobId)).toBeUndefined();
  });
});

describe("QueueMonitor stale cache - workflow chains", () => {
  test("workflow step that stalls keeps stale active status in cache", async () => {
    const workflowRunId = "wf-run-001";
    const step0Id = "step-0-001";
    const step1Id = "step-1-001";

    const fake = createFakeQueue("workflows:steps", [
      {
        id: step0Id,
        name: "step-0",
        queueName: "workflows:steps",
        data: { workflowRunId, workflowName: "test-wf", stepSlug: "fetch", stepIndex: 0, totalSteps: 2 },
        state: "waiting",
        timestamp: Date.now(),
      },
      {
        id: step1Id,
        name: "step-1",
        queueName: "workflows:steps",
        data: { workflowRunId, workflowName: "test-wf", stepSlug: "process", stepIndex: 1, totalSteps: 2 },
        state: "waiting",
        timestamp: Date.now(),
      },
    ]);

    const monitor = new QueueMonitor([fake.queue]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Step 0 becomes active
    fake.setJobState(step0Id, "active");
    fake.emit("active", { jobId: step0Id, job: await fake.queue.getJob(step0Id) });
    await new Promise((resolve) => setTimeout(resolve, 20));

    let jobs = getMonitorJobs(monitor);
    expect(jobs.find((j) => j.id === step0Id)?.status).toBe("active");
    expect(jobs.find((j) => j.id === step1Id)?.status).toBe("waiting");

    // Step 0 stalls — moved to DLQ
    fake.setJobState(step0Id, "failed");
    fake.emit("stalled", { jobId: step0Id, job: await fake.queue.getJob(step0Id) });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // BUG: The stalled step's status in the monitor cache should be "failed"
    jobs = getMonitorJobs(monitor);
    const step0 = jobs.find((j) => j.id === step0Id);
    if (step0) {
      expect(step0.status).toBe("failed");
    }
  });

  test("cancelJob for chain where lead job is in DLQ should cancel entire chain", async () => {
    const workflowRunId = "wf-run-002";
    const step0Id = "step-0-002";
    const step1Id = "step-1-002";
    const step2Id = "step-2-002";

    const fake = createFakeQueue("workflows:steps", [
      {
        id: step0Id,
        name: "step-0",
        queueName: "workflows:steps",
        data: { workflowRunId, workflowName: "chain-wf", stepSlug: "fetch", stepIndex: 0, totalSteps: 3 },
        state: "waiting",
        timestamp: Date.now(),
      },
      {
        id: step1Id,
        name: "step-1",
        queueName: "workflows:steps",
        data: { workflowRunId, workflowName: "chain-wf", stepSlug: "transform", stepIndex: 1, totalSteps: 3 },
        state: "waiting",
        timestamp: Date.now(),
      },
      {
        id: step2Id,
        name: "step-2",
        queueName: "workflows:steps",
        data: { workflowRunId, workflowName: "chain-wf", stepSlug: "notify", stepIndex: 2, totalSteps: 3 },
        state: "waiting",
        timestamp: Date.now(),
      },
    ]);

    const monitor = new QueueMonitor([fake.queue]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Step 0 goes active then stalls to DLQ
    fake.setJobState(step0Id, "active");
    fake.emit("active", { jobId: step0Id, job: await fake.queue.getJob(step0Id) });
    await new Promise((resolve) => setTimeout(resolve, 20));

    fake.setJobState(step0Id, "failed");
    fake.emit("stalled", { jobId: step0Id, job: await fake.queue.getJob(step0Id) });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Verify all three are still in cache
    let jobs = getMonitorJobs(monitor);
    expect(jobs.filter((j) => [step0Id, step1Id, step2Id].includes(j.id)).length).toBe(3);

    // Attempt to cancel the entire chain via the DLQ'd lead job.
    // getChainSiblings finds step0 in cache, calls getJob which returns it (state "failed"),
    // extracts workflowRunId, finds siblings. But cancelJob for step0 returns false (DLQ).
    const cancelled = await monitor.cancelJob(step0Id);

    // Expected CORRECT behavior: the operation should succeed overall.
    // Even though the lead job can't be "cancelled" (it's already dead in DLQ),
    // the waiting siblings should be cancelled and the lead should be evicted.
    expect(cancelled).toBe(true);

    // All chain jobs should be removed from the cache
    jobs = getMonitorJobs(monitor);
    expect(jobs.find((j) => j.id === step0Id)).toBeUndefined();
    expect(jobs.find((j) => j.id === step1Id)).toBeUndefined();
    expect(jobs.find((j) => j.id === step2Id)).toBeUndefined();
  });
});

describe("QueueMonitor stale cache - persistence across restart", () => {
  test("cancelled DLQ job does not reappear after simulated server restart", async () => {
    const jobId = "job-persist-001";

    const fake = createFakeQueue("agents", [
      {
        id: jobId,
        name: "test-job",
        queueName: "agents",
        data: { prompt: "hello" },
        state: "waiting",
        timestamp: Date.now(),
      },
    ]);

    const monitor = new QueueMonitor([fake.queue]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Job goes active, then stalls -> DLQ (failed)
    fake.setJobState(jobId, "active");
    fake.emit("active", { jobId, job: await fake.queue.getJob(jobId) });
    await new Promise((resolve) => setTimeout(resolve, 20));

    fake.setJobState(jobId, "failed");
    fake.emit("stalled", { jobId, job: await fake.queue.getJob(jobId) });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Cancel the DLQ'd job — this should remove it from both cache AND storage
    const cancelled = await monitor.cancelJob(jobId);
    expect(cancelled).toBe(true);

    // Verify it's gone from the cache
    let jobs = getMonitorJobs(monitor);
    expect(jobs.find((j) => j.id === jobId)).toBeUndefined();

    // Simulate server restart: create a new monitor with the same queue.
    // getAllJobs() will be called to backfill the cache.
    // Since cancelJob removed the job from the fake queue's storage,
    // it should NOT reappear.
    const monitor2 = new QueueMonitor([fake.queue]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    jobs = getMonitorJobs(monitor2);
    expect(jobs.find((j) => j.id === jobId)).toBeUndefined();
  });

  test("cancelled workflow chain does not reappear after simulated server restart", async () => {
    const workflowRunId = "wf-persist-001";
    const step0Id = "step-0-persist";
    const step1Id = "step-1-persist";

    const fake = createFakeQueue("workflows:steps", [
      {
        id: step0Id,
        name: "step-0",
        queueName: "workflows:steps",
        data: { workflowRunId, workflowName: "persist-wf", stepSlug: "fetch", stepIndex: 0, totalSteps: 2 },
        state: "waiting",
        timestamp: Date.now(),
      },
      {
        id: step1Id,
        name: "step-1",
        queueName: "workflows:steps",
        data: { workflowRunId, workflowName: "persist-wf", stepSlug: "process", stepIndex: 1, totalSteps: 2 },
        state: "waiting",
        timestamp: Date.now(),
      },
    ]);

    const monitor = new QueueMonitor([fake.queue]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Step 0 goes active then stalls -> DLQ
    fake.setJobState(step0Id, "active");
    fake.emit("active", { jobId: step0Id, job: await fake.queue.getJob(step0Id) });
    await new Promise((resolve) => setTimeout(resolve, 20));

    fake.setJobState(step0Id, "failed");
    fake.emit("stalled", { jobId: step0Id, job: await fake.queue.getJob(step0Id) });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Cancel entire chain
    const cancelled = await monitor.cancelJob(step0Id);
    expect(cancelled).toBe(true);

    // Verify both are gone from cache
    let jobs = getMonitorJobs(monitor);
    expect(jobs.find((j) => j.id === step0Id)).toBeUndefined();
    expect(jobs.find((j) => j.id === step1Id)).toBeUndefined();

    // Simulate restart — neither job should come back
    const monitor2 = new QueueMonitor([fake.queue]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    jobs = getMonitorJobs(monitor2);
    expect(jobs.find((j) => j.id === step0Id)).toBeUndefined();
    expect(jobs.find((j) => j.id === step1Id)).toBeUndefined();
  });
});
