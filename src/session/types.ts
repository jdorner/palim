/**
 * Session system type definitions.
 *
 * @module
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";

/** Plain data shape of a conversation session (no behavior). */
export interface SessionData {
  /** Opaque server-generated identifier (nanoid). */
  id: string;
  /** Origin identifier (e.g. "chat", "telegram", "scheduler"). */
  source: string;
  /** Caller's own identifier for the session (e.g. frontend conversation UUID, Telegram chat ID). */
  sourceId: string | null;
  /** Epoch timestamp (ms) when the session was created. */
  createdAt: number;
  /** Epoch timestamp (ms) of the last modification. */
  updatedAt: number;
  /** Optional parsed metadata object. */
  metadata: Record<string, unknown> | null;
  /** Running total: sum of input tokens across all assistant messages. */
  totalInputTokens: number;
  /** Running total: sum of output tokens across all assistant messages. */
  totalOutputTokens: number;
  /** Running total: sum of cache-read tokens across all assistant messages. */
  totalCacheReadTokens: number;
  /** Running total: sum of cache-write tokens across all assistant messages. */
  totalCacheWriteTokens: number;
  /** Running total: sum of totalTokens across all assistant messages. */
  totalTokens: number;
  /** The input token count from the most recent assistant message (approximates current context size). */
  lastInputTokens: number;
}

/**
 * A session with bound operations - the primary handle extensions interact with.
 * Returned by `create`, `get`, `getOrCreate` on the session store.
 */
export interface Session extends SessionData {
  /** Append a message to this session. */
  append(msg: AgentMessage): void;
  /** Retrieve messages for this session, ordered by seq ascending. */
  getMessages(opts?: GetMessagesOptions): AgentMessage[];
  /** Atomically replace all messages in this session. */
  replaceMessages(msgs: AgentMessage[]): void;
  /** Delete this session and all its messages. */
  delete(): void;
}

/** Options for creating a new session. */
export interface CreateSessionOptions {
  /** Origin identifier (e.g. "chat", "telegram", "scheduler"). */
  source: string;
  /** Caller's own identifier for the session. */
  sourceId?: string;
  /** Optional metadata to attach to the session. */
  metadata?: Record<string, unknown>;
}

/** Options for the atomic get-or-create operation. */
export interface GetOrCreateSessionOptions {
  /** Origin identifier. */
  source: string;
  /** Caller's own identifier - required for lookup. */
  sourceId: string;
  /** Optional metadata used only when creating a new session. */
  metadata?: Record<string, unknown>;
}

/** Options for listing sessions. */
export interface ListSessionsOptions {
  /** Filter by source. */
  source?: string;
  /** Maximum number of sessions to return. */
  limit?: number;
  /** Number of sessions to skip. */
  offset?: number;
}

/** Options for retrieving session messages. */
export interface GetMessagesOptions {
  /** Maximum number of messages to return. */
  limit?: number;
  /** Number of messages to skip. */
  offset?: number;
}

/**
 * Contract for the session store.
 *
 * Provides CRUD operations for sessions and their messages.
 * All message content is stored as opaque JSON blobs matching
 * pi-agent-core's {@link AgentMessage} format.
 */
export interface SessionStorePort {
  /** Create a new session with a server-generated ID. */
  create(opts: CreateSessionOptions): Session;
  /** Retrieve a session by its opaque ID. Returns `undefined` if not found. */
  get(sessionId: string): Session | undefined;
  /** Find a session by source + source-specific ID. Returns `undefined` if not found. */
  findBySource(source: string, sourceId: string): Session | undefined;
  /** Atomically find an existing session or create a new one. */
  getOrCreate(opts: GetOrCreateSessionOptions): Session;
  /** Delete a session and all its messages. */
  delete(sessionId: string): void;
  /** List sessions, optionally filtered by source. */
  list(opts?: ListSessionsOptions): Session[];
  /** Append a message to a session by ID. */
  append(sessionId: string, msg: AgentMessage): void;
  /** Retrieve messages for a session, ordered by seq ascending. */
  getMessages(sessionId: string, opts?: GetMessagesOptions): AgentMessage[];
  /** Atomically replace all messages in a session. */
  replaceMessages(sessionId: string, msgs: AgentMessage[]): void;
}
