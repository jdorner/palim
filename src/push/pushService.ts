/**
 * Push message service - programmatic API for injecting out-of-band messages
 * into chat sessions.
 *
 * Used by the HTTP push route, sandbox `push` command, and available to
 * extensions via `ExtensionContext.pushMessage()`.
 *
 * @module
 */

import type { WebSocketMessage } from "@shared/types";
import { getSessionStore } from "@src/session";
import { resolveSessionChat } from "@src/web/sessionChatMap";
import createLogger from "logging";
import type { PushMessageOptions, PushMessageResult } from "./types";

export type { PushMessageOptions, PushMessageResult } from "./types";

const log = createLogger("PushService");

/** Dependencies injected into the push service. */
export interface PushServiceDeps {
  /** Function to broadcast a WebSocket message to all connected clients. */
  broadcastFn: (message: WebSocketMessage) => void;
}

/**
 * Creates a push service instance with the given dependencies.
 *
 * @param deps - Service dependencies (broadcast function)
 * @returns Object with the `pushMessage` function
 */
export function createPushService(deps: PushServiceDeps) {
  /**
   * Sends a push message to a session.
   *
   * Appends the message to the session store and, if the session has an active
   * chat job, broadcasts it to the frontend via WebSocket.
   *
   * @param sessionId - Target session ID
   * @param content - Message content (text or markdown)
   * @param options - Optional configuration (contentType)
   * @returns Result indicating whether the message was broadcast or just stored
   * @throws {Error} If the session does not exist
   */
  function pushMessage(sessionId: string, content: string, options?: PushMessageOptions): PushMessageResult {
    const sessionStore = getSessionStore();
    const contentType = options?.contentType ?? "text/markdown";

    // Verify session exists
    const session = sessionStore.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Resolve chatId from active chat jobs
    const chatId = resolveSessionChat(sessionId);

    // Append push message to session store
    sessionStore.append(sessionId, {
      role: "push",
      content,
      contentType,
      timestamp: Date.now(),
    });

    // If chatId found: broadcast and return "broadcast"
    if (chatId) {
      deps.broadcastFn({
        type: "push_message",
        chatId,
        content,
        contentType,
      });

      log.info("Push message broadcast", { sessionId, chatId, contentType });
      return { status: "broadcast", chatId };
    }

    // No active job: stored but not broadcast
    log.info("Push message stored (no active chat)", { sessionId, contentType });
    return { status: "stored" };
  }

  return { pushMessage };
}

/** Type of the pushMessage function for external use. */
export type PushMessageFn = ReturnType<typeof createPushService>["pushMessage"];
