/**
 * ManagedQueue - wraps a bunqueue Queue + Worker pair behind the stable
 * {@link ManagedQueuePort} interface. Extensions interact with this class
 * instead of importing bunqueue directly, allowing the underlying
 * implementation to be swapped without breaking extension code.
 */

import { join } from "node:path";
import { DATA_DIR } from "@src/config";
import { Queue, QueueEvents, Worker } from "bunqueue/client";
import createLogger from "logging";
// Access bunqueue's shared QueueManager for direct cron data queries.
// The public client API (getJobSchedulers) strips the `data` field from
// scheduler entries; going through the manager preserves it.
// bunqueue's exports map doesn't expose the manager module, so it is
// imported by its file path inside node_modules.
import { getSharedManager } from "../../node_modules/bunqueue/dist/client/manager.js";
// The manager takes branded job IDs; its own helper brands them.
import { jobId as toJobId } from "../../node_modules/bunqueue/dist/domain/job/ids.js";
import { getLogStore } from "./logStore";
import type {
  CancelOutcome,
  JobInfo,
  JobProcessor,
  ManagedQueueOptions,
  ManagedQueuePort,
  QueueEventHandler,
  QueueEventMap,
  QueueEventType,
  QueueJob,
  QueueJobLogs,
  ScheduleJobTemplate,
  ScheduleRepeatOptions,
  SchedulerInfo,
} from "./types";

const logger = createLogger("ManagedQueue");

/**
 * Concrete implementation of {@link ManagedQueuePort} backed by bunqueue.
 *
 * @typeParam T - Job data type
 * @typeParam R - Job result type
 */
export class ManagedQueue<T = unknown, R = unknown> implements ManagedQueuePort<T> {
  /** The underlying bunqueue Queue instance. */
  private readonly queue: Queue<T>;
  /** The underlying bunqueue Worker instance. */
  private readonly worker: Worker<T, R>;
  /** Event emitter for queue lifecycle events. */
  private readonly events: QueueEvents;
  /** Maps original handlers to their wrapped listeners for unsubscription. */
  private readonly handlerMap = new Map<(...args: any[]) => void, (...args: any[]) => void>();
  /** Whether this queue has already been closed. */
  private closed = false;
  /** Per-job log sequence counters for ordering persisted entries. */
  private logSeq: Map<string, number> = new Map();

  /**
   * @param name - Queue name (will be used as-is by bunqueue)
   * @param processor - Function that processes each job
   * @param opts - Queue/worker configuration
   */
  constructor(name: string, processor: JobProcessor<T, R>, opts?: ManagedQueueOptions) {
    const dataPath = opts?.dataPath === null ? undefined : (opts?.dataPath ?? join(DATA_DIR, "bunqueue.db"));
    this.queue = new Queue<T>(name, { embedded: true, ...(dataPath ? { dataPath } : {}) });

    // Apply stall config if provided
    if (opts?.stallConfig) {
      this.queue.setStallConfig(opts.stallConfig);
    }
    this.queue.setDlqConfig({ autoRetry: false });

    const logSeq = this.logSeq;

    this.worker = new Worker<T, R>(
      name,
      (job, processorCtx) => {
        // Hand bunqueue's abort signal to the processor: worker.cancelJob()
        // aborts it, which is how an active job is cancelled.
        (job as unknown as QueueJob<T>).signal = processorCtx?.signal;
        // Wrap job.log to prepend a timestamp prefix and persist to SQLite
        const origLog = job.log.bind(job);
        const store = getLogStore();
        job.log = (message: string) => {
          const ts = Date.now();
          const seq = (logSeq.get(job.id) ?? 0) + 1;
          logSeq.set(job.id, seq);
          store.append(job.id, seq, message, ts);
          return origLog(`[ts:${ts}] ${message}`);
        };
        return processor(job as unknown as QueueJob<T>);
      },
      {
        embedded: true,
        concurrency: opts?.concurrency ?? 1,
        autorun: opts?.autorun ?? true,
        removeOnComplete: opts?.removeOnComplete ?? false,
        removeOnFail: opts?.removeOnFail ?? false,
        heartbeatInterval: opts?.heartbeatInterval,
        lockDuration: opts?.lockDuration,
        useLocks: opts?.useLocks,
      },
    );

    this.events = new QueueEvents(name);

    logger.debug(`Created managed queue "${name}"`);
  }

