/**
 * Portal launcher provider: offers the enabled workflows with a `portal`
 * trigger to the portal and starts them as their bound run-as account.
 *
 * @module
 */

import type { PortalLauncherDef, PortalLauncherProvider } from "@ext/types";
import { PORTAL_UPLOAD_DEFAULT_MB } from "@shared/portal";
import { getPortalRunAs } from "./portalRunAs";
import type { DagWorkflowDefinition } from "./schemas";

/**
 * Builds the launcher for a workflow, or null when it is not a usable
 * portal workflow (other trigger type, or disabled).
 *
 * @param wf - The workflow definition
 * @param runAsUserId - The bound run-as user id (null when unbound)
 * @returns The launcher, or null
 */
export function toPortalLauncher(wf: DagWorkflowDefinition, runAsUserId: string | null): PortalLauncherDef | null {
  if (wf.trigger.type !== "portal" || wf.enabled === false) return null;
  const config = wf.trigger.portal ?? {};
  return {
    name: wf.name,
    title: config.title?.trim() || wf.name,
    description: config.description?.trim() || wf.description?.trim() || null,
    accept: config.accept?.trim() || null,
    fileRequired: config.fileRequired ?? true,
    maxSizeMb: config.maxSizeMb ?? PORTAL_UPLOAD_DEFAULT_MB,
    fields: config.fields ?? null,
    roles: config.roles ?? [],
    runAsUserId,
  };
}

/**
 * Creates the launcher provider over the live workflow store.
 *
 * @param store - Loaded workflow definitions, keyed by name
 * @param dispatch - Starts a workflow run as the given initiator
 * @param runAsOf - Looks up a workflow's run-as binding (defaults to the `app_config` store)
 * @returns The provider
 */
export function createPortalLauncherProvider(
  store: ReadonlyMap<string, DagWorkflowDefinition>,
  dispatch: (
    wf: DagWorkflowDefinition,
    payload: unknown,
    initiatorUserId: string,
  ) => Promise<{ workflowRunId: string }>,
  runAsOf: (workflowName: string) => string | null = getPortalRunAs,
): PortalLauncherProvider {
  return {
    list() {
      const launchers: PortalLauncherDef[] = [];
      for (const wf of store.values()) {
        const launcher = toPortalLauncher(wf, runAsOf(wf.name));
        if (launcher) launchers.push(launcher);
      }
      return launchers;
    },
    async start(name, payload, initiatorUserId) {
      const wf = store.get(name);
      if (!wf || !toPortalLauncher(wf, null)) throw new Error(`Workflow "${name}" is not available in the portal`);
      const { workflowRunId } = await dispatch(wf, payload, initiatorUserId);
      return { runId: workflowRunId };
    },
  };
}

/**
 * Counts the portal workflows whose runs execute as a user (so deleting the
 * user is refused while they are still bound).
 *
 * @param store - Loaded workflow definitions
 * @param userId - The user id
 * @param runAsOf - Looks up a workflow's run-as binding
 * @returns The number of bound portal workflows
 */
export function countPortalWorkflowsRunAs(
  store: ReadonlyMap<string, DagWorkflowDefinition>,
  userId: string,
  runAsOf: (workflowName: string) => string | null = getPortalRunAs,
): number {
  let count = 0;
  for (const wf of store.values()) {
    if (wf.trigger.type === "portal" && runAsOf(wf.name) === userId) count++;
  }
  return count;
}
