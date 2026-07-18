/**
 * Job and log entry types shared between backend and frontend.
 *
 * @module
 */

export interface JobEntry {
  id: string;
  description: string;
  queue: string;
  status: "waiting" | "active" | "completed" | "failed" | "delayed" | "unknown";
  createdAt: number;
  completedAt?: number;
  logs?: LogEntry[];
  error?: string;
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
