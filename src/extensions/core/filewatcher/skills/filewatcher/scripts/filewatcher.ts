/**
 * Registers the `filewatcher` shell command for managing directory watchers
 * from the agent sandbox.
 *
 * Subcommands: list, get, create, delete, update
 */

import {
  createCommand,
  formatFetchError,
  formatHttpError,
  type ParsedArgs,
  registerProgram,
  type SkillScriptContext,
} from "@ext/sdk";
import type { CommandContext, ExecResult } from "just-bash";

/** A file watcher record returned from admin API endpoints. */
export type FileWatcherResponse = {
  slug: string;
  name: string;
  path: string;
  patterns: string[];
  recursive: boolean;
  processExisting: boolean;
  enabled: boolean;
  createdAt?: number;
};

/** An error response body from the filewatcher admin API. */
export type ApiError = { error: string };

/**
 * Builds the `filewatcher` command handler function.
 *
 * Exported for unit testing - allows injecting a base URL without
 * booting the full extension system.
 *
 * @param scriptCtx - Skill script context providing the extension base URL and authenticated fetch
 * @returns A command handler suitable for `registerProgram()`
 */
export function buildFilewatcherCommand(scriptCtx: SkillScriptContext) {
  return createCommand({
    name: "filewatcher",
    description: "Manage directory watchers that detect new files and trigger workflows.",
    subcommands: [
      {
        name: "list",
        description: "List all registered file watchers",
        handler: buildListHandler(scriptCtx),
      },
      {
        name: "get",
        description: "Get details for a specific file watcher",
        args: [{ name: "slug", description: "File watcher slug" }],
        handler: buildGetHandler(scriptCtx),
      },
      {
        name: "create",
        description: "Create a new file watcher",
        args: [
          { name: "slug", description: "URL-safe slug (lowercase, alphanumeric, hyphens)" },
          { name: "name", description: "Human-readable label" },
          { name: "path", description: "Directory path relative to work directory (e.g. inbox)" },
          { name: "patterns", description: "Comma-separated glob patterns (e.g. *.png,*.jpg)" },
        ],
        options: [
          { name: "recursive", short: "r", boolean: true, description: "Watch subdirectories recursively" },
          { name: "process-existing", boolean: true, description: "Emit events for files already present on start" },
        ],
        handler: buildCreateHandler(scriptCtx),
      },
      {
        name: "delete",
        description: "Delete a file watcher by slug",
        args: [{ name: "slug", description: "File watcher slug to delete" }],
        handler: buildDeleteHandler(scriptCtx),
      },
      {
        name: "update",
        description: "Update a file watcher field",
        args: [
          { name: "slug", description: "File watcher slug to update" },
          {
            name: "field",
            description: "Field to update: name, path, patterns, recursive, processExisting, enabled",
          },
          { name: "value", description: "New value for the field" },
        ],
        handler: buildUpdateHandler(scriptCtx),
      },
    ],
  });
}

/**
 * Registers the `filewatcher` shell command with the sandbox.
 *
 * @param skillName - The skill name this program belongs to
 * @param ctx - Context from the extension registry
 */
export async function registerSkill(skillName: string, ctx: SkillScriptContext) {
  const command = buildFilewatcherCommand(ctx);
  registerProgram("filewatcher", command, skillName);
}

// ---------------------------------------------------------------------------
// Handler factories
// ---------------------------------------------------------------------------

function buildListHandler(scriptCtx: SkillScriptContext) {
  return async (_ctx: CommandContext): Promise<ExecResult> => {
    try {
      const resp = await scriptCtx.fetch(`${scriptCtx.baseUrl}`);
      if (!resp.ok) return formatHttpError(resp);

      const body = (await resp.json()) as FileWatcherResponse[];
      if (!Array.isArray(body) || body.length === 0) {
        return { exitCode: 0, stdout: "No file watchers registered.", stderr: "" };
      }

      const lines = ["Registered File Watchers:", ""];
      for (const w of body) {
        const status = w.enabled ? "enabled" : "disabled";
        const recursive = w.recursive ? ", recursive" : "";
        const processExisting = w.processExisting ? ", processExisting" : "";
        lines.push(`${w.slug}: "${w.name}" [${status}${recursive}${processExisting}]`);
        lines.push(`  Path: ${w.path}`);
        lines.push(`  Patterns: ${(w.patterns as string[]).join(", ")}`);
        lines.push("");
      }

      return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
    } catch (error) {
      return { exitCode: 1, stdout: "", stderr: formatFetchError(error as Error) };
    }
  };
}

