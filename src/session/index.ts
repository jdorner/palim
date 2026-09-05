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
import createLogger from "logging";
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

// ---------------------------------------------------------------------------
// Periodic stale-session purge
// ---------------------------------------------------------------------------

const sessionLogger = createLogger("SessionPurge");

/** Handle for the periodic session purge timer. */
let _sessionPurgeTimer: ReturnType<typeof setInterval> | null = null;

/** Options controlling the stale-session purge. */
export interface SessionPurgeOptions {
  /** Interval between purge runs, in ms. */
  intervalMs: number;
  /** Minimum idle age in ms (based on `updatedAt`) before a session is eligible for purge. */
  maxAgeMs: number;
  /** Session sources that must never be purged (defaults to `["chat"]`). */
  excludeSources?: string[];
  /** Whether to run one purge immediately on start (defaults to `true`). */
  executeImmediately?: boolean;
}

/**
 * Builds the purge callback that runs on each timer tick.
 *
 * @param store - The session store to purge
 * @param opts - Purge options
 * @returns A callback that purges stale sessions and logs the result
 */
function execSessionPurgeCb(store: SessionStorePort, opts: SessionPurgeOptions): () => void {
  return () => {
    try {
      const purged = store.purgeStaleSessions({
        olderThanMs: opts.maxAgeMs,
        ...(opts.excludeSources ? { excludeSources: opts.excludeSources } : {}),
      });
      if (purged > 0) {
        sessionLogger.info(`Purged ${purged} stale session(s)`);
      }
    } catch (err) {
      sessionLogger.warn("Session purge failed:", err);
    }
  };
}

/**
 * Start a periodic timer that purges stale, non-interactive sessions.
 *
 * Only sessions idle for at least `maxAgeMs` and whose `source` is not in
 * `excludeSources` (default `["chat"]`) are removed. Chat sessions are
 * preserved because the server cannot tell whether the browser still holds the
 * conversation; those are deleted only via explicit user action.
 *
 * Replaces any previously started timer. The timer is unref'd so it never keeps
 * the process alive on its own.
 *
 * @param store - The session store to purge
 * @param opts - Purge options
 */
export function startSessionPurgeTimer(store: SessionStorePort, opts: SessionPurgeOptions): void {
  stopSessionPurgeTimer();
  _sessionPurgeTimer = setInterval(execSessionPurgeCb(store, opts), opts.intervalMs);
  _sessionPurgeTimer.unref();
  sessionLogger.debug(`Session purge timer started (interval: ${Math.round(opts.intervalMs / 60_000)}min)`);

  if (opts.executeImmediately ?? true) {
    execSessionPurgeCb(store, opts)();
  }
}

/**
 * Stop the periodic session purge timer, if running.
 */
export function stopSessionPurgeTimer(): void {
  if (_sessionPurgeTimer) {
    clearInterval(_sessionPurgeTimer);
    _sessionPurgeTimer = null;
  }
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
