/**
 * SQLite-backed session store.
 *
 * Provides CRUD operations for conversation sessions and their messages.
 * Messages are stored as opaque JSON blobs matching pi-agent-core's
 * {@link AgentMessage} format, with a lightweight `type` tag for
 * filtering without parsing.
 *
 * @module
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import * as schema from "@src/db/schema";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import createLogger from "logging";
import { nanoid } from "nanoid";
import type {
  CreateSessionOptions,
  GetMessagesOptions,
  GetOrCreateSessionOptions,
  ListSessionsOptions,
  Session,
  SessionData,
  SessionStorePort,
} from "./types";

const logger = createLogger("SessionStore");

/**
 * Derives a lightweight type tag from an {@link AgentMessage}'s content.
 *
 * - `"text"` - plain string content or a single text block
 * - `"mixed"` - content array containing tool_use blocks alongside text
 * - `"tool_result"` - role is "tool" or content contains tool_result blocks
 * - `"thinking"` - content contains thinking blocks
 *
 * @param msg - The agent message to classify
 * @returns The type tag string
 */
function deriveTypeTag(msg: AgentMessage): string {
  if (msg.role === "toolResult") return "tool_result";
  if (msg.role === "push") return "push";

  const content = msg.content;
  if (typeof content === "string") return "text";
  if (!Array.isArray(content)) return "text";

  const hasToolUse = content.some((b: { type: string }) => b.type === "tool_use");
  const hasToolResult = content.some((b: { type: string }) => b.type === "tool_result");
  const hasThinking = content.some((b: { type: string }) => b.type === "thinking");

  if (hasToolResult) return "tool_result";
  if (hasThinking) return "thinking";
  if (hasToolUse) return "mixed";
  return "text";
}

/**
 * Converts a database row from the sessions table into a {@link SessionData} object.
 *
 * @param row - Raw row from the sessions table
 * @returns Parsed SessionData object
 */
function rowToSession(row: typeof schema.sessions.$inferSelect): SessionData {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      logger.warn(`Failed to parse metadata for session ${row.id}`);
    }
  }
  return {
    id: row.id,
    source: row.source,
    sourceId: row.sourceId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    metadata,
    totalInputTokens: row.totalInputTokens,
    totalOutputTokens: row.totalOutputTokens,
    totalCacheReadTokens: row.totalCacheReadTokens,
    totalCacheWriteTokens: row.totalCacheWriteTokens,
    totalTokens: row.totalTokens,
    lastInputTokens: row.lastInputTokens,
  };
}

/**
 * Converts a database row from the session_messages table back into
 * an {@link AgentMessage}.
 *
 * For toolResult messages, restores `toolCallId` and `toolName` from
 * their dedicated columns so that the LLM message transformer can
 * correctly match tool results to their originating tool calls.
 *
 * @param row - Raw row from the session_messages table
 * @returns Reconstructed AgentMessage
 */
function rowToAgentMessage(row: typeof schema.sessionMessages.$inferSelect): AgentMessage {
  let content: AgentMessage["content"];
  try {
    content = JSON.parse(row.content);
  } catch {
    content = row.content;
  }

  // Restore toolResult-specific fields from dedicated columns
  if (row.role === "toolResult" && row.toolCallId) {
    return {
      role: row.role,
      toolCallId: row.toolCallId,
      toolName: row.toolName ?? "",
      content,
      timestamp: row.timestamp,
    } as unknown as AgentMessage;
  }

  // Restore assistant-specific fields (api, provider, model) from the usage JSON
  if (row.role === "assistant" && row.usage) {
    try {
      const meta = JSON.parse(row.usage) as Record<string, unknown>;
      return {
        role: row.role,
        content,
        timestamp: row.timestamp,
        api: meta._api,
        provider: meta._provider,
        model: meta._model,
        stopReason: meta._stopReason,
        usage: meta._api ? omitMetaFields(meta) : meta,
      } as unknown as AgentMessage;
    } catch {
      // Fall through to default
    }
  }

  return {
    role: row.role,
    content,
    timestamp: row.timestamp,
  } as unknown as AgentMessage;
}