function buildGetHandler(scriptCtx: SkillScriptContext) {
  return async (_ctx: CommandContext, args: ParsedArgs): Promise<ExecResult> => {
    const slug = args.get("slug");

    try {
      const resp = await scriptCtx.fetch(`${scriptCtx.baseUrl}`);
      if (!resp.ok) return formatHttpError(resp);

      const body = (await resp.json()) as FileWatcherResponse[];
      if (!Array.isArray(body)) {
        return { exitCode: 1, stdout: "", stderr: `Unexpected response format` };
      }

      const w = body.find((w) => w.slug === slug);

      if (!w) {
        return { exitCode: 1, stdout: "", stderr: `File watcher "${slug}" not found.` };
      }

      const lines = [
        `File Watcher: ${w.name}`,
        `  Slug: ${w.slug}`,
        `  Path: ${w.path}`,
        `  Patterns: ${(w.patterns as string[]).join(", ")}`,
        `  Recursive: ${w.recursive}`,
        `  Process Existing: ${w.processExisting}`,
        `  Enabled: ${w.enabled}`,
        `  Created: ${w.createdAt != null ? new Date(w.createdAt).toLocaleString() : "N/A"}`,
      ];

      return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
    } catch (error) {
      return { exitCode: 1, stdout: "", stderr: formatFetchError(error as Error) };
    }
  };
}

function buildCreateHandler(scriptCtx: SkillScriptContext) {
  return async (_ctx: CommandContext, args: ParsedArgs): Promise<ExecResult> => {
    const slug = args.get("slug");
    const name = args.get("name");
    const watchPath = args.get("path");
    const patternsStr = args.get("patterns");
    const recursive = args.flag("recursive");
    const processExisting = args.flag("process-existing");

    const patterns = patternsStr
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (patterns.length === 0) {
      return { exitCode: 1, stdout: "", stderr: "Error: at least one glob pattern is required" };
    }

    try {
      const resp = await scriptCtx.fetch(`${scriptCtx.baseUrl}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, name, path: watchPath, patterns, recursive, processExisting }),
      });

      const body = (await resp.json()) as FileWatcherResponse | ApiError;

      if (resp.status === 201) {
        return {
          exitCode: 0,
          stdout: `File watcher created: "${name}"\n  Path: ${watchPath}\n  Patterns: ${patterns.join(", ")}\n  Recursive: ${recursive}\n  Process Existing: ${processExisting}`,
          stderr: "",
        };
      }

      const errMsg = (body as { error?: string })?.error ?? `HTTP ${resp.status}`;
      return { exitCode: 1, stdout: "", stderr: `Error: ${errMsg}` };
    } catch (error) {
      return { exitCode: 1, stdout: "", stderr: formatFetchError(error as Error) };
    }
  };
}

function buildDeleteHandler(scriptCtx: SkillScriptContext) {
  return async (_ctx: CommandContext, args: ParsedArgs): Promise<ExecResult> => {
    const slug = args.get("slug");

    try {
      const resp = await scriptCtx.fetch(`${scriptCtx.baseUrl}/${slug}`, { method: "DELETE" });
      const body = (await resp.json()) as { ok?: boolean; error?: string };

      if (resp.ok && body.ok) {
        return { exitCode: 0, stdout: `File watcher "${slug}" deleted.`, stderr: "" };
      }

      const errMsg = body.error ?? `HTTP ${resp.status}`;
      return { exitCode: 1, stdout: "", stderr: `Error: ${errMsg}` };
    } catch (error) {
      return { exitCode: 1, stdout: "", stderr: formatFetchError(error as Error) };
    }
  };
}

const UPDATABLE_FIELDS = new Set(["name", "path", "patterns", "recursive", "processExisting", "enabled"]);
const BOOLEAN_FIELDS = new Set(["recursive", "processExisting", "enabled"]);

function buildUpdateHandler(scriptCtx: SkillScriptContext) {
  return async (_ctx: CommandContext, args: ParsedArgs): Promise<ExecResult> => {
    const slug = args.get("slug");
    const field = args.get("field");
    const value = args.get("value");

    if (!UPDATABLE_FIELDS.has(field)) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Error: invalid field "${field}". Valid fields: ${[...UPDATABLE_FIELDS].join(", ")}`,
      };
    }

    let parsed: unknown = value;

    if (BOOLEAN_FIELDS.has(field)) {
      if (value === "true") parsed = true;
      else if (value === "false") parsed = false;
      else {
        return { exitCode: 1, stdout: "", stderr: `Error: ${field} must be "true" or "false"` };
      }
    }

    if (field === "patterns") {
      const patterns = value
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      if (patterns.length === 0) {
        return { exitCode: 1, stdout: "", stderr: "Error: at least one glob pattern is required" };
      }
      parsed = patterns;
    }

    try {
      const resp = await scriptCtx.fetch(`${scriptCtx.baseUrl}/${slug}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: parsed }),
      });

      const body = (await resp.json()) as FileWatcherResponse | { error?: string };

      if (resp.ok) {
        return { exitCode: 0, stdout: `File watcher "${slug}" updated: ${field} = ${value}`, stderr: "" };
      }

      const errMsg = (body as { error?: string })?.error ?? `HTTP ${resp.status}`;
      return { exitCode: 1, stdout: "", stderr: `Error: ${errMsg}` };
    } catch (error) {
      return { exitCode: 1, stdout: "", stderr: formatFetchError(error as Error) };
    }
  };
}
