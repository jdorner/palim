/**
 * Helpers for capturing trigger and workflow-run ownership.
 *
 * Trigger registrations (webhooks, file watchers, schedules) record the user
 * who created or last edited them (`createdByUserId`). Background runs spawned
 * by a trigger act with that user's authority. Ownership does not restrict who
 * may change a trigger (that is gated by `triggers:write` alone), which is why
 * an edit re-binds the trigger to the editor.
 *
 * These helpers read the request principal established by the core auth check,
 * so they work uniformly for core-extension routes (which are protected by the
 * same global auth hook).
 *
 * @module
 */

import { getPrincipal } from "./auth";

/**
 * Returns the id of the user who made the current request, or undefined when
 * unauthenticated (should not happen for protected routes).
 *
 * @param request - The incoming request.
 * @returns The requesting user's id, or undefined.
 */
export function requestUserId(request: Request): string | undefined {
  return getPrincipal(request)?.user.id;
}

/**
 * Counts the triggers of one kind that a user created. Registered by the
 * trigger-owning core extensions so user deletion can refuse while the user
 * still owns triggers (which would otherwise fire with an unresolvable initiator).
 */
export type TriggerOwnerCounter = (userId: string) => number | Promise<number>;

/** Registered counters keyed by trigger kind (e.g. "webhook", "file watcher", "schedule"). */
const ownerCounters = new Map<string, TriggerOwnerCounter>();

/**
 * Registers a counter for triggers of the given kind.
 *
 * @param kind - Human-readable singular trigger kind, used in error messages.
 * @param counter - Returns how many triggers of this kind the user created.
 * @returns A function that removes the registration (call it on shutdown).
 */
export function registerTriggerOwnerCounter(kind: string, counter: TriggerOwnerCounter): () => void {
  ownerCounters.set(kind, counter);
  return () => {
    if (ownerCounters.get(kind) === counter) ownerCounters.delete(kind);
  };
}

/**
 * Counts the triggers a user created, per kind, across all registered counters.
 *
 * @param userId - The user id.
 * @returns Kinds with a non-zero count, in registration order.
 * @throws When a counter throws.
 */
export async function countTriggersOwnedBy(userId: string): Promise<{ kind: string; count: number }[]> {
  const results: { kind: string; count: number }[] = [];
  for (const [kind, counter] of ownerCounters) {
    const count = await counter(userId);
    if (count > 0) results.push({ kind, count });
  }
  return results;
}
