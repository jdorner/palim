/**
 * In-memory session-to-chat mapping.
 *
 * Maintained by the chat queue lifecycle: entries are registered when a chat job
 * becomes active and removed when the job completes or fails. This allows the push
 * endpoint to resolve which chat a given session belongs to without querying the queue.
 */

/** Maps sessionId to chatId for active chat jobs. */
const sessionChatMap = new Map<string, string>();

/**
 * Registers (or overwrites) a session-to-chat mapping.
 *
 * Called when a chat job becomes active so the push endpoint can route messages
 * to the correct WebSocket stream.
 *
 * @param sessionId - The session identifier
 * @param chatId - The chat job context identifier
 */
export function registerSessionChat(sessionId: string, chatId: string): void {
  sessionChatMap.set(sessionId, chatId);
}

/**
 * Removes the mapping for a session.
 *
 * Called when a chat job completes or fails.
 *
 * @param sessionId - The session identifier to unregister
 */
export function unregisterSessionChat(sessionId: string): void {
  sessionChatMap.delete(sessionId);
}

/**
 * Resolves the chatId currently associated with a session.
 *
 * @param sessionId - The session identifier to look up
 * @returns The associated chatId, or `undefined` if no active mapping exists
 */
export function resolveSessionChat(sessionId: string): string | undefined {
  return sessionChatMap.get(sessionId);
}
