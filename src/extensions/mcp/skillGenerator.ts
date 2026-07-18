/**
 * MCP Skill Generator - introspects MCP servers and generates skill files.
 *
 * On boot or manual sync, connects to each enabled server, retrieves its
 * tool list, computes a SHA-512 hash for change detection, and writes
 * SKILL.md + proxy script files to `DATA_DIR/extensions/mcp-skills/skills/`.
 */

import { join } from "node:path";
import type { ExtensionContext } from "@ext/types";
import type { McpClientManager } from "./clientManager";
import { updateServer } from "./config";
import type { McpServerDefinition, McpToolDefinition } from "./types";

/** Base directory name for generated MCP skills within DATA_DIR/extensions/. */
const MCP_SKILLS_BASE = "mcp-skills";

/**
 * Returns the absolute path to the MCP skills directory.
 *
 * @param dataDir - The data directory (DATA_DIR)
 * @returns Absolute path to `DATA_DIR/extensions/mcp-skills/skills/`
 */
export function getSkillsDir(dataDir: string): string {
  return join(dataDir, "extensions", MCP_SKILLS_BASE, "skills");
}

/**
 * Returns the skill directory path for a specific server.
 *
 * @param dataDir - The data directory (DATA_DIR)
 * @param serverName - The MCP server name
 * @returns Absolute path to the skill directory
 */
function getServerSkillDir(dataDir: string, serverName: string): string {
  return join(getSkillsDir(dataDir), `mcp-${serverName}`);
}

/**
 * Computes a SHA-512 hash of the canonical sorted tool list JSON.
 *
 * Tools are sorted by name to ensure deterministic hashing regardless
 * of the order the server reports them.
 *
 * @param tools - Array of tool definitions
 * @returns Hex-encoded SHA-512 hash string
 */
export function computeToolsHash(tools: McpToolDefinition[]): string {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const canonical = JSON.stringify(sorted);
  const hasher = new Bun.CryptoHasher("sha512");
  hasher.update(canonical);
  return hasher.digest("hex");
}

/**
 * Generates the SKILL.md content for a server.
 *
 * @param serverName - The MCP server name
 * @param tools - Tool definitions from introspection
 * @returns SKILL.md file content
 */
export function generateSkillMd(serverName: string, tools: McpToolDefinition[]): string {
  const skillName = `mcp-${serverName}`;
  const toolNames = tools.map((t) => t.name).join(", ");
  const description = `MCP bridge: ${serverName} (${toolNames})`;

  const toolLines = tools.map((t) => `- **${t.name}** - ${t.description || "No description"}`).join("\n");

  return `---
name: ${skillName}
description: "${description}"
---
# ${skillName}

MCP-backed skill bridging the "${serverName}" server.

## Usage

- \`${skillName} --help\` - List all available tools
- \`${skillName} <tool> --help\` - Show detailed schema for a specific tool
- \`${skillName} <tool> --args='{"key": "value"}'\` - Call a tool with JSON arguments

## Available Tools

${toolLines}

Always run \`${skillName} <tool> --help\` before calling a tool for the first time to learn its parameter schema.
`;
}

/**
 * Generates the TypeScript script content for a server.
 *
 * The generated script registers a sandbox command that proxies
 * tool calls to the backend via HTTP. It uses the `registerProgram`
 * function provided via the script context at runtime, so no
 * absolute import paths into the source tree are needed.
 *
 * Convention:
 * - `<skillName> --help` - lists all tools
 * - `<skillName> <tool> --help` - shows tool schema
 * - `<skillName> <tool> --args='...'` - calls the tool
 *
 * @param serverName - The MCP server name
 * @returns Script file content
 */