  /** @inheritdoc */
  get name(): string {
    return this.queue.name;
  }

  /** @inheritdoc */
  async add(name: string, data: T, opts?: { priority?: number; delay?: number }): Promise<string> {
    const job = await this.queue.add(name, data, { ...opts, attempts: 1 });
    return job.id;
  }

  /** @inheritdoc */
  async getJob(jobId: string): Promise<JobInfo<T> | null> {
    const job = await this.queue.getJob(jobId);
    if (!job) return null;
    const state = await job.getState();
    return {
      id: job.id,
      name: job.name,
      data: job.data,
      state: state as JobInfo<T>["state"],
      timestamp: job.timestamp,
      finishedOn: job.finishedOn,
      queueName: job.queueName,
      returnvalue: (job as unknown as { returnvalue?: unknown }).returnvalue,
    };
  }

  /** @inheritdoc */
  async getWaiting(): Promise<JobInfo<T>[]> {
    return this.mapJobs(await this.queue.getWaitingAsync(), "waiting");
  }

  /** @inheritdoc */
  async getActive(): Promise<JobInfo<T>[]> {
    return this.mapJobs(await this.queue.getActiveAsync(), "active");
  }

  /** @inheritdoc */
  async getDelayed(): Promise<JobInfo<T>[]> {
    return this.mapJobs(await this.queue.getDelayedAsync(), "delayed");
  }

  /**
   * Maps raw bunqueue Job instances to {@link JobInfo} objects.
   *
   * @param jobs - Raw bunqueue jobs
   * @param state - The known state for these jobs
   * @returns Array of mapped job info objects
   */
  private mapJobs(
    jobs: {
      id: string;
      name: string;
      queueName: string;
      data: T;
      timestamp: number;
      finishedOn?: number;
    }[],
    state: JobInfo<T>["state"],
  ): JobInfo<T>[] {
    return jobs.map((j) => ({
      id: j.id,
      name: j.name,
      queueName: j.queueName,
      data: j.data,
      state,
      timestamp: j.timestamp,
      finishedOn: j.finishedOn,
    }));
  }

  /** @inheritdoc */
  async upsertScheduler(
    schedulerId: string,
    repeat: ScheduleRepeatOptions,
    template?: ScheduleJobTemplate<T>,
  ): Promise<SchedulerInfo | null> {
    const repeatOpts: Record<string, unknown> = {};
    if (repeat.pattern) repeatOpts.pattern = repeat.pattern;
    if (repeat.every) repeatOpts.every = repeat.every;
    if (repeat.limit) repeatOpts.limit = repeat.limit;
    if (repeat.tz) repeatOpts.timezone = repeat.tz;
    if (repeat.immediately) repeatOpts.immediately = repeat.immediately;

    const jobTemplate: Record<string, unknown> | undefined = template
      ? { name: template.name, data: template.data, opts: template.opts }
      : undefined;

    const result = await this.queue.upsertJobScheduler(schedulerId, repeatOpts, jobTemplate);
    if (!result) return null;

    // Read from the shared manager to get the full CronJob (includes maxLimit)
    const cron = getSharedManager().getCron(schedulerId);
    if (!cron) {
      // Fallback: upsert succeeded but cron isn't in the manager yet.
      // Pass through whatever bunqueue returned plus the known limit.
      return { ...result, limit: repeat.limit, executions: 0 } as SchedulerInfo | null;
    }

    return {
      id: cron.name,
      name: cron.name,
      next: cron.nextRun,
      pattern: cron.schedule ?? undefined,
      every: cron.repeatEvery ?? undefined,
      limit: cron.maxLimit ?? undefined,
      executions: cron.executions ?? 0,
      data: cron.data,
    };
  }

