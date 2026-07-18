/**
 * Shared types for the workflows extension.
 */

import type { WorkflowStep } from "./schemas";

/** Data payload carried by each workflow step job in the chain. */
export interface WorkflowStepJobData {
  /** Unique identifier for this workflow run. */
  workflowRunId: string;
  /** Name of the workflow definition. */
  workflowName: string;
  /** Slug of this step. */
  stepSlug: string;
  /** Zero-based index of this step in the chain. */
  stepIndex: number;
  /** Total number of steps in the workflow. */
  totalSteps: number;
  /** The step definition from the YAML file. */
  stepDef: WorkflowStep;
  /** Trigger payload - only present on the first step. */
  triggerPayload?: unknown;
  /** Session ID for persisting conversation context for this step. */
  sessionId: string;
  /** Injected by bunqueue FlowProducer for chained jobs. */
  __flowParentId?: string;
}
