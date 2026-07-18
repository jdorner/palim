/**
 * Queue abstraction types.
 *
 * Defines a stable API contract for job queues and schedulers,
 * decoupling extensions from the underlying queue implementation (bunqueue).
 */

/** Job state types exposed to consumers. */
export type JobState = "waiting" | "waiting-children" | "delayed" | "active" | "completed" | "failed" | "unknown";

/**
 * Minimal job interface exposed to queue processors.
 * Mirrors the subset of bunqueue's Job that processors actually need.
 *
 * @typeParam T - The job data payload type
 */
export interface QueueJob<T = unknown> {
  /** Unique job identifier. */
  id: string;
  /** Job name (label). */
  name: string;
  /** Job payload data. */
  data: T;
  /** Number of processing attempts so far. */
  attemptsMade: number;
  /**
   * Append a log entry to the job.
   * @param message - Log message
   */
  log(message: string): Promise<void>;
}

/**
 * Job processor function that extensions implement.
 *
 * @typeParam T - Input data type
 * @typeParam R - Return value type
 * @param job - The job to process
 * @returns The processing result
 */
export type JobProcessor<T = unknown, R = unknown> = (job: QueueJob<T>) => Promise<R>;

/** Stall detection configuration for a managed queue. */
export interface StallConfig {
  /** How often (ms) the worker checks for stalled jobs. */
  stallInterval?: number;
  /** Maximum number of times a job can stall before failing. */
  maxStalls?: number;
  /** Grace period (ms) before a job is considered stalled. */
  gracePeriod?: number;
  /** Whether stall detection is enabled. */
  enabled?: boolean;
}

/** Options for creating a managed queue. */
export interface ManagedQueueOptions {
  /** Number of concurrent workers (default: 1). */
  concurrency?: number;
  /** Whether to remove jobs on completion (default: false). */
  removeOnComplete?: boolean;
  /** Whether to remove jobs on failure (default: false). */
  removeOnFail?: boolean;
  /** Worker heartbeat interval in ms. */
  heartbeatInterval?: number;
  /** Duration (ms) a job lock is held before expiring. */
  lockDuration?: number;
  /** Whether to use distributed locks (default: true). */
  useLocks?: boolean;
  /** Stall detection configuration. */
  stallConfig?: StallConfig;
  /**
   * SQLite database path for persistent job storage.
   * Set to `null` for in-memory mode (jobs lost on restart).
   * Defaults to `<DATA_DIR>/bunqueue.db` when omitted.
   */
  dataPath?: string | null;
}

/**
 * Schedule repeat configuration - supports cron patterns or fixed intervals.
 * Mutually exclusive: provide either `pattern` or `every`, not both.
 */
export interface ScheduleRepeatOptions {
  /** Cron expression (e.g. "0 9 * * *"). Mutually exclusive with `every`. */
  pattern?: string;
  /** Repeat every N milliseconds. Mutually exclusive with `pattern`. */
  every?: number;
  /** Maximum number of executions (omit for infinite). */
  limit?: number;
  /** IANA timezone for cron patterns (e.g. "Europe/Rome"). */
  tz?: string;
  /** Whether to execute immediately on creation. */
  immediately?: boolean;
}

/**
 * Template for jobs produced by a scheduler.
 *
 * @typeParam T - The job data payload type
 */
export interface ScheduleJobTemplate<T = unknown> {
  /** Job name/label. */
  name?: string;
  /** Job payload data. */
  data?: T;
  /** Optional job options. */
  opts?: {
    priority?: number;
    attempts?: number;
    delay?: number;
  };
}

/** Information about a registered job scheduler. */
export interface SchedulerInfo {
  /** Scheduler identifier. */
  id: string;
  /** Scheduler name/label. */
  name: string;
  /** Next scheduled execution timestamp (ms). */
  next: number;
  /** Cron pattern (if cron-based). */
  pattern?: string;
  /** Interval in ms (if interval-based). */
  every?: number;
  /** Maximum number of executions (omit for infinite). */
  limit?: number;
  /** Number of times this scheduler has already fired. */
  executions: number;
  /** Persisted job template data from the scheduler. */
  data?: unknown;
}

/**
 * Lightweight job info returned by query methods.
 *
 * @typeParam T - The job data payload type
 */
export interface JobInfo<T = unknown> {
  /** Unique job identifier. */
  id: string;
  /** Job name (label). */
  name: string;
  /* The queue name this job belongs to. */
  queueName: string;
  /** Job payload data. */
  data: T;
  /** Current job state. */
  state: JobState;
  /** Creation timestamp (ms). */
  timestamp: number;
  /** Completion timestamp (ms), if finished. */
  finishedOn?: number;
}

// ---------------------------------------------------------------------------
// Queue events - used by the monitor to track job lifecycle
// ---------------------------------------------------------------------------

/** Payload for queue lifecycle events. Includes the resolved job for job-related events. */
export type QueueEventMap<T = unknown> = {
  /** A job entered the waiting state. */
  waiting: { jobId: string; job: JobInfo<T> | null };
  /** A job became active (started processing). */
  active: { jobId: string; job: JobInfo<T> | null };
  /** A job completed successfully. */
  completed: { jobId: string; job: JobInfo<T> | null };
  /** A job failed. */
  failed: { jobId: string; failedReason: string; job: JobInfo<T> | null };
  /** A job stalled (heartbeat missed). */
  stalled: { jobId: string; job: JobInfo<T> | null };
  /** A queue-level error occurred. */
  error: { message: string };
};