/** Strips internal `_`-prefixed metadata fields from the usage object. */
function omitMetaFields(meta: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (!key.startsWith("_")) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * SQLite-backed implementation of {@link SessionStorePort}.
 *
 * All operations are synchronous (Bun's SQLite driver is sync) and
 * use the shared Drizzle database instance.
 */
export class SessionStore implements SessionStorePort {
  private readonly db: BunSQLiteDatabase<typeof schema>;

  /**
   * @param db - The shared Drizzle database instance
   */
  constructor(db: BunSQLiteDatabase<typeof schema>) {
    this.db = db;
  }

  /**
   * Wraps a plain {@link SessionData} object into a {@link Session}
   * with bound operations that delegate back to this store.
   *
   * @param data - The plain session data
   * @returns A session with bound `append`, `getMessages`, `replaceMessages`, `delete`
   */
  private toHandle(data: SessionData): Session {
    return Object.assign({}, data, {
      append: (msg: AgentMessage) => this.append(data.id, msg),
      getMessages: (opts?: GetMessagesOptions) => this.getMessages(data.id, opts),
      replaceMessages: (msgs: AgentMessage[]) => this.replaceMessages(data.id, msgs),
      delete: () => this.delete(data.id),
    });
  }

  /**
   * Create a new session with a server-generated nanoid.
   *
   * @param opts - Session creation options
   * @returns The created session handle
   */
  create(opts: CreateSessionOptions): Session {
    const now = Date.now();
    const id = nanoid();
    const metadataJson = opts.metadata ? JSON.stringify(opts.metadata) : null;

    this.db
      .insert(schema.sessions)
      .values({
        id,
        source: opts.source,
        sourceId: opts.sourceId ?? null,
        createdAt: now,
        updatedAt: now,
        metadata: metadataJson,
      })
      .run();

    logger.debug(`Created session ${id} (source: ${opts.source}, sourceId: ${opts.sourceId ?? "none"})`);

    return this.toHandle({
      id,
      source: opts.source,
      sourceId: opts.sourceId ?? null,
      createdAt: now,
      updatedAt: now,
      metadata: opts.metadata ?? null,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalTokens: 0,
      lastInputTokens: 0,
    });
  }

  /**
   * Retrieve a session by its opaque ID.
   *
   * @param sessionId - The session ID
   * @returns The session handle, or `undefined` if not found
   */
  get(sessionId: string): Session | undefined {
    const row = this.db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get();
    return row ? this.toHandle(rowToSession(row)) : undefined;
  }

  /**
   * Find a session by source + source-specific ID.
   *
   * @param source - The origin identifier
   * @param sourceId - The caller's own identifier
   * @returns The session handle, or `undefined` if not found
   */
  findBySource(source: string, sourceId: string): Session | undefined {
    const row = this.db
      .select()
      .from(schema.sessions)
      .where(and(eq(schema.sessions.source, source), eq(schema.sessions.sourceId, sourceId)))
      .get();
    return row ? this.toHandle(rowToSession(row)) : undefined;
  }

  /**
   * Atomically find an existing session by (source, sourceId) or create one.
   *
   * Uses INSERT OR IGNORE + SELECT to avoid race conditions.
   *
   * @param opts - Lookup/creation options
   * @returns The existing or newly created session handle
   */
  getOrCreate(opts: GetOrCreateSessionOptions): Session {
    const existing = this.findBySource(opts.source, opts.sourceId);
    if (existing) return existing;

    try {
      return this.create({ source: opts.source, sourceId: opts.sourceId, metadata: opts.metadata });
    } catch (err) {
      // Handle race condition: another caller created it between our check and insert
      const raced = this.findBySource(opts.source, opts.sourceId);
      if (raced) return raced;
      throw err;
    }
  }

  /**
   * Delete a session and all its messages.
   *
   * @param sessionId - The session ID to delete
   */
  delete(sessionId: string): void {
    this.db.transaction((tx) => {
      tx.delete(schema.sessionMessages).where(eq(schema.sessionMessages.sessionId, sessionId)).run();
      tx.delete(schema.sessions).where(eq(schema.sessions.id, sessionId)).run();
    });
    logger.debug(`Deleted session ${sessionId}`);
  }

  /**
   * List sessions, optionally filtered by source.
   *
   * @param opts - Filter and pagination options
   * @returns Array of session handles ordered by updatedAt descending
   */
  list(opts?: ListSessionsOptions): Session[] {
    let query = this.db.select().from(schema.sessions).orderBy(desc(schema.sessions.updatedAt)).$dynamic();

    if (opts?.source) {
      query = query.where(eq(schema.sessions.source, opts.source));
    }
    if (opts?.limit) {
      query = query.limit(opts.limit);
    }
    if (opts?.offset) {
      query = query.offset(opts.offset);
    }

    return query.all().map((row) => this.toHandle(rowToSession(row)));
  }

  /**
   * Append a message to a session.
   *
   * Automatically assigns the next `seq` value and derives the `type`
   * tag from the message content. Updates the session's `updated_at`.
   * For toolResult messages, persists `toolCallId` and `toolName` in
   * dedicated columns.
   * For assistant messages, persists `usage` as JSON and updates the
   * session's running token totals.
   *
   * @param sessionId - The session to append to
   * @param msg - The agent message to append
   */
  append(sessionId: string, msg: AgentMessage): void {
    this.db.transaction((tx) => {
      const result = tx
        .select({ maxSeq: sql<number>`COALESCE(MAX(${schema.sessionMessages.seq}), 0)` })
        .from(schema.sessionMessages)
        .where(eq(schema.sessionMessages.sessionId, sessionId))
        .get();
      const nextSeq = (result?.maxSeq ?? 0) + 1;

      const contentJson = JSON.stringify(msg.content);
      const typeTag = deriveTypeTag(msg);

      // Extract toolCallId and toolName for toolResult messages
      const toolCallId = msg.role === "toolResult" ? (msg as unknown as { toolCallId: string }).toolCallId : null;
      const toolName = msg.role === "toolResult" ? (msg as unknown as { toolName: string }).toolName : null;

      // Extract usage for assistant messages
      const usage = msg.role === "assistant" ? ((msg as unknown as { usage?: unknown }).usage ?? null) : null;
      // Also persist model identity fields needed for correct LLM serialization (thinking blocks, tool signatures)
      const assistantMeta =
        msg.role === "assistant"
          ? {
              ...(usage ? (usage as object) : {}),
              _api: (msg as unknown as { api?: string }).api,
              _provider: (msg as unknown as { provider?: string }).provider,
              _model: (msg as unknown as { model?: string }).model,
              _stopReason: (msg as unknown as { stopReason?: string }).stopReason,
            }
          : null;
      const usageJson = assistantMeta ? JSON.stringify(assistantMeta) : null;

      tx.insert(schema.sessionMessages)
        .values({
          sessionId,
          role: msg.role,
          content: contentJson,
          type: typeTag,
          timestamp: msg.timestamp ?? Date.now(),
          seq: nextSeq,
          toolCallId,
          toolName,
          usage: usageJson,
        })
        .run();

      // Update session timestamp and token totals for assistant messages
      if (msg.role === "assistant" && usage) {
        const u = usage as {
          input?: number;
          output?: number;
          cacheRead?: number;
          cacheWrite?: number;
          totalTokens?: number;
        };
        tx.update(schema.sessions)
          .set({
            updatedAt: Date.now(),
            totalInputTokens: sql`${schema.sessions.totalInputTokens} + ${u.input ?? 0}`,
            totalOutputTokens: sql`${schema.sessions.totalOutputTokens} + ${u.output ?? 0}`,
            totalCacheReadTokens: sql`${schema.sessions.totalCacheReadTokens} + ${u.cacheRead ?? 0}`,
            totalCacheWriteTokens: sql`${schema.sessions.totalCacheWriteTokens} + ${u.cacheWrite ?? 0}`,
            totalTokens: sql`${schema.sessions.totalTokens} + ${u.totalTokens ?? 0}`,
            lastInputTokens: u.input ?? 0,
          })
          .where(eq(schema.sessions.id, sessionId))
          .run();
      } else {
        tx.update(schema.sessions).set({ updatedAt: Date.now() }).where(eq(schema.sessions.id, sessionId)).run();
      }
    });
  }

  /**
   * Retrieve messages for a session, ordered by seq ascending.
   *
   * When `limit` is provided without `offset`, returns the most recent
   * N messages (still ordered ascending).
   *
   * @param sessionId - The session to read from
   * @param opts - Pagination options
   * @returns Array of AgentMessages in sequence order
   */
  getMessages(sessionId: string, opts?: GetMessagesOptions): AgentMessage[] {
    if (opts?.limit && !opts.offset) {
      // Get the N most recent messages, but return them in ascending order
      const rows = this.db
        .select()
        .from(schema.sessionMessages)
        .where(eq(schema.sessionMessages.sessionId, sessionId))
        .orderBy(desc(schema.sessionMessages.seq))
        .limit(opts.limit)
        .all();
      return rows.reverse().map(rowToAgentMessage);
    }

    let query = this.db
      .select()
      .from(schema.sessionMessages)
      .where(eq(schema.sessionMessages.sessionId, sessionId))
      .orderBy(asc(schema.sessionMessages.seq))
      .$dynamic();

    if (opts?.limit) {
      query = query.limit(opts.limit);
    }
    if (opts?.offset) {
      query = query.offset(opts.offset);
    }

    return query.all().map(rowToAgentMessage);
  }

  /**
   * Atomically replace all messages in a session.
   *
   * Deletes existing messages and inserts the provided ones with
   * fresh sequential `seq` values. Updates `updated_at` and recomputes
   * running token totals from the new message set.
   *
   * @param sessionId - The session to replace messages in
   * @param msgs - The new message array
   */
  replaceMessages(sessionId: string, msgs: AgentMessage[]): void {
    this.db.transaction((tx) => {
      tx.delete(schema.sessionMessages).where(eq(schema.sessionMessages.sessionId, sessionId)).run();

      // Accumulate token totals from assistant messages
      let totalInput = 0;
      let totalOutput = 0;
      let totalCacheRead = 0;
      let totalCacheWrite = 0;
      let totalTokens = 0;
      let lastInput = 0;

      if (msgs.length > 0) {
        const rows = msgs.map((msg, i) => {
          const usage = msg.role === "assistant" ? ((msg as unknown as { usage?: unknown }).usage ?? null) : null;
          const usageJson = usage ? JSON.stringify(usage) : null;

          if (msg.role === "assistant" && usage) {
            const u = usage as {
              input?: number;
              output?: number;
              cacheRead?: number;
              cacheWrite?: number;
              totalTokens?: number;
            };
            totalInput += u.input ?? 0;
            totalOutput += u.output ?? 0;
            totalCacheRead += u.cacheRead ?? 0;
            totalCacheWrite += u.cacheWrite ?? 0;
            totalTokens += u.totalTokens ?? 0;
            lastInput = u.input ?? 0;
          }

          return {
            sessionId,
            role: msg.role,
            content: JSON.stringify(msg.content),
            type: deriveTypeTag(msg),
            timestamp: msg.timestamp ?? Date.now(),
            seq: i + 1,
            toolCallId: msg.role === "toolResult" ? (msg as unknown as { toolCallId: string }).toolCallId : null,
            toolName: msg.role === "toolResult" ? (msg as unknown as { toolName: string }).toolName : null,
            usage: usageJson,
          };
        });

        tx.insert(schema.sessionMessages).values(rows).run();
      }

      tx.update(schema.sessions)
        .set({
          updatedAt: Date.now(),
          totalInputTokens: totalInput,
          totalOutputTokens: totalOutput,
          totalCacheReadTokens: totalCacheRead,
          totalCacheWriteTokens: totalCacheWrite,
          totalTokens,
          lastInputTokens: lastInput,
        })
        .where(eq(schema.sessions.id, sessionId))
        .run();
    });

    logger.debug(`Replaced messages in session ${sessionId} (${msgs.length} messages)`);
  }
}
