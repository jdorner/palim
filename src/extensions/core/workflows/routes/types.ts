/**
 * Dependencies shared by the workflow route modules.
 *
 * @module
 */

import type { ExtensionContext, Logger } from "@ext/types";
import type { DagWorkflowDefinition } from "../schemas";
import type { TriggerRefLookup } from "../triggerRefs";
import type { WorkflowAnalysis } from "../workflowAnalysis";
import type { WorkflowFileIndex } from "../workflowFileIndex";
import type { WorkflowRuns } from "../workflowRuns";

/** State and services of a workflows extension instance that its routes use. */
export interface WorkflowRouteDeps {
  ctx: ExtensionContext;
  logger: Logger;
  /** Loaded workflow definitions, keyed by name. */
  store: Map<string, DagWorkflowDefinition>;
  /** Why workflow files are not loaded, to explain a missing workflow. */
  loadErrors: Pick<WorkflowFileIndex, "loadErrors" | "loadErrorFor">;
  /** Directory holding the workflow JSON5 files. */
  workflowsDir: string;
  /** The run lifecycle (start, describe, remove, signal delivery deps). */
  runs: WorkflowRuns;
  /** Whether the human task service is configured (`humanTask` steps available). */
  hitlEnabled: boolean;
  /**
   * Schedules a debounced reload of one workflow file from disk (the file
   * watcher usually reports the same write; the duplicate is merged).
   */
  scheduleReload: (filename: string) => void;
  /** Resolves output schemas and advisory warnings of a definition. */
  analyzeWorkflow: (def: DagWorkflowDefinition, triggerRefs: TriggerRefLookup) => Promise<WorkflowAnalysis>;
}
