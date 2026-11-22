/**
 * Job cancellation logic extracted from QueueMonitor.
 *
 * Cancels exactly one job: it ends `failed` and stays in its queue. Deleting
 * a job is a separate operation ({@link QueueCleaner.deleteJob}); a workflow
 * step's run is cancelled through the workflows extension, which also decides
 * what a cancelled step means for its run.
 *
 * Also resolves a job's workflow chain (the jobs sharing its `workflowRunId`)
 * for the chain lookup route.
 *
 * @module
 */

import type { JobEntry } from "@shared/jobs";
import type { CancelOutcome, JobInfo, ManagedQueuePort } from "@src/queue";

/** Dependencies injected from QueueMonitor. */
export interface JobCancellerDeps {
  /** Returns all tracked queues. */
  getQueues: () => ManagedQueuePort[];
  /** Returns the cached job entry by ID. */
  getCachedJob: (jobId: string) => JobEntry | undefined;
  /** Maps a job state to a frontend status. */
  mapJobStateToStatus: (state: string) => JobEntry["status"];
  /** Converts a JobInfo to a JobEntry. */
  jobInfoToEntry: (job: JobInfo, queueName: string, status: JobEntry["status"]) => JobEntry;
}

/**
 * Cancels single jobs and resolves workflow chains.
 */
export class JobCanceller {
  private readonly deps: JobCancellerDeps;

  constructor(deps: JobCancellerDeps) {
    this.deps = deps;
  }

  /**
   * Finds all jobs in the same workflow chain as the given job.
   * A chain is identified by sharing the same `workflowRunId` in their data payload.
   *
   * @param jobId - Any job in the chain
   * @returns The list of sibling job entries and the workflow run ID, or null if not part of a chain
   */
  async getChainSiblings(jobId: string): Promise<{ workflowRunId: string; siblings: JobEntry[] } | null> {
    const entry = this.deps.getCachedJob(jobId);
    if (!entry) return null;

    let workflowRunId: string | null = null;

    // Look up the actual job data from the queue to get the workflowRunId
    for (const queue of this.deps.getQueues()) {
      const job = await queue.getJob(jobId);
      if (job) {
        const data = job.data as Record<string, unknown> | null;
        if (data && typeof data.workflowRunId === "string") {
          workflowRunId = data.workflowRunId;
        }
        break;
      }
    }

    if (!workflowRunId) return null;

    // Find all jobs sharing that workflowRunId
    const siblings: JobEntry[] = [];
    const seenIds = new Set<string>();
    for (const queue of this.deps.getQueues()) {
      const allJobs = await queue.getAllJobs();
      for (const job of allJobs) {
        const data = job.data as Record<string, unknown> | null;
        if (data && data.workflowRunId === workflowRunId) {
          seenIds.add(job.id);
          const cached = this.deps.getCachedJob(job.id);
          if (cached) {
            siblings.push(cached);
          } else {
            const status = this.deps.mapJobStateToStatus(job.state);
            siblings.push(this.deps.jobInfoToEntry(job, queue.name, status));
          }
        }
      }
    }

    // Ensure the triggering job is included even if it's no longer in the queue
    if (!seenIds.has(jobId) && entry) {
      siblings.unshift(entry);
    }

    return { workflowRunId, siblings };
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
