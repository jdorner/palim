/**
 * Workflow pipeline types shared between backend and frontend.
 *
 * @module
 */

/** Step summary included in workflow WebSocket events. */
export interface WorkflowStepSummary {
  slug: string;
  type: string;
  jobId?: string;
}

/** WebSocket messages for workflow pipeline lifecycle events. */
export type WorkflowWebSocketEvent =
  | { type: "workflow_reload" }
  | { type: "workflow_started"; workflowRunId: string; workflowName: string; steps: WorkflowStepSummary[] }
  | { type: "workflow_step_started"; workflowRunId: string; stepSlug: string; jobId: string }
  | { type: "workflow_step_completed"; workflowRunId: string; stepSlug: string; jobId: string }
  | { type: "workflow_step_failed"; workflowRunId: string; stepSlug: string; jobId: string; error: string }
  | { type: "workflow_completed"; workflowRunId: string }
  | { type: "workflow_failed"; workflowRunId: string; failedStep: string; error: string }
  | { type: "workflow_deleted"; workflowName: string };
