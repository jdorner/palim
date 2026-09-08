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
  /**
   * Optional callback invoked with removed job IDs before cache eviction.
   * Allows consumers (e.g. workflow extension) to extract metadata from
   * cached jobs before they are discarded.
   */
  onBeforeJobsRemoved?: (jobIds: string[], getCachedJob: (id: string) => JobEntry | undefined) => void;
  /**
   * Optional guard that protects individual jobs from being cleaned.
   *
   * Invoked with a cached job entry; returning `true` keeps the job (it is
   * excluded from cleanup). Used to preserve jobs whose removal would corrupt
   * higher-level state - e.g. completed workflow step jobs belonging to a run
   * that is still active (running or paused on a `waitFor` signal).
   *
   * When set, cleanup switches from the fast bulk path to selective per-job
   * removal so protected jobs are never touched.
   */
  isJobProtected?: (job: JobEntry) => boolean;
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
    const guard = this.deps.isJobProtected;
    const results = await Promise.all(
      this.deps
        .getQueues()
        .map((q) => (guard ? this.cleanQueueGuarded(q, grace, limit, type, guard) : q.clean(grace, limit, type))),
    );
    const allRemoved = results.flat();

    // Notify consumers before cache eviction (allows metadata extraction)
    if (allRemoved.length > 0 && this.deps.onBeforeJobsRemoved) {
      this.deps.onBeforeJobsRemoved(allRemoved, this.deps.getCachedJob);
    }

    this.deps.removeJobs(allRemoved);
    return allRemoved;
  }

  /**
   * Cleans a single queue while honoring the {@link QueueCleanerDeps.isJobProtected}
   * guard. Enumerates the queue's jobs, keeps only those in the target state that
   * are old enough (past the grace period) and not protected, then removes them
   * individually (up to `limit`).
   *
   * This is the slower, correctness-preserving counterpart to the bulk
   * `queue.clean()` path. It is used whenever a guard is registered so that
   * protected jobs (e.g. step jobs of an active workflow run) are never removed.
   *
   * @param queue - The queue to clean
   * @param grace - Minimum age in ms (measured from completion) before a job is eligible
   * @param limit - Maximum number of jobs to remove from this queue
   * @param type - Job state to clean (defaults to "completed")
   * @param guard - Predicate returning true for jobs that must be kept
   * @returns Array of removed job IDs
   */
  private async cleanQueueGuarded(
    queue: ManagedQueuePort,
    grace: number,
    limit: number,
    type: string | undefined,
    guard: (job: JobEntry) => boolean,
  ): Promise<string[]> {
    const state = type ?? "completed";
    const now = Date.now();

    let jobs: Awaited<ReturnType<ManagedQueuePort["getAllJobs"]>>;
    try {
      jobs = await queue.getAllJobs();
    } catch (err) {
      log.warn(`Guarded clean: failed to list jobs for queue "${queue.name}", skipping`, { err });
      return [];
    }

    const removed: string[] = [];
    for (const job of jobs) {
      if (removed.length >= limit) break;
      if (job.state !== state) continue;

      // Respect the grace period, measured from completion when available.
      const finishedAt = job.finishedOn ?? job.timestamp;
      if (grace > 0 && now - finishedAt < grace) continue;

      // Skip jobs the guard wants to keep. The guard reads from the monitor's
      // cached entry; if the job is not cached, fall back to a minimal entry so
      // the guard can still inspect the queue name.
      const cached = this.deps.getCachedJob(job.id);
      const entry: JobEntry = cached ?? {
        id: job.id,
        description: job.name,
        queue: queue.name,
        status: state as JobEntry["status"],
        createdAt: job.timestamp,
        completedAt: job.finishedOn,
      };
      if (guard(entry)) continue;

      const ok = await queue.cancelJob(job.id);
      if (ok) removed.push(job.id);
    }

    if (removed.length > 0) {
      log.debug(`Guarded clean removed ${removed.length} "${state}" jobs from "${queue.name}"`);
    }
    return removed;
  }
}
