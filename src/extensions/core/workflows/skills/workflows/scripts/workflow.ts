/**
 * Registers the `workflow` shell command for managing workflow JSON5 definitions.
 *
 * Subcommands: list, read, write, validate, delete, trigger, runs, logs, cancel
 */

import {
  createCommand,
  formatFetchError,
  formatValidationErrors,
  type ParsedArgs,
  registerProgram,
  type SkillScriptContext,
} from "@ext/sdk";
import { Value } from "@sinclair/typebox/value";
import type { CommandContext, ExecResult, IFileSystem } from "just-bash";
import { normalizePrompt, type WorkflowDefinition, WorkflowDefinitionSchema } from "../../../schemas";
import { validateWorkflowTemplates } from "../../../templateValidation";

/** Relative path to the workflows directory within the agent's working directory. */
const WORKFLOWS_DIR = "workflows";

/**
 * Resolves the absolute virtual-fs path to the workflows directory.
 */
function getWorkflowsDir(fs: IFileSystem, cwd: string): string {
  return fs.resolvePath(cwd, WORKFLOWS_DIR);
}

/**
 * Ensures the workflows directory exists by creating a `.gitkeep` marker.
 */
async function ensureDir(fs: IFileSystem, cwd: string): Promise<void> {
  const dir = getWorkflowsDir(fs, cwd);
  if (!(await fs.exists(dir))) {
    await fs.mkdir(dir, { recursive: true });
  }
  const marker = fs.resolvePath(dir, ".gitkeep");
  if (!(await fs.exists(marker))) {
    await fs.writeFile(marker, "");
  }
}

/**
 * Builds the `workflow` command handler function.
 *
 * Exported for unit testing - allows injecting a context without
 * booting the full extension system.
 *
 * @param scriptCtx - Skill script context providing the extension base URL and authenticated fetch
 * @returns A command handler suitable for `registerProgram()`
 */
export function buildWorkflowCommand(scriptCtx: SkillScriptContext) {
  return createCommand({
    name: "workflow",
    description: "Manage workflow pipeline JSON5 definitions.",
    subcommands: [
      {
        name: "list",
        description: "List all workflow definitions",
        handler: buildListHandler(),
      },
      {
        name: "read",
        description: "Display the full JSON5 content of a workflow",
        args: [{ name: "name", description: "Workflow name (filename without .json5)" }],
        handler: buildReadHandler(),
      },
      {
        name: "write",
        description: "Create or overwrite a workflow JSON5 file (validates before writing)",
        args: [
          { name: "name", description: "Workflow name (becomes <name>.json5)" },
          { name: "content", description: "Full JSON5 content of the workflow" },
        ],
        handler: buildWriteHandler(scriptCtx),
      },
      {
        name: "validate",
        description: "Validate a workflow JSON5 file against the schema",
        args: [{ name: "name", description: "Workflow name to validate" }],
        handler: buildValidateHandler(scriptCtx),
      },
      {
        name: "delete",
        description: "Delete a workflow JSON5 file",
        args: [{ name: "name", description: "Workflow name to delete" }],
        handler: buildDeleteHandler(),
      },
      {
        name: "trigger",
        description: "Trigger a workflow run with an optional JSON payload",
        args: [
          { name: "name", description: "Workflow name to trigger" },
          { name: "payload", required: false, description: "Optional JSON payload (becomes {{trigger.payload}})" },
        ],
        handler: buildTriggerHandler(scriptCtx),
      },
      {
        name: "runs",
        description: "List recent runs for a workflow",
        args: [{ name: "name", description: "Workflow name" }],
        handler: buildRunsHandler(scriptCtx),
      },
      {
        name: "logs",
        description: "Show per-step execution details and logs for a workflow run",
        args: [{ name: "run-id", description: "Workflow run ID" }],
        handler: buildLogsHandler(scriptCtx),
      },
      {
        name: "cancel",
        description: "Cancel all steps of a running workflow by its run ID",
        args: [{ name: "run-id", description: "Workflow run ID to cancel" }],
        handler: buildCancelHandler(scriptCtx),
      },
    ],
  });
}

/**
 * Registers the `workflow` shell command with the sandbox.
 *
 * @param skillName - The skill name this program belongs to
 * @param ctx - Skill script context providing the extension base URL and authenticated fetch
 */
export async function registerSkill(skillName: string, ctx: SkillScriptContext) {
  const command = buildWorkflowCommand(ctx);
  registerProgram("workflow", command, skillName);
}

// ---------------------------------------------------------------------------
// File-based handler factories
// ---------------------------------------------------------------------------

/** Warning shape returned by the workflow API. */
interface ApiTemplateWarning {
  stepSlug: string;
  field: string;
  message: string;
}

/**
 * Fetches server-side template warnings for a loaded workflow.
 * Returns the warnings array from the API, or null if the workflow is not
 * loaded or the server is unavailable.
 */