  /** @inheritdoc */
  async removeScheduler(schedulerId: string): Promise<boolean> {
    return this.queue.removeJobScheduler(schedulerId);
  }

  /** @inheritdoc */
  async getScheduler(schedulerId: string): Promise<SchedulerInfo | null> {
    const cron = getSharedManager().getCron(schedulerId);
    if (!cron) return null;
    return {
      id: cron.name,
      name: cron.name,
      next: cron.nextRun,
      pattern: cron.schedule ?? undefined,
      every: cron.repeatEvery ?? undefined,
      limit: cron.maxLimit ?? undefined,
      executions: cron.executions ?? 0,
      data: cron.data,
    };
  }

  /** @inheritdoc */
  async getSchedulers(): Promise<SchedulerInfo[]> {
    const queueName = this.queue.name;
    return getSharedManager()
      .listCrons()
      .filter(
        (c: { queue: string; maxLimit: number | null; executions: number }) =>
          c.queue === queueName && (c.maxLimit === null || c.executions < c.maxLimit),
      )
      .map(
        (c: {
          name: string;
          nextRun: number;
          schedule: string | null;
          repeatEvery: number | null;
          maxLimit: number | null;
          executions: number;
          data: unknown;
        }) => ({
          id: c.name,
          name: c.name,
          next: c.nextRun,
          pattern: c.schedule ?? undefined,
          every: c.repeatEvery ?? undefined,
          limit: c.maxLimit ?? undefined,
          executions: c.executions ?? 0,
          data: c.data,
        }),
      );
  }

  /** @inheritdoc */
  async getAllJobs(): Promise<JobInfo<T>[]> {
    const rawJobs = this.queue.getJobs({ end: Number.MAX_SAFE_INTEGER, asc: false });
    const results: JobInfo<T>[] = [];
    for (const job of rawJobs) {
      const state = await job.getState();
      results.push({
        id: job.id,
        name: job.name,
        data: job.data,
        state: state as JobInfo<T>["state"],
        timestamp: job.timestamp,
        finishedOn: job.finishedOn,
        queueName: job.queueName,
      });
    }
    return results;
  }

  /** @inheritdoc */
  async appendJobLog(jobId: string, message: string): Promise<void> {
    const store = getLogStore();
    // After a restart the in-memory counter is gone: continue after the stored entries.
    const seq = Math.max(this.logSeq.get(jobId) ?? 0, store.getLastSeq(jobId)) + 1;
    this.logSeq.set(jobId, seq);
    store.append(jobId, seq, message, Date.now());
  }

  /** @inheritdoc */
  async getJobLogs(jobId: string): Promise<QueueJobLogs> {
    const raw = await this.queue.getJobLogs(jobId, 0, 100);

    // bunqueue keeps logs in an in-memory LRUMap that is lost on restart.
    // Fall back to the persistent SQLite store when the in-memory logs are empty.
    if (raw.count === 0) {
      const persisted = getLogStore().getLogs(jobId);
      if (persisted.length > 0) {
        return {
          logs: persisted.map((e) => ({ message: e.message, timestamp: e.timestamp ?? 0 })),
          count: persisted.length,
        };
      }
    }

    const TIMESTAMP_RE = /^(?:\[info] )?\[ts:(\d+)] /;
    const logs = raw.logs.map((line) => {
      const match = TIMESTAMP_RE.exec(line);
      return match
        ? { message: line.slice(match[0].length), timestamp: Number(match[1]) }
        : { message: line, timestamp: 0 };
    });
    return { logs, count: raw.count };
  }

