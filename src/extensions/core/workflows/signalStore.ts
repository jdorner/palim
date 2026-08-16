/**
 * Signal Store - SQLite-backed persistence for workflow signal records.
 *
 * Tracks pending signals created by `waitFor` nodes and coordinates
 * delivery from `emit` nodes or external API calls. Uses atomic
 * UPDATE...WHERE status='waiting' for race-safe claim semantics.
 *
 * Uses the same module-level DB injection pattern as
 * `src/extensions/core/workflows/runStore.ts`.
 *
 * @module
 */

import { and, eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { nanoid } from "nanoid";
import { workflowSignals } from "./signalSchema";

/** Signal record status values. */
export type SignalStatus = "waiting" | "received" | "timed_out";

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
}

/**
 * Signal Store data access interface.
 *
 * Provides CRUD operations for signal records with atomic claim
 * semantics for race-safe delivery.
 */
export interface SignalStore {
  /** Creates a new signal record in `waiting` status. */
  create(record: Omit<SignalRecord, "id" | "createdAt" | "receivedAt" | "payload" | "status">): SignalRecord;
  /** Retrieves the waiting signal for a given run and event. */
  getWaiting(runId: string, event: string): SignalRecord | null;
  /** Retrieves all signal records with status `waiting`. */
  getAllWaiting(): SignalRecord[];
  /** Retrieves all signal records with status `waiting` for a specific event name. */
  getAllWaitingByEvent(event: string): SignalRecord[];
  /** Atomically marks a signal as received with the given payload. No-op if not waiting. */
  markReceived(id: string, payload: unknown): void;
  /** Atomically marks a signal as timed out. No-op if not waiting. */
  markTimedOut(id: string): void;
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
  };
}

/**
 * Creates a new signal record in `waiting` status.
 *
 * @param record - The signal data (ID, status, timestamps, and payload are auto-generated)
 * @returns The created signal record
 */
export function create(
  record: Omit<SignalRecord, "id" | "createdAt" | "receivedAt" | "payload" | "status">,
): SignalRecord {
  const now = Date.now();
  const id = nanoid();

  const row = {
    id,
    runId: record.runId,
    stepSlug: record.stepSlug,
    event: record.event,
    status: "waiting" as const,
    inputSchema: record.inputSchema != null ? JSON.stringify(record.inputSchema) : null,
    timeoutMs: record.timeoutMs,
    payload: null,
    createdAt: now,
    receivedAt: null,
  };

  db.insert(workflowSignals).values(row).run();

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
  };
}

/**
 * Retrieves the waiting signal for a given run and event.
 *
 * @param runId - The workflow run identifier
 * @param event - The signal event name
 * @returns The waiting signal record, or null if none found
 */
export function getWaiting(runId: string, event: string): SignalRecord | null {
  const row = db
    .select()
    .from(workflowSignals)
    .where(
      and(eq(workflowSignals.runId, runId), eq(workflowSignals.event, event), eq(workflowSignals.status, "waiting")),
    )
    .get();

  return row ? rowToSignal(row) : null;
}

/**
 * Retrieves all signal records with status `waiting`.
 *
 * Used for crash recovery and emit handler to find all pending signals.
 *
 * @returns Array of all waiting signal records
 */
export function getAllWaiting(): SignalRecord[] {
  const rows = db.select().from(workflowSignals).where(eq(workflowSignals.status, "waiting")).all();

  return rows.map(rowToSignal);
}

/**
 * Retrieves all signal records with status `waiting` for a specific event name.
 *
 * Used by the `emit` handler to find all runs waiting for a particular event.
 * More efficient than loading all waiting signals and filtering in memory.
 *
 * @param event - The signal event name to query
 * @returns Array of waiting signal records matching the event name
 */
export function getAllWaitingByEvent(event: string): SignalRecord[] {
  const rows = db
    .select()
    .from(workflowSignals)
    .where(and(eq(workflowSignals.event, event), eq(workflowSignals.status, "waiting")))
    .all();

  return rows.map(rowToSignal);
}

/**
 * Atomically marks a signal as received with the given payload.
 *
 * Uses `UPDATE ... WHERE status = 'waiting'` for race protection.
 * If the signal is not in `waiting` status (already received or timed out),
 * this is a no-op.
 *
 * @param id - The signal record identifier
 * @param payload - The delivered payload to store
 */
export function markReceived(id: string, payload: unknown): void {
  const now = Date.now();

  db.update(workflowSignals)
    .set({
      status: "received",
      payload: JSON.stringify(payload),
      receivedAt: now,
    })
    .where(and(eq(workflowSignals.id, id), eq(workflowSignals.status, "waiting")))
    .run();
}

/**
 * Atomically marks a signal as timed out.
 *
 * Uses `UPDATE ... WHERE status = 'waiting'` for race protection.
 * If the signal is not in `waiting` status (already received or timed out),
 * this is a no-op.
 *
 * @param id - The signal record identifier
 */
export function markTimedOut(id: string): void {
  db.update(workflowSignals)
    .set({
      status: "timed_out",
    })
    .where(and(eq(workflowSignals.id, id), eq(workflowSignals.status, "waiting")))
    .run();
}
