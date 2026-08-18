/**
 * Run Store - SQLite-backed persistence for workflow run state.
 *
 * Persists accumulated step results, trigger payload, run status,
 * and execution cursor across segment boundaries. Survives process
 * restarts and enables crash recovery.
 *
 * Uses the same module-level DB injection pattern as
 * `src/extensions/core/filewatcher/store.ts`.
 *
 * @module
 */

import { eq, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { workflowRuns } from "./runSchema";

/** Run status values for a workflow execution. */
export type RunStatus = "running" | "waiting-signal" | "completed" | "failed";

/**
 * A workflow run record persisted in SQLite.
 *
 * Represents the durable state of a single workflow execution,
 * including accumulated step results and execution cursor.
 */
export interface WorkflowRun {
  /** UUID run identifier. */
  id: string;
  /** Workflow definition name. */
  workflowName: string;
  /** Current run status. */
  status: RunStatus;
  /** Accumulated step results keyed by step slug. */
  stepResults: Record<string, unknown>;
  /** Trigger payload (nullable). */
  triggerPayload: unknown;
  /** Zero-based execution cursor (points to current/next segment). */
  currentStepIndex: number;
  /** Ordered list of all step slugs in the workflow. */
  fullStepOrder: string[];
  /** Failure reason (when status is "failed"). */
  failureReason: string | null;
  /** Creation timestamp (epoch ms). */
  createdAt: number;
  /** Last update timestamp (epoch ms). */
  updatedAt: number;
}

/**
 * Run Store data access interface.
 *
 * Provides CRUD operations for workflow run records with
 * JSON serialization/deserialization handled transparently.
 */
export interface RunStore {
  /** Creates a new run record. */
  create(run: Omit<WorkflowRun, "createdAt" | "updatedAt">): WorkflowRun;
  /** Retrieves a run by ID. */
  get(runId: string): WorkflowRun | null;
  /** Updates a single step result (last-write-wins). */
  updateStepResult(runId: string, stepSlug: string, result: unknown): void;
  /** Updates run status and optional failure reason. */
  updateStatus(runId: string, status: RunStatus, failureReason?: string): void;
  /** Updates the execution cursor (current step index). */
  updateStepIndex(runId: string, index: number): void;
  /** Retrieves all runs with the given status. */
  getByStatus(status: RunStatus): WorkflowRun[];
  /** Retrieves all runs for the given workflow name. */
  getByWorkflowName(name: string): WorkflowRun[];
}

/** Module-level DB reference - set by {@link initRunStore}. */
let db: BunSQLiteDatabase<Record<string, unknown>>;

/**
 * Initializes the Run Store with a database instance.
 * Must be called before any other store function.
 *
 * @param database - The shared Drizzle database instance
 */
export function initRunStore(database: BunSQLiteDatabase<Record<string, unknown>>): void {
  db = database;
}

/**
 * Converts a database row to a {@link WorkflowRun}.
 *
 * Handles JSON deserialization of `stepResults`, `triggerPayload`,
 * and `fullStepOrder` columns.
 *
 * @param row - Raw row from the workflow_runs table
 * @returns The deserialized workflow run record
 */
function rowToRun(row: typeof workflowRuns.$inferSelect): WorkflowRun {
  let stepResults: Record<string, unknown>;
  try {
    stepResults = JSON.parse(row.stepResults) as Record<string, unknown>;
  } catch {
    stepResults = {};
  }

  let triggerPayload: unknown = null;
  if (row.triggerPayload !== null) {
    try {
      triggerPayload = JSON.parse(row.triggerPayload);
    } catch {
      triggerPayload = row.triggerPayload;
    }
  }

  let fullStepOrder: string[];
  try {
    fullStepOrder = JSON.parse(row.fullStepOrder) as string[];
  } catch {
    fullStepOrder = [];
  }

  return {
    id: row.id,
    workflowName: row.workflowName,
    status: row.status as RunStatus,
    stepResults,
    triggerPayload,
    currentStepIndex: row.currentStepIndex,
    fullStepOrder,
    failureReason: row.failureReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Creates a new workflow run record.
 *
 * @param run - The run data (timestamps are auto-generated)
 * @returns The created run with timestamps
 */
export function create(run: Omit<WorkflowRun, "createdAt" | "updatedAt">): WorkflowRun {
  const now = Date.now();
  const record = {
    id: run.id,
    workflowName: run.workflowName,
    status: run.status,
    stepResults: JSON.stringify(run.stepResults),
    triggerPayload: run.triggerPayload != null ? JSON.stringify(run.triggerPayload) : null,
    currentStepIndex: run.currentStepIndex,
    fullStepOrder: JSON.stringify(run.fullStepOrder),
    failureReason: run.failureReason,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(workflowRuns).values(record).run();

  return {
    ...run,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Retrieves a workflow run by ID.
 *
 * @param runId - The run identifier
 * @returns The run record, or null if not found
 */
export function get(runId: string): WorkflowRun | null {
  const row = db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get();
  return row ? rowToRun(row) : null;
}

/**
 * Updates a single step result atomically using SQLite's json_set().
 *
 * Performs a single UPDATE statement that merges the new key/value
 * into the existing JSON without a separate SELECT, preventing
 * race conditions when concurrent segments write different keys.
 *
 * @param runId - The run identifier
 * @param stepSlug - The step slug to write the result for
 * @param result - The result value to store
 */
export function updateStepResult(runId: string, stepSlug: string, result: unknown): void {
  const jsonPath = `$.${stepSlug}`;
  const jsonValue = JSON.stringify(result);

  db.update(workflowRuns)
    .set({
      stepResults: sql`json_set(${workflowRuns.stepResults}, ${jsonPath}, json(${jsonValue}))`,
      updatedAt: Date.now(),
    })
    .where(eq(workflowRuns.id, runId))
    .run();
}

/**
 * Updates the run status and optional failure reason.
 *
 * @param runId - The run identifier
 * @param status - The new status value
 * @param failureReason - Optional failure reason (relevant when status is "failed")
 */
export function updateStatus(runId: string, status: RunStatus, failureReason?: string): void {
  db.update(workflowRuns)
    .set({
      status,
      failureReason: failureReason ?? null,
      updatedAt: Date.now(),
    })
    .where(eq(workflowRuns.id, runId))
    .run();
}

/**
 * Updates the execution cursor (current step index).
 *
 * @param runId - The run identifier
 * @param index - The new zero-based step index
 */
export function updateStepIndex(runId: string, index: number): void {
  db.update(workflowRuns)
    .set({
      currentStepIndex: index,
      updatedAt: Date.now(),
    })
    .where(eq(workflowRuns.id, runId))
    .run();
}

/**
 * Retrieves all runs with the given status.
 *
 * Useful for crash recovery (finding `running` or `waiting-signal` runs).
 *
 * @param status - The status to filter by
 * @returns Array of matching runs
 */
export function getByStatus(status: RunStatus): WorkflowRun[] {
  const rows = db.select().from(workflowRuns).where(eq(workflowRuns.status, status)).all();
  return rows.map(rowToRun);
}

/**
 * Retrieves all runs for the given workflow name.
 *
 * @param name - The workflow definition name
 * @returns Array of matching runs
 */
export function getByWorkflowName(name: string): WorkflowRun[] {
  const rows = db.select().from(workflowRuns).where(eq(workflowRuns.workflowName, name)).all();
  return rows.map(rowToRun);
}

/**
 * Deletes workflow run records by their IDs.
 *
 * Used to keep the Run Store in sync when completed/failed jobs are
 * cleaned from the queue. No-op for empty arrays or nonexistent IDs.
 *
 * @param ids - Array of run IDs to delete
 */
export function deleteByIds(ids: string[]): void {
  if (ids.length === 0) return;

  for (const id of ids) {
    db.delete(workflowRuns).where(eq(workflowRuns.id, id)).run();
  }
}
