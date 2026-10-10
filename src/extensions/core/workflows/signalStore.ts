/**
 * Signal Store - SQLite-backed persistence for workflow signal records.
 *
 * Tracks pending signals created by `waitFor` nodes and coordinates
 * delivery from `emit` nodes or external API calls. Uses atomic
 * UPDATE...WHERE status='waiting' for race-safe claim semantics: the
 * claim functions report whether this caller won the row.
 *
 * Each signal belongs to exactly one waiting step of one run, so the signal
 * ID is the precise delivery address. `broadcast` signals can additionally be
 * matched by event name (and correlation key) from `emit` steps; `instance`
 * signals can only be delivered directly.
 *
 * Uses the same module-level DB injection pattern as
 * `src/extensions/core/workflows/runStore.ts`.
 *
 * @module
 */

import { and, eq, isNull, or } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { nanoid } from "nanoid";
import { workflowSignals } from "./signalSchema";

/** Signal record status values. */
export type SignalStatus = "waiting" | "received" | "timed_out";

/**
 * Delivery scope of a signal.
 *
 * - `broadcast`: deliverable directly and via `emit` (matched by event name
 *   and correlation key).
 * - `instance`: deliverable only directly (by signal ID or run + step).
 */
export type SignalScope = "broadcast" | "instance";

/** The node type that created a signal. */
export type SignalSource = "waitFor" | "humanTask";

/**
 * A signal record persisted in SQLite.
 *
 * Represents the lifecycle of a single signal expectation created
 * by a `waitFor` node, from creation through delivery or timeout.
 */
export interface SignalRecord {
  /** Auto-generated signal record ID. */
  id: string;
  /** FK to workflow_runs.id. */
  runId: string;
  /** The waitFor step's slug. */
  stepSlug: string;
  /** Signal event name. */
  event: string;
  /** Current signal status. */
  status: SignalStatus;
  /** JSON Schema for payload validation (optional). */
  inputSchema: object | null;
  /** Timeout duration in ms (null = no timeout). */
  timeoutMs: number | null;
  /** Received payload (null until delivered). */
  payload: unknown;
  /** Creation timestamp (epoch ms). */
  createdAt: number;
  /** Delivery timestamp (epoch ms, null until received). */
  receivedAt: number | null;
  /** Delivery scope. */
  scope: SignalScope;
  /** Correlation key (null = matches any emit of the event). */
  correlationKey: string | null;
  /** The node type that created the signal. */
  source: SignalSource;
}

/** Input for {@link create}. Scope, correlation key, and source are optional. */
export interface CreateSignalInput {
  /** FK to workflow_runs.id. */
  runId: string;
  /** The waiting step's slug. */
  stepSlug: string;
  /** Signal event name. */
  event: string;
  /** JSON Schema for payload validation (optional). */
  inputSchema: object | null;
  /** Timeout duration in ms (null = no timeout). */
  timeoutMs: number | null;
  /** Delivery scope (default `broadcast`). */
  scope?: SignalScope;
  /** Correlation key (default null). */
  correlationKey?: string | null;
  /** The node type that created the signal (default `waitFor`). */
  source?: SignalSource;
}

/** Filter for {@link findBroadcastMatches}. */
export interface BroadcastMatchFilter {
  /**
   * The emitted correlation key. Signals with a key only match an equal key;
   * signals without a key match any emit. When omitted, only signals without
   * a key match.
   */
  correlationKey?: string;
  /** Restrict matches to a single run. */
  runId?: string;
}

/** Module-level DB reference - set by {@link initSignalStore}. */
let db: BunSQLiteDatabase<Record<string, unknown>>;

/**
 * Initializes the Signal Store with a database instance.
 * Must be called before any other store function.
 *
 * @param database - The shared Drizzle database instance
 */
export function initSignalStore(database: BunSQLiteDatabase<Record<string, unknown>>): void {
  db = database;
}

