/**
 * MCP extension database schema.
 *
 * Defines the `ext_mcp_servers` table for persisting MCP server
 * configurations, connection state, and tool introspection hashes.
 */

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * MCP server configurations.
 *
 * Each row represents a configured MCP server that can be connected to
 * for tool discovery and execution. Generated skills are derived from
 * the tool list retrieved via introspection.
 */
export const mcpServers = sqliteTable("ext_mcp_servers", {
  /** Server identifier (lowercase alphanumeric + hyphens). */
  name: text("name").primaryKey(),
  /** Transport type: "stdio", "streamable-http", or "sse". */
  type: text("type").notNull(),
  /** JSON-encoded transport config (command/args/env/cwd for stdio, url/headers for http/sse). */
  config: text("config").notNull(),
  /** Whether this server is active (skills generated + callable). */
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /** SHA-512 hash of the canonical sorted tool list JSON. Null if never synced. */
  toolsHash: text("tools_hash"),
  /** Epoch timestamp (ms) of last successful introspection. */
  lastSyncedAt: integer("last_synced_at"),
  /** Last connection or sync error message. Null if last attempt succeeded. */
  lastError: text("last_error"),
  /** Creation timestamp (epoch ms). */
  createdAt: integer("created_at").notNull(),
});
