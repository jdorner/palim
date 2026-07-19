/**
 * Registers the `wiki` shell command for managing and searching the agent's
 * wiki knowledge base via REST API calls.
 *
 * Subcommands: search, docs, stats
 */

import { createCommand, formatFetchError, type ParsedArgs, registerProgram, type SkillScriptContext } from "@ext/sdk";
import type { CommandContext, ExecResult } from "just-bash";

// ---------------------------------------------------------------------------
// buildWikiCommand
// ---------------------------------------------------------------------------

/**
 * Builds the `wiki` command handler function.
 *
 * Exported for unit testing - allows injecting a context without
 * booting the full extension system.
 *
 * @param scriptCtx - Skill script context providing the extension base URL and authenticated fetch
 * @returns A command handler suitable for `registerProgram()`
 */
export function buildWikiCommand(scriptCtx: SkillScriptContext) {
  return createCommand({
    name: "wiki",
    description: "Manage and search the agent's wiki knowledge base.",
    subcommands: [
      {
        name: "search",
        description: "Search the wiki by keyword or phrase",
        args: [{ name: "query", description: "Search term (required)" }],
        options: [{ name: "limit", short: "n", defaultValue: "5", description: "Max results (1-50, default 5)" }],
        handler: buildSearchHandler(scriptCtx),
      },
      {
        name: "docs",
        description: "List all indexed wiki markdown files",
        handler: buildDocsHandler(scriptCtx),
      },
      {
        name: "stats",
        description: "Show wiki index statistics",
        handler: buildStatsHandler(scriptCtx),
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// registerSkill
// ---------------------------------------------------------------------------

/**
 * Registers the `wiki` shell command with the sandbox.
 *
 * @param skillName - The skill name this program belongs to
 * @param ctx - Skill script context providing the extension base URL and authenticated fetch
 */
export async function registerSkill(skillName: string, ctx: SkillScriptContext) {
  const command = buildWikiCommand(ctx);
  registerProgram("wiki", command, skillName);
}

// ---------------------------------------------------------------------------
// Handler factories
// ---------------------------------------------------------------------------

function buildSearchHandler(scriptCtx: SkillScriptContext) {
  return async (_ctx: CommandContext, args: ParsedArgs): Promise<ExecResult> => {
    const query = args.get("query");

    if (!query) {
      return { exitCode: 1, stdout: "", stderr: "Error: query is required (search term)" };
    }

    const limitRaw = args.option("limit") || undefined;
    let limit = 5;
    if (limitRaw) {
      const parsed = Number.parseInt(limitRaw, 10);
      if (!Number.isNaN(parsed)) {
        limit = Math.min(Math.max(parsed, 1), 50);
      }
    }

    try {
      const resp = await scriptCtx.fetch(`${scriptCtx.baseUrl}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, limit }),
      });

      const data = await resp.json();
      const result = data as Record<string, unknown>;

      if (!resp.ok) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `Error: ${(result.error as string | undefined) || `HTTP ${resp.status}`}`,
        };
      }

      const results = result.results as { hits?: unknown[] } | Record<string, unknown> | undefined;
      type HitDoc = { title?: string; id: string; score?: number; document?: Record<string, unknown> };
      const hitArray = Array.isArray(results)
        ? (results as unknown[])
        : ((results as { hits?: HitDoc[] } | undefined)?.hits ?? []);
      if (hitArray.length === 0) {
        return { exitCode: 0, stdout: `No results for "${query}".`, stderr: "" };
      }

      const lines = [`Results for "${query}" (${hitArray.length} hits):`];
      for (const hit of hitArray as HitDoc[]) {
        const title = hit.document?.title ?? hit.id;
        const filePath = hit.document?.filePath ?? "";
        const score = hit.score ? `, score: ${hit.score.toFixed(4)}` : "";
        lines.push(`  - [${filePath}] ${title}${score}`);
      }

      return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
    } catch (err) {
      return { exitCode: 1, stdout: "", stderr: formatFetchError(err as Error) };
    }
  };
}

function buildDocsHandler(scriptCtx: SkillScriptContext) {
  return async (_ctx: CommandContext): Promise<ExecResult> => {
    try {
      const resp = await scriptCtx.fetch(`${scriptCtx.baseUrl}/docs`);
      const result = (await resp.json()) as Record<string, unknown>;

      if (!resp.ok) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `Error: ${(result.error as string | undefined) || `HTTP ${resp.status}`}`,
        };
      }

      const files = (result.files as string[] | undefined) ?? [];
      if (files.length === 0) {
        return { exitCode: 0, stdout: "No wiki files indexed.", stderr: "" };
      }

      const lines = ["Wiki files:", ...files.map((f) => `  - ${f}`)];
      return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
    } catch (err) {
      return { exitCode: 1, stdout: "", stderr: formatFetchError(err as Error) };
    }
  };
}

function buildStatsHandler(scriptCtx: SkillScriptContext) {
  return async (_ctx: CommandContext): Promise<ExecResult> => {
    try {
      const resp = await scriptCtx.fetch(`${scriptCtx.baseUrl}/stats`);
      const result = (await resp.json()) as Record<string, unknown>;

      if (!resp.ok) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `Error: ${(result.error as string | undefined) || `HTTP ${resp.status}`}`,
        };
      }

      const files = (result.files as number | undefined) ?? 0;
      const documents = (result.documents as number | undefined) ?? 0;
      return { exitCode: 0, stdout: `Files: ${files}\nDocuments: ${documents}`, stderr: "" };
    } catch (err) {
      return { exitCode: 1, stdout: "", stderr: formatFetchError(err as Error) };
    }
  };
}
