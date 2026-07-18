/**
 * MCP server configuration persistence layer.
 *
 * Provides CRUD operations for MCP server entries in the `ext_mcp_servers`
 * table via Drizzle ORM.
 */

import { eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { mcpServers } from "./schema";
import type { McpServerDefinition, McpServerRow, ServerType, TransportConfig } from "./types";

/**
 * Retrieves all MCP server rows from the database.
 *
 * @param db - Drizzle database instance
 * @returns Array of all server rows
 */
export function getAllServers(db: BunSQLiteDatabase<Record<string, unknown>>): McpServerDefinition[] {
  const rows = db.select().from(mcpServers).all();
  return rows.map((row) => parseServerRow(row as unknown as McpServerRow));
}

/**
 * Retrieves all enabled MCP server definitions.
 *
 * @param db - Drizzle database instance
 * @returns Array of enabled server definitions
 */
export function getEnabledServers(db: BunSQLiteDatabase<Record<string, unknown>>): McpServerDefinition[] {
  const rows = db.select().from(mcpServers).where(eq(mcpServers.enabled, true)).all();
  return rows.map((row) => parseServerRow(row as unknown as McpServerRow));
}

/**
 * Retrieves a single server by name.
 *
 * @param db - Drizzle database instance
 * @param name - Server name
 * @returns The server definition, or null if not found
 */
export function getServer(db: BunSQLiteDatabase<Record<string, unknown>>, name: string): McpServerDefinition | null {
  const row = db.select().from(mcpServers).where(eq(mcpServers.name, name)).get();
  if (!row) return null;
  return parseServerRow(row as unknown as McpServerRow);
}

/**
 * Inserts a new MCP server configuration.
 *
 * @param db - Drizzle database instance
 * @param name - Server name
 * @param type - Transport type
 * @param config - Transport configuration
 * @param enabled - Whether the server is active
 */
export function insertServer(
  db: BunSQLiteDatabase<Record<string, unknown>>,
  name: string,
  type: ServerType,
  config: TransportConfig,
  enabled = true,
): void {
  db.insert(mcpServers)
    .values({
      name,
      type,
      config: JSON.stringify(config),
      enabled,
      createdAt: Date.now(),
    })
    .run();
}

/**
 * Updates an existing MCP server configuration.
 *
 * @param db - Drizzle database instance
 * @param name - Server name to update
 * @param updates - Fields to update
 */
export function updateServer(
  db: BunSQLiteDatabase<Record<string, unknown>>,
  name: string,
  updates: {
    type?: ServerType;
    config?: TransportConfig;
    enabled?: boolean;
    toolsHash?: string | null;
    lastSyncedAt?: number | null;
    lastError?: string | null;
  },
): void {
  const values: Record<string, unknown> = {};

  if (updates.type !== undefined) values.type = updates.type;
  if (updates.config !== undefined) values.config = JSON.stringify(updates.config);
  if (updates.enabled !== undefined) values.enabled = updates.enabled;
  if (updates.toolsHash !== undefined) values.toolsHash = updates.toolsHash;
  if (updates.lastSyncedAt !== undefined) values.lastSyncedAt = updates.lastSyncedAt;
  if (updates.lastError !== undefined) values.lastError = updates.lastError;

  if (Object.keys(values).length > 0) {
    db.update(mcpServers).set(values).where(eq(mcpServers.name, name)).run();
  }
}

/**
 * Deletes an MCP server configuration by name.
 *
 * @param db - Drizzle database instance
 * @param name - Server name to delete
 */
export function deleteServer(db: BunSQLiteDatabase<Record<string, unknown>>, name: string): void {
  db.delete(mcpServers).where(eq(mcpServers.name, name)).run();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parses a raw database row into a typed {@link McpServerDefinition}.
 */
function parseServerRow(row: McpServerRow): McpServerDefinition {
  return {
    name: row.name,
    type: row.type as ServerType,
    config: JSON.parse(row.config) as TransportConfig,
    enabled: row.enabled,
    toolsHash: row.toolsHash,
    lastSyncedAt: row.lastSyncedAt,
    lastError: row.lastError,
  };
}
