/**
 * Drizzle schema for the `workflow_signals` table.
 *
 * Persists signal records for `waitFor` and `emit` coordination across
 * workflow runs. Tracks pending, received, and timed-out signals with
 * optional payload validation schemas and timeout durations.
 *
 * @module
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Workflow signal records.
 *
 * Each row represents a signal expectation created by a `waitFor` node,
 * tracking its lifecycle from `waiting` through `received` or `timed_out`.
 */
export const workflowSignals = sqliteTable(
  "workflow_signals",
  {
    /** Auto-generated signal record ID. */
    id: text("id").primaryKey(),
    /** FK to workflow_runs.id. */
    runId: text("run_id").notNull(),
    /** The waitFor step's slug. */
    stepSlug: text("step_slug").notNull(),
    /** Signal event name (e.g. "approval.granted"). */
    event: text("event").notNull(),
    /** Signal status: waiting, received, timed_out. */
    status: text("status").notNull().default("waiting"),
    /** JSON-encoded input schema for payload validation (nullable). */
    inputSchema: text("input_schema"),
    /** Timeout in ms (nullable = no timeout). */
    timeoutMs: integer("timeout_ms"),
    /** JSON-encoded received payload (null until delivered). */
    payload: text("payload"),
    /** Creation timestamp (epoch ms). */
    createdAt: integer("created_at").notNull(),
    /** Delivery timestamp (epoch ms, null until received). */
    receivedAt: integer("received_at"),
  },
  (table) => [
    index("idx_workflow_signals_run_event").on(table.runId, table.event),
    index("idx_workflow_signals_status").on(table.status),
  ],
);
