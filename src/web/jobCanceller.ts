/**
 * Job cancellation logic extracted from QueueMonitor.
 *
 * Handles single-job cancellation and workflow chain resolution (cancelling
 * all sibling jobs in a workflow run). Manages a TTL-based set of recently
 * cancelled IDs to suppress stale worker events.
 *
 * @module
 */

import type { JobEntry } from "@shared/types";
import { abortJob } from "@src/jobs";
import type { JobInfo, ManagedQueuePort } from "@src/queue";

/** How long (ms) to remember cancelled job IDs to suppress stale worker events. */
const CANCELLED_ID_TTL_MS = 30_000;

/** How often (ms) to sweep expired entries from the cancelled-job map. */
const CANCELLED_SWEEP_INTERVAL_MS = 10_000;

/** Dependencies injected from QueueMonitor. */
export interface JobCancellerDeps {
  /** Returns all tracked queues. */
  getQueues: () => ManagedQueuePort[];
  /** Returns the cached job entry by ID. */
  getCachedJob: (jobId: string) => JobEntry | undefined;
  /** Removes a job from the cache. */
  evictJob: (jobId: string) => void;
  /** Maps a job state to a frontend status. */
  mapJobStateToStatus: (state: string) => JobEntry["status"];
  /** Converts a JobInfo to a JobEntry. */
  jobInfoToEntry: (job: JobInfo, queueName: string, status: JobEntry["status"]) => JobEntry;
  /** Broadcasts a full state refresh to all clients. */
  broadcastFullState: () => void;
}

/**
 * Manages job cancellation with workflow chain resolution and stale-event suppression.
 */
export class JobCanceller {
  private readonly deps: JobCancellerDeps;

  /**
   * Recently cancelled job IDs mapped to their expiry timestamp (ms).
   * Used to suppress stale events from workers still running after cancellation.
   */
  private cancelledJobs: Map<string, number> = new Map();

  /** Handle for the periodic cancelled-job sweep timer, or null when idle. */
  private cancelledSweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: JobCancellerDeps) {
    this.deps = deps;
  }

  /**
   * Checks whether a job ID was recently cancelled (used by the monitor
   * to suppress stale events from workers that haven't noticed yet).
   *
   * @param jobId - The job ID to check
   * @returns true if the job was recently cancelled
   */
  isRecentlyCancelled(jobId: string): boolean {
    return this.cancelledJobs.has(jobId);
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
   * Cancels a job by ID, searching across all tracked queues.
   * If the job is part of a workflow chain (has a `workflowRunId` in its data),
   * all sibling jobs in the chain are cancelled as well.
   *
   * @param jobId - The job to cancel
   * @returns true if the job was found and cancelled
   */
  async cancelJob(jobId: string): Promise<boolean> {
    let jobsToDelete: { id: string; queueName: string }[] = [];

    // Check if this job is part of a workflow chain
    const chainResult = await this.getChainSiblings(jobId);

    if (chainResult) {
      jobsToDelete = chainResult.siblings.map((job) => ({ id: job.id, queueName: job.queue }));
    } else {
      jobsToDelete = [{ id: jobId, queueName: "" }];
    }

    let overallStatus = true;
    for (const jobToDelete of jobsToDelete) {
      abortJob(jobToDelete.id);

      const queue = this.deps.getQueues().find((q) => q.name === jobToDelete.queueName);
      if (queue) {
        const job = await queue.getJob(jobToDelete.id);
        if (job) {
          const removed = await queue.cancelJob(jobToDelete.id);
          if (removed) {
            this.deps.evictJob(jobToDelete.id);
            this.markCancelled(jobToDelete.id);
          } else {
            overallStatus = false;
          }
        } else {
          overallStatus = false;
        }
      } else {
        overallStatus = false;
      }
    }

    this.deps.broadcastFullState();

    return overallStatus;
  }

  /**
   * Records a cancelled job ID with an expiry timestamp and starts the
   * periodic sweep timer if it isn't already running.
   *
   * @param jobId - The cancelled job ID to track
   */
  private markCancelled(jobId: string): void {
    this.cancelledJobs.set(jobId, Date.now() + CANCELLED_ID_TTL_MS);

    if (!this.cancelledSweepTimer) {
      this.cancelledSweepTimer = setInterval(() => this.sweepCancelledJobs(), CANCELLED_SWEEP_INTERVAL_MS);
    }
  }

  /**
   * Removes expired entries from the cancelled-job map.
   * Stops the sweep timer when the map is empty.
   */
  private sweepCancelledJobs(): void {
    const now = Date.now();
    for (const [id, expiry] of this.cancelledJobs) {
      if (now >= expiry) {
        this.cancelledJobs.delete(id);
      }
    }

    if (this.cancelledJobs.size === 0 && this.cancelledSweepTimer) {
      clearInterval(this.cancelledSweepTimer);
      this.cancelledSweepTimer = null;
    }
  }
}