  /** @inheritdoc */
  onEvent<E extends QueueEventType>(event: E, handler: QueueEventHandler<E, T>): void {
    if (event === "error") {
      const wrapped = (err: Error) => {
        (handler as QueueEventHandler<"error", T>)({ message: err.message });
      };
      this.handlerMap.set(handler, wrapped);
      this.events.on("error", wrapped);
    } else {
      // Job-related events: resolve the job before invoking the handler.
      const wrapped = async (data: { jobId: string; failedReason?: string; data?: unknown }) => {
        const job = await this.getJob(data.jobId);
        const payload = { ...data, job } as unknown as QueueEventMap<T>[E];
        handler(payload);
      };
      this.handlerMap.set(handler, wrapped);
      this.events.on(event as "waiting", wrapped);
    }
  }

  /** @inheritdoc */
  offEvent<E extends QueueEventType>(event: E, handler: QueueEventHandler<E, T>): void {
    const wrapped = this.handlerMap.get(handler);
    if (!wrapped) return;
    this.events.off(event as string, wrapped);
    this.handlerMap.delete(handler);
  }

  /** @inheritdoc */
  async cancelJob(jobId: string, reason = "Cancelled"): Promise<CancelOutcome> {
    try {
      const state = await this.queue.getJobState(jobId);
      if (state === "unknown") {
        logger.warn(`Job ${jobId} not found in "${this.queue.name}" for cancellation`);
        return "not_found";
      }
      if (state === "completed" || state === "failed") return "finished";
      // A legacy flow-chain job parked on its children cannot be moved to the DLQ.
      if (state === "waiting-children") return "not_cancellable";

      // Not started yet: move it to the DLQ directly (bunqueue's discard; the
      // client API only offers it fire-and-forget).
      if (state !== "active" && (await getSharedManager().discard(toJobId(jobId)))) {
        // The worker may have claimed the job between the state read and the
        // discard (discard takes processing jobs too): stop its processor as well.
        this.worker.cancelJob(jobId, reason);
        await this.failDiscarded(jobId, reason);
        logger.info(`Cancelled job ${jobId} in "${this.queue.name}" before it started`);
        return "cancelled";
      }

      // The job is being processed: abort its signal. The processor stops and
      // throws, so the job ends failed with `reason` as its error.
      if (this.worker.cancelJob(jobId, reason)) {
        logger.info(`Signalled cancellation for active job ${jobId} in "${this.queue.name}"`);
        return "cancelled";
      }

      // It finished in the meantime, or another process's worker holds it.
      const now = await this.queue.getJobState(jobId);
      if (now === "completed" || now === "failed") return "finished";
      logger.warn(`Job ${jobId} in "${this.queue.name}" could not be cancelled (state: ${now})`);
      return now === "unknown" ? "not_found" : "not_cancellable";
    } catch (err) {
      logger.warn(`Failed to cancel job ${jobId} from "${this.queue.name}"`, err);
      return "not_cancellable";
    }
  }

  /**
   * Finishes cancelling a job that was moved to the DLQ before it ran: logs
   * the reason and announces the failure. bunqueue's discard records no error
   * and emits no event, so without this the job would fail silently (and a
   * workflow waiting on it would never learn).
   *
   * @param jobId - The discarded job
   * @param reason - The cancel reason (logged, and the event's `failedReason`)
   * @returns Resolves once the log entry is written and the event emitted
   */
  private async failDiscarded(jobId: string, reason: string): Promise<void> {
    try {
      await this.appendJobLog(jobId, reason);
    } catch (err) {
      logger.warn(`Could not log the cancellation of job ${jobId} in "${this.queue.name}"`, err);
    }
    // Same shape as bunqueue's own failed event, so every onEvent("failed")
    // handler (queue monitor, workflow runs) treats it like any failure.
    this.events.emit("failed", { jobId, failedReason: reason });
  }

