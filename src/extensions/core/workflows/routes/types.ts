/**
 * Dependencies shared by the workflow route modules.
 *
 * @module
 */

import type { ExtensionContext, HitlApi, Logger, ManagedQueuePort } from "@ext/types";
import type { DagCoordinatorDeps } from "../dagCoordinator";
import type { DagStepJobData } from "../dagEngine";
import type { DagWorkflowDefinition } from "../schemas";
import type { TriggerRefLookup } from "../triggerRefs";
import type { WorkflowAnalysis } from "../workflowAnalysis";

/** State and services of a workflows extension instance that its routes use. */
export interface WorkflowRouteDeps {
  ctx: ExtensionContext;
  logger: Logger;
  /** Loaded workflow definitions, keyed by name. */
  store: Map<string, DagWorkflowDefinition>;
  /** Directory holding the workflow JSON5 files. */
  workflowsDir: string;
  stepsQueue: ManagedQueuePort<DagStepJobData>;
  coordinatorDeps: DagCoordinatorDeps;
  hitl: HitlApi | undefined;
  /** Dispatches a workflow run and announces it to clients. */
  dispatchAndAnnounce: (
    wf: DagWorkflowDefinition,
    payload: unknown,
    initiatorUserId?: string,
  ) => Promise<{ workflowRunId: string; jobIds: string[] }>;
  /** Schedules a debounced reload of the definitions from disk. */
  scheduleReload: () => void;
  /** Resolves output schemas and advisory warnings of a definition. */
  analyzeWorkflow: (def: DagWorkflowDefinition, triggerRefs: TriggerRefLookup) => Promise<WorkflowAnalysis>;
}
