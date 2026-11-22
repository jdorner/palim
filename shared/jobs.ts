/**
 * Job and log entry types shared between backend and frontend.
 *
 * @module
 */

export interface JobEntry {
  id: string;
  description: string;
  queue: string;
  status: "waiting" | "active" | "completed" | "failed" | "delayed" | "waiting-signal" | "unknown";
  createdAt: number;
  completedAt?: number;
  logs?: LogEntry[];
  error?: string;
  /** Conversation session ID this job is associated with, if any. */
  sessionId?: string;
  /** Owning user id (the job's initiator); when set, only that user and admins see the job. */
  userId?: string;
  /** Workflow run ID if this job is part of a workflow chain. */
  workflowRunId?: string;
  /** Workflow definition name if this job is part of a workflow chain. */
  workflowName?: string;
  /** Step slug within the workflow. */
  stepSlug?: string;
  /** Zero-based step index within the workflow. */
  stepIndex?: number;
  /** Total number of steps in the workflow. */
  totalSteps?: number;
}

export interface LogEntry {
  timestamp: number;
  message: string;
}

/** Leading word of every {@link cancelReason}. */
const CANCELLED = "Cancelled";

/**
 * Error message of a job cancelled while it ran. The cancelled processor
 * throws it, so it is the job's `failedReason` and its last log line.
 *
 * @param by - Who cancelled the job (a username), or why when no user did it
 *   (e.g. "the workflow run failed"); omitted for an anonymous cancel
 * @returns "Cancelled by alice", "Cancelled: the workflow run failed", or "Cancelled"
 */
export function cancelReason(by?: { user: string } | { cause: string }): string {
  if (!by) return CANCELLED;
  return "user" in by ? `${CANCELLED} by ${by.user}` : `${CANCELLED}: ${by.cause}`;
}

/**
 * Whether a job's failure reason says it was cancelled (see {@link cancelReason}).
 *
 * @param reason - The job's `failedReason` / error text
 * @returns true when the job failed because it was cancelled
 */
export function isCancelReason(reason: string | undefined): boolean {
  if (!reason) return false;
  return reason === CANCELLED || reason.startsWith(`${CANCELLED} by `) || reason.startsWith(`${CANCELLED}: `);
}
