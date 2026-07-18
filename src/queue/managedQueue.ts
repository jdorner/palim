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
import { getLogStore } from "./logStore";

// Access bunqueue's shared QueueManager for direct cron data queries.
// The public client API (getJobSchedulers) strips the `data` field from
// scheduler entries; going through the manager preserves it.
// bunqueue's exports map doesn't expose the manager module directly,
// so we resolve the absolute file path relative to this module's location.
const managerPath = join(import.meta.dir, "../../node_modules/bunqueue/dist/client/manager.js");
const { getSharedManager } = await import(managerPath);

import type {
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
      (job) => {
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
    const job = await this.queue.add(name, data, opts);
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
  async cancelJob(jobId: string): Promise<boolean> {
    try {
      // Check whether the job actually exists before attempting removal.
      const stateBefore = await this.queue.getJobState(jobId);
      if (stateBefore === "unknown") {
        logger.warn(`Job ${jobId} not found in "${this.queue.name}" for cancellation`);
        return false;
      }

      // removeAsync handles queue, waitingDeps, and waitingChildren states.
      await this.queue.removeAsync(jobId);

      // removeAsync does not report success/failure, so verify via state.
      const stateAfter = await this.queue.getJobState(jobId);
      if (stateAfter === "unknown") {
        logger.info(`Cancelled job ${jobId} from "${this.queue.name}"`);
        return true;
      }

      // Job is likely active (processing). discard() pulls it out of the
      // processing shard and moves it to the DLQ. We then retryDlq (which
      // moves it from DLQ back to queue) and removeAsync to fully delete it.
      const job = await this.queue.getJob(jobId);
      if (job) {
        job.discard();
        // Allow the async discard operation to settle
        await new Promise((resolve) => setTimeout(resolve, 0));
        this.queue.retryDlq(jobId);
        await this.queue.removeAsync(jobId);
        logger.info(`Discarded active job ${jobId} from "${this.queue.name}"`);
        return true;
      }

      logger.warn(`Job ${jobId} not found in "${this.queue.name}" for cancellation`);
      return false;
    } catch (err) {
      logger.warn(`Failed to cancel job ${jobId} from "${this.queue.name}"`, err);
      return false;
    }
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
