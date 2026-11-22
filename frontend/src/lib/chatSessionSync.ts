/**
 * Request parameters that keep a chat conversation (IndexedDB) in sync with its
 * server session.
 *
 * The server identifies user messages by the UI's message IDs. Turn counts are
 * sent alongside as a fallback for sessions stored before the server kept those
 * IDs (see `src/session/chatSync.ts`).
 */

/** The fields of a chat message these helpers read. */
export interface SyncMessage {
  id: string;
  role: string;
}

/** Sync fields of a `POST /api/chat` body. */
export interface ChatSendSync {
  clientMessageId: string;
  expectedLastClientId: string | null;
  userTurnIndex: number;
}

/** Error codes the server returns with a 409 on chat and session routes. */
export type SessionConflictCode = "session_busy" | "session_diverged";

/**
 * Builds the sync fields for sending (or resending) a user message.
 *
 * @param messages - The conversation's messages, oldest first, including `userMsg`
 * @param userMsg - The user message being sent
 * @returns The fields to add to the chat request
 * @throws Error when `userMsg` is not in `messages`
 */
export function chatSendSync(messages: SyncMessage[], userMsg: SyncMessage): ChatSendSync {
  const index = messages.findIndex((m) => m.id === userMsg.id);
  if (index < 0) throw new Error("User message is not part of the conversation");
  const earlierUsers = messages.slice(0, index).filter((m) => m.role === "user");
  return {
    clientMessageId: userMsg.id,
    expectedLastClientId: earlierUsers.at(-1)?.id ?? null,
    userTurnIndex: earlierUsers.length,
  };
}

/**
 * Builds the query for `DELETE /api/sessions/:id/messages` that removes a
 * message and everything after it.
 *
 * - A user message: delete it and everything after it.
 * - An assistant message: keep the user message it answers, delete the rest.
 *
 * @param messages - The conversation's messages, oldest first, including `msg`
 * @param msg - The first message to remove
 * @returns The query parameters
 * @throws Error when `msg` is not in `messages`
 */
export function truncateQuery(messages: SyncMessage[], msg: SyncMessage): Record<string, string> {
  const index = messages.findIndex((m) => m.id === msg.id);
  if (index < 0) throw new Error("Message is not part of the conversation");
  const earlierUsers = messages.slice(0, index).filter((m) => m.role === "user");
  if (msg.role === "user") {
    return { from: msg.id, keep: String(earlierUsers.length) };
  }
  const answered = earlierUsers.at(-1);
  if (!answered) return { keep: "0" };
  return { after: answered.id, keep: String(earlierUsers.length - 1), includeTrailing: "true" };
}

/**
 * Reads the conflict code from a 409 response body.
 *
 * @param body - The parsed response body
 * @returns The code, or `undefined` when the body carries none
 */
export function conflictCode(body: unknown): SessionConflictCode | undefined {
  const code = (body as { code?: unknown } | null)?.code;
  return code === "session_busy" || code === "session_diverged" ? code : undefined;
}
