/**
 * MCP Client Manager - maintains a pool of MCP client connections.
 *
 * - stdio transports: kept alive for the runtime, reconnect on failure
 * - streamable-http / sse: connect per call (stateless)
 *
 * Provides `listTools()` and `callTool()` methods that auto-connect
 * to the target server if not already connected.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Logger } from "logging";
import type {
  McpCallToolResult,
  McpServerDefinition,
  McpToolDefinition,
  SseConfig,
  StdioConfig,
  StreamableHttpConfig,
} from "./types";

/** Connection timeout for boot-time introspection (ms). */
const CONNECT_TIMEOUT_MS = 5_000;

/** Tracks the state of a single MCP server connection. */
interface ConnectionEntry {
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
  connected: boolean;
}

/** Public interface for the MCP client manager. */
export interface McpClientManager {
  /** Connect to a server and list its tools. Auto-connects if needed. */
  listTools(server: McpServerDefinition): Promise<McpToolDefinition[]>;

  /** Call a tool on an MCP server. Auto-connects if needed. */
  callTool(server: McpServerDefinition, toolName: string, args: Record<string, unknown>): Promise<McpCallToolResult>;

  /** Disconnect a specific server (for cleanup or reconnect). */
  disconnect(serverName: string): Promise<void>;

  /** Shutdown all connections and release resources. */
  shutdown(): Promise<void>;
}

/**
 * Creates a new {@link McpClientManager} instance.
 *
 * @param logger - Logger for connection events
 * @returns A client manager ready to manage MCP connections
 */