async function fetchServerWarnings(
  scriptCtx: SkillScriptContext,
  workflowName: string,
): Promise<ApiTemplateWarning[] | null> {
  try {
    const resp = await scriptCtx.fetch(`${scriptCtx.baseUrl}/${workflowName}`);
    if (!resp.ok) return null;
    const data = (await resp.json()) as { warnings?: ApiTemplateWarning[] };
    return data.warnings ?? null;
  } catch {
    return null;
  }
}

/**
 * Formats template warnings into a human-readable block for shell output.
 */
function formatWarnings(warnings: ApiTemplateWarning[]): string {
  if (warnings.length === 0) return "";
  const lines = warnings.map((w) => `  [${w.stepSlug}.${w.field}] ${w.message}`);
  return `\nTemplate warnings:\n${lines.join("\n")}`;
}

function buildListHandler() {
  return async (ctx: CommandContext): Promise<ExecResult> => {
    const { fs, cwd } = ctx;
    await ensureDir(fs, cwd);
    const dir = getWorkflowsDir(fs, cwd);
    const allEntries = await fs.readdir(dir);
    const entries = allEntries.filter((e) => e.endsWith(".json5")).sort();

    if (entries.length === 0) {
      return { exitCode: 0, stdout: `No workflows found in ${dir}`, stderr: "" };
    }

    const lines: string[] = ["Workflows:"];
    for (const entry of entries) {
      try {
        const content = await fs.readFile(fs.resolvePath(dir, entry));
        const parsed = Bun.JSON5.parse(content) as Record<string, unknown>;
        const name = (parsed?.name as string) ?? "(unnamed)";
        const stepCount = Array.isArray(parsed?.steps) ? (parsed.steps as unknown[]).length : 0;
        const trigger = (parsed?.trigger as Record<string, unknown>)?.type ?? "?";
        const enabled = parsed?.enabled !== false;
        lines.push(`  ${name} (${entry}) - ${stepCount} steps, trigger: ${trigger}${enabled ? "" : " [disabled]"}`);
      } catch {
        lines.push(`  ${entry} - (parse error)`);
      }
    }
    lines.push("", "Use `workflow read <name>` to read a workflow definition.");

    return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
  };
}

function buildReadHandler() {
  return async (ctx: CommandContext, args: ParsedArgs): Promise<ExecResult> => {
    const { fs, cwd } = ctx;
    const name = args.get("name");
    const dir = getWorkflowsDir(fs, cwd);
    const filePath = fs.resolvePath(dir, `${name}.json5`);

    if (!(await fs.exists(filePath))) {
      return { exitCode: 1, stdout: "", stderr: `Error: Workflow "${name}" not found at ${filePath}` };
    }

    const content = await fs.readFile(filePath);
    return { exitCode: 0, stdout: content, stderr: "" };
  };
}

