/**
 * Sync rules between the chat UI's conversation (IndexedDB) and its server session.
 *
 * The UI gives every message a client-generated ID and sends it with each user
 * message; the server stores it on the session row. These pure functions locate
 * UI messages in a session by that ID instead of counting turns.
 *
 * Sessions written before client IDs existed have user messages without one
 * ("legacy" messages). For those, truncation falls back to turn counting and
 * the divergence check is skipped, since there is nothing to compare.
 *
 * @module
 */

import type { UserMessageMarker } from "./types";

/** What the chat route does with an incoming user message. */
export type ChatSendPlan =
  /** Append the message (deleting nothing). */
  | { kind: "append" }
  /**
   * The message is already the last user message: delete everything from `cutSeq`
   * and run again without appending. `backfillSeq` names a legacy user message
   * that is this message and gets its client ID stored.
   */
  | { kind: "rerun"; cutSeq: number; backfillSeq?: number }
  /** The UI's view of the conversation does not match the session. */
  | { kind: "diverged" };

/**
 * Whether a session contains user messages stored without a client ID.
 *
 * @param markers - The session's user message markers
 * @returns `true` when at least one user message has no client ID
 */
export function hasLegacyUserMessages(markers: UserMessageMarker[]): boolean {
  return markers.some((m) => m.clientId === null);
}

/**
 * Decides how to handle a chat message sent with a client ID.
 *
 * - The ID is already the session's last user message (retry, regenerate):
 *   rerun from it, deleting any response that followed.
 * - The ID is an earlier user message: diverged (the UI should have truncated first).
 * - The ID is new: append, provided `expectedLastClientId` matches the session's
 *   last user message (`null` = the UI expects no user message yet).
 * - The session's last user message is a legacy message without an ID: there is
 *   nothing to compare, so the UI's `userTurnIndex` decides. When it points at
 *   that last message, the UI is resending it: rerun and store the ID on it.
 *   Otherwise append.
 *
 * @param markers - The session's user message markers, oldest first
 * @param clientId - The client ID of the message being sent
 * @param expectedLastClientId - The client ID of the user message the UI sees before this one, or `null` for none
 * @param userTurnIndex - Zero-based position of this message among the UI's user messages, if known
 * @returns The plan for the chat route
 */
export function planChatSend(
  markers: UserMessageMarker[],
  clientId: string,
  expectedLastClientId: string | null,
  userTurnIndex?: number,
): ChatSendPlan {
  const last = markers.at(-1);
  const index = markers.findIndex((m) => m.clientId === clientId);
  if (index >= 0) {
    return index === markers.length - 1 ? { kind: "rerun", cutSeq: markers[index]!.seq + 1 } : { kind: "diverged" };
  }
  if (last && last.clientId === null) {
    return userTurnIndex === markers.length - 1
      ? { kind: "rerun", cutSeq: last.seq + 1, backfillSeq: last.seq }
      : { kind: "append" };
  }
  return (last?.clientId ?? null) === expectedLastClientId ? { kind: "append" } : { kind: "diverged" };
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
  const marker = markers.find((m) => m.clientId === clientId);
  if (!marker) return undefined;
  return mode === "from" ? marker.seq : marker.seq + 1;
}

/**
 * Finds where to truncate a session by counting turns (legacy fallback).
 *
 * A turn is a user message plus every message after it up to the next user
 * message. Keeps the first `keepTurns` turns and, with `includeTrailing`, the
 * user message that starts the next turn (without its response).
 *
 * @param markers - The session's user message markers
 * @param keepTurns - Number of complete turns to keep
 * @param includeTrailing - Also keep the next turn's user message
 * @returns The first `seq` to delete, or `undefined` when everything is kept
 */
export function cutSeqForTurns(
  markers: UserMessageMarker[],
  keepTurns: number,
  includeTrailing: boolean,
): number | undefined {
  if (keepTurns === 0 && !includeTrailing) return 0;
  const next = markers[keepTurns];
  if (!next) return undefined;
  return includeTrailing ? next.seq + 1 : next.seq;
}

/**
 * Finds the legacy user message a turn count points at (the user message that
 * starts turn `keepTurns + 1`), so its client ID can be stored.
 *
 * @param markers - The session's user message markers
 * @param keepTurns - Number of complete turns before the message
 * @returns The message's `seq`, or `undefined` when it does not exist or already has an ID
 */
export function legacySeqForTurn(markers: UserMessageMarker[], keepTurns: number): number | undefined {
  const marker = markers[keepTurns];
  return marker && marker.clientId === null ? marker.seq : undefined;
}