/** Queue event names. */
export type QueueEventType = keyof QueueEventMap;

/** Callback for a specific queue event type. */
export type QueueEventHandler<E extends QueueEventType, T = unknown> = (payload: QueueEventMap<T>[E]) => void;

/** Structured log entry with timestamp, returned by {@link ManagedQueuePort.getJobLogs}. */
export interface QueueJobLogEntry {
  /** Log message text. */
  message: string;
  /** Epoch timestamp (ms) when the log was written. */
  timestamp: number;
}

/** Log entries returned by {@link ManagedQueuePort.getJobLogs}. */
export interface QueueJobLogs {
  /** Array of structured log entries. */
  logs: QueueJobLogEntry[];
  /** Total number of log entries. */
  count: number;
}

/**
 * Stable queue interface exposed to extensions.
 * Wraps the underlying queue implementation.
 *
 * @typeParam T - Job data type
 */
export interface ManagedQueuePort<T = unknown> {
  /** Queue name. */
  readonly name: string;

  /**
   * Add a one-shot job to the queue.
   * @param name - Job name/label
   * @param data - Job payload
   * @param opts - Optional job options
   * @returns The created job ID
   */
  add(name: string, data: T, opts?: { priority?: number; delay?: number }): Promise<string>;

  /**
   * Retrieve a single job by ID.
   * @param jobId - The job to look up
   * @returns Job info, or null if not found
   */
  getJob(jobId: string): Promise<JobInfo<T> | null>;

  /**
   * Get all jobs currently in the "waiting" state.
   * @returns Array of waiting job info objects
   */
  getWaiting(): Promise<JobInfo<T>[]>;

  /**
   * Get all jobs currently in the "active" state.
   * @returns Array of active job info objects
   */
  getActive(): Promise<JobInfo<T>[]>;

  /**
   * Get all jobs currently in the "delayed" state.
   * @returns Array of delayed job info objects
   */
  getDelayed(): Promise<JobInfo<T>[]>;

  /**
   * Create or update a recurring job scheduler.
   * @param schedulerId - Unique scheduler identifier
   * @param repeat - Cron or interval configuration
   * @param template - Template for jobs the scheduler produces
   * @returns Scheduler info, or null if creation failed
   */
  upsertScheduler(
    schedulerId: string,
    repeat: ScheduleRepeatOptions,
    template?: ScheduleJobTemplate<T>,
  ): Promise<SchedulerInfo | null>;

  /**
   * Remove a scheduler by ID.
   * @param schedulerId - The scheduler to remove
   * @returns true if the scheduler was found and removed
   */
  removeScheduler(schedulerId: string): Promise<boolean>;

  /**
   * Get a single scheduler by ID.
   * @param schedulerId - The scheduler to look up
   * @returns Scheduler info, or null if not found
   */
  getScheduler(schedulerId: string): Promise<SchedulerInfo | null>;

  /**
   * List all schedulers on this queue.
   * @returns Array of scheduler info objects
   */
  getSchedulers(): Promise<SchedulerInfo[]>;

  /**
   * Get all jobs across all states.
   * @returns Array of job info objects
   */
  getAllJobs(): Promise<JobInfo<T>[]>;

  /**
   * Retrieve log entries for a specific job.
   * @param jobId - The job to fetch logs for
   * @returns Log entries and total count
   */
  getJobLogs(jobId: string): Promise<QueueJobLogs>;

  /**
   * Subscribe to a queue lifecycle event.
   * For job-related events (waiting, active, completed, failed),
   * the handler receives the resolved {@link JobInfo} alongside the job ID.
   *
   * @param event - The event type to listen for
   * @param handler - Callback invoked when the event fires
   */
  onEvent<E extends QueueEventType>(event: E, handler: QueueEventHandler<E, T>): void;

  /**
   * Unsubscribe a previously registered event handler.
   *
   * @param event - The event type to unsubscribe from
   * @param handler - The exact handler reference passed to {@link onEvent}
   */
  offEvent<E extends QueueEventType>(event: E, handler: QueueEventHandler<E, T>): void;

  /**
   * Cancel a job by removing it from the queue.
   * Works for waiting, delayed, failed, and active jobs.
   *
   * @param jobId - The job to cancel
   * @returns true if the job was found and removed
   */
  cancelJob(jobId: string): Promise<boolean>;

  /**
   * Retry a failed job by moving it from the DLQ back to the waiting state.
   * Only works for jobs in the "failed" state.
   *
   * @param jobId - The job to retry
   * @returns true if the job was retried successfully
   */
  retryJob(jobId: string): Promise<boolean>;

  /**
   * Remove jobs in a given state older than the grace period.
   *
   * @param grace - Minimum age in ms a job must have before it can be cleaned
   * @param limit - Maximum number of jobs to clean
   * @param type - Job state to clean (e.g. "completed", "failed"). Defaults to "completed".
   * @returns Array of removed job IDs
   */
  clean(grace: number, limit: number, type?: string): Promise<string[]>;

  /**
   * Shut down the queue and its worker.
   */
  close(): Promise<void>;
}
