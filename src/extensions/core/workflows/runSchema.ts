/**
 * Drizzle schema for the `workflow_runs` table.
 *
 * Persists DAG workflow run state: run status, step results, step statuses,
 * and edge states, so runs survive restarts.
 *
 * @module
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Workflow run records.
 *
 * Each row represents a single execution of a workflow definition.
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
    /** JSON-encoded step results keyed by slug, plus `__statuses` and `__edges` (see `dagRunStore.ts`). */
    stepResults: text("step_results").notNull().default("{}"),
    /** JSON-encoded trigger payload (nullable). */
    triggerPayload: text("trigger_payload"),
    /** Failure reason (null unless status is failed). */
    failureReason: text("failure_reason"),
    /** Id of the user who initiated the run (trigger creator or starter); null for user-less runs. */
    createdByUserId: text("created_by_user_id"),
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
