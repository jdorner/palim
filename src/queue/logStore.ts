/**
 * Persistent job log store backed by Drizzle ORM + SQLite.
 *
 * bunqueue keeps job logs only in an in-memory LRUMap - they are lost on
 * restart. This module provides a thin persistence layer that stores log
 * entries so they survive server restarts.
 *
 * @module
 */

import { getDb, schema } from "@src/db";
import { asc, desc, eq, inArray } from "drizzle-orm";
import createLogger from "logging";

const logger = createLogger("LogStore");

/** A single persisted log entry. */
export interface PersistedLogEntry {
  /** Log message text. */
  message: string;
  /** Epoch timestamp (ms) when the log was written. */
  timestamp: number;
}

/**
 * Drizzle-backed store for job log entries.
 *
 * Delegates all database access to the shared Drizzle instance from
 * `@src/db`, keeping this module focused on the log-specific queries.
 */
export class LogStore {
  /**
   * Append a log entry for a job.
   *
   * @param jobId - The job this log belongs to
   * @param seq - Sequence number (monotonically increasing per job)
   * @param message - Log message text
   * @param timestamp - Epoch ms when the log was written
   */
  append(jobId: string, seq: number, message: string, timestamp: number): void {
    getDb().insert(schema.jobLogs).values({ jobId, seq, message, ts: timestamp }).onConflictDoNothing().run();
  }

  /**
   * Retrieve all log entries for a job, ordered by sequence.
   *
   * @param jobId - The job to fetch logs for
   * @returns Array of persisted log entries
   */
  getLogs(jobId: string): PersistedLogEntry[] {
    const rows = getDb()
      .select({ message: schema.jobLogs.message, timestamp: schema.jobLogs.ts })
      .from(schema.jobLogs)
      .where(eq(schema.jobLogs.jobId, jobId))
      .orderBy(asc(schema.jobLogs.seq))
      .all();

    return rows;
  }

  /**
   * Delete all log entries for a job (used during cleanup).
   *
   * @param jobId - The job whose logs should be removed
   */
  deleteLogs(jobId: string): void {
    getDb().delete(schema.jobLogs).where(eq(schema.jobLogs.jobId, jobId)).run();
  }

  /**
   * Delete logs for multiple jobs in a single transaction.
   *
   * @param jobIds - Array of job IDs whose logs should be removed
   */
  deleteMany(jobIds: string[]): void {
    if (jobIds.length === 0) return;
    getDb().delete(schema.jobLogs).where(inArray(schema.jobLogs.jobId, jobIds)).run();
  }

  /**
   * Get the timestamp of the last log entry for a job.
   * Useful as an approximation of completion time when the queue doesn't persist it.
   *
   * @param jobId - The job to check
   * @returns The last log timestamp (ms), or undefined if no logs exist
   */
  getLastTimestamp(jobId: string): number | undefined {
    const row = getDb()
      .select({ timestamp: schema.jobLogs.ts })
      .from(schema.jobLogs)
      .where(eq(schema.jobLogs.jobId, jobId))
      .orderBy(desc(schema.jobLogs.seq))
      .limit(1)
      .get();

    return row?.timestamp || undefined;
  }

  /**
   * Remove log entries for jobs that no longer exist in any queue.
   *
   * Queries all distinct job IDs from the log table, compares them against
   * the provided set of live job IDs, and deletes logs for any orphaned jobs.
   *
   * @param liveJobIds - Set of job IDs that still exist in bunqueue
   * @returns Number of orphaned jobs whose logs were removed
   */
  purgeOrphaned(liveJobIds: Set<string>): number {
    const rows = getDb().selectDistinct({ jobId: schema.jobLogs.jobId }).from(schema.jobLogs).all();

    const orphanedIds = rows.map((r) => r.jobId).filter((id) => !liveJobIds.has(id));

    if (orphanedIds.length > 0) {
      this.deleteMany(orphanedIds);
    }

    return orphanedIds.length;
  }
}

/** Shared singleton instance. */
let instance: LogStore | null = null;

/**
 * Get or create the shared LogStore singleton.
 *
 * @returns The shared LogStore instance
 */
export function getLogStore(): LogStore {
  if (!instance) {
    instance = new LogStore();
  }
  return instance;
}

/**
 * Close the shared LogStore singleton (for graceful shutdown).
 * Does not close the shared database - that is the caller's responsibility.
 */
export function closeLogStore(): void {
  stopLogPurgeTimer();
  instance = null;
}

// ---------------------------------------------------------------------------
// Periodic orphan purge
// ---------------------------------------------------------------------------

/** Handle for the periodic purge timer. */
let _purgeTimer: ReturnType<typeof setInterval> | null = null;

function execPurgeCb(collectLiveIds: () => Promise<Set<string>>): () => void {
  return async () => {
    try {
      const liveIds = await collectLiveIds();
      const purged = getLogStore().purgeOrphaned(liveIds);
      if (purged > 0) {
        logger.info(`Purged orphaned logs for ${purged} job(s)`);
      }
    } catch (err) {
      logger.warn("Log purge failed:", err);
    }
  };
}

/**
 * Start a periodic timer that purges log entries for jobs that no longer
 * exist in any queue.
 *
 * The caller provides an async function that collects all live job IDs
 * from core and extension queues - the store itself has no knowledge of
 * the queue layer.
 *
 * @param collectLiveIds - Returns all job IDs still present in bunqueue
 * @param intervalMs - How often to run, in ms (default: 6 hours)
 * @param opts - Timer options
 */
export function startLogPurgeTimer(
  collectLiveIds: () => Promise<Set<string>>,
  opts: { intervalMs: number; executeImmediately: boolean } = {
    intervalMs: 6 * 60 * 60 * 1000,
    executeImmediately: false,
  },
): void {
  stopLogPurgeTimer();
  _purgeTimer = setInterval(execPurgeCb(collectLiveIds), opts.intervalMs);

  // Don't keep the process alive just for this timer
  _purgeTimer.unref();
  logger.debug(`Log purge timer started (interval: ${Math.round(opts.intervalMs / 60_000)}min)`);

  if (opts.executeImmediately) {
    execPurgeCb(collectLiveIds)();
  }
}

/**
 * Stop the periodic log purge timer.
 */
export function stopLogPurgeTimer(): void {
  if (_purgeTimer) {
    clearInterval(_purgeTimer);
    _purgeTimer = null;
  }
}
