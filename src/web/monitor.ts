/**
 * QueueMonitor - tracks job lifecycle events across all managed queues
 * and broadcasts real-time updates to connected WebSocket clients.
 *
 * Operates entirely through the {@link ManagedQueuePort} abstraction,
 * with no direct dependency on the underlying queue implementation.
 */

import type { JobEntry, WebSocketMessage } from "@shared/types";
import type { AuthResolver, ResolvedPrincipal } from "@src/auth";
import type { JobInfo, ManagedQueuePort, QueueJobLogs } from "@src/queue";
import { getLogStore } from "@src/queue";
import { mainLogger as log } from "@src/utils/logger";
import type { ServerWebSocket } from "elysia/ws/bun";
import { JobCanceller } from "./jobCanceller";
import { type CleanDecision, QueueCleaner } from "./queueCleaner";

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
 * Extracts the chat ID from a job payload whose routing context is a chat.
 *
 * @param data - The raw job data
 * @returns The chat ID, or `null` when the job is not chat-routed
 */
function extractChatId(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const context = (data as Record<string, unknown>).context as Record<string, unknown> | undefined;
  if (context?.source === "chat" && typeof context.id === "string") return context.id;
  return null;
}

/** WebSocket close code telling the client its credentials are no longer valid. */
const WS_CLOSE_UNAUTHORIZED = 4001;

/** Per-connection auth state tracked by the monitor. */
interface ClientAuth {
  /** The principal the connection currently acts as (null when unauthenticated). */
  principal: ResolvedPrincipal | null;
  /** The bearer token the connection opened with, re-resolved on revalidation. */
  token?: string;
}

/**
 * Monitor class for tracking job status and broadcasting updates to WebSocket clients.
 */
