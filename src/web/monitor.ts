/**
 * QueueMonitor - tracks job lifecycle events across all managed queues
 * and broadcasts real-time updates to connected WebSocket clients.
 *
 * Operates entirely through the {@link ManagedQueuePort} abstraction,
 * with no direct dependency on the underlying queue implementation.
 */

import type { JobEntry, WebSocketMessage } from "@shared/types";
import type { JobInfo, ManagedQueuePort, QueueJobLogs } from "@src/queue";
import { getLogStore } from "@src/queue";
import { mainLogger as log } from "@src/utils/logger";
import type { ServerWebSocket } from "elysia/ws/bun";
import { JobCanceller } from "./jobCanceller";
import { QueueCleaner } from "./queueCleaner";

/**
 * Extracts a `prompt` string from an unknown job data payload.
 *
 * @param data - The raw job data
 * @returns The prompt string, or `null` if not present or not a string
 */
function extractPrompt(data: unknown): string | null {
  if (data && typeof data === "object" && "prompt" in data) {
    const prompt = (data as Record<string, unknown>).prompt;
    return typeof prompt === "string" ? prompt : null;
  }
  return null;
}

/**
 * Monitor class for tracking job status and broadcasting updates to WebSocket clients.
 */
export class QueueMonitor {
  private clients: Set<ServerWebSocket<unknown>> = new Set();
  private jobCache: Map<string, JobEntry> = new Map();
  private queues: ManagedQueuePort[] = [];
  /** Handles job cancellation and workflow chain resolution. */
  private canceller: JobCanceller;
  /** Handles job retry, cleanup, and log retrieval. */
  private cleaner: QueueCleaner;

  /**
   * Initializes the QueueMonitor with the provided queues.
   *
   * @param queues - Array of queues to monitor
   */
  constructor(queues: ManagedQueuePort[]) {
    this.canceller = new JobCanceller({
      getQueues: () => this.queues,
      getCachedJob: (id) => this.jobCache.get(id),
      evictJob: (id) => this.jobCache.delete(id),
      mapJobStateToStatus: (state) => this.mapJobStateToStatus(state),
      jobInfoToEntry: (job, queueName, status) => this.jobInfoToEntry(job, queueName, status),
      broadcastFullState: () => this.broadcastFullState(),
    });
    this.cleaner = new QueueCleaner({
      getQueues: () => this.queues,
      getCachedJob: (id) => this.jobCache.get(id),
      removeJobs: (ids) => this.removeJobs(ids),
      broadcastFullState: () => this.broadcastFullState(),
    });
    this.addQueues(queues);
  }

  /**
   * Add additional queues to the monitor (e.g. extension-created queues).
   *
   * @param queues - Array of managed queues to add
   */
  async addQueues(queues: ManagedQueuePort[]): Promise<void> {
    for (const queue of queues) {
      if (this.queues.some((q) => q.name === queue.name)) {
        log.debug(`Queue ${queue.name} already tracked by monitor`);
        continue;
      }
      this.trackQueue(queue);

      // Backfill the cache with existing jobs so they appear in initial_state
      try {
        const jobs = await queue.getAllJobs();
        for (const job of jobs) {
          const status = this.mapJobStateToStatus(job.state);
          const entry = this.jobInfoToEntry(job, queue.name, status);
          if (status === "completed" || status === "failed") {
            entry.completedAt = job.finishedOn || getLogStore().getLastTimestamp(job.id);
          }
          this.jobCache.set(job.id, entry);
        }
        if (jobs.length > 0) {
          log.debug(`Loaded ${jobs.length} jobs from queue ${queue.name}`);
        }
      } catch (error) {
        log.error(`Failed to load jobs from queue ${queue.name}:`, error);
      }
    }

    // Notify already-connected clients about the newly backfilled jobs
    if (this.clients.size > 0) {
      this.broadcastFullState();
    }
  }

