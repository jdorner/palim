/**
 * Tests for {@link ManagedQueue} - cancelling (jobs end failed and stay in
 * the queue), batch removal, and persisted logs.
 */

import { describe, expect, test } from "bun:test";
import { FlowProducer } from "bunqueue/client";
import { getLogStore } from "./logStore";
import { ManagedQueue } from "./managedQueue";
import type { QueueJob } from "./types";

const TEST_QUEUE = "test-cancel";

describe("ManagedQueue.cancelJob", () => {
  describe("jobs that have not started", () => {
    test("fails a waiting job with the reason, logs it, and emits failed", async () => {
      const mq = new ManagedQueue(TEST_QUEUE, async () => {}, { autorun: false, dataPath: null });
      const failed = new Promise<{ jobId: string; failedReason: string; state?: string }>((resolve) => {
        mq.onEvent("failed", ({ jobId, failedReason, job }) => resolve({ jobId, failedReason, state: job?.state }));
      });

      const jobId = await mq.add("simple-job", { value: 42 });
      expect((await mq.getJob(jobId))?.state).toBe("waiting");

      expect(await mq.cancelJob(jobId, "Cancelled by alice")).toBe("cancelled");

      // The job is not removed: it is failed and can be retried or deleted.
      expect((await mq.getJob(jobId))?.state).toBe("failed");
      expect(await failed).toEqual({ jobId, failedReason: "Cancelled by alice", state: "failed" });
      const logs = await mq.getJobLogs(jobId);
      expect(logs.logs.map((l) => l.message)).toEqual(["Cancelled by alice"]);
      expect(await mq.retryJob(jobId)).toBe(true);
      expect((await mq.getJob(jobId))?.state).toBe("waiting");

      await mq.close();
    });

    test("fails a delayed job", async () => {
      const mq = new ManagedQueue(TEST_QUEUE, async () => {}, { dataPath: null });
      const jobId = await mq.add("delayed-job", { value: 1 }, { delay: 60_000 });
      expect((await mq.getJob(jobId))?.state).toBe("delayed");

      expect(await mq.cancelJob(jobId)).toBe("cancelled");
      expect((await mq.getJob(jobId))?.state).toBe("failed");

      await mq.close();
    });

    test("refuses a job parked on its children (flow chain)", async () => {
      const flow = new FlowProducer({ embedded: true });
      const mq = new ManagedQueue(TEST_QUEUE, async () => {}, { autorun: false, dataPath: null });

      const { jobIds } = await flow.addChain([
        { name: "step-0", queueName: TEST_QUEUE, data: { index: 0 } },
        { name: "step-1", queueName: TEST_QUEUE, data: { index: 1 } },
      ]);
      const [id0, id1] = jobIds as [string, string];
      expect((await mq.getJob(id1))?.state).toBe("waiting-children");

      expect(await mq.cancelJob(id1)).toBe("not_cancellable");
      expect((await mq.getJob(id1))?.state).toBe("waiting-children");

      await mq.removeJobs([id0, id1]);
      await mq.close();
      await flow.close();
    });
  });

  describe("finished and unknown jobs", () => {
    test("reports a finished job as finished and leaves it in place", async () => {
      const mq = new ManagedQueue(TEST_QUEUE, async () => "done", { dataPath: null });
      const completed = new Promise<void>((resolve) => mq.onEvent("completed", () => resolve()));
      const jobId = await mq.add("quick-job", { value: 1 });
      await completed;

      expect(await mq.cancelJob(jobId)).toBe("finished");
      expect((await mq.getJob(jobId))?.state).toBe("completed");

      await mq.removeJobs([jobId]);
      await mq.close();
    });

    test("returns not_found for a non-existent job", async () => {
      const mq = new ManagedQueue(TEST_QUEUE, async () => {}, { autorun: false, dataPath: null });

      expect(await mq.cancelJob("non-existent-job-id")).toBe("not_found");

      await mq.close();
    });
  });

  describe("active/processing jobs", () => {
    test("signals cancellation for an active job via worker", async () => {
      let jobStarted: () => void;
      const jobStartedPromise = new Promise<void>((resolve) => {
        jobStarted = resolve;
      });
      let unblock: () => void;
      const blockPromise = new Promise<void>((resolve) => {
        unblock = resolve;
      });

      const mq = new ManagedQueue<{ value: number }>(
        TEST_QUEUE,
        async (_job: QueueJob<{ value: number }>) => {
          // Signal that we've started processing
          jobStarted!();
          // Block until unblocked (simulates processor checking cancellation)
          await blockPromise;
        },
        { concurrency: 1, dataPath: null },
      );

      const jobId = await mq.add("active-job", { value: 99 });

      // Wait for the worker to pick up the job
      await jobStartedPromise;

      // Small delay to ensure bunqueue has moved it to processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify it's active
      const jobBefore = await mq.getJob(jobId);
      expect(jobBefore).not.toBeNull();
      expect(jobBefore!.state).toBe("active");

      // Cancel should succeed — signals cooperative cancellation
      expect(await mq.cancelJob(jobId)).toBe("cancelled");

      // Unblock the worker so close() can finish
      unblock!();
      await mq.close();
    });

    test("aborts the job's signal with the reason, so the job ends failed with it", async () => {
      let started: () => void;
      const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
      });

      const mq = new ManagedQueue<{ value: number }>(
        TEST_QUEUE,
        async (job: QueueJob<{ value: number }>) => {
          started!();
          // A cooperative processor: wait for the abort, then throw its reason.
          await new Promise<void>((_, reject) => {
            job.signal!.addEventListener("abort", () => reject(job.signal!.reason), { once: true });
          });
        },
        { concurrency: 1, dataPath: null },
      );
      const failed = new Promise<string | undefined>((resolve) => {
        mq.onEvent("failed", ({ failedReason }) => resolve(failedReason));
      });

      const jobId = await mq.add("active-job", { value: 1 });
      await startedPromise;
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(await mq.cancelJob(jobId, "Cancelled by alice")).toBe("cancelled");
      expect(await failed).toBe("Cancelled by alice");
      expect((await mq.getJob(jobId))?.state).toBe("failed");

      await mq.close();
    });

    test("fails a cancelled job whose processor ignores the signal and returns", async () => {
      let started: () => void;
      const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
      });
      let finish: () => void;
      const finishPromise = new Promise<void>((resolve) => {
        finish = resolve;
      });

      const mq = new ManagedQueue<{ value: number }>(
        TEST_QUEUE,
        async () => {
          started!();
          // Not cooperative: runs to the end whatever the signal says.
          await finishPromise;
          return { done: true };
        },
        { concurrency: 1, dataPath: null },
      );
      const outcome = new Promise<string>((resolve) => {
        mq.onEvent("failed", ({ failedReason }) => resolve(`failed: ${failedReason}`));
        mq.onEvent("completed", () => resolve("completed"));
      });

      const jobId = await mq.add("stubborn-job", { value: 1 });
      await startedPromise;
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(await mq.cancelJob(jobId, "Cancelled by alice")).toBe("cancelled");
      finish!();
      expect(await outcome).toBe("failed: Cancelled by alice");
      expect((await mq.getJob(jobId))?.state).toBe("failed");
      const logs = await mq.getJobLogs(jobId);
      expect(JSON.stringify(logs.logs)).toContain("**Error:** Cancelled by alice");

      await mq.close();
    });
  });
});

