/**
 * Drizzle ORM schema definitions.
 *
 * Core application tables are defined here. Extension-owned tables
 * live in their respective extension directories (e.g.
 * `src/extensions/core/filewatcher/schema.ts`).
 *
 * @module
 */

import { index, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

/**
 * Persistent job log entries.
 *
 * bunqueue keeps logs only in an in-memory LRUMap - this table persists
 * them so they survive server restarts.
 */
export const jobLogs = sqliteTable(
  "job_logs",
  {
    /** The job this log belongs to. */
    jobId: text("job_id").notNull(),
    /** Sequence number (monotonically increasing per job). */
    seq: integer("seq").notNull(),
    /** Log message text. */
    message: text("message").notNull(),
    /** Epoch timestamp (ms) when the log was written. */
    ts: integer("ts").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.jobId, table.seq] })],
);

/**
 * Extension settings.
 *
 * Stores per-extension enabled/disabled state and optional JSON
 * configuration. Extensions not present in this table are treated
 * as enabled by default.
 */
export const extensionSettings = sqliteTable("extension_settings", {
  /** Extension manifest name (e.g. "telegram", "webhooks"). */
  name: text("name").primaryKey(),
  /** Whether the extension is visible to the agent (tools, skills, shell). */
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /** Optional JSON-encoded per-extension configuration (reserved for future use). */
  config: text("config"),
  /** Last update timestamp (epoch ms). */
  updatedAt: integer("updated_at").notNull(),
});

/**
 * Application-level configuration.
 *
 * Generic key/value store for settings that apply globally
 * (e.g. selected LLM model, default thinking level).
 */
export const appConfig = sqliteTable("app_config", {
  /** Configuration key (e.g. "selected_model"). */
  key: text("key").primaryKey(),
  /** JSON-encoded or plain-text value. */
  value: text("value").notNull(),
  /** Last update timestamp (epoch ms). */
  updatedAt: integer("updated_at").notNull(),
});

/**
 * Conversation sessions.
 *
 * Each session represents a conversation context (e.g. a frontend chat,
 * a Telegram thread, a scheduled agent run). Sessions are created
 * explicitly, identified by an opaque server-generated ID, and live
 * until explicitly deleted or pruned.
 */
export const sessions = sqliteTable(
  "sessions",
  {
    /** Opaque server-generated identifier (nanoid). */
    id: text("id").primaryKey(),
    /** Origin identifier (e.g. "chat", "telegram", "scheduler"). */
    source: text("source").notNull(),
    /** Caller's own identifier for the session (e.g. frontend conversation UUID, Telegram chat ID). */
    sourceId: text("source_id"),
    /** Epoch timestamp (ms) when the session was created. */
    createdAt: integer("created_at").notNull(),
    /** Epoch timestamp (ms) of the last modification. */
    updatedAt: integer("updated_at").notNull(),
    /** Optional JSON-encoded metadata. */
    metadata: text("metadata"),
    /** Running total: sum of input tokens across all assistant messages. */
    totalInputTokens: integer("total_input_tokens").notNull().default(0),
    /** Running total: sum of output tokens across all assistant messages. */
    totalOutputTokens: integer("total_output_tokens").notNull().default(0),
    /** Running total: sum of cache-read tokens across all assistant messages. */
    totalCacheReadTokens: integer("total_cache_read_tokens").notNull().default(0),
    /** Running total: sum of cache-write tokens across all assistant messages. */
    totalCacheWriteTokens: integer("total_cache_write_tokens").notNull().default(0),
    /** Running total: sum of totalTokens across all assistant messages. */
    totalTokens: integer("total_tokens").notNull().default(0),
    /** The input token count from the most recent assistant message (approximates current context size). */
    lastInputTokens: integer("last_input_tokens").notNull().default(0),
  },
  (table) => [unique("uq_sessions_source").on(table.source, table.sourceId)],
);

/**
 * Messages belonging to a conversation session.
 *
 * Each row stores a single {@link AgentMessage} as a JSON blob in the
 * `content` column. The `type` column provides a lightweight tag for
 * filtering without parsing the JSON (e.g. "text", "mixed", "tool_result").
 */
export const sessionMessages = sqliteTable(
  "session_messages",
  {
    /** Auto-incrementing primary key. */
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Foreign key referencing {@link sessions}.id. */
    sessionId: text("session_id").notNull(),
    /** Message role ("user", "assistant", "tool"). */
    role: text("role").notNull(),
    /** JSON-encoded message content (string for user, ContentBlock[] for assistant/tool). */
    content: text("content").notNull(),
    /** Lightweight tag for filtering: "text", "mixed", "tool_result", "thinking". */
    type: text("type").notNull().default("text"),
    /** Epoch timestamp (ms) when the message was produced. */
    timestamp: integer("timestamp").notNull(),
    /** Monotonically increasing sequence number within the session. */
    seq: integer("seq").notNull(),
    /** Tool call ID (only for toolResult messages, correlates with assistant tool_call). */
    toolCallId: text("tool_call_id"),
    /** Tool name (only for toolResult messages). */
    toolName: text("tool_name"),
    /** JSON-encoded token usage data (only for assistant messages). */
    usage: text("usage"),
  },
  (table) => [index("idx_session_messages_session_seq").on(table.sessionId, table.seq)],
);

export { fileWatchers as extFilewatcherWatchers } from "@src/extensions/core/filewatcher/schema";
export { webhooks as extWebhooksRegistrations } from "@src/extensions/core/webhooks/schema";
//export { extInstallerRegistry } from "@src/extensions/ext-installer/schema";
//export { toolUsage as extIntrospectionToolUsage } from "@src/extensions/introspection/schema";
export { mcpServers as extMcpServers } from "@src/extensions/mcp/schema";
// Re-export extension-owned tables so drizzle-kit sees the complete schema.
export { secretAuditLog } from "@src/secrets/audit";
export { secretsVault } from "@src/secrets/vaultSchema";
