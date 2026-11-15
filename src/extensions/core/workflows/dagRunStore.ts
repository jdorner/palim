/**
 * DAG Run Store - SQLite-backed persistence for DAG workflow run state.
 *
 * Tracks per-run edge states, step statuses, step results, and overall
 * run status. Designed for the DAG execution model where coordination
 * is driven by edge state transitions rather than a linear cursor.
 *
 * @module
 */

import type { RunTemplateInfo } from "@shared/workflows";
import { publicBaseUrl } from "@src/config";
import { eq, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { DagRunStatus, EdgeState, RunPatch, StepStatus } from "./runKernel";
import { workflowRuns } from "./runSchema";

// Run status types and the active-status rule belong to the run kernel;
// re-exported here for callers that only read runs.
export type { DagRunStatus, EdgeState, RunPatch, StepStatus } from "./runKernel";
export { isActiveRunStatus } from "./runKernel";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A DAG workflow run record.
 *
 * Represents the durable state of a single DAG workflow execution,
 * including edge states for join barrier coordination.
 */
export interface DagWorkflowRun {
  /** UUID run identifier. */
  id: string;
  /** Workflow definition name. */
  workflowName: string;
  /** Current run status. */
  status: DagRunStatus;
  /** Edge states keyed by edge ID (format: "from:to" or "from:to:branch"). */
  edgeStates: Record<string, EdgeState>;
  /** Step statuses keyed by slug. */
  stepStatuses: Record<string, StepStatus>;
  /** Accumulated step results keyed by step slug. */
  stepResults: Record<string, unknown>;
  /** Trigger payload (nullable). */
  triggerPayload: unknown;
  /** Failure reason (when status is "failed"). */
  failureReason: string | null;
  /** Id of the user who initiated the run (null for user-less runs). */
  createdByUserId: string | null;
  /** Creation timestamp (epoch ms). */
  createdAt: number;
  /** Last update timestamp (epoch ms). */
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Edge ID helpers
// ---------------------------------------------------------------------------

/** Deterministic edge id (`from:to[:branch]`), defined with the other graph rules in shared/. */
export { edgeId } from "@shared/workflowTopology";

// ---------------------------------------------------------------------------
// Module-level DB
// ---------------------------------------------------------------------------

/** Module-level DB reference - set by {@link initDagRunStore}. */
let db: BunSQLiteDatabase<Record<string, unknown>>;

/**
 * Initializes the DAG Run Store with a database instance.
 * Must be called before any other store function.
 *
 * @param database - The shared Drizzle database instance
 */
export function initDagRunStore(database: BunSQLiteDatabase<Record<string, unknown>>): void {
  db = database;
}

// ---------------------------------------------------------------------------
// Row conversion
// ---------------------------------------------------------------------------

/**
 * Converts a database row to a {@link DagWorkflowRun}.
 *
 * The `stepResults` column holds step results, step statuses, and edge states
 * as one combined JSON object:
 * `{ "__statuses": {...}, "__edges": {...}, ...stepResults }`
 *
 * @param row - Raw row from the workflow_runs table
 * @returns The deserialized DAG workflow run record
 */
function rowToRun(row: typeof workflowRuns.$inferSelect): DagWorkflowRun {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(row.stepResults) as Record<string, unknown>;
  } catch {
    parsed = {};
  }

  // Extract DAG-specific fields from the combined JSON
  const edgeStates = (parsed.__edges as Record<string, EdgeState>) ?? {};
  const stepStatuses = (parsed.__statuses as Record<string, StepStatus>) ?? {};

  // Step results are everything except the internal fields
  const stepResults: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key !== "__edges" && key !== "__statuses") {
      stepResults[key] = value;
    }
  }

  let triggerPayload: unknown = null;
  if (row.triggerPayload !== null) {
    try {
      triggerPayload = JSON.parse(row.triggerPayload);
    } catch {
      triggerPayload = row.triggerPayload;
    }
  }

  return {
    id: row.id,
    workflowName: row.workflowName,
    status: row.status as DagRunStatus,
    edgeStates,
    stepStatuses,
    stepResults,
    triggerPayload,
    failureReason: row.failureReason,
    createdByUserId: row.createdByUserId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Serializes the DAG run state into the `stepResults` column format.
 *
 * Combines edge states, step statuses, and step results into a single JSON object.
 */
function serializeState(run: Pick<DagWorkflowRun, "edgeStates" | "stepStatuses" | "stepResults">): string {
  return JSON.stringify({
    __edges: run.edgeStates,
    __statuses: run.stepStatuses,
    ...run.stepResults,
  });
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

/**
 * Creates a new DAG workflow run record.
 *
 * @param run - The run data (timestamps are auto-generated)
 * @returns The created run with timestamps
 */
export function create(
  run: Omit<DagWorkflowRun, "createdAt" | "updatedAt" | "createdByUserId"> & { createdByUserId?: string | null },
): DagWorkflowRun {
  const now = Date.now();
  const record = {
    id: run.id,
    workflowName: run.workflowName,
    status: run.status,
    stepResults: serializeState(run),
    triggerPayload: run.triggerPayload != null ? JSON.stringify(run.triggerPayload) : null,
    failureReason: run.failureReason,
    createdByUserId: run.createdByUserId ?? null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(workflowRuns).values(record).run();

  return {
    ...run,
    createdByUserId: run.createdByUserId ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Retrieves a DAG workflow run by ID.
 *
 * @param runId - The run identifier
 * @returns The run record, or null if not found
 */
export function get(runId: string): DagWorkflowRun | null {
  const row = db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get();
  return row ? rowToRun(row) : null;
}

/**
 * Builds the `run` template namespace values for a run.
 *
 * @param run - The run record
 * @returns The run's ID, workflow name, creator, UI base URL, and run page link
 */
export function toRunTemplateInfo(
  run: Pick<DagWorkflowRun, "id" | "workflowName" | "createdByUserId">,
): RunTemplateInfo {
  const baseUrl = publicBaseUrl();
  return {
    id: run.id,
    workflow: run.workflowName,
    createdBy: run.createdByUserId,
    baseUrl,
    url: `${baseUrl}/#/workflows/${encodeURIComponent(run.workflowName)}/runs/${encodeURIComponent(run.id)}`,
  };
}

/**
 * Updates a single step's status.
 *
 * Writes outside the run kernel; production code changes run state only
 * through {@link applyPatch}. Kept for setting up run state directly (tests).
 *
 * @param runId - The run identifier
 * @param slug - The step slug
 * @param status - The new step status
 */
export function updateStepStatus(runId: string, slug: string, status: StepStatus): void {
  const jsonPath = `$.__statuses.${slug}`;
  const jsonValue = JSON.stringify(status);

  db.update(workflowRuns)
    .set({
      stepResults: sql`json_set(${workflowRuns.stepResults}, ${jsonPath}, json(${jsonValue}))`,
      updatedAt: Date.now(),
    })
    .where(eq(workflowRuns.id, runId))
    .run();
}

/** Path/value pairs per `json_set` call in {@link applyPatch}. */
const PATCH_BATCH = 40;

/**
 * Applies a patch in one statement. Each step status, edge state and result is
 * written with its own `json_set`, never by replacing the whole blob, so keys
 * written concurrently by another handler survive.
 *
 * @param runId - The run identifier
 * @param patch - The changes to apply
 */
export function applyPatch(runId: string, patch: RunPatch): void {
  const writes: [string, unknown][] = [
    ...Object.entries(patch.stepResults).map(([slug, value]): [string, unknown] => [`$.${slug}`, value]),
    ...Object.entries(patch.stepStatuses).map(([slug, value]): [string, unknown] => [`$.__statuses.${slug}`, value]),
    ...Object.entries(patch.edgeStates).map(([key, value]): [string, unknown] => [`$.__edges.${key}`, value]),
  ];
  if (writes.length === 0 && patch.status === undefined) return;

  // json_set takes many path/value pairs; batch them to stay well below
  // SQLite's function-argument and expression-depth limits.
  let expr = sql`${workflowRuns.stepResults}`;
  for (let i = 0; i < writes.length; i += PATCH_BATCH) {
    const pairs = writes
      .slice(i, i + PATCH_BATCH)
      .map(([path, value]) => sql`${path}, json(${JSON.stringify(value) ?? "null"})`);
    expr = sql`json_set(${expr}, ${sql.join(pairs, sql`, `)})`;
  }

  db.update(workflowRuns)
    .set({
      ...(writes.length > 0 ? { stepResults: expr } : {}),
      ...(patch.status !== undefined ? { status: patch.status, failureReason: patch.failureReason ?? null } : {}),
      updatedAt: Date.now(),
    })
    .where(eq(workflowRuns.id, runId))
    .run();
}

/**
 * Updates the run status and optional failure reason.
 *
 * Writes outside the run kernel; production code changes run state only
 * through {@link applyPatch}. Kept for setting up run state directly (tests).
 *
 * @param runId - The run identifier
 * @param status - The new status value
 * @param failureReason - Optional failure reason (relevant when status is "failed")
 */
export function updateStatus(runId: string, status: DagRunStatus, failureReason?: string): void {
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
 * Retrieves all DAG runs for the given workflow name.
 *
 * @param name - The workflow definition name
 * @returns Array of matching runs
 */
export function getByWorkflowName(name: string): DagWorkflowRun[] {
  const rows = db.select().from(workflowRuns).where(eq(workflowRuns.workflowName, name)).all();
  return rows.map(rowToRun);
}

/**
 * Retrieves all DAG runs across every workflow.
 *
 * Intended for lightweight bulk status lookups (e.g. enriching workflow
 * group badges in the job list) so callers do not have to fan out one
 * request per workflow definition.
 *
 * @returns Array of all persisted runs
 */
export function getAll(): DagWorkflowRun[] {
  const rows = db.select().from(workflowRuns).all();
  return rows.map(rowToRun);
}

/**
 * Deletes DAG workflow run records by their IDs.
 *
 * @param ids - Array of run IDs to delete
 */
export function deleteByIds(ids: string[]): void {
  if (ids.length === 0) return;
  for (const id of ids) {
    db.delete(workflowRuns).where(eq(workflowRuns.id, id)).run();
  }
}
