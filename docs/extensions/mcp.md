# MCP

The MCP extension bridges [Model Context Protocol](https://modelcontextprotocol.io/) servers into Palim's skill system. It connects to configured MCP servers, introspects their tools, and generates skill files so the agent can use external tools without any MCP-specific awareness.

## Enabling

Enable the extension in the web UI under **Settings > Extensions** by toggling the switch next to "mcp".

## How It Works

1. MCP servers are configured via the web UI (Settings > MCP Servers page)
2. On sync, the extension connects to each enabled server and discovers its tools
3. For each server, it generates a skill file (SKILL.md) and proxy scripts
4. The agent sees these as regular skills and can invoke the tools via sandbox commands

## Settings

All settings are configurable in the web UI under **Settings > Extensions > MCP**.

### Auto-sync on Boot

When enabled, the extension automatically connects to all enabled MCP servers and regenerates skills on startup. When disabled, you must manually trigger a sync from the MCP Servers page.

Default: `false`

## Environment Variable Override

| Setting | Environment Variable |
| --- | --- |
| Auto-sync | `EXT_MCP_AUTO_SYNC` |

## Web UI

The extension registers an **MCP Servers** page in the sidebar where you can:

- Add new MCP servers (command, args, env)
- Enable/disable individual servers
- Trigger manual sync to regenerate skills
- View connected server status and available tools

## Server Configuration

Each MCP server entry consists of:

- **Command** - The executable to run (e.g. `uvx`, `npx`)
- **Args** - Command arguments (e.g. `["some-mcp-server@latest"]`)
- **Env** - Environment variables passed to the server process
- **Enabled** - Whether the server should be connected on sync

## Generated Skills

After syncing, each server gets:

- A `SKILL.md` describing available tools
- Proxy scripts in the skill's `scripts/` directory that the agent calls via `exec`

The agent reads a server's skill with `skill read <server-name>` to discover what tools are available.
