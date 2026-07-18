import { derived, type Readable } from "svelte/store";
import { fileWatcherCount, mcpServerCount, schedules, webhookCount, workflowCount } from "./appStore";

/** Derived store providing the number of configured schedules. */
const scheduleCount: Readable<number> = derived(schedules, ($s) => $s.length);

/** Maps badge key strings from extension manifests to reactive count stores. */
export const badgeRegistry: Record<string, Readable<number>> = {
  mcpServerCount,
  webhookCount,
  fileWatcherCount,
  workflowCount,
  scheduleCount,
};

/**
 * Resolves a badge key to its reactive store.
 * Returns null if the key is not registered.
 */
export function resolveBadge(badgeKey: string): Readable<number> | null {
  return badgeRegistry[badgeKey] ?? null;
}
