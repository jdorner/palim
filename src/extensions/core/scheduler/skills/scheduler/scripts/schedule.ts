/**
 * Registers the `schedule` shell command for managing cron and interval-based
 * schedules via the scheduler extension's REST API.
 *
 * Subcommands: list, get, create, delete, trigger
 */

import { createCommand, formatFetchError, type ParsedArgs, registerProgram, type SkillScriptContext } from "@ext/sdk";
import type { CommandContext, ExecResult } from "just-bash";

/** Shape of a schedule entry returned by the REST API. */
interface ScheduleEntry {
  id: string;
  name: string;
  description?: string;
  pattern?: string;
  every?: number;
  limit?: number;
  executions: number;
  tz?: string;
  next?: number;
}

/**
 * Formats a timestamp as a human-readable date/time string.
 *
 * @param ts - Unix timestamp in milliseconds
 * @returns Formatted date string
 */
function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString("de-DE", {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}

/**
 * Formats a single schedule entry into a human-readable line.
 *
 * @param s - Schedule entry from the API
 * @returns Formatted string
 */
function formatSchedule(s: ScheduleEntry): string {
  const schedule = s.pattern ? `\n  - cron "${s.pattern}"` : `\n  - every ${s.every}ms`;
  const next = s.next ? `\n  - next: ${formatTimestamp(s.next)}` : "";
  const limit = s.limit ? `\n  - limit: ${s.limit}` : "\n  - limit: ∞";
  const executions = s.executions ? `\n  - completed: ${s.executions}` : "";
  const runsLeft = s.limit ? `\n  - runs left: ${s.limit - s.executions}` : "";
  const tz = s.tz ? `\n  - tz: ${s.tz}` : "";
  const description = s.description ? `\n  - description: ${s.description}` : "";
  return `${s.id}: "${s.name}"${schedule}${limit}${executions}${runsLeft}${tz}${next}${description}\n`;
}

/**
 * Builds the `schedule` command handler function.
 *
 * Exported for unit testing - allows injecting a context without
 * booting the full extension system.
 *
 * @param scriptCtx - Skill script context providing the extension base URL and authenticated fetch
 * @returns A command handler suitable for `registerProgram()`
 */
export function buildScheduleCommand(scriptCtx: SkillScriptContext) {
  return createCommand({
    name: "schedule",
    description: "Manage cron and interval-based scheduled tasks.",
    subcommands: [
      {
        name: "list",
        description: "List all configured schedules",
        handler: buildListHandler(scriptCtx),
      },
      {
        name: "get",
        description: "Get details for a specific schedule",
        args: [{ name: "id", description: "Schedule ID" }],
        handler: buildGetHandler(scriptCtx),
      },
      {
        name: "create",
        description: "Create a new schedule (provide --pattern or --every, not both)",
        args: [
          { name: "id", description: "Unique schedule ID (used as trigger.ref in workflows)" },
          { name: "name", description: "Human-readable label" },
        ],
        options: [
          { name: "description", short: "d", description: "What this schedule does" },
          { name: "pattern", short: "p", description: 'Cron expression, e.g. "0 9 * * *"' },
          { name: "every", short: "e", description: "Interval in ms, minimum 1000" },
          { name: "tz", description: "IANA timezone for cron, e.g. Europe/Berlin" },
          { name: "limit", short: "l", description: "Max executions (omit for infinite)" },
        ],
        handler: buildCreateHandler(scriptCtx),
      },
      {
        name: "delete",
        description: "Delete a schedule by ID",
        args: [{ name: "id", description: "Schedule ID to delete" }],
        handler: buildDeleteHandler(scriptCtx),
      },
      {
        name: "trigger",
        description: "Manually fire a schedule (does not count as a scheduled execution)",
        args: [{ name: "id", description: "Schedule ID to trigger" }],
        handler: buildTriggerHandler(scriptCtx),
      },
    ],
  });
}

/**
 * Registers the `schedule` shell command with the sandbox.
 *
 * @param skillName - The skill name this program belongs to
 * @param ctx - Skill script context providing the extension base URL and authenticated fetch
 */
export async function registerSkill(skillName: string, ctx: SkillScriptContext) {
  const command = buildScheduleCommand(ctx);
  registerProgram("schedule", command, skillName);
}

// ---------------------------------------------------------------------------
// Handler factories
// ---------------------------------------------------------------------------

function buildListHandler(scriptCtx: SkillScriptContext) {
  return async (_ctx: CommandContext): Promise<ExecResult> => {
    try {
      const resp = await scriptCtx.fetch(`${scriptCtx.baseUrl}/schedules`);
      if (!resp.ok) {
        return { exitCode: 1, stdout: "", stderr: `Error: HTTP ${resp.status}` };
      }

      const schedules = (await resp.json()) as ScheduleEntry[];
      if (schedules.length === 0) {
        return { exitCode: 0, stdout: "No schedules configured.", stderr: "" };
      }

      const lines = ["Schedules:", ...schedules.map((s) => `  ${formatSchedule(s)}`)];
      return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
    } catch (err) {
      return { exitCode: 1, stdout: "", stderr: formatFetchError(err as Error) };
    }
  };
}

function buildGetHandler(scriptCtx: SkillScriptContext) {
  return async (_ctx: CommandContext, args: ParsedArgs): Promise<ExecResult> => {
    const id = args.get("id");

    try {
      const resp = await scriptCtx.fetch(`${scriptCtx.baseUrl}/schedules`);
      if (!resp.ok) {
        return { exitCode: 1, stdout: "", stderr: `Error: HTTP ${resp.status}` };
      }

      const schedules = (await resp.json()) as ScheduleEntry[];
      const schedule = schedules.find((s) => s.id === id);

      if (!schedule) {
        return { exitCode: 1, stdout: "", stderr: `Error: Schedule "${id}" not found` };
      }

      return { exitCode: 0, stdout: formatSchedule(schedule), stderr: "" };
    } catch (err) {
      return { exitCode: 1, stdout: "", stderr: formatFetchError(err as Error) };
    }
  };
}

function buildCreateHandler(scriptCtx: SkillScriptContext) {
  return async (_ctx: CommandContext, args: ParsedArgs): Promise<ExecResult> => {
    const id = args.get("id");
    const name = args.get("name");
    const description = args.option("description") || undefined;
    const pattern = args.option("pattern") || undefined;
    const everyRaw = args.option("every");
    const tz = args.option("tz") || undefined;
    const limitRaw = args.option("limit");

    if (!id || !name) {
      return { exitCode: 1, stdout: "", stderr: "Error: id and name are required" };
    }

    const every = everyRaw ? Number.parseInt(everyRaw, 10) : undefined;
    if (everyRaw && (Number.isNaN(every!) || every! < 1000)) {
      return { exitCode: 1, stdout: "", stderr: "Error: --every must be a number >= 1000 (milliseconds)" };
    }

    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    if (limitRaw && (Number.isNaN(limit!) || limit! < 1)) {
      return { exitCode: 1, stdout: "", stderr: "Error: --limit must be a positive number" };
    }

    if (!pattern && !every) {
      return { exitCode: 1, stdout: "", stderr: "Error: provide either --pattern (cron) or --every (ms interval)" };
    }

    if (pattern && every) {
      return { exitCode: 1, stdout: "", stderr: "Error: --pattern and --every are mutually exclusive" };
    }

    const body: Record<string, unknown> = { id, name };
    if (description) body.description = description;
    if (pattern) body.pattern = pattern;
    if (every) body.every = every;
    if (tz) body.tz = tz;
    if (limit) body.limit = limit;

    try {
      const resp = await scriptCtx.fetch(`${scriptCtx.baseUrl}/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const result = (await resp.json()) as { scheduler?: unknown; name?: string; error?: string };

      if (!resp.ok) {
        return { exitCode: 1, stdout: "", stderr: `Error: ${result.error || `HTTP ${resp.status}`}` };
      }

      const scheduleDesc = pattern ? `Cron: ${pattern}` : `Every: ${every}ms`;
      return { exitCode: 0, stdout: `Created schedule "${name}" (${id}). ${scheduleDesc}`, stderr: "" };
    } catch (err) {
      return { exitCode: 1, stdout: "", stderr: formatFetchError(err as Error) };
    }
  };
}

function buildDeleteHandler(scriptCtx: SkillScriptContext) {
  return async (_ctx: CommandContext, args: ParsedArgs): Promise<ExecResult> => {
    const id = args.get("id");

    try {
      const resp = await scriptCtx.fetch(`${scriptCtx.baseUrl}/schedules/${id}`, { method: "DELETE" });
      const result = (await resp.json()) as { ok?: boolean; error?: string };

      if (!resp.ok) {
        return { exitCode: 1, stdout: "", stderr: `Error: ${result.error || `HTTP ${resp.status}`}` };
      }

      return { exitCode: 0, stdout: `Deleted schedule "${id}".`, stderr: "" };
    } catch (err) {
      return { exitCode: 1, stdout: "", stderr: formatFetchError(err as Error) };
    }
  };
}

function buildTriggerHandler(scriptCtx: SkillScriptContext) {
  return async (_ctx: CommandContext, args: ParsedArgs): Promise<ExecResult> => {
    const id = args.get("id");

    try {
      const resp = await scriptCtx.fetch(`${scriptCtx.baseUrl}/schedules/${id}/trigger`, { method: "POST" });
      const result = (await resp.json()) as { ok?: boolean; error?: string };

      if (!resp.ok) {
        return { exitCode: 1, stdout: "", stderr: `Error: ${result.error || `HTTP ${resp.status}`}` };
      }

      return { exitCode: 0, stdout: `Triggered schedule "${id}".`, stderr: "" };
    } catch (err) {
      return { exitCode: 1, stdout: "", stderr: formatFetchError(err as Error) };
    }
  };
}
