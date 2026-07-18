/**
 * Tests for {@link ManagedQueue.cancelJob} - verifies that jobs in all states
 * (waiting, waitingDeps, active/processing) are properly removed.
 */

import { describe, expect, test } from "bun:test";
import { FlowProducer } from "bunqueue/client";
import { ManagedQueue } from "./managedQueue";
import type { QueueJob } from "./types";

const TEST_QUEUE = "test-cancel";

describe("ManagedQueue.cancelJob", () => {
  describe("waitingDeps jobs (flow chain)", () => {
    test("cancels a job parked in waitingDeps", async () => {
      const flow = new FlowProducer({ embedded: true });

      // Create a queue that never processes (concurrency: 0 worker equivalent)
      const mq = new ManagedQueue(
        TEST_QUEUE,
        async () => {
          // Never resolves - jobs stay active indefinitely
          await new Promise(() => {});
        },
        { concurrency: 0, dataPath: null },
      );

      // Create a 3-step chain: step-0 -> step-1 -> step-2
      const { jobIds } = await flow.addChain([
        { name: "step-0", queueName: TEST_QUEUE, data: { index: 0 } },
        { name: "step-1", queueName: TEST_QUEUE, data: { index: 1 } },
        { name: "step-2", queueName: TEST_QUEUE, data: { index: 2 } },
      ]);

      const [id0, id1, id2] = jobIds as [string, string, string];

      // step-1 and step-2 should be in waitingDeps (state: waiting-children)
      const job1Before = await mq.getJob(id1);
      expect(job1Before).not.toBeNull();
      expect(job1Before!.state).toBe("waiting-children");

      // Cancel step-1 (waitingDeps job)
      const removed = await mq.cancelJob(id1);
      expect(removed).toBe(true);

      // Verify it's actually gone
      const job1After = await mq.getJob(id1);
      expect(job1After).toBeNull();

      // Cancel step-2 as well
      const removed2 = await mq.cancelJob(id2);
      expect(removed2).toBe(true);

      const job2After = await mq.getJob(id2);
      expect(job2After).toBeNull();

      // step-0 should still exist (it's in the queue, waiting to be processed)
      const job0 = await mq.getJob(id0);
      expect(job0).not.toBeNull();

      // Cleanup
      await mq.cancelJob(id0);
      await mq.close();
      await flow.close();
    });

    test("cancels a waiting (non-deps) job", async () => {
      const mq = new ManagedQueue(
        TEST_QUEUE,
        async () => {
          await new Promise(() => {});
        },
        { concurrency: 0, dataPath: null },
      );

      const jobId = await mq.add("simple-job", { value: 42 });

      const jobBefore = await mq.getJob(jobId);
      expect(jobBefore).not.toBeNull();
      expect(jobBefore!.state).toBe("waiting");

      const removed = await mq.cancelJob(jobId);
      expect(removed).toBe(true);

      const jobAfter = await mq.getJob(jobId);
      expect(jobAfter).toBeNull();

      await mq.close();
    });

    test("returns false for non-existent job", async () => {
      const mq = new ManagedQueue(TEST_QUEUE, async () => {}, { concurrency: 0, dataPath: null });

      const removed = await mq.cancelJob("non-existent-job-id");
      expect(removed).toBe(false);

      await mq.close();
    });
  });

  describe("active/processing jobs", () => {
    test("cancels an active job via discard path", async () => {
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
          // Block until unblocked (allows cleanup after test assertions)
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

      // Cancel should succeed via the discard fallback path
      const removed = await mq.cancelJob(jobId);
      expect(removed).toBe(true);

      // Verify it's gone
      const jobAfter = await mq.getJob(jobId);
      expect(jobAfter).toBeNull();

      // Unblock the worker so close() can finish
      unblock!();
      await mq.close();
    });
  });
});
