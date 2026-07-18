/**
 * MCP extension - bridges Model Context Protocol servers into the skill system.
 *
 * On boot, connects to configured MCP servers, introspects their tools,
 * generates skill files (SKILL.md + proxy scripts) for each server, and
 * exposes HTTP routes for tool execution and server management.
 *
 * Generated skills appear as first-class skills to the agent - no special
 * MCP awareness required.
 */

import type { Extension, ExtensionContext, ExtensionManifest, Logger } from "@ext/types";
import { Type } from "@sinclair/typebox";
import type { McpClientManager } from "./clientManager.ts";
import { createClientManager } from "./clientManager.ts";
import { getAllServers } from "./config.ts";
import { registerRoutes } from "./routes.ts";
import { syncAllSkills } from "./skillGenerator.ts";

const manifest = {
  name: "mcp",
  version: "1.0.0",
  description: "Bridges MCP servers into the skill system",
  settingsSchema: Type.Object({
    autoSync: Type.Optional(
      Type.Boolean({
        title: "Auto-sync on boot",
        description: "Automatically connect to all enabled MCP servers and regenerate skills on startup",
        default: false,
      }),
    ),
  }),
  ui: {
    navigation: [
      {
        label: "MCP Servers",
        route: "/mcp",
        icon: "PlugIcon",
        order: 90,
        badgeKey: "mcpServerCount",
        iconColor: "text-violet-600 dark:text-violet-500",
      },
    ],
  },
} satisfies ExtensionManifest;

/**
 * Creates a fresh MCP extension instance.
 *
 * @returns An {@link Extension} object ready to be loaded by the registry
 */
export function createExtension(): Extension {
  let logger: Logger;
  let clientManager: McpClientManager;

  return {
    manifest,

    async initialize(ctx: ExtensionContext) {
      logger = ctx.log;

      // Ensure table exists (defensive - migration may not have run yet)
      const db = ctx.getDatabase();

      // Create client manager
      clientManager = createClientManager(logger);

      // Register HTTP routes first (so they're available even if sync fails)
      registerRoutes(ctx, clientManager);

      // Run skill generation on boot (best-effort - don't fail the extension)
      try {
        const servers = getAllServers(db);

        if (servers.length > 0) {
          if (ctx.getConfig("AUTO_SYNC", false)) {
            const enabledServers = servers.filter((s) => s.enabled);
            logger.info(`Syncing ${enabledServers.length} MCP server(s)...`);
            await syncAllSkills(ctx, clientManager, enabledServers);
            logger.info("MCP skill generation complete");
          }
          await ctx.skills.rescan();
        } else {
          logger.info("No MCP servers configured");
        }
      } catch (err) {
        logger.error("MCP skill sync failed on boot:", err);
      }
    },

    async shutdown() {
      if (clientManager) {
        await clientManager.shutdown();
      }
    },
  };
}

export default createExtension();
