/**
 * DAG Run Store - SQLite-backed persistence for DAG workflow run state.
 *
 * Tracks per-run edge states, step statuses, step results, and overall
 * run status. Designed for the DAG execution model where coordination
 * is driven by edge state transitions rather than a linear cursor.
 *
 * Uses the same module-level DB injection pattern as the legacy Run Store.
 *
 * @module
 */

import { eq, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { workflowRuns } from "./runSchema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Run status values for a DAG workflow execution. */
export type DagRunStatus = "running" | "waiting-signal" | "completed" | "failed";

/** State of a single edge in the DAG during execution. */
export type EdgeState = "pending" | "satisfied" | "dead";

/** Status of a single step in the DAG during execution. */
export type StepStatus = "pending" | "running" | "completed" | "failed" | "dead";

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
  /** Creation timestamp (epoch ms). */
  createdAt: number;
  /** Last update timestamp (epoch ms). */
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Edge ID helpers
// ---------------------------------------------------------------------------

/**
 * Computes a deterministic edge ID from an edge definition.
 *
 * @param from - Source step slug
 * @param to - Target step slug
 * @param branch - Optional branch label (for CF edges)
 * @returns Edge ID string
 */
export function edgeId(from: string, to: string, branch?: string): string {
  return branch ? `${from}:${to}:${branch}` : `${from}:${to}`;
}

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
 * The DAG Run Store reuses the `workflow_runs` table but interprets columns
 * differently:
 * - `fullStepOrder` stores JSON-encoded `edgeStates` record
 * - `currentStepIndex` is unused (always 0)
 * - `stepResults` stores both step results and step statuses as a combined JSON
 *
 * Format of stepResults column for DAG runs:
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
export function create(run: Omit<DagWorkflowRun, "createdAt" | "updatedAt">): DagWorkflowRun {
  const now = Date.now();
  const record = {
    id: run.id,
    workflowName: run.workflowName,
    status: run.status,
    stepResults: serializeState(run),
    triggerPayload: run.triggerPayload != null ? JSON.stringify(run.triggerPayload) : null,
    currentStepIndex: 0,
    fullStepOrder: JSON.stringify([]), // unused for DAG runs
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
 * Updates a single edge state atomically.
 *
 * @param runId - The run identifier
 * @param edgeKey - The edge ID (e.g. "a:b" or "decide:x:then")
 * @param state - The new edge state
 */
export function updateEdgeState(runId: string, edgeKey: string, state: EdgeState): void {
  const jsonPath = `$.__edges.${edgeKey}`;
  const jsonValue = JSON.stringify(state);

  db.update(workflowRuns)
    .set({
      stepResults: sql`json_set(${workflowRuns.stepResults}, ${jsonPath}, json(${jsonValue}))`,
      updatedAt: Date.now(),
    })
    .where(eq(workflowRuns.id, runId))
    .run();
}

/**
 * Updates multiple edge states atomically in a single statement.
 *
 * @param runId - The run identifier
 * @param updates - Map of edge ID to new state
 */
export function updateEdgeStates(runId: string, updates: Record<string, EdgeState>): void {
  if (Object.keys(updates).length === 0) return;

  // Build a chained json_set expression
  const entries = Object.entries(updates);
  let expr = sql`${workflowRuns.stepResults}`;
  for (const [key, state] of entries) {
    const jsonPath = `$.__edges.${key}`;
    const jsonValue = JSON.stringify(state);
    expr = sql`json_set(${expr}, ${jsonPath}, json(${jsonValue}))`;
  }

  db.update(workflowRuns)
    .set({
      stepResults: expr,
      updatedAt: Date.now(),
    })
    .where(eq(workflowRuns.id, runId))
    .run();
}

/**
 * Updates a single step's status.
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

/**
 * Persists a step's result value.
 *
 * @param runId - The run identifier
 * @param stepSlug - The step slug
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
 * Computes which steps are ready to be dispatched.
 *
 * A step is "ready" when:
 * 1. Its current status is "pending"
 * 2. All its incoming edges are in a terminal state (satisfied or dead)
 * 3. At least one incoming edge is "satisfied"
 *
 * @param run - The current run state
 * @param incomingEdgeMap - Map of step slug to array of edge IDs for its incoming edges
 * @returns Array of step slugs that are ready for dispatch
 */
export function getReadySteps(run: DagWorkflowRun, incomingEdgeMap: Map<string, string[]>): string[] {
  const ready: string[] = [];

  for (const [slug, status] of Object.entries(run.stepStatuses)) {
    if (status !== "pending") continue;

    const incomingEdgeIds = incomingEdgeMap.get(slug);
    if (!incomingEdgeIds || incomingEdgeIds.length === 0) {
      // Root node — should already be dispatched, but if pending, it's ready
      ready.push(slug);
      continue;
    }

    let allResolved = true;
    let hasSatisfied = false;

    for (const eid of incomingEdgeIds) {
      const state = run.edgeStates[eid];
      if (state === "satisfied") {
        hasSatisfied = true;
      } else if (state === "dead") {
        // dead is resolved but not satisfied
      } else {
        // pending or undefined — not resolved
        allResolved = false;
        break;
      }
    }

    if (allResolved && hasSatisfied) {
      ready.push(slug);
    }
  }

  return ready;
}

/**
 * Retrieves all DAG runs with the given status.
 *
 * @param status - The status to filter by
 * @returns Array of matching runs
 */
export function getByStatus(status: DagRunStatus): DagWorkflowRun[] {
  const rows = db.select().from(workflowRuns).where(eq(workflowRuns.status, status)).all();
  return rows.map(rowToRun);
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
