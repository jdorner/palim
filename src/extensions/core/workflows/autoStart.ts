/**
 * Selection of the workflows that start without a person asking for them:
 * event triggers (webhook, schedule, file watcher, extension trigger types) and dispatch from other
 * workflows (`start-workflow`, `ctx.workflows.dispatch`). Both defer to
 * {@link isAutoStartable}.
 *
 * @module
 */

import type { WorkflowLoadError } from "@shared/workflows";
import type { TemplateWarning } from "./dagTemplateValidation";
import { type DagWorkflowDefinition, isAutoStartable } from "./schemas";
import { missingWorkflowMessage } from "./workflowFileIndex";

/** Step type (registered by `core-wf-steps`) that dispatches the workflow named in its `workflowName`. */
const START_WORKFLOW_STEP = "start-workflow";

/**
 * Returns the workflows an event trigger starts.
 *
 * @param workflows - The loaded workflow definitions
 * @param triggerType - The trigger type of the event (`webhook`, `schedule`, `filewatcher`, or an extension's type)
 * @param ref - The event's slug, matched against `trigger.ref`; undefined for a
 *   trigger type without refs, which matches every workflow of the type
 * @returns The matching workflows that may start automatically
 */
export function workflowsForTrigger(
  workflows: Iterable<DagWorkflowDefinition>,
  triggerType: string,
  ref: string | undefined,
): DagWorkflowDefinition[] {
  const matches: DagWorkflowDefinition[] = [];
  for (const wf of workflows) {
    if (wf.trigger.type !== triggerType || !isAutoStartable(wf)) continue;
    if (ref === undefined || wf.trigger.ref === ref) matches.push(wf);
  }
  return matches;
}

/**
 * Resolves a workflow another workflow or extension asked to start.
 *
 * @param wf - The workflow looked up by name, or undefined when none is loaded
 * @param name - The requested name, for the error message
 * @param loadError - Why a file meant to define it is not loaded, so the error names the broken file
 * @returns The workflow, when it may start automatically
 * @throws {Error} When the workflow does not exist (or its file is invalid), is a draft, or is disabled
 */
export function resolveDispatchTarget(
  wf: DagWorkflowDefinition | undefined,
  name: string,
  loadError?: WorkflowLoadError,
): DagWorkflowDefinition {
  if (!wf) throw new Error(missingWorkflowMessage(name, loadError));
  if (!isAutoStartable(wf)) {
    throw new Error(wf.draft === true ? `Workflow is a draft: ${name}` : `Workflow is disabled: ${name}`);
  }
  return wf;
}

/**
 * Warns about `start-workflow` steps whose target is a draft: the definition
 * is valid, but {@link resolveDispatchTarget} refuses the dispatch, so the step
 * fails on every run until the target is activated. Templated names are
 * resolved at run time and are not checked.
 *
 * Advisory only: it must not block saving, since pointing at a draft that is
 * activated later is a normal way to build two workflows together.
 *
 * @param definition - The workflow definition to check
 * @param lookup - Returns the loaded workflow of a name, or undefined
 * @returns One warning per step that targets a draft
 */
export function getDraftTargetWarnings(
  definition: DagWorkflowDefinition,
  lookup: (name: string) => DagWorkflowDefinition | undefined,
): TemplateWarning[] {
  const warnings: TemplateWarning[] = [];
  for (const [slug, stepDef] of Object.entries(definition.steps)) {
    if (stepDef.type !== START_WORKFLOW_STEP) continue;
    const target = (stepDef as Record<string, unknown>).workflowName;
    if (typeof target !== "string" || target.includes("{{")) continue;
    if (lookup(target.trim())?.draft === true) {
      warnings.push({
        stepSlug: slug,
        field: "workflowName",
        message: `Workflow "${target.trim()}" is a draft: this step fails until it is activated`,
      });
    }
  }
  return warnings;
}
