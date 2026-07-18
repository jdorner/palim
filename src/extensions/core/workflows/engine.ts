/**
 * Workflow engine - dispatches workflow executions as job chains
 * via bunqueue's {@link FlowProducer.addChain}.
 */

import type { Logger } from "@ext/types";
import type { FlowProducer, FlowStep } from "bunqueue/client";
import type { WorkflowDefinition } from "./schemas";
import type { WorkflowStepJobData } from "./types";

/**
 * Minimal session factory interface - only the `create` method is needed
 * by the workflow engine to create per-step sessions.
 */
export interface SessionFactory {
  create(opts: { source: string; sourceId?: string; metadata?: Record<string, unknown> }): { id: string };
}

/** Result of dispatching a workflow. */
export interface WorkflowDispatchResult {
  /** Unique identifier for this workflow run. */
  workflowRunId: string;
  /** Job IDs for each step in the chain. */
  jobIds: string[];
}

/** Queue name used for all workflow step jobs. */
export const WORKFLOW_STEPS_QUEUE = "workflows:steps";

/**
 * Dispatch a workflow execution as a sequential job chain.
 *
 * Generates a unique run ID, creates a session per agent step, builds a
 * {@link FlowStep} array from the workflow definition, and calls
 * {@link FlowProducer.addChain}.
 *
 * @param flow - The shared FlowProducer instance
 * @param definition - The validated workflow definition
 * @param triggerPayload - The trigger's input data (webhook body, etc.)
 * @param log - Logger for reporting dispatch details
 * @param sessionStore - Session factory for creating per-step sessions
 * @returns The run ID and step job IDs
 */
export async function dispatchWorkflow(
  flow: FlowProducer,
  definition: WorkflowDefinition,
  triggerPayload: unknown,
  log: Logger,
  sessionStore: SessionFactory,
): Promise<WorkflowDispatchResult> {
  const workflowRunId = crypto.randomUUID();
  const totalSteps = definition.steps.length;

  const steps: FlowStep<WorkflowStepJobData>[] = definition.steps.map((stepDef, index) => {
    // Create a session for each step so conversation context is persisted
    const session = sessionStore.create({
      source: "workflow",
      metadata: {
        workflowName: definition.name,
        workflowRunId,
        stepSlug: stepDef.slug,
        stepIndex: index,
      },
    });

    return {
      name: stepDef.slug,
      queueName: WORKFLOW_STEPS_QUEUE,
      data: {
        workflowRunId,
        workflowName: definition.name,
        stepSlug: stepDef.slug,
        stepIndex: index,
        totalSteps,
        stepDef,
        sessionId: session.id,
        ...(index === 0 ? { triggerPayload } : {}),
      },
      opts: {
        failParentOnFailure: true,
        attempts: 1,
      },
    };
  });

  log.info(`Dispatching workflow "${definition.name}" run ${workflowRunId} (${totalSteps} steps)`);

  const { jobIds } = await flow.addChain(steps);

  log.info(`Workflow "${definition.name}" run ${workflowRunId} dispatched: ${jobIds.join(", ")}`);

  return { workflowRunId, jobIds };
}
