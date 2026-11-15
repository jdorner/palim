/**
 * DAG step jobs - the queue job shape of a workflow step and its builder.
 *
 * Runs are started by `startRun` in `dagCoordinator.ts`, which lets the run
 * kernel activate the root steps.
 *
 * @module
 */

import type { FlowJob } from "bunqueue/client";
import type { DagStep } from "./schemas";

/**
 * Minimal session factory interface - only the `create` method is needed
 * by the workflow engine to create per-step sessions.
 */
export interface SessionFactory {
  create(opts: { source: string; sourceId?: string; userId?: string; metadata?: Record<string, unknown> }): {
    id: string;
  };
}

/** Queue name used for all workflow step jobs. */
const DAG_WORKFLOW_STEPS_QUEUE = "workflows:steps";

/** Data payload carried by each DAG workflow step job. */
export interface DagStepJobData {
  /** Unique identifier for this workflow run. */
  workflowRunId: string;
  /** Name of the workflow definition. */
  workflowName: string;
  /** Slug of this step. */
  stepSlug: string;
  /** The step definition. */
  stepDef: DagStep;
  /** All step definitions in the workflow, keyed by slug. Used for `{{steps.<slug>.config}}` resolution. */
  allStepDefs: Record<string, unknown>;
  /** Session ID for persisting conversation context for this step. */
  sessionId: string;
  /** Trigger payload (available to all steps via template resolution from Run Store). */
  triggerPayload?: unknown;
  /** Slug of the iterator this step belongs to (when inside an iteration body). */
  iteratorSlug?: string;
  /**
   * Id of the user who initiated the run (the trigger's creator or the user who
   * started it). Internal calls made during step execution authorize as this
   * user; absent for genuinely user-less runs (fall back to system).
   */
  initiatorUserId?: string;
}

/**
 * Builds a single FlowStep for an individual DAG step dispatch.
 *
 * @param slug - The step slug
 * @param opts - Context for building the job
 * @returns A FlowStep ready for `flow.add()`
 */
export function buildDagStepJob(
  slug: string,
  opts: {
    workflowRunId: string;
    workflowName: string;
    stepDef: DagStep;
    allStepDefs: Record<string, unknown>;
    sessionFactory: SessionFactory;
    triggerPayload?: unknown;
    iteratorSlug?: string;
    initiatorUserId?: string;
  },
): FlowJob<DagStepJobData> {
  const session = opts.sessionFactory.create({
    source: "workflow",
    ...(opts.initiatorUserId ? { userId: opts.initiatorUserId } : {}),
    metadata: {
      workflowName: opts.workflowName,
      workflowRunId: opts.workflowRunId,
      stepSlug: slug,
    },
  });

  const data: DagStepJobData = {
    workflowRunId: opts.workflowRunId,
    workflowName: opts.workflowName,
    stepSlug: slug,
    stepDef: opts.stepDef,
    allStepDefs: opts.allStepDefs,
    sessionId: session.id,
    triggerPayload: opts.triggerPayload,
    iteratorSlug: opts.iteratorSlug,
    ...(opts.initiatorUserId ? { initiatorUserId: opts.initiatorUserId } : {}),
  };

  return {
    name: slug,
    queueName: DAG_WORKFLOW_STEPS_QUEUE,
    data,
    opts: { attempts: 1 },
  };
}