  /**
   * Creates an event handler for a job state transition.
   * Handles the common "update cache or fetch-and-insert" pattern.
   *
   * @param queue - The queue the event originates from
   * @param status - The target status to assign
   * @param opts - Optional log message and post-transition hook
   * @param opts.logMsg - Template string logged on cache hit (use `{id}` for job ID)
   * @returns An async event handler suitable for `queue.onEvent()`
   */
  private trackStateChange(
    queue: ManagedQueuePort,
    status: JobEntry["status"],
    opts?: { logMsg?: string },
  ): (eventData: { jobId: string; job: JobInfo | null }) => Promise<void> {
    return async ({ jobId, job }) => {
      const isTerminal = status === "completed" || status === "failed";

      let entry = this.jobCache.get(jobId);
      if (entry) {
        if (opts?.logMsg) log.info(opts.logMsg.replace("{id}", jobId));
        entry.status = status;
        if (isTerminal) entry.completedAt = Date.now();
        this.broadcast({ type: "job_updated", job: entry });
        return;
      }

      // Not in cache - use the resolved job from the event or fetch as fallback
      if (this.canceller.isRecentlyCancelled(jobId)) return;
      log.warn(`Job ${jobId} not in cache during '${status}' event, fetching from queue ${queue.name}`);
      const resolvedJob = job ?? (await queue.getJob(jobId));
      if (!resolvedJob) {
        log.warn(`Job ${jobId} not found in queue ${queue.name}`);
        return;
      }
      entry = this.jobInfoToEntry(resolvedJob, queue.name, status);
      if (isTerminal) entry.completedAt = Date.now();
      this.jobCache.set(jobId, entry);
      this.broadcast({ type: "job_updated", job: entry });
    };
  }

  /**
   * Subscribe to lifecycle events on a single queue.
   *
   * @param queue - The queue to track
   */
  private trackQueue(queue: ManagedQueuePort): void {
    this.queues.push(queue);

    try {
      queue.onEvent("waiting", async ({ jobId, job }) => {
        const resolvedJob = job ?? (await queue.getJob(jobId));
        if (!resolvedJob) {
          log.warn(`Job ${jobId} not found in queue ${queue.name} during 'waiting' event`);
          return;
        }
        const entry = this.jobInfoToEntry(resolvedJob, queue.name, "waiting");
        this.jobCache.set(resolvedJob.id, entry);
        this.broadcast({ type: "job_added", job: entry });
      });

      queue.onEvent("active", this.trackStateChange(queue, "active", { logMsg: "Started job: {id}" }));
      queue.onEvent(
        "completed",
        this.trackStateChange(queue, "completed", {
          logMsg: "✓ Job completed: {id}",
        }),
      );
      queue.onEvent("failed", this.trackStateChange(queue, "failed"));

      queue.onEvent("stalled", ({ jobId }) => {
        log.warn(`Job ${jobId} stalled in queue ${queue.name}`);
      });

      queue.onEvent("error", ({ message }) => {
        log.error(`Queue ${queue.name} error: ${message}`);
      });
    } catch (error) {
      log.error(`Failed to attach event handlers to queue ${queue.name}:`, error);
    }
  }

  /**
   * Converts a {@link JobInfo} to a {@link JobEntry} for the frontend.
   *
   * @param job - The job info from the queue
   * @param queueName - The queue name for display
   * @param status - The status to assign
   * @returns A JobEntry suitable for WebSocket broadcast
   */
  private jobInfoToEntry(job: JobInfo, queueName: string, status: JobEntry["status"]): JobEntry {
    const description = job.name || extractPrompt(job.data) || "Unknown job";
    const entry: JobEntry = {
      id: job.id,
      description,
      queue: queueName,
      status,
      createdAt: job.timestamp || Date.now(),
      logs: [],
    };

    // Enrich with workflow metadata if the job payload carries it
    const data = job.data as Record<string, unknown> | null | undefined;
    if (data && typeof data.workflowRunId === "string") {
      entry.workflowRunId = data.workflowRunId;
      if (typeof data.workflowName === "string") entry.workflowName = data.workflowName;
      if (typeof data.stepSlug === "string") entry.stepSlug = data.stepSlug;
      if (typeof data.stepIndex === "number") entry.stepIndex = data.stepIndex;
      if (typeof data.totalSteps === "number") entry.totalSteps = data.totalSteps;
    }

    return entry;
  }