  /**
   * Attempts to remove a job, tolerating bunqueue's refusal for jobs it cannot
   * remove (active, failed). Callers verify the outcome via `getJobState`.
   *
   * @param jobId - The job to remove
   * @returns Resolves once the removal attempt has settled
   */
  private async tryRemove(jobId: string): Promise<void> {
    try {
      await this.queue.removeAsync(jobId);
    } catch {
      // Refused (job still exists in a non-removable state); the caller's state check handles it.
    }
  }

  /** @inheritdoc */
  async removeJobs(jobIds: string[]): Promise<string[]> {
    if (jobIds.length === 0) return [];

    // Partition by current state: each class needs a different removal path.
    const completed: string[] = [];
    const failed: string[] = [];
    const other: string[] = [];
    for (const id of jobIds) {
      const state = await this.queue.getJobState(id);
      if (state === "unknown") continue;
      if (state === "completed") completed.push(id);
      else if (state === "failed") failed.push(id);
      else other.push(id);
    }

    const removed: string[] = [];

    // DLQ (failed) jobs: removeAsync cannot touch them; use the dedicated DLQ
    // removal instead.
    for (const id of failed) {
      this.queue.removeDlqJob(id);
      if ((await this.queue.getJobState(id)) === "unknown") {
        removed.push(id);
      } else {
        logger.warn(`Job ${id} still present after DLQ removal in "${this.queue.name}"`);
      }
    }

    // Queued/active/delayed/waiting-children jobs: removeAsync handles these.
    for (const id of other) {
      await this.tryRemove(id);
      if ((await this.queue.getJobState(id)) === "unknown") {
        removed.push(id);
      } else {
        logger.warn(`Job ${id} still present after removeAsync in "${this.queue.name}" (may be active)`);
      }
    }

    // Completed jobs live in a separate completed store that removeAsync does not
    // touch. The only per-id purge that does not re-run the job is to requeue it
    // (completed -> waiting) then remove it while the worker cannot pick it up.
    // Pause the queue ONCE around the whole completed group so a batch cancel
    // does not churn pause/resume per job.
    if (completed.length > 0) {
      try {
        await this.queue.pauseAsync();
        for (const id of completed) {
          await this.queue.retryCompletedAsync(id);
          await this.queue.removeAsync(id);
        }
      } finally {
        await this.queue.resumeAsync();
      }
      for (const id of completed) {
        if ((await this.queue.getJobState(id)) === "unknown") {
          removed.push(id);
        } else {
          logger.warn(`Completed job ${id} still present after removal in "${this.queue.name}"`);
        }
      }
    }

    // Clean persisted logs for everything actually removed.
    if (removed.length > 0) {
      try {
        getLogStore().deleteMany(removed);
      } catch {
        logger.warn(`Failed to clean persisted logs for ${removed.length} removed jobs in "${this.queue.name}"`);
      }
      logger.info(`Removed ${removed.length}/${jobIds.length} job(s) from "${this.queue.name}"`);
    }

    return removed;
  }

  /** @inheritdoc */
  async retryJob(jobId: string): Promise<boolean> {
    try {
      await this.queue.retryJob(jobId);
      logger.info(`Retried job ${jobId} in "${this.queue.name}"`);
      return true;
    } catch (err) {
      logger.warn(`Failed to retry job ${jobId} in "${this.queue.name}"`, err);
      return false;
    }
  }

  /** @inheritdoc */
  async clean(grace: number, limit: number, type?: string): Promise<string[]> {
    const state = type ?? "completed";
    const removed = await this.queue.cleanAsync(grace, limit, type);

    // Clean persisted logs for removed jobs
    if (removed.length > 0) {
      try {
        getLogStore().deleteMany(removed);
      } catch {
        logger.warn(`Failed to clean persisted logs for ${removed.length} jobs`);
      }
    }

    logger.debug(`Cleaned ${removed.length} "${state}" jobs from "${this.queue.name}"`);
    return removed;
  }

  /** @inheritdoc */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    await this.worker.close();
    this.queue.close();
    logger.debug(`Closed managed queue "${this.queue.name}"`);
  }
}
