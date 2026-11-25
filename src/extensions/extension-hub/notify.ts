/**
 * Update notifications: which updates are new since the last check, and the
 * payload of the `extension-update` workflow trigger.
 *
 * @module
 */

import { type Static, Type } from "@sinclair/typebox";
import type { UpdateSummary } from "./hub";

/** Workflow trigger type fired when a check finds new extension versions. */
export const UPDATE_TRIGGER = "extension-update";

/** One update in the trigger payload. */
const NotifiedUpdateSchema = Type.Object({
  name: Type.String({ description: "Extension name" }),
  source: Type.String({ description: "Name of the source the extension was installed from" }),
  installedVersion: Type.String({ description: "Installed version" }),
  installedRef: Type.String({ description: "Installed ref (tag or branch)" }),
  latestRef: Type.String({ description: "Ref the update installs (tag or branch)" }),
  latestVersion: Type.Union([Type.String(), Type.Null()], {
    description: "Version of the update (null when unknown, e.g. a branch head with a broken package.json)",
  }),
  commit: Type.String({ description: "Commit of the update" }),
});

/** Payload schema of the {@link UPDATE_TRIGGER} trigger (`{{trigger.payload}}`). */
export const UpdateNotificationPayloadSchema = Type.Object({
  updates: Type.Array(NotifiedUpdateSchema, { description: "Updates found since the previous check, sorted by name" }),
  checkedAt: Type.String({ description: "ISO timestamp of the check" }),
  hubUrl: Type.String({ description: "URL of the Extension Hub page in the operator UI" }),
});

/** One update in the {@link UpdateNotificationPayload}. */
export type NotifiedUpdate = Static<typeof NotifiedUpdateSchema>;

/** Payload of the {@link UPDATE_TRIGGER} trigger. */
export type UpdateNotificationPayload = Static<typeof UpdateNotificationPayloadSchema>;

/** Reference for workflow authors, shown by `workflow trigger-types extension-update`. */
export const UPDATE_TRIGGER_DOCS = `Fires once per update check (periodic or "Check for updates" in the Extension Hub) that finds updates it has not reported before. An update counts as new per extension, target ref (tag or branch), and commit; each one is reported once. Updates already known at startup, and updates caused by an admin's own action (installing an older version, enabling prereleases), are not reported. Nothing fires while the hub setting "Update notifications" is off; updates found meanwhile are not reported later. Updates are never installed automatically.

Payload (\`trigger.payload\`):

- \`updates\`: list of \`{ name, source, installedVersion, installedRef, latestRef, latestVersion, commit }\`, sorted by name (\`latestVersion\` may be null)
- \`checkedAt\`: ISO timestamp of the check
- \`hubUrl\`: link to the Extension Hub page

Example message: \`New extension versions: {{ join(pluck(trigger.payload.updates, "latestRef"), ", ") }}\`
`;

/**
 * Identifies an update by extension, target ref, and target commit, so a later
 * release of an extension that already had an update counts as new, even when
 * its tag points at the same commit as the previous one.
 *
 * @param update - An available update
 * @returns The key `<name> <ref> <commit>` (spaces cannot occur in git refs)
 */
export function updateKey(update: UpdateSummary): string {
  return `${update.name} ${update.update.ref} ${update.update.commit}`;
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
 * Builds the payload of the {@link UPDATE_TRIGGER} trigger.
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