function buildWriteHandler(scriptCtx: SkillScriptContext) {
  return async (ctx: CommandContext, args: ParsedArgs): Promise<ExecResult> => {
    const { fs, cwd } = ctx;
    const name = args.get("name");
    const content = args.get("content");

    await ensureDir(fs, cwd);

    // Validate before writing
    let parsed: Record<string, unknown>;
    try {
      parsed = Bun.JSON5.parse(content) as Record<string, unknown>;
    } catch (err) {
      return { exitCode: 1, stdout: "", stderr: `JSON5 parse error: ${(err as Error).message}` };
    }

    // Normalize prompt arrays for validation
    if (Array.isArray(parsed.steps)) {
      for (const step of parsed.steps as Array<Record<string, unknown>>) {
        if (step.type === "agent" && Array.isArray(step.prompt)) {
          step.prompt = normalizePrompt(step.prompt as string[]);
        }
      }
    }

    if (!Value.Check(WorkflowDefinitionSchema, parsed)) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Validation failed:\n${formatValidationErrors(WorkflowDefinitionSchema, parsed, "\n")}`,
      };
    }

    // Check for duplicate step slugs
    const slugs = new Set<string>();
    for (const step of (parsed as { steps: { slug: string }[] }).steps) {
      if (slugs.has(step.slug)) {
        return { exitCode: 1, stdout: "", stderr: `Validation failed: duplicate step slug "${step.slug}"` };
      }
      slugs.add(step.slug);
    }

    // Template expression validation (local check, then try server-side for secret validation)
    const definition = parsed as unknown as WorkflowDefinition;
    const localWarnings = await validateWorkflowTemplates(definition, { workflowName: definition.name });

    const dir = getWorkflowsDir(fs, cwd);
    const filePath = fs.resolvePath(dir, `${name}.json5`);
    await fs.writeFile(filePath, `${Bun.JSON5.stringify(parsed, null, 2)}`);

    // After write, try server-side validation (includes secret store checks)
    const serverWarnings = await fetchServerWarnings(scriptCtx, definition.name);
    const warnings = serverWarnings ?? localWarnings;
    const warningOutput = formatWarnings(warnings);

    return { exitCode: 0, stdout: `Workflow "${name}" written to ${filePath}${warningOutput}`, stderr: "" };
  };
}

function buildValidateHandler(scriptCtx: SkillScriptContext) {
  return async (ctx: CommandContext, args: ParsedArgs): Promise<ExecResult> => {
    const { fs, cwd } = ctx;
    const name = args.get("name");
    const dir = getWorkflowsDir(fs, cwd);
    const filePath = fs.resolvePath(dir, `${name}.json5`);

    if (!(await fs.exists(filePath))) {
      return { exitCode: 1, stdout: "", stderr: `Error: Workflow "${name}" not found at ${filePath}` };
    }

    let content: string;
    try {
      content = await fs.readFile(filePath);
    } catch (err) {
      return { exitCode: 1, stdout: "", stderr: `Error reading file: ${(err as Error).message}` };
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = Bun.JSON5.parse(content) as Record<string, unknown>;
    } catch (err) {
      return { exitCode: 1, stdout: "", stderr: `JSON5 syntax error: ${(err as Error).message}` };
    }

    // Normalize prompt arrays for validation
    if (Array.isArray(parsed.steps)) {
      for (const step of parsed.steps as Array<Record<string, unknown>>) {
        if (step.type === "agent" && Array.isArray(step.prompt)) {
          step.prompt = normalizePrompt(step.prompt as string[]);
        }
      }
    }

    if (!Value.Check(WorkflowDefinitionSchema, parsed)) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Schema validation failed:\n${formatValidationErrors(WorkflowDefinitionSchema, parsed, "\n")}`,
      };
    }

    // Check duplicate slugs
    const slugs = new Set<string>();
    for (const step of (parsed as { steps: { slug: string }[] }).steps) {
      if (slugs.has(step.slug)) {
        return { exitCode: 1, stdout: "", stderr: `Validation warning: duplicate step slug "${step.slug}"` };
      }
      slugs.add(step.slug);
    }

    // Template expression validation (try server-side first for secret checks, fallback to local)
    const definition = parsed as unknown as WorkflowDefinition;
    const serverWarnings = await fetchServerWarnings(scriptCtx, definition.name);
    const localWarnings = await validateWorkflowTemplates(definition, { workflowName: definition.name });
    const warnings = serverWarnings ?? localWarnings;

    const stepCount = (parsed as { steps: unknown[] }).steps.length;
    const warningOutput = formatWarnings(warnings);
    if (warningOutput) {
      return {
        exitCode: 0,
        stdout: `✓ Workflow "${name}" schema is valid (${stepCount} steps)${warningOutput}`,
        stderr: "",
      };
    }

    return { exitCode: 0, stdout: `✓ Workflow "${name}" is valid (${stepCount} steps)`, stderr: "" };
  };
}

function buildDeleteHandler() {
  return async (ctx: CommandContext, args: ParsedArgs): Promise<ExecResult> => {
    const { fs, cwd } = ctx;
    const name = args.get("name");
    const dir = getWorkflowsDir(fs, cwd);
    const filePath = fs.resolvePath(dir, `${name}.json5`);

    if (!(await fs.exists(filePath))) {
      return { exitCode: 1, stdout: "", stderr: `Error: Workflow "${name}" not found` };
    }

    await fs.rm(filePath);
    return { exitCode: 0, stdout: `Workflow "${name}" deleted`, stderr: "" };
  };
}

// ---------------------------------------------------------------------------
// HTTP-based handler factories
// ---------------------------------------------------------------------------

/** Response shape for a single run from GET /ext/workflows/:name */
interface WorkflowRunEntry {
  runId: string;
  status: string;
  startedAt: number;
  steps: Array<{ slug: string; status: string; jobId: string }>;
}

/** Response shape from GET /ext/workflows/:name (includes runs) */
interface WorkflowDetailResponse {
  name: string;
  runs?: WorkflowRunEntry[];
  error?: string;
}

/** Response shape from GET /ext/workflows/runs/:runId/logs */
interface WorkflowRunLogsResponse {
  runId: string;
  steps: Array<{ slug: string; type: string; status: string; logs: unknown[]; count: number }>;
  error?: string;
}

