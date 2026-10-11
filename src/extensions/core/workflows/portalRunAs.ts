/**
 * Run-as bindings of portal-triggered workflows.
 *
 * A run started from the portal executes as an operator account, not as the
 * portal user. That account is bound to the workflow when an operator saves it
 * in the editor (which needs `workflows:manage`) and stored in `app_config`,
 * not in the definition file: workflow files live in the work directory, which
 * the agent sandbox can write, so a binding there could name any account.
 *
 * @module
 */

import * as appConfig from "@src/db/appConfig";

/** `app_config` key of a workflow's run-as binding. */
function bindingKey(workflowName: string): string {
  return `workflows.portalRunAs.${workflowName}`;
}

/**
 * Returns the user id a portal-triggered workflow runs as.
 *
 * @param workflowName - The workflow name
 * @returns The bound user id, or null when the workflow is not bound
 */
export function getPortalRunAs(workflowName: string): string | null {
  return appConfig.get(bindingKey(workflowName)) ?? null;
}

/**
 * Binds a workflow to the account its portal-started runs execute as.
 *
 * @param workflowName - The workflow name
 * @param userId - The operator's user id
 */
export function setPortalRunAs(workflowName: string, userId: string): void {
  appConfig.set(bindingKey(workflowName), userId);
}

/**
 * Removes a workflow's run-as binding (no-op when there is none).
 *
 * @param workflowName - The workflow name
 */
export function clearPortalRunAs(workflowName: string): void {
  appConfig.remove(bindingKey(workflowName));
}
