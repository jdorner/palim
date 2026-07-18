/**
 * MCP extension type definitions and validation schemas.
 *
 * Defines TypeBox schemas for server configuration validation and
 * TypeScript types for internal use.
 */

import { type Static, Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Server configuration schemas
// ---------------------------------------------------------------------------

/** Schema for stdio transport configuration. */
export const StdioConfigSchema = Type.Object({
  command: Type.String({ minLength: 1, description: "Executable path or command name" }),
  args: Type.Optional(Type.Array(Type.String(), { description: "Command-line arguments" })),
  env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Environment variables" })),
  cwd: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Working directory" })),
});

/** Schema for Streamable HTTP transport configuration. */
export const StreamableHttpConfigSchema = Type.Object({
  url: Type.String({ minLength: 1, format: "uri", description: "MCP server URL" }),
  headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "HTTP headers" })),
});

/** Schema for SSE transport configuration. */
export const SseConfigSchema = Type.Object({
  url: Type.String({ minLength: 1, format: "uri", description: "SSE endpoint URL" }),
  headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "HTTP headers" })),
});

/** Schema for validating server name format. */
export const ServerNameSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z][a-z0-9-]*$",
  description: "Server name (lowercase alphanumeric + hyphens)",
});

/** Schema for the transport type field. */
export const ServerTypeSchema = Type.Union([
  Type.Literal("stdio"),
  Type.Literal("streamable-http"),
  Type.Literal("sse"),
]);

/** Schema for adding a new MCP server. */
export const AddServerSchema = Type.Object({
  name: ServerNameSchema,
  type: ServerTypeSchema,
  config: Type.Union([StdioConfigSchema, StreamableHttpConfigSchema, SseConfigSchema]),
  enabled: Type.Optional(Type.Boolean({ default: true })),
});

/** Schema for updating an MCP server. */
export const UpdateServerSchema = Type.Object({
  type: Type.Optional(ServerTypeSchema),
  config: Type.Optional(Type.Union([StdioConfigSchema, StreamableHttpConfigSchema, SseConfigSchema])),
  enabled: Type.Optional(Type.Boolean()),
});

/** Schema for the call-tool request body. */
export const CallToolSchema = Type.Object({
  toolName: Type.String({ minLength: 1, description: "Tool name to call" }),
  arguments: Type.Record(Type.String(), Type.Unknown(), { description: "Tool arguments" }),
});

// ---------------------------------------------------------------------------
// TypeScript types
// ---------------------------------------------------------------------------

/** Stdio transport config. */
export type StdioConfig = Static<typeof StdioConfigSchema>;

/** Streamable HTTP transport config. */
export type StreamableHttpConfig = Static<typeof StreamableHttpConfigSchema>;

/** SSE transport config. */
export type SseConfig = Static<typeof SseConfigSchema>;

/** Union of all transport configs. */
export type TransportConfig = StdioConfig | StreamableHttpConfig | SseConfig;

/** Transport type identifier. */
export type ServerType = Static<typeof ServerTypeSchema>;

/** A server row as read from the database. */
export interface McpServerRow {
  name: string;
  type: ServerType;
  config: string;
  enabled: boolean;
  toolsHash: string | null;
  lastSyncedAt: number | null;
  lastError: string | null;
  createdAt: number;
}

/** Parsed server definition with typed config. */
export interface McpServerDefinition {
  name: string;
  type: ServerType;
  config: TransportConfig;
  enabled: boolean;
  toolsHash: string | null;
  lastSyncedAt: number | null;
  lastError: string | null;
}

/** An MCP tool definition as returned by introspection. */
export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** Result of calling an MCP tool. */
export interface McpCallToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError: boolean;
}
