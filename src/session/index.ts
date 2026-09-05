/**
 * Session module - server-side conversation session management.
 *
 * Provides a SQLite-backed store for conversation history that replaces
 * the per-consumer `previousMessages` pattern with a central, persistent
 * session identified by an opaque ID.
 *
 * @module
 */

import type { AppDatabase } from "@src/db";
import { SessionStore } from "./sessionStore";
import type { SessionStorePort } from "./types";

export type { PushMessage } from "./pushMessage";
export { SessionStore } from "./sessionStore";
export type {
  CreateSessionOptions,
  GetMessagesOptions,
  GetOrCreateSessionOptions,
  ListSessionsOptions,
  Session,
  SessionData,
  SessionStorePort,
} from "./types";

/**
 * Delete the given sessions (and their messages) unless their `source` is `"chat"`.
 *
 * Used when jobs are removed from the queue so that one-shot, non-chat
 * conversations (e.g. scheduler, telegram, workflow-triggered agent runs) are
 * cleaned up alongside their jobs, while user-facing chat conversations are
 * preserved. Session IDs that do not resolve to an existing session are ignored.
 *
 * @param store - The session store to operate on
 * @param sessionIds - The candidate session IDs to delete
 * @returns The IDs of the sessions that were actually deleted
 */
export function deleteNonChatSessions(store: SessionStorePort, sessionIds: Iterable<string>): string[] {
  const deleted: string[] = [];
  for (const sessionId of sessionIds) {
    const session = store.get(sessionId);
    if (session && session.source !== "chat") {
      store.delete(sessionId);
      deleted.push(sessionId);
    }
  }
  return deleted;
}

let _store: SessionStore | null = null;

/**
 * Get or create the shared {@link SessionStore} singleton.
 *
 * Must be called after the database is initialized (i.e. after
 * {@link getDb} has been called at least once).
 *
 * @param db - The Drizzle database instance (required on first call)
 * @returns The shared SessionStore instance
 * @throws If called without `db` before the store has been initialized
 */
export function getSessionStore(db?: AppDatabase): SessionStore {
  if (!_store) {
    if (!db) {
      throw new Error("SessionStore not initialized - call getSessionStore(db) with a database instance first");
    }
    _store = new SessionStore(db);
  }
  return _store;
}
