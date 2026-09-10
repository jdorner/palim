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
   * Optional guard that decides how a job participates in a clean operation.
   *
   * Invoked with a cached job entry and the clean's target state (`cleanType`,
   * e.g. "completed" or "failed"). Returns a {@link CleanDecision}:
   *  - `"keep"`    - protect the job; never remove it in this clean.
   *  - `"remove"`  - remove the job now, regardless of its own queue state.
   *  - `"default"` - not managed by the guard; apply the normal rule (remove
   *                  iff the job's own state equals `cleanType`).
   *
   * This lets a consumer manage a job by higher-level state than the queue
   * state. For workflow steps, eligibility is keyed on the PARENT run status,
   * not the step's own queue state: every step of a run is removed together
   * when the run's status matches `cleanType` (so a failed run's steps - whose
   * queue states are a mix of "completed"/"failed" - are all cleaned by "clean
   * failed"), steps of an active run are always kept, and steps whose parent
   * status mismatches `cleanType` are kept.
   *
   * When set, cleanup switches from the fast bulk path to selective per-job
   * removal so the guard's decision is honored precisely.
   */
  decideJobClean?: (job: JobEntry, cleanType: string) => CleanDecision;
}

/**
 * Per-job verdict returned by {@link QueueCleanerDeps.decideJobClean}.
 *
 * - `keep`: protect the job from this clean.
 * - `remove`: remove the job now, ignoring its own queue state.
 * - `default`: apply the normal rule (remove iff `job.state === cleanType`).
 */
export type CleanDecision = "keep" | "remove" | "default";

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
    const guard = this.deps.decideJobClean;
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
   * Cleans a single queue while honoring the {@link QueueCleanerDeps.decideJobClean}
   * guard. Enumerates the queue's jobs, asks the guard how each participates in
   * this clean, selects the eligible + old-enough ones (up to `limit`), and
   * removes exactly those via {@link ManagedQueuePort.removeJobs}.
   *
   * Per-job eligibility follows the guard's verdict:
   *  - `"keep"`    - excluded.
   *  - `"remove"`  - included regardless of the job's own queue state (lets a
   *                  consumer clean a job by higher-level state, e.g. removing
   *                  a failed run's steps whose queue states are "completed").
   *  - `"default"` - included iff the job's own state equals the clean type
   *                  (the normal rule).
   *
   * Unlike the bulk `queue.clean()` path (age-ordered, no per-id exclusion),
   * `removeJobs` removes specific job IDs with no collateral over/under-removal.
   *
   * @param queue - The queue to clean
   * @param grace - Minimum age in ms (measured from completion) before a job is eligible
   * @param limit - Maximum number of jobs to remove from this queue
   * @param type - Job state to clean (defaults to "completed")
   * @param decide - Guard returning a per-job {@link CleanDecision}
   * @returns Array of removed job IDs
   */
  private async cleanQueueGuarded(
    queue: ManagedQueuePort,
    grace: number,
    limit: number,
    type: string | undefined,
    decide: (job: JobEntry, cleanType: string) => CleanDecision,
  ): Promise<string[]> {
    const state = type ?? "completed";
    const now = Date.now();

    let jobs: Awaited<ReturnType<ManagedQueuePort["getAllJobs"]>>;
    try {
      jobs = await queue.getAllJobs();
    } catch (err) {
      log.warn(`Guarded clean: failed to list jobs for queue "${queue.name}", skipping`, { err });
      // Fall back to the normal bulk clean so a listing failure doesn't silently
      // skip cleanup entirely.
      return queue.clean(grace, limit, type);
    }

    // Select job IDs to remove per the guard's verdict. The guard reads from the
    // monitor's cached entry; if a job is not cached, fall back to a minimal
    // entry so the guard can still inspect the queue name and workflow run id.
    const toRemove: string[] = [];
    for (const job of jobs) {
      if (toRemove.length >= limit) break;

      const cached = this.deps.getCachedJob(job.id);
      const entry: JobEntry = cached ?? {
        id: job.id,
        description: job.name,
        queue: queue.name,
        status: job.state as JobEntry["status"],
        createdAt: job.timestamp,
        completedAt: job.finishedOn,
      };

      const decision = decide(entry, state);
      if (decision === "keep") continue;
      // "default": only jobs whose own state matches the clean type are eligible.
      if (decision === "default" && job.state !== state) continue;

      // Respect the grace period, measured from completion when available.
      const finishedAt = job.finishedOn ?? job.timestamp;
      if (grace > 0 && now - finishedAt < grace) continue;

      toRemove.push(job.id);
    }

    if (toRemove.length === 0) return [];

    const removed = await queue.removeJobs(toRemove);
    log.debug(`Guarded clean of "${queue.name}": removed ${removed.length} job(s) for clean type "${state}"`);
    return removed;
  }
}
