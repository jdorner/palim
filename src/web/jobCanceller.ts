/**
 * Job cancellation logic extracted from QueueMonitor.
 *
 * Cancels exactly one job: it ends `failed` and stays in its queue. Deleting
 * a job is a separate operation ({@link QueueCleaner.deleteJob}); a workflow
 * step's run is cancelled through the workflows extension, which also decides
 * what a cancelled step means for its run.
 *
 * @module
 */

import type { JobEntry } from "@shared/jobs";
import type { CancelOutcome, ManagedQueuePort } from "@src/queue";

/** Dependencies injected from QueueMonitor. */
export interface JobCancellerDeps {
  /** Returns all tracked queues. */
  getQueues: () => ManagedQueuePort[];
  /** Returns the cached job entry by ID. */
  getCachedJob: (jobId: string) => JobEntry | undefined;
}

/**
 * Cancels single jobs.
 */
export class JobCanceller {
  private readonly deps: JobCancellerDeps;

  constructor(deps: JobCancellerDeps) {
    this.deps = deps;
  }

  /**
   * Cancels one job. The job is never removed: an active job's processor is
   * aborted and a waiting or delayed one is failed at once, so it ends
   * `failed` with `reason` as its error. Its queue's `failed` event updates
   * the cache and the clients. Other jobs of the same workflow run are left
   * alone; the run reacts to the failed step itself.
   *
   * @param jobId - The job to cancel
   * @param reason - Why (see `cancelReason`); defaults to the queue's "Cancelled"
   * @returns The queue's outcome; `not_found` when no tracked queue has the job
   */
  async cancelJob(jobId: string, reason?: string): Promise<CancelOutcome> {
    const queue = await this.findQueue(jobId);
    if (!queue) return "not_found";
    return queue.cancelJob(jobId, reason);
  }

  /**
   * Finds the queue that holds a job: the cached entry's queue, or the first
   * tracked queue that knows the job.
   *
   * @param jobId - The job
   * @returns The queue, or undefined when no tracked queue has the job
   */
  private async findQueue(jobId: string): Promise<ManagedQueuePort | undefined> {
    const queues = this.deps.getQueues();
    const cachedQueue = this.deps.getCachedJob(jobId)?.queue;
    const byName = cachedQueue ? queues.find((q) => q.name === cachedQueue) : undefined;
    if (byName && (await byName.getJob(jobId))) return byName;
    for (const queue of queues) {
      if (await queue.getJob(jobId)) return queue;
    }
    return undefined;
  }
}