export class QueueMonitor {
  /** Connected clients mapped to their auth state. */
  private clients: Map<ServerWebSocket<unknown>, ClientAuth> = new Map();
  /** Resolver used to re-check client tokens; revalidation is a no-op without it. */
  private authResolver: AuthResolver | null = null;
  private revalidationTimer: ReturnType<typeof setInterval> | null = null;
  private jobCache: Map<string, JobEntry> = new Map();
  /**
   * Owner of each known chat stream, keyed by chatId (null = no recorded owner).
   * The first claim wins so a later job naming the same chatId cannot hijack
   * another user's stream.
   */
  private chatOwners: Map<string, string | null> = new Map();
  /** Chat-routed job IDs mapped to their chatId, for evicting {@link chatOwners}. */
  private jobChats: Map<string, string> = new Map();
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
      onBeforeJobsRemoved: (ids, getCached) => {
        if (this.beforeJobsRemovedCallback) {
          this.beforeJobsRemovedCallback(ids, getCached);
        }
      },
      decideJobClean: (job, cleanType) => (this.cleanGuard ? this.cleanGuard(job, cleanType) : "default"),
    });
    this.addQueues(queues);
  }

  /** Optional callback invoked before jobs are evicted from the cache during clean operations. */
  private beforeJobsRemovedCallback:
    | ((jobIds: string[], getCachedJob: (id: string) => JobEntry | undefined) => void)
    | null = null;

  /**
   * Registers a callback invoked before cleaned jobs are evicted from the cache.
   *
   * Allows consumers (e.g. the workflow extension) to extract metadata from
   * cached job entries before they are permanently discarded.
   *
   * @param callback - Function receiving job IDs and a cache lookup function
   */
  setOnBeforeJobsRemoved(
    callback: (jobIds: string[], getCachedJob: (id: string) => JobEntry | undefined) => void,
  ): void {
    this.beforeJobsRemovedCallback = callback;
  }

  /** Optional guard consulted during clean operations to decide per-job handling. */
  private cleanGuard: ((job: JobEntry, cleanType: string) => CleanDecision) | null = null;

  /**
   * Registers a guard that decides how each job participates in a clean.
   *
   * The guard receives a cached job entry and the clean's target state
   * (`cleanType`, e.g. "completed" or "failed") and returns a
   * {@link CleanDecision}: `"keep"` (protect), `"remove"` (remove regardless of
   * the job's own queue state), or `"default"` (apply the normal rule). When a
   * guard is set, clean operations use selective per-job removal instead of the
   * fast bulk path so the guard's verdict is honored precisely. Used to clean a
   * workflow run's steps together when the run status matches the clean type,
   * keep them when it does not, and always keep steps of a still-active run.
   *
   * @param guard - Function returning a per-job clean decision
   */
  setCleanGuard(guard: (job: JobEntry, cleanType: string) => CleanDecision): void {
    this.cleanGuard = guard;
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
        // Stalled jobs are moved to DLQ by bunqueue (state becomes "failed").
        // Update the cache to reflect the terminal state so stale "active"
        // entries don't persist in initial_state snapshots.
        const entry = this.jobCache.get(jobId);
        if (entry) {
          entry.status = "failed";
          entry.completedAt = Date.now();
          this.broadcast({ type: "job_updated", job: entry });
        }
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

    // Enrich with session/workflow metadata if the job payload carries it
    const data = job.data as Record<string, unknown> | null | undefined;
    if (data && typeof data.sessionId === "string") {
      entry.sessionId = data.sessionId;
    }
    // The initiating user id scopes visibility of chat jobs to their owner.
    if (data && typeof data.initiatorUserId === "string") {
      entry.userId = data.initiatorUserId;
    }
    const chatId = extractChatId(data);
    if (chatId) {
      this.registerChatOwner(chatId, entry.userId ?? null);
      this.jobChats.set(job.id, chatId);
    }
    if (data && typeof data.workflowRunId === "string") {
      entry.workflowRunId = data.workflowRunId;
      if (typeof data.workflowName === "string") entry.workflowName = data.workflowName;
      if (typeof data.stepSlug === "string") entry.stepSlug = data.stepSlug;
      if (typeof data.stepIndex === "number") entry.stepIndex = data.stepIndex;
      if (typeof data.totalSteps === "number") entry.totalSteps = data.totalSteps;
    }

    return entry;
  }

  /**
   * Records the owner of a chat stream so `chat_event` and `push_message`
   * broadcasts for it reach only that user (and admins).
   *
   * The first claim for a chatId wins; later claims are ignored. Callers that
   * enqueue chat jobs should register before enqueueing so the owner is known
   * before any streamed output is broadcast.
   *
   * @param chatId - The client-generated chat correlation ID
   * @param userId - The owning user's id, or null when there is no initiator (delivered to no one)
   */
  registerChatOwner(chatId: string, userId: string | null): void {
    if (!this.chatOwners.has(chatId)) this.chatOwners.set(chatId, userId);
  }

  /**
   * Drops chat ownership for an evicted job once no remaining job references its chat.
   *
   * @param jobId - The evicted job's id
   */
  private forgetJobChat(jobId: string): void {
    const chatId = this.jobChats.get(jobId);
    if (!chatId) return;
    this.jobChats.delete(jobId);
    for (const other of this.jobChats.values()) {
      if (other === chatId) return;
    }
    this.chatOwners.delete(chatId);
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
   * Pass the connection's bearer token so {@link revalidateClients} can drop the
   * connection once the token is revoked or expires, or its user is disabled.
   *
   * @param ws - The WebSocket client to add
   * @param principal - The authenticated principal for this connection (null when unauthenticated)
   * @param token - The bearer token the connection authenticated with
   */
  addClient(ws: ServerWebSocket<unknown>, principal: ResolvedPrincipal | null = null, token?: string): void {
    this.clients.set(ws, { principal, ...(token ? { token } : {}) });
    log.debug("New monitor client connected");
    this.sendInitialState(ws, principal);
  }

  /**
   * Sends the job cache, scoped to the given principal, as an `initial_state`
   * snapshot. Clients replace their whole job list on receipt.
   *
   * @param ws - The WebSocket client to send to
   * @param principal - The principal the snapshot is scoped to
   */
  private sendInitialState(ws: ServerWebSocket<unknown>, principal: ResolvedPrincipal | null): void {
    const initialState: WebSocketMessage = {
      type: "initial_state",
      jobs: Array.from(this.jobCache.values()).filter((j) => this.isJobVisibleTo(j.id, principal)),
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
   * Sets the resolver used by {@link revalidateClients} to re-check client tokens.
   *
   * @param resolver - The token resolver (typically the auth service)
   */
  setAuthResolver(resolver: AuthResolver): void {
    this.authResolver = resolver;
  }

  /**
   * Re-resolves every token-bearing client against the auth resolver.
   *
   * A WebSocket otherwise keeps the identity it had when it opened. Clients
   * whose token no longer resolves (logout, expiry, revoked sessions, disabled
   * user) are closed with code 4001 and stop receiving broadcasts immediately;
   * the rest pick up their current principal so role and permission changes
   * apply to subsequent broadcasts, and receive a fresh `initial_state` when
   * their admin status flips. Call after auth state changes, and
   * periodically to catch expiry and out-of-process changes.
   *
   * @returns The number of clients that were disconnected
   */
  revalidateClients(): number {
    const resolver = this.authResolver;
    if (!resolver) return 0;

    let closed = 0;
    for (const [ws, auth] of this.clients) {
      if (!auth.token) continue;
      let principal: ResolvedPrincipal | null;
      try {
        principal = resolver.resolveToken(auth.token);
      } catch (error) {
        // Keep the connection on transient resolver failures; the next pass retries.
        log.error("Failed to revalidate monitor client:", error);
        continue;
      }
      if (principal) {
        auth.principal = principal;
        continue;
      }
      this.clients.delete(ws);
      closed++;
      try {
        ws.close(WS_CLOSE_UNAUTHORIZED, "Unauthorized");
      } catch (error) {
        log.debug("Failed to close revoked monitor client:", error);
      }
    }
    if (closed > 0) log.info(`Disconnected ${closed} WebSocket client(s) with revoked credentials`);
    return closed;
  }

  /**
   * Starts a periodic {@link revalidateClients} pass, replacing any running timer.
   * The timer is unref'd so it never keeps the process alive on its own.
   *
   * @param intervalMs - Interval between revalidation passes, in ms
   */
  startRevalidationTimer(intervalMs: number): void {
    this.stopRevalidationTimer();
    this.revalidationTimer = setInterval(() => this.revalidateClients(), intervalMs);
    this.revalidationTimer.unref();
  }

  /**
   * Stops the periodic revalidation timer, if running.
   */
  stopRevalidationTimer(): void {
    if (this.revalidationTimer) {
      clearInterval(this.revalidationTimer);
      this.revalidationTimer = null;
    }
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
      this.forgetJobChat(id);
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
   * If the message is a `job_removed` event, the corresponding entry is also
   * evicted from the in-memory cache so it won't resurface in future
   * `initial_state` snapshots.
   *
   * @param message - The message to broadcast
   */
  broadcast(message: WebSocketMessage): void {
    // Keep cache consistent when extensions broadcast job_removed directly.
    // Capture a chat job's owner BEFORE eviction so per-client filtering still works.
    let removedChatOwner: string | null | undefined;
    if (message.type === "job_removed") {
      if (this.jobChats.has(message.jobId)) removedChatOwner = this.jobCache.get(message.jobId)?.userId ?? null;
      this.jobCache.delete(message.jobId);
      this.forgetJobChat(message.jobId);
    }

    for (const [client, { principal }] of this.clients) {
      const scoped = this.scopeMessageForClient(message, principal, removedChatOwner);
      if (scoped === null) continue;
      try {
        client.send(JSON.stringify(scoped));
      } catch (error) {
        log.error("Failed to send message to client:", error);
      }
    }
  }

  /**
   * Scopes a broadcast message to what a specific client is permitted to see.
   *
   * Chat streams (`chat_event`/`push_message`) and chat jobs are delivered only
   * to the chat's owner, admins included; chats with no recorded or unknown
   * owner reach no one. For job events this means:
   * - `initial_state` has its `jobs` array filtered to the visible jobs.
   * - `job_added`/`job_updated`/`job_log` are dropped for other users' chat jobs.
   * - `job_removed` is dropped when the evicted job was another user's chat job.
   *
   * Every other event (non-chat jobs, schedules, reloads, extension lifecycle,
   * approvals, workflows) is readable by all authenticated clients and passes through.
   *
   * @param message - The outgoing message.
   * @param principal - The client's principal (null when unauthenticated).
   * @param removedChatOwner - For `job_removed` of a chat job, its owner captured before
   *   eviction (null when it had none); undefined when the removed job was not a chat job.
   * @returns The (possibly filtered) message, or null to drop it for this client.
   */
  private scopeMessageForClient(
    message: WebSocketMessage,
    principal: ResolvedPrincipal | null,
    removedChatOwner?: string | null,
  ): WebSocketMessage | null {
    switch (message.type) {
      // Chat streams go to the chat's owner only - admins included. Clients only
      // render streams they started (and surface unknown-chat errors as their own),
      // so delivering other users' streams would leak content and show bogus errors.
      case "chat_event":
      case "push_message": {
        const owner = this.chatOwners.get(message.chatId);
        return owner != null && owner === principal?.user.id ? message : null;
      }
      case "initial_state":
        return { type: "initial_state", jobs: message.jobs.filter((j) => this.isJobVisibleTo(j.id, principal)) };
      case "job_added":
      case "job_updated":
        return this.isJobVisibleTo(message.job.id, principal) ? message : null;
      case "job_log":
        return this.isJobVisibleTo(message.jobId, principal) ? message : null;
      case "job_removed":
        if (removedChatOwner === undefined) return message;
        return removedChatOwner !== null && removedChatOwner === principal?.user.id ? message : null;
      default:
        return message;
    }
  }

  /**
   * Whether a cached job is visible to a principal.
   *
   * Chat jobs are private to the user who started them (admins included), like
   * the chat sessions and streams they belong to; a chat job with no recorded
   * initiator is visible to no one. All other jobs are readable by everyone.
   *
   * @param jobId - The job's id.
   * @param principal - The viewing principal (null when unauthenticated).
   * @returns True when the principal may see the job.
   */
  private isJobVisibleTo(jobId: string, principal: ResolvedPrincipal | null): boolean {
    if (!this.jobChats.has(jobId)) return true;
    const owner = this.jobCache.get(jobId)?.userId;
    return owner !== undefined && owner === principal?.user.id;
  }

  /**
   * Whether a principal may see and act on a job, for the per-job HTTP routes.
   *
   * Applies the same rule as the WebSocket feed: chat jobs are private to their
   * initiator, everything else is open. Falls back to the queues for jobs not in
   * the cache. Unknown jobs count as accessible so callers keep their own 404.
   *
   * @param jobId - The job's id.
   * @param principal - The requesting principal (undefined when unauthenticated).
   * @returns True when the principal may access the job.
   */
  async canAccessJob(jobId: string, principal: ResolvedPrincipal | undefined): Promise<boolean> {
    if (this.jobCache.has(jobId)) return this.isJobVisibleTo(jobId, principal ?? null);
    for (const queue of this.queues) {
      const job = await queue.getJob(jobId);
      if (!job) continue;
      if (!extractChatId(job.data)) return true;
      const owner = (job.data as Record<string, unknown>).initiatorUserId;
      return typeof owner === "string" && owner === principal?.user.id;
    }
    return true;
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