function buildTriggerHandler(scriptCtx: SkillScriptContext) {
  return async (_ctx: CommandContext, args: ParsedArgs): Promise<ExecResult> => {
    const name = args.get("name");
    const payloadRaw = args.get("payload");

    let payload = "{}";
    if (payloadRaw) {
      try {
        JSON.parse(payloadRaw);
        payload = payloadRaw;
      } catch {
        return { exitCode: 1, stdout: "", stderr: "Error: payload must be valid JSON" };
      }
    }

    try {
      const resp = await scriptCtx.fetch(`${scriptCtx.baseUrl}/run/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });

      const result = (await resp.json()) as { ok?: boolean; workflowRunId?: string; error?: string };

      if (resp.ok && result.ok) {
        return { exitCode: 0, stdout: `Workflow "${name}" triggered - run ${result.workflowRunId}`, stderr: "" };
      }

      return { exitCode: 1, stdout: "", stderr: `Error: ${result.error || `HTTP ${resp.status}`}` };
    } catch (err) {
      return { exitCode: 1, stdout: "", stderr: formatFetchError(err as Error) };
    }
  };
}

function buildRunsHandler(scriptCtx: SkillScriptContext) {
  return async (_ctx: CommandContext, args: ParsedArgs): Promise<ExecResult> => {
    const name = args.get("name");

    try {
      const resp = await scriptCtx.fetch(`${scriptCtx.baseUrl}/${name}`);
      const result = (await resp.json()) as WorkflowDetailResponse;

      if (!resp.ok) {
        return { exitCode: 1, stdout: "", stderr: `Error: Workflow "${name}" not found` };
      }

      const runs = result.runs ?? [];
      if (runs.length === 0) {
        return { exitCode: 0, stdout: `No runs found for workflow "${name}"`, stderr: "" };
      }

      const lines: string[] = [`Runs for "${name}":`];
      for (const run of runs) {
        const date = `${new Date(run.startedAt).toISOString().replace("T", " ").slice(0, 19)}Z`;
        lines.push(`${run.runId}  ${run.status.padEnd(10)}  ${date}`);
      }
      return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
    } catch (err) {
      return { exitCode: 1, stdout: "", stderr: formatFetchError(err as Error) };
    }
  };
}

function buildLogsHandler(scriptCtx: SkillScriptContext) {
  return async (_ctx: CommandContext, args: ParsedArgs): Promise<ExecResult> => {
    const runId = args.get("run-id");

    try {
      const resp = await scriptCtx.fetch(`${scriptCtx.baseUrl}/runs/${runId}/logs`);
      const result = (await resp.json()) as WorkflowRunLogsResponse;

      if (!resp.ok) {
        return { exitCode: 1, stdout: "", stderr: `Error: Run "${runId}" not found` };
      }

      const lines: string[] = [`Run: ${result.runId}`];
      for (const step of result.steps) {
        lines.push(`\n── ${step.slug} (${step.type}) [${step.status}]`);
        if (step.logs.length > 0) {
          for (const log of step.logs) {
            const text = typeof log === "string" ? log : JSON.stringify(log);
            lines.push(`   ${text.replace("[info] ", "")}`);
          }
        } else {
          lines.push("   (no logs)");
        }
      }
      return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
    } catch (err) {
      return { exitCode: 1, stdout: "", stderr: formatFetchError(err as Error) };
    }
  };
}

/** Response shape from GET /ext/workflows/runs/:runId */
interface WorkflowRunResponse {
  runId: string;
  workflowName: string;
  status: string;
  steps: Array<{ slug: string; type: string; status: string; jobId: string }>;
  error?: string;
}

function buildCancelHandler(scriptCtx: SkillScriptContext) {
  return async (_ctx: CommandContext, args: ParsedArgs): Promise<ExecResult> => {
    const runId = args.get("run-id");

    try {
      // First, get the run details for the summary output
      const runResp = await scriptCtx.fetch(`${scriptCtx.baseUrl}/runs/${runId}`);
      if (!runResp.ok) {
        return { exitCode: 1, stdout: "", stderr: `Error: Run "${runId}" not found` };
      }

      const run = (await runResp.json()) as WorkflowRunResponse;
      if (!run.steps || run.steps.length === 0) {
        return { exitCode: 1, stdout: "", stderr: `Error: Run "${runId}" has no steps` };
      }

      // Cancel the run via DELETE /ext/workflows/runs/:runId
      const cancelResp = await scriptCtx.fetch(`${scriptCtx.baseUrl}/runs/${runId}`, { method: "DELETE" });
      if (!cancelResp.ok) {
        const body = (await cancelResp.json()) as { error?: string };
        return { exitCode: 1, stdout: "", stderr: `Error: ${body.error || `HTTP ${cancelResp.status}`}` };
      }

      const stepSummary = run.steps.map((s) => `  ${s.slug} [${s.status}]`).join("\n");
      return {
        exitCode: 0,
        stdout: `Cancelled workflow run ${runId} (${run.steps.length} steps):\n${stepSummary}`,
        stderr: "",
      };
    } catch (err) {
      return { exitCode: 1, stdout: "", stderr: formatFetchError(err as Error) };
    }
  };
}
