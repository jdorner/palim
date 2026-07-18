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
