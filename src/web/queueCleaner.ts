/**
 * Queue maintenance operations extracted from QueueMonitor.
 *
 * Handles job retry, bulk cleanup, and log retrieval - operations that
 * modify queue state but are not part of the real-time event tracking
 * or cancellation flows.
 *
 * @module
 */

import type { JobEntry } from "@shared/types";
import type { ManagedQueuePort, QueueJobLogs } from "@src/queue";
import { mainLogger as log } from "@src/utils/logger";

/** Dependencies injected from QueueMonitor. */
export interface QueueCleanerDeps {
  /** Returns all tracked queues. */
  getQueues: () => ManagedQueuePort[];
  /** Returns the cached job entry by ID. */
  getCachedJob: (jobId: string) => JobEntry | undefined;
  /** Evicts job IDs from the cache and broadcasts a full state refresh. */
  removeJobs: (jobIds: string[]) => void;
  /** Broadcasts a full state refresh to all clients. */
  broadcastFullState: () => void;
}

/**
 * Manages queue maintenance: retry, cleanup, and log retrieval.
 */
export class QueueCleaner {
  private readonly deps: QueueCleanerDeps;

  constructor(deps: QueueCleanerDeps) {
    this.deps = deps;
  }

  /**
   * Retrieves log entries for a job by searching across all tracked queues.
   *
   * @param jobId - The job to fetch logs for
   * @returns Log entries and count, or null if the job was not found in any queue
   */
  async getJobLogs(jobId: string): Promise<QueueJobLogs | null> {
    for (const queue of this.deps.getQueues()) {
      const job = await queue.getJob(jobId);
      if (job) {
        return queue.getJobLogs(jobId);
      }
    }
    return null;
  }

  /**
   * Retries a failed job by moving it from the DLQ back to waiting.
   * Searches across all tracked queues for the job, using the job's
   * queue name to ensure the retry targets the correct DLQ.
   *
   * @param jobId - The job to retry
   * @returns true if the job was found and retried
   */
  async retryJob(jobId: string): Promise<boolean> {
    const cached = this.deps.getCachedJob(jobId);
    const queueName = cached?.queue;

    // Find the owning queue by name (preferred) or fall back to scanning
    let targetQueue: ManagedQueuePort | undefined;
    if (queueName) {
      targetQueue = this.deps.getQueues().find((q) => q.name === queueName);
    }

    if (!targetQueue) {
      // Fallback: find the queue that reports this job in "failed" state
      for (const queue of this.deps.getQueues()) {
        const job = await queue.getJob(jobId);
        if (job && job.state === "failed" && job.queueName === queue.name) {
          targetQueue = queue;
          break;
        }
      }
    }

    if (!targetQueue) {
      log.warn(`Cannot retry job ${jobId}: not found in any tracked queue`);
      return false;
    }

    const job = await targetQueue.getJob(jobId);
    if (job?.state !== "failed") {
      log.warn(`Cannot retry job ${jobId}: current state is "${job?.state ?? "unknown"}", expected "failed"`);
      return false;
    }

    const ok = await targetQueue.retryJob(jobId);
    if (ok) {
      const entry = this.deps.getCachedJob(jobId);
      if (entry) {
        entry.status = "waiting";
        entry.completedAt = undefined;
        entry.error = undefined;
      }
      this.deps.broadcastFullState();
    }
    return ok;
  }

  /**
   * Cleans jobs across all tracked queues and evicts them from the cache.
   *
   * @param grace - Minimum age in ms before a job can be cleaned
   * @param limit - Maximum number of jobs to clean per queue
   * @param type - Job state to clean (e.g. "completed", "failed")
   * @returns Array of all removed job IDs
   */
  async cleanAllQueues(grace: number, limit: number, type?: string): Promise<string[]> {
    const results = await Promise.all(this.deps.getQueues().map((q) => q.clean(grace, limit, type)));
    const allRemoved = results.flat();
    this.deps.removeJobs(allRemoved);
    return allRemoved;
  }
}
