/**
 * Sync rules between the chat UI's conversation (IndexedDB) and its server session.
 *
 * The UI gives every message a client-generated ID and sends it with each user
 * message; the server stores it on the session row. These pure functions locate
 * UI messages in a session by that ID.
 *
 * A user message stored without a client ID is known by `legacy-<seq>`
 * (`userMessageId`), the ID the UI gets for it when it resyncs the session.
 *
 * @module
 */

import { userMessageId } from "@shared/chatTranscript";
import type { UserMessageMarker } from "./types";

/** What the chat route does with an incoming user message. */
export type ChatSendPlan =
  /** Append the message (deleting nothing). */
  | { kind: "append" }
  /** The message is already the last user message: delete everything from `cutSeq` and run again without appending. */
  | { kind: "rerun"; cutSeq: number }
  /** The UI's view of the conversation does not match the session. */
  | { kind: "diverged" };

/**
 * The UI ID of a user message marker.
 *
 * @param marker - The marker
 * @returns Its client ID, or `legacy-<seq>`
 */
function markerId(marker: UserMessageMarker): string {
  return userMessageId(marker.clientId, marker.seq);
}

/**
 * Decides how to handle a chat message sent with a client ID.
 *
 * - The ID is already the session's last user message (retry, regenerate):
 *   rerun from it, deleting any response that followed.
 * - The ID is an earlier user message: diverged (the UI should have truncated first).
 * - The ID is new: append, provided `expectedLastClientId` matches the session's
 *   last user message (`null` = the UI expects no user message yet).
 *
 * @param markers - The session's user message markers, oldest first
 * @param clientId - The client ID of the message being sent
 * @param expectedLastClientId - The client ID of the user message the UI sees before this one, or `null` for none
 * @returns The plan for the chat route
 */
export function planChatSend(
  markers: UserMessageMarker[],
  clientId: string,
  expectedLastClientId: string | null,
): ChatSendPlan {
  const index = markers.findIndex((m) => markerId(m) === clientId);
  if (index >= 0) {
    return index === markers.length - 1 ? { kind: "rerun", cutSeq: markers[index]!.seq + 1 } : { kind: "diverged" };
  }
  const last = markers.at(-1);
  return (last ? markerId(last) : null) === expectedLastClientId ? { kind: "append" } : { kind: "diverged" };
}

/**
 * Finds where to truncate a session relative to a UI user message.
 *
 * @param markers - The session's user message markers
 * @param clientId - The client ID of the user message
 * @param mode - `"from"` deletes the message and everything after it; `"after"` keeps it and deletes its response
 * @returns The first `seq` to delete, or `undefined` when the session has no such message
 */
export function cutSeqForClientId(
  markers: UserMessageMarker[],
  clientId: string,
  mode: "from" | "after",
): number | undefined {
  const marker = markers.find((m) => markerId(m) === clientId);
  if (!marker) return undefined;
  return mode === "from" ? marker.seq : marker.seq + 1;
}
