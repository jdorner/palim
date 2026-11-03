/**
 * Drag-and-drop helpers of the workflow list: container ids of the drop
 * zones (one per group section plus the "new group" zone) and group-name
 * normalization.
 *
 * @module
 */

/** Drop-zone id of the "new group" target. */
export const NEW_GROUP_CONTAINER = "new-group";

/** Maximum length of a group name (mirrors the backend schema). */
export const GROUP_NAME_MAX_LENGTH = 64;

const GROUP_PREFIX = "group:";
const UNGROUPED_CONTAINER = "ungrouped";

/**
 * Drop-zone id of a group section. Never empty, so drag-and-drop state can
 * treat a falsy container as "none".
 *
 * @param group - Group name, or `null` for the ungrouped section
 * @returns The container id
 */
export function groupContainer(group: string | null): string {
  return group === null ? UNGROUPED_CONTAINER : `${GROUP_PREFIX}${group}`;
}

/**
 * Inverse of {@link groupContainer}.
 *
 * @param container - A drop-zone id
 * @returns The group name, `null` for the ungrouped section, or `undefined` for a non-group zone
 */
export function containerGroup(container: string): string | null | undefined {
  if (container === UNGROUPED_CONTAINER) return null;
  if (container.startsWith(GROUP_PREFIX)) return container.slice(GROUP_PREFIX.length);
  return undefined;
}

/**
 * Normalizes a group name typed by the user.
 *
 * @param input - Raw input
 * @returns The trimmed name, or `null` if it is empty or too long
 */
export function normalizeGroupName(input: string): string | null {
  const name = input.trim();
  return name.length > 0 && name.length <= GROUP_NAME_MAX_LENGTH ? name : null;
}
