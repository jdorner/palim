/**
 * Update notifications: which updates are new since the last check, and the
 * trigger payload of the notification workflow.
 *
 * @module
 */

import type { UpdateSummary } from "./hub";

/** One update in the {@link UpdateNotificationPayload}. */
export interface NotifiedUpdate {
  /** Extension name. */
  name: string;
  /** Name of the source the extension was installed from. */
  source: string;
  /** Installed version. */
  installedVersion: string;
  /** Installed ref (tag or branch). */
  installedRef: string;
  /** Ref the update installs (tag or branch). */
  latestRef: string;
  /** Version of the update (null when unknown, e.g. a branch head with a broken package.json). */
  latestVersion: string | null;
  /** Commit of the update. */
  commit: string;
}

/** Trigger payload of the notification workflow. */
export interface UpdateNotificationPayload {
  /** Updates that appeared since the previous check, sorted by name. */
  updates: NotifiedUpdate[];
  /** ISO timestamp of the check. */
  checkedAt: string;
  /** URL of the Extension Hub page in the operator UI. */
  hubUrl: string;
}

/**
 * Identifies an update by extension and target commit, so a later release of
 * an extension that already had an update counts as new.
 *
 * @param update - An available update
 * @returns The key `<name>@<commit>`
 */
export function updateKey(update: UpdateSummary): string {
  return `${update.name}@${update.update.commit}`;
}

/**
 * Returns the updates whose key is not in the set of already known updates.
 *
 * @param known - Keys ({@link updateKey}) of the updates known before
 * @param current - Currently available updates
 * @returns The new updates, in the order of `current`
 */
export function newUpdates(known: ReadonlySet<string>, current: UpdateSummary[]): UpdateSummary[] {
  return current.filter((u) => !known.has(updateKey(u)));
}

/**
 * Returns the settings warning for a notification workflow that does not
 * exist. An empty name means "no notification" and is not warned about.
 *
 * @param workflowName - Configured workflow name (trimmed)
 * @param workflowNames - Names of all loaded workflows
 * @returns The warning, or null when there is nothing to warn about
 */
export function missingWorkflowWarning(workflowName: string, workflowNames: string[]): string | null {
  if (workflowName === "" || workflowNames.includes(workflowName)) return null;
  return `Notification workflow "${workflowName}" does not exist. No update notifications are sent until you select another one.`;
}

/**
 * Builds the trigger payload of the notification workflow.
 *
 * @param updates - The new updates
 * @param checkedAt - Time of the check
 * @param hubUrl - URL of the Extension Hub page
 * @returns The payload
 */
export function notificationPayload(
  updates: UpdateSummary[],
  checkedAt: Date,
  hubUrl: string,
): UpdateNotificationPayload {
  return {
    updates: updates
      .map((u) => ({
        name: u.name,
        source: u.source,
        installedVersion: u.installedVersion,
        installedRef: u.ref,
        latestRef: u.update.ref,
        latestVersion: u.update.version,
        commit: u.update.commit,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    checkedAt: checkedAt.toISOString(),
    hubUrl,
  };
}
