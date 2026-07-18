/**
 * MCP extension HTTP routes.
 *
 * Provides REST endpoints for server CRUD, tool listing, tool execution,
 * and manual sync triggers. All routes are auto-prefixed with `/ext/mcp/`.
 */

import type { ExtensionContext } from "@ext/types";
import { Value } from "@sinclair/typebox/value";
import type { McpClientManager } from "./clientManager";
import { deleteServer, getAllServers, getServer, insertServer, updateServer } from "./config";
import { removeSkillDir, syncServer } from "./skillGenerator";
import type { TransportConfig } from "./types";
import { AddServerSchema, CallToolSchema, UpdateServerSchema } from "./types";

/**
 * Registers all HTTP routes for the MCP extension.
 *
 * @param ctx - Extension context for route registration and DB access
 * @param clientManager - The MCP client manager for tool operations
 */
export function registerRoutes(ctx: ExtensionContext, clientManager: McpClientManager): void {
  const db = ctx.getDatabase();

  // GET /ext/mcp/servers - list all configured servers
  ctx.registerRoute("GET", "servers", async () => {
    const servers = getAllServers(db);
    return Response.json({
      servers: servers.map((s) => ({
        name: s.name,
        type: s.type,
        enabled: s.enabled,
        toolsHash: s.toolsHash,
        lastSyncedAt: s.lastSyncedAt,
        lastError: s.lastError,
      })),
    });
  });

  // POST /ext/mcp/servers - add a new server
  ctx.registerRoute("POST", "servers", async (elysiaCtx) => {
    const body = await elysiaCtx.request.json();

    if (!Value.Check(AddServerSchema, body)) {
      const errors = [...Value.Errors(AddServerSchema, body)];
      return new Response(
        JSON.stringify({
          error: "Validation failed",
          details: errors.map((e) => ({ path: e.path, message: e.message })),
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Check for duplicate
    const existing = getServer(db, body.name);
    if (existing) {
      return new Response(JSON.stringify({ error: `Server "${body.name}" already exists` }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }

    insertServer(db, body.name, body.type, body.config as TransportConfig, body.enabled ?? true);
    let created = getServer(db, body.name);
    if (created?.enabled) {
      // Enabled: generate skills from the server
      try {
        await syncServer(ctx, clientManager, created);
        await ctx.skills.rescan();
      } catch (err) {
        ctx.log.error(`Failed to sync MCP server "${created.name}" on creation:`, err);
      }

      created = getServer(db, created.name);
    }

    return new Response(JSON.stringify(created), { status: 201, headers: { "Content-Type": "application/json" } });
  });

  // PUT /ext/mcp/servers/:name - update server config
  ctx.registerRoute("PUT", "servers/:name", async (elysiaCtx) => {
    const name = (elysiaCtx.params as { name: string }).name;
    const body = await elysiaCtx.request.json();

    const existing = getServer(db, name);
    if (!existing) {
      return new Response(JSON.stringify({ error: "Server not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!Value.Check(UpdateServerSchema, body)) {
      const errors = [...Value.Errors(UpdateServerSchema, body)];
      return new Response(
        JSON.stringify({
          error: "Validation failed",
          details: errors.map((e) => ({ path: e.path, message: e.message })),
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    updateServer(db, name, {
      type: body.type,
      config: body.config as TransportConfig | undefined,
      enabled: body.enabled,
    });

    // Handle enable/disable side effects for skill visibility
    if (body.enabled === false && existing.enabled) {
      await clientManager.disconnect(name);
      await removeSkillDir(ctx.dataDir, name);
      // Clear tools_hash so re-enable always regenerates even if tools haven't changed
      updateServer(db, name, { toolsHash: null });
      await ctx.skills.rescan();
    } else if (body.enabled === true && !existing.enabled) {
      // Re-enabled: regenerate skills from the server
      const refreshed = getServer(db, name);
      if (refreshed) {
        try {
          await syncServer(ctx, clientManager, refreshed);
          await ctx.skills.rescan();
        } catch (err) {
          ctx.log.error(`Failed to sync MCP server "${name}" on re-enable:`, err);
        }
      }
    }

    const updated = getServer(db, name);
    return Response.json(updated);
  });

  // DELETE /ext/mcp/servers/:name - remove server + generated skill
  ctx.registerRoute("DELETE", "servers/:name", async (elysiaCtx) => {
    const name = (elysiaCtx.params as { name: string }).name;

    const existing = getServer(db, name);
    if (!existing) {
      return new Response(JSON.stringify({ error: "Server not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Disconnect if connected
    await clientManager.disconnect(name);

    // Delete from DB
    deleteServer(db, name);

    // Remove generated skill directory
    await removeSkillDir(ctx.dataDir, name);

    // Trigger skill rescan
    await ctx.skills.rescan();

    return Response.json({ success: true, deleted: name });
  });

  // GET /ext/mcp/servers/:name/tools - return tool list
  ctx.registerRoute("GET", "servers/:name/tools", async (elysiaCtx) => {
    const name = (elysiaCtx.params as { name: string }).name;

    const server = getServer(db, name);
    if (!server) {
      return new Response(JSON.stringify({ error: "Server not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const tools = await clientManager.listTools(server);
      return Response.json({ server: name, tools });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(JSON.stringify({ error: msg }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }
  });

  // POST /ext/mcp/servers/:name/call - execute a tool
  ctx.registerRoute("POST", "servers/:name/call", async (elysiaCtx) => {
    const name = (elysiaCtx.params as { name: string }).name;
    const body = await elysiaCtx.request.json();

    if (!Value.Check(CallToolSchema, body)) {
      const errors = [...Value.Errors(CallToolSchema, body)];
      return new Response(
        JSON.stringify({
          error: "Validation failed",
          details: errors.map((e) => ({ path: e.path, message: e.message })),
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const server = getServer(db, name);
    if (!server) {
      return new Response(JSON.stringify({ error: "Server not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const result = await clientManager.callTool(server, body.toolName, body.arguments as Record<string, unknown>);
      return Response.json({
        server: name,
        tool: body.toolName,
        content: result.content,
        isError: result.isError,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(JSON.stringify({ server: name, tool: body.toolName, error: msg }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }
  });

  // POST /ext/mcp/import - bulk import from MCP JSON config format
  ctx.registerRoute("POST", "/import", async (elysiaCtx) => {
    const body = (await elysiaCtx.request.json()) as Record<string, unknown>;

    // Support both { mcpServers: { ... } } and { servers: { ... } } formats
    const serversObj = (body.mcpServers ?? body.servers ?? body) as Record<string, unknown>;

    if (!serversObj || typeof serversObj !== "object" || Array.isArray(serversObj)) {
      return new Response(
        JSON.stringify({
          error: "Expected an object with server definitions (e.g. { mcpServers: { name: { command, args } } })",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const results: Array<{ name: string; status: "created" | "skipped" | "error"; reason?: string }> = [];

    for (const [name, rawConfig] of Object.entries(serversObj)) {
      // Validate name format
      if (!/^[a-z][a-z0-9-]*$/.test(name)) {
        results.push({
          name,
          status: "error",
          reason: "Invalid name format (must be lowercase alphanumeric + hyphens)",
        });
        continue;
      }

      // Skip if already exists
      const existing = getServer(db, name);
      if (existing) {
        results.push({ name, status: "skipped", reason: "Already exists" });
        continue;
      }

      const cfg = rawConfig as Record<string, unknown>;

      // Determine type and build config
      let type: "stdio" | "streamable-http" | "sse";
      let config: TransportConfig;

      if (cfg.command) {
        type = "stdio";
        config = {
          command: cfg.command as string,
          args: (cfg.args as string[]) ?? [],
          env: (cfg.env as Record<string, string>) ?? undefined,
          cwd: (cfg.cwd as string) ?? undefined,
        };
      } else if (cfg.url && cfg.type === "sse") {
        type = "sse";
        config = {
          url: cfg.url as string,
          headers: (cfg.headers as Record<string, string>) ?? undefined,
        };
      } else if (cfg.url) {
        type = "streamable-http";
        config = {
          url: cfg.url as string,
          headers: (cfg.headers as Record<string, string>) ?? undefined,
        };
      } else {
        results.push({ name, status: "error", reason: "Cannot determine transport type (need 'command' or 'url')" });
        continue;
      }

      try {
        insertServer(db, name, type, config);

        const created = getServer(db, name);
        if (created?.enabled) {
          try {
            await syncServer(ctx, clientManager, created);
          } catch (err) {
            results.push({ name, status: "error", reason: `Failed to sync: "${String(err)}"` });
            continue;
          }
        }
        results.push({ name, status: "created" });
      } catch (err) {
        results.push({ name, status: "error", reason: err instanceof Error ? err.message : String(err) });
      }
    }

    // Trigger a single skill rescan at the end
    await ctx.skills.rescan();

    const created = results.filter((r) => r.status === "created").length;
    return Response.json({ imported: created, results });
  });

  // POST /ext/mcp/servers/:name/sync - manual resync trigger
  ctx.registerRoute("POST", "servers/:name/sync", async (elysiaCtx) => {
    const name = (elysiaCtx.params as { name: string }).name;

    const server = getServer(db, name);
    if (!server) {
      return new Response(JSON.stringify({ error: "Server not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const changed = await syncServer(ctx, clientManager, server);

    if (changed) {
      await ctx.skills.rescan();
    }

    // Re-read to get updated state
    const updated = getServer(db, name);

    return Response.json({
      server: name,
      changed,
      toolsHash: updated?.toolsHash,
      lastSyncedAt: updated?.lastSyncedAt,
      lastError: updated?.lastError,
    });
  });
}
