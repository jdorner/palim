/**
 * Selection of the workflows that start without a person asking for them:
 * event triggers (webhook, schedule, file watcher) and dispatch from other
 * workflows (`start-workflow`, `ctx.workflows.dispatch`). Both defer to
 * {@link isAutoStartable}.
 *
 * @module
 */

import { type DagWorkflowDefinition, isAutoStartable } from "./schemas";

/**
 * Returns the workflows an event trigger starts.
 *
 * @param workflows - The loaded workflow definitions
 * @param triggerType - The trigger type of the event (`webhook`, `schedule`, `filewatcher`)
 * @param ref - The event's slug, matched against `trigger.ref`
 * @returns The matching workflows that may start automatically
 */
export function workflowsForTrigger(
  workflows: Iterable<DagWorkflowDefinition>,
  triggerType: string,
  ref: string,
): DagWorkflowDefinition[] {
  const matches: DagWorkflowDefinition[] = [];
  for (const wf of workflows) {
    if (wf.trigger.type === triggerType && wf.trigger.ref === ref && isAutoStartable(wf)) matches.push(wf);
  }
  return matches;
}

/**
 * Resolves a workflow another workflow or extension asked to start.
 *
 * @param wf - The workflow looked up by name, or undefined when none is loaded
 * @param name - The requested name, for the error message
 * @returns The workflow, when it may start automatically
 * @throws {Error} When the workflow does not exist, is a draft, or is disabled
 */
export function resolveDispatchTarget(wf: DagWorkflowDefinition | undefined, name: string): DagWorkflowDefinition {
  if (!wf) throw new Error(`Workflow not found: ${name}`);
  if (!isAutoStartable(wf)) {
    throw new Error(wf.draft === true ? `Workflow is a draft: ${name}` : `Workflow is disabled: ${name}`);
  }
  return wf;
}