  /** Lookup table mapping queue job states to frontend-facing statuses. */
  private static readonly STATE_TO_STATUS: Record<string, JobEntry["status"]> = {
    waiting: "waiting",
    "waiting-children": "waiting",
    active: "active",
    completed: "completed",
    failed: "failed",
    delayed: "delayed",
    unknown: "unknown",
  };

  /**
   * Maps a job state string to a {@link JobEntry} status.
   *
   * @param state - The job state from the queue
   * @returns The corresponding JobEntry status
   */
  private mapJobStateToStatus(state: string): JobEntry["status"] {
    return QueueMonitor.STATE_TO_STATUS[state] ?? "unknown";
  }

  /**
   * Adds a WebSocket client and sends the current job state snapshot.
   *
   * @param ws - The WebSocket client to add
   */
  addClient(ws: ServerWebSocket<unknown>): void {
    this.clients.add(ws);
    log.debug("New monitor client connected");

    const initialState: WebSocketMessage = {
      type: "initial_state",
      jobs: Array.from(this.jobCache.values()),
    };
    try {
      log.debug("Sending initial state", initialState);
      ws.send(JSON.stringify(initialState));
    } catch (error) {
      log.error("Failed to send initial state to client:", error);
    }
  }

  /**
   * Removes a WebSocket client.
   *
   * @param ws - The WebSocket client to remove
   */
  removeClient(ws: ServerWebSocket<unknown>): void {
    this.clients.delete(ws);
    log.debug("Monitor client disconnected");
  }

  /**
   * Evicts the given job IDs from the cache and broadcasts the full job state
   * to all clients, avoiding incremental sync issues.
   *
   * @param jobIds - Array of job IDs that were cleaned
   */
  removeJobs(jobIds: string[]): void {
    for (const id of jobIds) {
      this.jobCache.delete(id);
    }
    this.broadcastFullState();
  }

  /**
   * Finds all jobs in the same workflow chain as the given job.
   * A chain is identified by sharing the same `workflowRunId` in their data payload.
   *
   * @param jobId - Any job in the chain
   * @returns The list of sibling job entries and the workflow run ID, or null if not part of a chain
   */
  async getChainSiblings(jobId: string): Promise<{ workflowRunId: string; siblings: JobEntry[] } | null> {
    return this.canceller.getChainSiblings(jobId);
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
    return this.canceller.cancelJob(jobId);
  }

  /**
   * Retrieves log entries for a job by searching across all tracked queues.
   *
   * @param jobId - The job to fetch logs for
   * @returns Log entries and count, or null if the job was not found in any queue
   */
  async getJobLogs(jobId: string): Promise<QueueJobLogs | null> {
    return this.cleaner.getJobLogs(jobId);
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
    return this.cleaner.retryJob(jobId);
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
    return this.cleaner.cleanAllQueues(grace, limit, type);
  }

  /**
   * Broadcasts a WebSocket message to all connected clients.
   *
   * @param message - The message to broadcast
   */
  broadcast(message: WebSocketMessage): void {
    const payload = JSON.stringify(message);

    for (const client of this.clients) {
      try {
        client.send(payload);
      } catch (error) {
        log.error("Failed to send message to client:", error);
      }
    }
  }

  /**
   * Broadcasts the full job cache as an `initial_state` message to all clients.
   * Used after destructive operations (clean, cancel) to guarantee client/server
   * state consistency without relying on incremental deltas.
   */
  private broadcastFullState(): void {
    this.broadcast({
      type: "initial_state",
      jobs: Array.from(this.jobCache.values()),
    });
  }
}
