/**
 * Workflow pipeline types shared between backend and frontend.
 *
 * @module
 */

/**
 * Canonical machine-readable output schema for a workflow step or trigger.
 *
 * This is the single source of truth for the canonical output schema shape: a
 * JSON Schema object (represented as an untyped record of JSON Schema keywords
 * such as `type`, `properties`, `enum`, `description`). It is distinct from the
 * backend type-hint shorthand used in `*.json5` workflow files, which is
 * compiled into this canonical form.
 */
export type OutputSchema = Record<string, unknown>;

/**
 * The `outputSchemas` payload returned by the workflow detail API.
 *
 * Carries the resolved canonical JSON Schemas for the workflow trigger and for
 * every step, keyed by step slug.
 */
export interface OutputSchemas {
  /** Resolved trigger output schema as JSON Schema, or null when unavailable. */
  trigger: OutputSchema | null;
  /** Per-step output schemas keyed by step slug, as JSON Schema. */
  steps: Record<string, OutputSchema>;
}

/**
 * Canonical default env-var allowlist for workflow templates.
 *
 * These are the environment variable NAMES that workflow templates may reference
 * by default (via `{{env.NAME}}`), before any per-instance additions are unioned
 * in. This is the single source of truth shared by the backend template engine,
 * the backend DAG validator, and the frontend template scope.
 */
export const DEFAULT_ENV_ALLOWLIST: readonly string[] = ["WEB_HOST", "WEB_PORT", "AGENT_WORK_DIR", "NODE_ENV"];

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
  | { type: "workflow_step_completed"; workflowRunId: string; stepSlug: string; jobId: string; chosenBranch?: string }
  | { type: "workflow_step_dead"; workflowRunId: string; stepSlug: string }
  | { type: "workflow_step_failed"; workflowRunId: string; stepSlug: string; jobId: string; error: string }
  | {
      type: "workflow_step_waiting";
      workflowRunId: string;
      stepSlug: string;
      event: string;
      inputSchema?: Record<string, unknown> | null;
    }
  | { type: "workflow_step_resumed"; workflowRunId: string; stepSlug: string; signalEvent: string }
  | { type: "workflow_completed"; workflowRunId: string }
  | { type: "workflow_failed"; workflowRunId: string; failedStep: string; error: string }
  | { type: "workflow_deleted"; workflowName: string };