export function createClientManager(logger: Logger): McpClientManager {
  const connections = new Map<string, ConnectionEntry>();

  /**
   * Ensures a connection exists for the given server. For stdio transports,
   * reuses an existing connection if alive. Creates a new one otherwise.
   */
  async function ensureConnected(server: McpServerDefinition): Promise<Client> {
    const existing = connections.get(server.name);
    if (existing?.connected) {
      return existing.client;
    }

    // Clean up any stale entry
    if (existing) {
      await safeClose(existing, server.name);
      connections.delete(server.name);
    }

    if (server.type === "stdio") {
      return connectStdio(server);
    }

    if (server.type === "streamable-http") {
      return connectStreamableHttp(server);
    }

    if (server.type === "sse") {
      return connectSse(server);
    }

    throw new Error(`Transport type "${server.type}" is not supported`);
  }

  /**
   * Connects to a stdio MCP server by spawning the child process.
   */
  async function connectStdio(server: McpServerDefinition): Promise<Client> {
    const config = server.config as StdioConfig;

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd ?? undefined,
      stderr: "pipe",
    });

    const client = new Client({
      name: "pi-agent-mcp",
      version: "1.0.0",
    });

    // Set up connection timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Connection timeout (${CONNECT_TIMEOUT_MS}ms)`)), CONNECT_TIMEOUT_MS);
    });

    try {
      await Promise.race([client.connect(transport), timeoutPromise]);
    } catch (err) {
      // Clean up on failure
      try {
        await transport.close();
      } catch {
        // Ignore close errors
      }
      throw err;
    }

    const entry: ConnectionEntry = { client, transport, connected: true };

    // Track disconnection
    transport.onclose = () => {
      entry.connected = false;
      logger.warn(`MCP server "${server.name}" disconnected`);
    };

    transport.onerror = (error) => {
      logger.error(`MCP server "${server.name}" transport error:`, error.message);
      entry.connected = false;
    };

    connections.set(server.name, entry);
    logger.debug(`Connected to MCP server "${server.name}" (stdio, pid: ${transport.pid})`);

    return client;
  }

  /**
   * Connects to a Streamable HTTP MCP server.
   */
  async function connectStreamableHttp(server: McpServerDefinition): Promise<Client> {
    const config = server.config as StreamableHttpConfig;

    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: config.headers ? { headers: config.headers } : undefined,
    });

    const client = new Client({
      name: "pi-agent-mcp",
      version: "1.0.0",
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Connection timeout (${CONNECT_TIMEOUT_MS}ms)`)), CONNECT_TIMEOUT_MS);
    });

    try {
      await Promise.race([client.connect(transport), timeoutPromise]);
    } catch (err) {
      try {
        await transport.close();
      } catch {
        // Ignore close errors
      }
      throw err;
    }

    const entry: ConnectionEntry = { client, transport, connected: true };
    connections.set(server.name, entry);
    logger.debug(`Connected to MCP server "${server.name}" (streamable-http)`);

    return client;
  }

  /**
   * Connects to an SSE MCP server.
   */
  async function connectSse(server: McpServerDefinition): Promise<Client> {
    const config = server.config as SseConfig;

    const transport = new SSEClientTransport(new URL(config.url), {
      requestInit: config.headers ? { headers: config.headers } : undefined,
    });

    const client = new Client({
      name: "pi-agent-mcp",
      version: "1.0.0",
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Connection timeout (${CONNECT_TIMEOUT_MS}ms)`)), CONNECT_TIMEOUT_MS);
    });

    try {
      await Promise.race([client.connect(transport), timeoutPromise]);
    } catch (err) {
      try {
        await transport.close();
      } catch {
        // Ignore close errors
      }
      throw err;
    }

    const entry: ConnectionEntry = { client, transport, connected: true };
    connections.set(server.name, entry);
    logger.debug(`Connected to MCP server "${server.name}" (sse)`);

    return client;
  }

  /**
   * Safely closes a connection entry, suppressing errors.
   */
  async function safeClose(entry: ConnectionEntry, name: string): Promise<void> {
    try {
      await entry.client.close();
    } catch (err) {
      logger.debug(`Error closing client for "${name}": ${err}`);
    }
    try {
      await entry.transport.close();
    } catch (err) {
      logger.debug(`Error closing transport for "${name}": ${err}`);
    }
    entry.connected = false;
  }

  return {
    async listTools(server: McpServerDefinition): Promise<McpToolDefinition[]> {
      const client = await ensureConnected(server);
      const result = await client.listTools();

      return result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>,
      }));
    },

    async callTool(
      server: McpServerDefinition,
      toolName: string,
      args: Record<string, unknown>,
    ): Promise<McpCallToolResult> {
      let client: Client;

      try {
        client = await ensureConnected(server);
      } catch (err) {
        // If reconnection fails, propagate the error
        throw new Error(
          `Failed to connect to MCP server "${server.name}": ${err instanceof Error ? err.message : err}`,
        );
      }

      try {
        const result = await client.callTool({ name: toolName, arguments: args });
        return {
          content: (result.content ?? []) as McpCallToolResult["content"],
          isError: result.isError === true,
        };
      } catch (err) {
        // On call failure, try reconnecting once (handles stale connections)
        const entry = connections.get(server.name);
        if (entry) {
          logger.warn(`Tool call failed on "${server.name}", attempting reconnect...`);
          await safeClose(entry, server.name);
          connections.delete(server.name);

          // Retry once with a fresh connection
          client = await ensureConnected(server);
          const result = await client.callTool({ name: toolName, arguments: args });
          return {
            content: (result.content ?? []) as McpCallToolResult["content"],
            isError: result.isError === true,
          };
        }
        throw err;
      }
    },

    async disconnect(serverName: string): Promise<void> {
      const entry = connections.get(serverName);
      if (entry) {
        await safeClose(entry, serverName);
        connections.delete(serverName);
        logger.debug(`Disconnected from MCP server "${serverName}"`);
      }
    },

    async shutdown(): Promise<void> {
      const names = [...connections.keys()];
      for (const name of names) {
        const entry = connections.get(name);
        if (entry) {
          await safeClose(entry, name);
        }
      }
      connections.clear();
      if (names.length > 0) {
        logger.info(`Closed ${names.length} MCP connection(s)`);
      }
    },
  };
}