describe("ManagedQueue.removeJobs", () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("removes completed jobs without re-running them", async () => {
    let processed = 0;
    const mq = new ManagedQueue<{ n: number }>(
      TEST_QUEUE,
      async () => {
        processed++;
        return { ok: true };
      },
      { concurrency: 1, dataPath: null },
    );

    const id1 = await mq.add("j1", { n: 1 });
    const id2 = await mq.add("j2", { n: 2 });

    // Let both jobs process to completion.
    await wait(150);
    expect(processed).toBe(2);
    expect((await mq.getJob(id1))?.state).toBe("completed");
    expect((await mq.getJob(id2))?.state).toBe("completed");

    const runsBefore = processed;
    const removed = await mq.removeJobs([id1, id2]);

    // Give any (incorrectly) requeued job a chance to be picked up.
    await wait(150);

    expect(removed.sort()).toEqual([id1, id2].sort());
    expect(await mq.getJob(id1)).toBeNull();
    expect(await mq.getJob(id2)).toBeNull();
    // Critical: the completed jobs must NOT have been re-processed.
    expect(processed).toBe(runsBefore);

    await mq.close();
  });

  test("removes a mixed batch of waiting and completed jobs", async () => {
    let processed = 0;
    // autorun false: added jobs stay "waiting" and are never processed.
    const idle = new ManagedQueue<{ n: number }>(
      TEST_QUEUE,
      async () => {
        processed++;
      },
      { autorun: false, dataPath: null },
    );
    const waitingId = await idle.add("waiting-job", { n: 1 });
    expect((await idle.getJob(waitingId))?.state).toBe("waiting");

    const removed = await idle.removeJobs([waitingId, "does-not-exist"]);
    expect(removed).toEqual([waitingId]);
    expect(await idle.getJob(waitingId)).toBeNull();
    expect(processed).toBe(0);

    await idle.close();
  });

  test("returns empty array for empty input", async () => {
    const mq = new ManagedQueue(TEST_QUEUE, async () => {}, { autorun: false, dataPath: null });
    expect(await mq.removeJobs([])).toEqual([]);
    await mq.close();
  });
});

