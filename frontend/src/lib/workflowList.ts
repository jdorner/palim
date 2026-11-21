/**
 * Live-update rules of the workflow list page.
 *
 * @module
 */

import type { WorkflowWebSocketEvent } from "../../../shared/workflows";

/**
 * Events after which the list refetches definitions, run counts and load
 * errors: a run ended or was removed (its counts changed), or a workflow file
 * was reloaded or deleted (a workflow appeared, changed, vanished, or a file
 * failed to load).
 */
const REFETCH_EVENTS: ReadonlySet<WorkflowWebSocketEvent["type"]> = new Set([
  "workflow_completed",
  "workflow_failed",
  "workflow_run_removed",
  "workflow_reload",
  "workflow_deleted",
]);

/**
 * Whether the workflow list must refetch from the server after a WebSocket event.
 *
 * @param type - The event's `type`
 * @returns `true` when the list is stale after this event
 */
export function listNeedsRefetch(type: WorkflowWebSocketEvent["type"]): boolean {
  return REFETCH_EVENTS.has(type);
}
