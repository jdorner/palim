/**
 * Portal wire types shared by the backend and the end-user portal frontend.
 *
 * The portal is the end-user surface of Palim. Its first module is human
 * tasks (HITL): work items created by background processes (e.g. a workflow
 * `humanTask` step) that a person answers by picking an outcome, optionally
 * filling a form and leaving a comment.
 *
 * Pure types and constants only, so this module is import-safe from both the
 * backend and frontends.
 *
 * @module
 */

/** Lifecycle status of a human task. */
export type HumanTaskStatus = "open" | "completed" | "expired" | "cancelled";

/** All human task statuses. */
export const HUMAN_TASK_STATUSES: readonly HumanTaskStatus[] = ["open", "completed", "expired", "cancelled"];

/** Priority of a human task. */
export type HumanTaskPriority = "low" | "normal" | "high";

/** All human task priorities. */
export const HUMAN_TASK_PRIORITIES: readonly HumanTaskPriority[] = ["low", "normal", "high"];

/** Visual style of an outcome button. */
export type HumanTaskOutcomeStyle = "primary" | "danger" | "default";

/** An answer a person can give to a task (rendered as a button). */
export interface HumanTaskOutcome {
  /** Stable identifier delivered to the task's source (e.g. `approve`). */
  id: string;
  /** Button label. */
  label: string;
  /** Button style (default `default`). */
  style?: HumanTaskOutcomeStyle;
}

/** The outcomes a task gets when none are declared. */
export const DEFAULT_HUMAN_TASK_OUTCOMES: readonly HumanTaskOutcome[] = [
  { id: "approve", label: "Approve", style: "primary" },
  { id: "reject", label: "Reject", style: "danger" },
];

/** A user reference as shown in the portal. */
export interface HumanTaskUserRef {
  /** User ID. */
  id: string;
  /** Login name. */
  username: string;
  /** Display name, if set. */
  displayName: string | null;
}

/** The answer recorded when a task was completed. */
export interface HumanTaskCompletion {
  /** Completion timestamp (epoch ms). */
  at: number;
  /** Who completed the task (null if the user no longer exists). */
  by: HumanTaskUserRef | null;
  /** The chosen outcome ID. */
  outcome: string;
  /** Form data (null when the task has no form). */
  data: unknown;
  /** Optional comment. */
  comment: string | null;
}

/** Kind of an audit event in a task's history. */
export type HumanTaskEventKind = "created" | "viewed" | "completed" | "cancelled" | "expired" | "reassigned";

/** One entry of a task's history. */
export interface HumanTaskHistoryEntry {
  /** Event timestamp (epoch ms). */
  at: number;
  /** Event kind. */
  kind: HumanTaskEventKind;
  /** Acting user (null for system actions such as expiry). */
  actor: HumanTaskUserRef | null;
  /** Event-specific details (e.g. the cancel reason). */
  data: Record<string, unknown> | null;
}

/** A human task as returned by the portal API. */
export interface HumanTask {
  /** Task ID. */
  id: string;
  /** Short title. */
  title: string;
  /** Markdown body (may be empty). */
  body: string;
  /** Additional key/value context shown next to the body. */
  context: Record<string, unknown> | null;
  /** The answers the person can choose from. */
  outcomes: HumanTaskOutcome[];
  /** JSON Schema of the form to fill in (null = no form). */
  formSchema: Record<string, unknown> | null;
  /** Whether a comment is required. */
  requireComment: boolean;
  /** Priority. */
  priority: HumanTaskPriority;
  /** Lifecycle status. */
  status: HumanTaskStatus;
  /** Due timestamp (epoch ms), if any. */
  dueAt: number | null;
  /** Creation timestamp (epoch ms). */
  createdAt: number;
  /** Last change timestamp (epoch ms). */
  updatedAt: number;
  /** Who the task is assigned to. */
  assignees: { users: HumanTaskUserRef[]; roles: string[] };
  /** Whether the viewing user may answer the task. */
  canRespond: boolean;
  /** The recorded answer (null until completed). */
  completion: HumanTaskCompletion | null;
  /**
   * What created the task. `ref` (e.g. the workflow run and step) is only
   * included for viewers who manage tasks.
   */
  source: { kind: string; ref?: Record<string, unknown> };
  /** Optimistic concurrency version, sent back when completing. */
  version: number;
}

/** A human task with its history (detail view). */
export interface HumanTaskDetail extends HumanTask {
  /** Audit history, oldest first. */
  history: HumanTaskHistoryEntry[];
}

/** Badge counts for the portal. */
export interface HumanTaskCounts {
  /** Open tasks the viewer may answer. */
  open: number;
  /** Open tasks the viewer may answer that are due within 24 hours or overdue. */
  dueSoon: number;
}
