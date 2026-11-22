/**
 * Serializes changes to chat sessions.
 *
 * A chat session must not change while a job for it waits or runs (the job
 * appends its messages when it finishes), and two requests must not change it
 * at once (two tabs or devices). Routes that change a session claim it first.
 *
 * @module
 */

import type { ChatJob } from "@src/jobs";
import type { ManagedQueuePort } from "@src/queue";

/** Exclusive, short-lived access to a chat session for one request. */
export interface ChatSessionGuard {
  /**
   * Claims a session for the current request.
   *
   * @param sessionId - The session to change
   * @returns `true` when claimed; `false` when another request holds it or a chat job for it is pending
   */
  claim(sessionId: string): Promise<boolean>;
  /**
   * Releases a session claimed with {@link ChatSessionGuard.claim}.
   *
   * @param sessionId - The claimed session
   */
  release(sessionId: string): void;
}

/**
 * Creates a guard backed by the chat queue.
 *
 * The claim is taken synchronously before the queue is checked, so concurrent
 * requests in this process cannot both pass.
 *
 * @param chatQueue - The managed chat queue
 * @returns The guard
 */
export function createChatSessionGuard(chatQueue: ManagedQueuePort<ChatJob>): ChatSessionGuard {
  const claimed = new Set<string>();
  return {
    async claim(sessionId) {
      if (claimed.has(sessionId)) return false;
      claimed.add(sessionId);
      try {
        const [waiting, active] = await Promise.all([chatQueue.getWaiting(), chatQueue.getActive()]);
        if (![...waiting, ...active].some((job) => job.data.sessionId === sessionId)) return true;
      } catch (err) {
        claimed.delete(sessionId);
        throw err;
      }
      claimed.delete(sessionId);
      return false;
    },
    release(sessionId) {
      claimed.delete(sessionId);
    },
  };
}
