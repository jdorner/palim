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
  /** All step definitions in the workflow, keyed by slug. Used for `{{steps.<slug>.config}}` resolution. */
  allStepDefs?: Record<string, unknown>;
  /** Ordered list of step slugs matching the chain execution order. Used by input validation to identify the next step. */
  stepOrder?: string[];
  /** Trigger payload - only present on the first step. */
  triggerPayload?: unknown;
  /** Session ID for persisting conversation context for this step. */
  sessionId: string;
  /** Accumulated step results from previous segments (injected by segment dispatcher into first job of non-first segments). */
  accumulatedStepResults?: Record<string, unknown>;
  /** Marks this job as part of a control flow branch (then/else/path). Non-last branch steps skip segment dispatch on completion. */
  isBranchStep?: boolean;
  /** Set on the LAST branch step only. When present, the completion handler dispatches the next segment at this index instead of using stepIndex + 1. */
  resumeStepIndex?: number;
  /**
   * Carries remaining branch steps when a branch is segmented at CF boundaries.
   * When the last step of a branch segment completes, the completion handler uses
   * this context to dispatch the next branch segment or handle inline CF nodes.
   */
  branchContext?: {
    /** Remaining branch steps (after the current segment). */
    remainingSteps: import("./schemas").WorkflowStep[];
    /** The main-flow step index to resume at after the entire branch finishes. */
    resumeStepIndex: number;
  };
  /** Injected by bunqueue FlowProducer for chained jobs. */
  __flowParentId?: string;
}
