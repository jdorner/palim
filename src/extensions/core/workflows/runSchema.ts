/**
 * Drizzle schema for the `workflow_runs` table.
 *
 * Persists workflow run state across segment boundaries, enabling
 * segment-based dispatch with durable step results and run status.
 *
 * @module
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Workflow run records.
 *
 * Each row represents a single execution of a workflow definition,
 * tracking accumulated step results, execution cursor, and run status
 * across segment dispatches.
 */
export const workflowRuns = sqliteTable(
  "workflow_runs",
  {
    /** UUID run identifier. */
    id: text("id").primaryKey(),
    /** Workflow definition name. */
    workflowName: text("workflow_name").notNull(),
    /** Run status: running, waiting-signal, completed, failed. */
    status: text("status").notNull().default("running"),
    /** JSON-encoded accumulated step results keyed by slug. */
    stepResults: text("step_results").notNull().default("{}"),
    /** JSON-encoded trigger payload (nullable). */
    triggerPayload: text("trigger_payload"),
    /** Zero-based execution cursor (points to current/next segment). */
    currentStepIndex: integer("current_step_index").notNull().default(0),
    /** JSON-encoded ordered step slug array. */
    fullStepOrder: text("full_step_order").notNull(),
    /** Failure reason (null unless status is failed). */
    failureReason: text("failure_reason"),
    /** Creation timestamp (epoch ms). */
    createdAt: integer("created_at").notNull(),
    /** Last update timestamp (epoch ms). */
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_workflow_runs_name").on(table.workflowName),
    index("idx_workflow_runs_status").on(table.status),
  ],
);
