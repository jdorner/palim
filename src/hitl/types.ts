/**
 * HITL contract types for task sources (e.g. the workflows extension).
 *
 * Self-contained on purpose: this module only uses relative imports of pure
 * type modules, so it can be re-exported through `@ext/types` (see
 * `src/extensions/publicTypes.ts`) without `@src`/`@shared` path aliases.
 *
 * @module
 */

import type { HumanTaskOutcome, HumanTaskOutcomeStyle, HumanTaskPriority, HumanTaskStatus } from "../../shared/portal";

/** Who a task is assigned to: user IDs and role names. */
export interface TaskAssignees {
  /** Assigned user IDs. */
  users: string[];
  /** Assigned role names. */
  roles: string[];
}

/** What created a task. */
export interface TaskSource {
  /** Source kind (e.g. `workflow`). */
  kind: string;
  /** Grouping ID for bulk cancellation (e.g. the workflow run ID). */
  id: string;
  /** Source-specific reference (e.g. `{ runId, stepSlug, signalId }`). */
  ref: Record<string, unknown>;
}

/** A persisted human task. */
export interface TaskRecord {
  id: string;
  source: TaskSource;
  title: string;
  body: string;
  context: Record<string, unknown> | null;
  outcomes: HumanTaskOutcome[];
  formSchema: Record<string, unknown> | null;
  requireComment: boolean;
  priority: HumanTaskPriority;
  status: HumanTaskStatus;
  dueAt: number | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  completedBy: string | null;
  outcome: string | null;
  response: unknown;
  comment: string | null;
  version: number;
  assignees: TaskAssignees;
}

/** Input for creating a task. Users are given by username, roles by name. */
export interface CreateTaskInput {
  /** What creates the task; `id` groups tasks for bulk cancellation (e.g. a workflow run ID). */
  source: TaskSource;
  /** Short title (1-200 characters). */
  title: string;
  /** Markdown body. */
  body?: string;
  /** Additional key/value context shown next to the body. */
  context?: Record<string, unknown> | null;
  /** The answers to offer (default: approve / reject). */
  outcomes?: { id: string; label: string; style?: HumanTaskOutcomeStyle }[];
  /** JSON Schema of a form to fill in. */
  form?: Record<string, unknown> | null;
  /** Whether a comment is required. */
  requireComment?: boolean;
  /** Priority (default `normal`). */
  priority?: HumanTaskPriority;
  /** Due timestamp (epoch ms). */
  dueAt?: number | null;
  /** Who may answer: usernames and role names (at least one entry). */
  assignees: { users?: string[]; roles?: string[] };
  /** User ID of whoever started the work that creates the task. */
  createdBy?: string | null;
}

/** Callbacks of a task source, invoked after a task it created ends. */
export interface HitlSourceHandler {
  /** Called after a task was completed. Errors are logged, not propagated. */
  onCompleted?(task: TaskRecord): void | Promise<void>;
  /** Called after a task was cancelled by a manager. Errors are logged, not propagated. */
  onCancelled?(task: TaskRecord, reason: string | null): void | Promise<void>;
}

/** The HITL operations available to core extensions via `ctx.internal.hitl`. */
export interface HitlApi {
  /**
   * Creates a task.
   *
   * @throws Error with a `status` of 400 for invalid input or unknown assignees
   */
  createTask(input: CreateTaskInput): TaskRecord;
  /** Cancels all open tasks of a source without calling it back; returns the count. */
  cancelBySource(kind: string, sourceId: string, reason?: string | null): number;
  /** Marks an open task as expired; returns false if it was not open. */
  expireTask(id: string): boolean;
  /** Lists the open tasks of a source. */
  listOpenBySource(kind: string, sourceId: string): TaskRecord[];
  /** Returns a task by ID (no visibility checks). */
  getRecord(id: string): TaskRecord | null;
  /** Describes a user for display (null if unknown). */
  describeUser(id: string): { id: string; username: string; displayName: string | null } | null;
  /** Registers the callbacks for a source kind; returns a function that unregisters them. */
  registerSourceHandler(kind: string, handler: HitlSourceHandler): () => void;
}