export function generateScript(serverName: string): string {
  const skillName = `mcp-${serverName}`;

  return `/**
 * Generated MCP skill script for server "${serverName}".
 * DO NOT EDIT - this file is regenerated on MCP sync.
 */

import type { CommandContext, ExecResult } from "just-bash";

/** Minimal context interface matching SkillScriptContext from the host. */
interface ScriptContext {
  serverUrl: string;
  fetch: typeof globalThis.fetch;
  registerProgram: (
    name: string,
    callback: (args: string[], ctx: CommandContext) => Promise<ExecResult>,
    skillName: string,
  ) => void;
}

const SERVER_NAME = "${serverName}";
const SKILL_NAME = "${skillName}";

/**
 * Fetches the tool list from the backend.
 */
async function fetchTools(ctx: ScriptContext): Promise<{ tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> }> {
  const resp = await ctx.fetch(\`\${ctx.serverUrl}/ext/mcp/servers/\${SERVER_NAME}/tools\`);
  if (!resp.ok) {
    throw new Error(\`HTTP \${resp.status} \${resp.statusText}\`);
  }
  return resp.json() as Promise<{ tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> }>;
}

/**
 * Shows the list of all available tools.
 */
async function showHelp(ctx: ScriptContext): Promise<ExecResult> {
  try {
    const data = await fetchTools(ctx);

    if (data.tools.length === 0) {
      return { exitCode: 0, stdout: \`\${SKILL_NAME} - No tools available on server "\${SERVER_NAME}".\\n\\nUsage:\\n  \${SKILL_NAME} --help              List available tools\\n  \${SKILL_NAME} <tool> --help       Show tool schema\\n  \${SKILL_NAME} <tool> --args='{}'  Call a tool\`, stderr: "" };
    }

    const maxName = Math.max(...data.tools.map((t) => t.name.length));
    const lines = data.tools.map((t) => {
      const padded = t.name.padEnd(maxName + 2);
      return \`  \${padded}\${t.description || "No description"}\`;
    });

    const usage = [
      \`\${SKILL_NAME} - Tools on "\${SERVER_NAME}":\\n\`,
      ...lines,
      "",
      "Usage:",
      \`  \${SKILL_NAME} --help              List available tools\`,
      \`  \${SKILL_NAME} <tool> --help       Show tool schema\`,
      \`  \${SKILL_NAME} <tool> --args='{}'  Call a tool\`,
    ];

    return { exitCode: 0, stdout: usage.join("\\n"), stderr: "" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { exitCode: 1, stdout: "", stderr: \`Error: \${msg}\` };
  }
}

/**
 * Shows the schema for a specific tool.
 */
async function showToolHelp(ctx: ScriptContext, toolName: string): Promise<ExecResult> {
  try {
    const data = await fetchTools(ctx);
    const tool = data.tools.find((t) => t.name === toolName);
    if (!tool) {
      return { exitCode: 1, stdout: "", stderr: \`Error: Tool "\${toolName}" not found on server "\${SERVER_NAME}"\` };
    }
    const schema = JSON.stringify(tool.inputSchema, null, 2);
    return { exitCode: 0, stdout: \`Tool: \${tool.name}\\nDescription: \${tool.description || "N/A"}\\n\\nInput Schema:\\n\${schema}\\n\\nUsage:\\n  \${SKILL_NAME} \${tool.name} --args='{"key": "value"}'\`, stderr: "" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { exitCode: 1, stdout: "", stderr: \`Error: \${msg}\` };
  }
}

/**
 * Calls a tool with the given arguments.
 */
async function callTool(ctx: ScriptContext, toolName: string, argsJson: string): Promise<ExecResult> {
  let parsedArgs: Record<string, unknown>;
  try {
    parsedArgs = JSON.parse(argsJson);
  } catch {
    return { exitCode: 1, stdout: "", stderr: "Error: --args must be valid JSON" };
  }

  try {
    const resp = await ctx.fetch(\`\${ctx.serverUrl}/ext/mcp/servers/\${SERVER_NAME}/call\`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolName, arguments: parsedArgs }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return { exitCode: 1, stdout: "", stderr: \`Error: HTTP \${resp.status} - \${text}\` };
    }

    const data = await resp.json() as { content: Array<{ type: string; text?: string }>; isError: boolean };

    const textContent = data.content
      .filter((c: { type: string }) => c.type === "text")
      .map((c: { text?: string }) => c.text || "")
      .join("\\n");

    if (data.isError) {
      return { exitCode: 1, stdout: "", stderr: textContent || "Tool returned an error" };
    }

    return { exitCode: 0, stdout: textContent, stderr: "" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { exitCode: 1, stdout: "", stderr: \`Error: \${msg}\` };
  }
}

/**
 * Extracts the value of a --name=value or --name value option from args.
 */
function extractOption(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === \`--\${name}\` && i + 1 < args.length) return args[i + 1];
    if (arg.startsWith(\`--\${name}=\`)) return arg.slice(name.length + 3);
  }
  return undefined;
}

/**
 * Checks if a flag (e.g. --help) is present in the args.
 */
function hasFlag(args: string[], name: string): boolean {
  return args.includes(\`--\${name}\`) || args.includes(\`-\${name[0]}\`);
}

export async function registerSkill(skillName: string, ctx: ScriptContext) {
  const handler = async (args: string[], _cmdCtx: CommandContext): Promise<ExecResult> => {
    const first = args[0] ?? "";

    // No args or --help -> show all tools
    if (!first || first === "--help" || first === "-h") {
      return showHelp(ctx);
    }

    // First arg is the tool name
    const toolName = first;
    const rest = args.slice(1);

    // <tool> --help -> show tool schema
    if (hasFlag(rest, "help")) {
      return showToolHelp(ctx, toolName);
    }

    // <tool> [--args='...'] -> call the tool
    const argsJson = extractOption(rest, "args") || "{}";
    return callTool(ctx, toolName, argsJson);
  };

  ctx.registerProgram(SKILL_NAME, handler, skillName);
}
`;
}

/**
 * Writes the generated skill files for a single server to disk.
 *
 * @param dataDir - The data directory (DATA_DIR)
 * @param serverName - The MCP server name
 * @param tools - Tool definitions to generate from
 */
