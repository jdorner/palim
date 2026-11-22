/**
 * Announces changes to chat sessions to their owner's WebSocket connections,
 * so every tab and device showing a conversation can resync it.
 *
 * @module
 */

import { sessionTitle, userMessageId } from "@shared/chatTranscript";
import type { SessionChangedEvent, SessionChangeReason } from "@shared/websocket";
import { mainLogger as log } from "@src/utils/logger";
import { getSessionStore } from "./index";

/**
 * Announces that a session changed. Does nothing for sessions that are not
 * chat sessions or have no owner. Never throws. Call it before deleting a
 * session (reason `deleted`), while the session can still be read.
 *
 * @param sessionId - The changed session
 * @param reason - What changed
 * @param origin - ID the client chose for the request that caused the change
 */
export type NotifySessionChanged = (sessionId: string, reason: SessionChangeReason, origin?: string) => void;

/**
 * Creates the function that announces session changes.
 *
 * @param broadcast - Sends a WebSocket message (the monitor delivers `session_changed` to its `userId` only)
 * @returns The notifier
 */
export function createSessionChangeNotifier(broadcast: (event: SessionChangedEvent) => void): NotifySessionChanged {
  return (sessionId, reason, origin) => {
    try {
      const store = getSessionStore();
      const session = store.get(sessionId);
      if (session?.source !== "chat" || !session.userId) return;
      const summary = store.getSessionSummary(sessionId);
      broadcast({
        type: "session_changed",
        userId: session.userId,
        sessionId,
        lastUserClientId: summary.lastUserSeq > 0 ? userMessageId(summary.lastUserClientId, summary.lastUserSeq) : null,
        title: sessionTitle(summary.title, summary.firstUserContent),
        reason,
        ...(origin ? { origin } : {}),
      });
    } catch (error) {
      log.error("Failed to announce session change", { error, sessionId, reason });
    }
  };
}