describe("ManagedQueue.appendJobLog", () => {
  test("continues after the stored entries of a job from an earlier process", async () => {
    const jobId = `test-append-${Date.now()}`;
    // Entries an earlier process persisted; this queue's in-memory counter does not know them.
    getLogStore().append(jobId, 1, "first", 1000);
    getLogStore().append(jobId, 2, "second", 2000);
    const mq = new ManagedQueue(TEST_QUEUE, async () => {}, { autorun: false, dataPath: null });

    await mq.appendJobLog(jobId, "interrupted");
    await mq.appendJobLog(jobId, "again");

    expect(
      getLogStore()
        .getLogs(jobId)
        .map((e) => e.message),
    ).toEqual(["first", "second", "interrupted", "again"]);
    expect((await mq.getJobLogs(jobId)).logs.map((e) => e.message)).toEqual([
      "first",
      "second",
      "interrupted",
      "again",
    ]);
    getLogStore().deleteLogs(jobId);
    await mq.close();
  });
});

describe("ManagedQueue job.log", () => {
  test("keeps the logs of a job that runs again after a restart", async () => {
    const queueName = `test-log-rerun-${Date.now()}`;
    // The queue of the earlier process only enqueues; its job has stored logs from an earlier attempt.
    const earlier = new ManagedQueue(queueName, async () => {}, { autorun: false, dataPath: null });
    const jobId = await earlier.add("rerun-job", {});
    getLogStore().append(jobId, 1, "first attempt", 1000);
    getLogStore().append(jobId, 2, "first attempt failed", 2000);
    await earlier.close();

    // A fresh queue (empty in-memory counters) runs the job again.
    let done!: () => void;
    const ran = new Promise<void>((resolve) => {
      done = resolve;
    });
    const fresh = new ManagedQueue(
      queueName,
      async (job) => {
        await job.log("second attempt");
        done();
      },
      { dataPath: null },
    );
    await ran;

    expect(
      getLogStore()
        .getLogs(jobId)
        .map((e) => e.message),
    ).toEqual(["first attempt", "first attempt failed", "second attempt"]);
    getLogStore().deleteLogs(jobId);
    await fresh.close();
  });
});