async function writeSkillFiles(dataDir: string, serverName: string, tools: McpToolDefinition[]): Promise<void> {
  const skillDir = getServerSkillDir(dataDir, serverName);
  const scriptsDir = join(skillDir, "scripts");
  const skillName = `mcp-${serverName}`;

  // Ensure directories exist
  await Bun.write(join(scriptsDir, ".gitkeep"), "");

  // Write SKILL.md
  const skillMd = generateSkillMd(serverName, tools);
  await Bun.write(join(skillDir, "SKILL.md"), skillMd);

  // Write script
  const script = generateScript(serverName);
  await Bun.write(join(scriptsDir, `${skillName}.ts`), script);
}

/**
 * Removes the generated skill directory for a server.
 *
 * @param dataDir - The data directory (DATA_DIR)
 * @param serverName - The MCP server name
 */
async function removeSkillDir(dataDir: string, serverName: string): Promise<void> {
  const skillDir = getServerSkillDir(dataDir, serverName);
  const { rm } = await import("node:fs/promises");
  try {
    await rm(skillDir, { recursive: true, force: true });
  } catch {
    // Directory may not exist - that's fine
  }
}

/**
 * Syncs a single server: introspects, checks hash, regenerates if needed.
 *
 * @param ctx - Extension context (for dataDir and DB access)
 * @param clientManager - The MCP client manager
 * @param server - Server definition to sync
 * @returns `true` if skills were (re)generated, `false` if unchanged
 */
export async function syncServer(
  ctx: ExtensionContext,
  clientManager: McpClientManager,
  server: McpServerDefinition,
): Promise<boolean> {
  const db = ctx.getDatabase();
  const logger = ctx.log;

  try {
    const tools = await clientManager.listTools(server);
    const hash = computeToolsHash(tools);

    if (hash === server.toolsHash) {
      // No change - update last_error to null in case it was set from a previous failure
      updateServer(db, server.name, { lastError: null });
      return false;
    }

    // Tools changed - regenerate
    await writeSkillFiles(ctx.dataDir, server.name, tools);

    updateServer(db, server.name, {
      toolsHash: hash,
      lastSyncedAt: Date.now(),
      lastError: null,
    });

    logger.info(`Generated skill for MCP server "${server.name}" (${tools.length} tools)`);
    return true;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    updateServer(db, server.name, { lastError: errorMsg });
    logger.error(`Failed to sync MCP server "${server.name}": ${errorMsg}`);
    return false;
  }
}

/**
 * Syncs all provided servers and cleans up orphan skill directories.
 *
 * @param ctx - Extension context
 * @param clientManager - The MCP client manager
 * @param servers - All server definitions (enabled ones will be synced)
 */
export async function syncAllSkills(
  ctx: ExtensionContext,
  clientManager: McpClientManager,
  servers: McpServerDefinition[],
): Promise<void> {
  const skillsDir = getSkillsDir(ctx.dataDir);

  // Ensure base directory structure exists
  await Bun.write(join(skillsDir, ".gitkeep"), "");

  // Ensure the generated extension has a valid index.ts manifest
  await ensureExtensionManifest(ctx.dataDir);

  // Sync enabled servers
  const enabledServers = servers.filter((s) => s.enabled);
  for (const server of enabledServers) {
    await syncServer(ctx, clientManager, server);
  }

  // Clean up orphan directories
  const validSkillNames = new Set(enabledServers.map((s) => `mcp-${s.name}`));
  await cleanOrphanSkills(ctx.dataDir, validSkillNames);
}

/**
 * Removes skill directories that don't correspond to any enabled server.
 *
 * @param dataDir - The data directory (DATA_DIR)
 * @param validSkillNames - Set of valid skill directory names (e.g., "mcp-filesystem")
 */
async function cleanOrphanSkills(dataDir: string, validSkillNames: Set<string>): Promise<void> {
  const skillsDir = getSkillsDir(dataDir);
  const { readdir } = await import("node:fs/promises");

  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith("mcp-") && !validSkillNames.has(entry.name)) {
        const serverName = entry.name.replace(/^mcp-/, "");
        await removeSkillDir(dataDir, serverName);
      }
    }
  } catch {
    // Directory may not exist yet - that's fine on first run
  }
}

export { removeSkillDir };

/**
 * Ensures the generated MCP extension directory has a valid `index.ts`
 * manifest so the registry recognizes it and scans its `skills/` subdirectory.
 *
 * @param dataDir - The data directory (DATA_DIR)
 */
async function ensureExtensionManifest(dataDir: string): Promise<void> {
  const manifestPath = join(dataDir, "extensions", MCP_SKILLS_BASE, "index.ts");
  const file = Bun.file(manifestPath);
  if (await file.exists()) return;

  const content = `/**
 * Generated MCP skill host extension.
 * DO NOT EDIT - this file exists so the registry discovers generated MCP skills.
 */
export default {
  manifest: {
    name: "mcp-skills",
    version: "1.0.0",
    description: "Auto-generated skills bridging MCP servers",
  },
  async initialize() {},
  async shutdown() {},
};
`;

  await Bun.write(manifestPath, content);
}
