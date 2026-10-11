/**
 * Drizzle ORM schema for human tasks (HITL).
 *
 * - `hitl_tasks`: one row per task with its content, lifecycle, and answer.
 * - `hitl_task_assignees`: who may answer a task (users by ID, roles by name),
 *   normalized so "tasks visible to me" is a single indexed query.
 * - `hitl_task_events`: append-only audit history per task.
 *
 * @module
 */

import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Human tasks. */
export const hitlTasks = sqliteTable(
  "hitl_tasks",
  {
    /** Task ID (nanoid). */
    id: text("id").primaryKey(),
    /** What created the task (e.g. `workflow`). */
    sourceKind: text("source_kind").notNull(),
    /** Source-level grouping ID used for bulk cancellation (e.g. the workflow run ID). */
    sourceId: text("source_id").notNull(),
    /** JSON-encoded source reference (e.g. `{ runId, stepSlug, signalId }`). */
    sourceRef: text("source_ref").notNull(),
    /** Short title. */
    title: text("title").notNull(),
    /** Markdown body. */
    body: text("body").notNull().default(""),
    /** JSON-encoded key/value context (nullable). */
    context: text("context"),
    /** JSON-encoded outcomes array. */
    outcomes: text("outcomes").notNull(),
    /** JSON-encoded form JSON Schema (nullable). */
    formSchema: text("form_schema"),
    /** Whether a comment is required (0/1). */
    requireComment: integer("require_comment", { mode: "boolean" }).notNull().default(false),
    /** Priority: low, normal, high. */
    priority: text("priority").notNull().default("normal"),
    /** Status: open, completed, expired, cancelled. */
    status: text("status").notNull().default("open"),
    /** Due timestamp (epoch ms, nullable). */
    dueAt: integer("due_at"),
    /** User ID of whoever started the work that created the task (nullable). */
    createdBy: text("created_by"),
    /** Creation timestamp (epoch ms). */
    createdAt: integer("created_at").notNull(),
    /** Last change timestamp (epoch ms). */
    updatedAt: integer("updated_at").notNull(),
    /** Completion timestamp (epoch ms, nullable). */
    completedAt: integer("completed_at"),
    /** User ID of whoever completed the task (nullable). */
    completedBy: text("completed_by"),
    /** Chosen outcome ID (nullable). */
    outcome: text("outcome"),
    /** JSON-encoded form data (nullable). */
    response: text("response"),
    /** Comment given on completion (nullable). */
    comment: text("comment"),
    /** Optimistic concurrency version, incremented on every change. */
    version: integer("version").notNull().default(1),
  },
  (table) => [
    index("idx_hitl_tasks_status").on(table.status, table.createdAt),
    index("idx_hitl_tasks_source").on(table.sourceKind, table.sourceId),
    index("idx_hitl_tasks_completed_by").on(table.completedBy),
  ],
);

/** Task assignees: a user (by ID) or a role (by name). */
export const hitlTaskAssignees = sqliteTable(
  "hitl_task_assignees",
  {
    /** FK to hitl_tasks.id. */
    taskId: text("task_id").notNull(),
    /** Assignee kind: `user` or `role`. */
    kind: text("kind").notNull(),
    /** User ID or role name. */
    value: text("value").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.kind, table.value] }),
    index("idx_hitl_task_assignees_lookup").on(table.kind, table.value),
  ],
);

/** Append-only audit history of tasks. */
export const hitlTaskEvents = sqliteTable(
  "hitl_task_events",
  {
    /** Auto-incrementing ID (preserves insertion order). */
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** FK to hitl_tasks.id. */
    taskId: text("task_id").notNull(),
    /** Event timestamp (epoch ms). */
    at: integer("at").notNull(),
    /** Acting user ID (null for system actions). */
    actorId: text("actor_id"),
    /** Event kind. */
    kind: text("kind").notNull(),
    /** JSON-encoded event details (nullable). */
    data: text("data"),
  },
  (table) => [index("idx_hitl_task_events_task").on(table.taskId, table.id)],
);