/**
 * Converts a database row to a {@link SignalRecord}.
 *
 * Handles JSON deserialization of `inputSchema` and `payload` columns.
 *
 * @param row - Raw row from the workflow_signals table
 * @returns The deserialized signal record
 */
function rowToSignal(row: typeof workflowSignals.$inferSelect): SignalRecord {
  let inputSchema: object | null = null;
  if (row.inputSchema !== null) {
    try {
      inputSchema = JSON.parse(row.inputSchema) as object;
    } catch {
      inputSchema = null;
    }
  }

  let payload: unknown = null;
  if (row.payload !== null) {
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = row.payload;
    }
  }

  return {
    id: row.id,
    runId: row.runId,
    stepSlug: row.stepSlug,
    event: row.event,
    status: row.status as SignalStatus,
    inputSchema,
    timeoutMs: row.timeoutMs,
    payload,
    createdAt: row.createdAt,
    receivedAt: row.receivedAt,
    scope: row.scope as SignalScope,
    correlationKey: row.correlationKey,
    source: row.source as SignalSource,
  };
}

/**
 * Creates a new signal record in `waiting` status.
 *
 * @param record - The signal data (ID, status, timestamps, and payload are auto-generated)
 * @returns The created signal record
 */
export function create(record: CreateSignalInput): SignalRecord {
  const now = Date.now();
  const id = nanoid();
  const scope = record.scope ?? "broadcast";
  const correlationKey = record.correlationKey ?? null;
  const source = record.source ?? "waitFor";

  db.insert(workflowSignals)
    .values({
      id,
      runId: record.runId,
      stepSlug: record.stepSlug,
      event: record.event,
      status: "waiting",
      inputSchema: record.inputSchema != null ? JSON.stringify(record.inputSchema) : null,
      timeoutMs: record.timeoutMs,
      payload: null,
      createdAt: now,
      receivedAt: null,
      scope,
      correlationKey,
      source,
    })
    .run();

  return {
    id,
    runId: record.runId,
    stepSlug: record.stepSlug,
    event: record.event,
    status: "waiting",
    inputSchema: record.inputSchema,
    timeoutMs: record.timeoutMs,
    payload: null,
    createdAt: now,
    receivedAt: null,
    scope,
    correlationKey,
    source,
  };
}

/**
 * Retrieves a signal record by ID, regardless of status.
 *
 * @param id - The signal record identifier
 * @returns The signal record, or null if not found
 */
export function getById(id: string): SignalRecord | null {
  const row = db.select().from(workflowSignals).where(eq(workflowSignals.id, id)).get();
  return row ? rowToSignal(row) : null;
}

/**
 * Retrieves the waiting signal of a specific step in a run.
 *
 * A step has at most one waiting signal at a time, so this is an exact
 * address for direct delivery.
 *
 * @param runId - The workflow run identifier
 * @param stepSlug - The waiting step's slug
 * @returns The waiting signal record, or null if the step is not waiting
 */
export function getWaitingForStep(runId: string, stepSlug: string): SignalRecord | null {
  const row = db
    .select()
    .from(workflowSignals)
    .where(
      and(
        eq(workflowSignals.runId, runId),
        eq(workflowSignals.stepSlug, stepSlug),
        eq(workflowSignals.status, "waiting"),
      ),
    )
    .get();

  return row ? rowToSignal(row) : null;
}

/**
 * Lists all waiting signals of a run for an event name.
 *
 * More than one entry means several steps of the run wait on the same event,
 * so an address of (run, event) is ambiguous.
 *
 * @param runId - The workflow run identifier
 * @param event - The signal event name
 * @returns The waiting signal records (possibly empty)
 */
export function listWaitingForRunEvent(runId: string, event: string): SignalRecord[] {
  const rows = db
    .select()
    .from(workflowSignals)
    .where(
      and(eq(workflowSignals.runId, runId), eq(workflowSignals.event, event), eq(workflowSignals.status, "waiting")),
    )
    .all();

  return rows.map(rowToSignal);
}

/**
 * Lists all waiting signals of a run.
 *
 * @param runId - The workflow run identifier
 * @returns The waiting signal records (possibly empty)
 */
export function listWaitingForRun(runId: string): SignalRecord[] {
  const rows = db
    .select()
    .from(workflowSignals)
    .where(and(eq(workflowSignals.runId, runId), eq(workflowSignals.status, "waiting")))
    .all();

  return rows.map(rowToSignal);
}

/**
 * Retrieves all signal records with status `waiting`.
 *
 * Used at boot to re-arm timeout timers and to enrich run listings.
 *
 * @returns Array of all waiting signal records
 */
export function getAllWaiting(): SignalRecord[] {
  const rows = db.select().from(workflowSignals).where(eq(workflowSignals.status, "waiting")).all();

  return rows.map(rowToSignal);
}

/**
 * Finds the waiting `broadcast` signals an `emit` of the given event reaches.
 *
 * `instance` signals never match. A signal with a correlation key only matches
 * an emit carrying the same key; a signal without a key matches any emit of
 * the event (the original, uncorrelated behavior).
 *
 * @param event - The emitted event name
 * @param filter - Optional correlation key and run restriction
 * @returns Array of matching waiting signal records
 */
export function findBroadcastMatches(event: string, filter: BroadcastMatchFilter = {}): SignalRecord[] {
  const keyCondition =
    filter.correlationKey !== undefined
      ? or(isNull(workflowSignals.correlationKey), eq(workflowSignals.correlationKey, filter.correlationKey))
      : isNull(workflowSignals.correlationKey);

  const rows = db
    .select()
    .from(workflowSignals)
    .where(
      and(
        eq(workflowSignals.event, event),
        eq(workflowSignals.status, "waiting"),
        eq(workflowSignals.scope, "broadcast"),
        keyCondition,
        filter.runId !== undefined ? eq(workflowSignals.runId, filter.runId) : undefined,
      ),
    )
    .all();

  return rows.map(rowToSignal);
}

/**
 * Atomically marks a signal as received with the given payload.
 *
 * Uses `UPDATE ... WHERE status = 'waiting'` for race protection. Exactly one
 * caller can claim a signal; every other caller (and any caller after a
 * timeout) gets `false`.
 *
 * @param id - The signal record identifier
 * @param payload - The delivered payload to store
 * @returns True if this call claimed the signal, false if it was no longer waiting
 */
export function markReceived(id: string, payload: unknown): boolean {
  const now = Date.now();

  const claimed = db
    .update(workflowSignals)
    .set({
      status: "received",
      payload: JSON.stringify(payload),
      receivedAt: now,
    })
    .where(and(eq(workflowSignals.id, id), eq(workflowSignals.status, "waiting")))
    .returning({ id: workflowSignals.id })
    .all();

  return claimed.length === 1;
}

/**
 * Atomically marks a signal as timed out.
 *
 * Uses `UPDATE ... WHERE status = 'waiting'` for race protection.
 *
 * @param id - The signal record identifier
 * @returns True if this call timed the signal out, false if it was no longer waiting
 */
export function markTimedOut(id: string): boolean {
  const claimed = db
    .update(workflowSignals)
    .set({
      status: "timed_out",
    })
    .where(and(eq(workflowSignals.id, id), eq(workflowSignals.status, "waiting")))
    .returning({ id: workflowSignals.id })
    .all();

  return claimed.length === 1;
}

/**
 * Deletes all signal records belonging to the given run IDs.
 *
 * Used to clean up signal history when workflow runs are removed
 * (e.g. when jobs are cleaned via the queue clean endpoint).
 *
 * @param runIds - Array of workflow run IDs whose signals should be deleted
 */
export function deleteByRunIds(runIds: string[]): void {
  if (runIds.length === 0) return;

  for (const runId of runIds) {
    db.delete(workflowSignals).where(eq(workflowSignals.runId, runId)).run();
  }
}
