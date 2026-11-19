/**
 * Registers the `workflow` shell command for managing workflow JSON5 definitions.
 *
 * Subcommands: list, step-types, read, outline, write (`--draft`, `--file`), set-step, remove-step,
 * add-edge, remove-edge, set-meta, add-loop, validate, delete, trigger, runs, logs, wait, cancel
 */

import {
  createCommand,
  formatFetchError,
  formatValidationErrors,
  type ParsedArgs,
  registerProgram,
  type SkillScriptContext,
} from "@ext/sdk";
import type { WorkflowLoadError } from "@shared/workflows";
import { analyzeWorkflowGraph } from "@shared/workflowTopology";
import { Value } from "@sinclair/typebox/value";
import type { CommandContext, ExecResult, IFileSystem } from "just-bash";
import { validateDagWorkflowTemplates } from "../../../dagTemplateValidation";
import { validateCfEdges, validateDag } from "../../../dagValidation";
import {
  addEdge,
  addLoop,
  describeEdge,
  type EditResult,
  META_FIELDS,
  type RawDefinition,
  removeEdge,
  removeStep,
  setMeta,
  setStep,
} from "../../../definitionEdit";
import { getDesignWarnings } from "../../../designWarnings";
import { getOutcomeCoverageWarnings } from "../../../outcomeCoverage";
import { renderOutline } from "../../../outline";
import { type DagWorkflowDefinition, DagWorkflowDefinitionSchema, normalizePrompt } from "../../../schemas";

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

/** `--file`: read the JSON5 content from a file in the work directory instead of an argument. */
const FILE_OPTION = {
  name: "file",
  description: "Read the JSON5 content from this file in the work directory instead of the argument",
};

/** `--branch`: branch key of an edge leaving an if, case, or iterator step. */
const BRANCH_OPTION = {
  name: "branch",
  description: "Branch key (edges leaving an if, case, or iterator step)",
};

/**
 * Builds the `workflow` command handler function.
 *
 * Exported for unit testing - allows injecting a context without
 * booting the full extension system.
 *
 * @param scriptCtx - Skill script context providing the extension base URL and authenticated fetch
 * @param waitOptions - Timing of `workflow wait`
 * @returns A command handler suitable for `registerProgram()`
 */
export function buildWorkflowCommand(scriptCtx: SkillScriptContext, waitOptions: WaitOptions = DEFAULT_WAIT_OPTIONS) {
  return createCommand({
    name: "workflow",
    description: "Manage workflow pipeline JSON5 definitions.",
    subcommands: [
      {
        name: "list",
        description: "List all workflow definitions",
        handler: buildListHandler(scriptCtx),
      },
      {
        name: "step-types",
        description:
          "List all workflow step types (engine and extensions), show one type's fields, examples, and behavior, or search them",
        args: [{ name: "type", required: false, description: "Step type to show in full (e.g. http-request)" }],
        options: [
          {
            name: "search",
            short: "s",
            description: "Only list step types matching all of these keywords (quote several words)",
          },
        ],
        handler: buildStepTypesHandler(scriptCtx),
      },
      {
        name: "read",
        description: "Display the full JSON5 content of a workflow",
        args: [{ name: "name", description: "Workflow name (filename without .json5)" }],
        handler: buildReadHandler(),
      },
      {
        name: "outline",
        description: "Show a workflow's steps, where each leads, and its warnings (does not write)",
        args: [{ name: "name", description: "Workflow name" }],
        handler: buildOutlineHandler(scriptCtx),
      },
      {
        name: "write",
        description: "Create or overwrite a workflow JSON5 file (validates before writing)",
        args: [
          { name: "name", description: "Workflow name (becomes <name>.json5)" },
          { name: "content", required: false, description: "Full JSON5 content of the workflow (or use --file)" },
        ],
        options: [
          {
            name: "draft",
            boolean: true,
            description: "Save as a draft: runnable by hand, but its trigger does not start it until activated",
          },
          FILE_OPTION,
        ],
        handler: buildWriteHandler(scriptCtx),
      },
      {
        name: "set-step",
        description: "Create or replace one step (validates, writes, prints the outline)",
        args: [
          { name: "name", description: "Workflow name" },
          { name: "slug", description: "Step slug" },
          { name: "content", required: false, description: "The whole step as JSON5 (or use --file)" },
        ],
        options: [
          FILE_OPTION,
          { name: "after", description: "Also add an edge from this step to the new one" },
          { name: "branch", description: "Branch of that edge (when --after is an if, case, or iterator step)" },
        ],
        handler: buildSetStepHandler(scriptCtx),
      },
      {
        name: "remove-step",
        description: "Remove one step and every edge from or to it",
        args: [
          { name: "name", description: "Workflow name" },
          { name: "slug", description: "Step slug" },
        ],
        handler: buildRemoveStepHandler(scriptCtx),
      },
      {
        name: "add-edge",
        description: "Add an edge between two steps",
        args: [
          { name: "name", description: "Workflow name" },
          { name: "from", description: "Source step slug" },
          { name: "to", description: "Target step slug" },
        ],
        options: [BRANCH_OPTION],
        handler: buildEdgeHandler(scriptCtx, "add"),
      },
      {
        name: "remove-edge",
        description: "Remove the edge between two steps (only the one with --branch, when given)",
        args: [
          { name: "name", description: "Workflow name" },
          { name: "from", description: "Source step slug" },
          { name: "to", description: "Target step slug" },
        ],
        options: [BRANCH_OPTION],
        handler: buildEdgeHandler(scriptCtx, "remove"),
      },
      {
        name: "set-meta",
        description: `Set ${META_FIELDS.join(", ")} (shallow merge; null removes description or group)`,
        args: [
          { name: "name", description: "Workflow name" },
          { name: "content", description: "JSON5 object with the fields to set" },
        ],
        handler: buildSetMetaHandler(scriptCtx),
      },
      {
        name: "add-loop",
        description:
          "Wrap the steps from --from to --to in an iterator over --over and its aggregator <slug>-done (validates, writes, prints the outline)",
        args: [
          { name: "name", description: "Workflow name" },
          { name: "slug", description: "Slug of the new iterator" },
        ],
        options: [
          { name: "over", description: "The list to iterate over, e.g. {{steps.fetch.result.items}}" },
          { name: "as", description: 'Name of the loop variable (default "item")' },
          { name: "from", description: "First step of the loop body" },
          { name: "to", description: "Last step of the loop body (the same as --from for one step)" },
        ],
        handler: buildAddLoopHandler(scriptCtx),
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
        name: "wait",
        description:
          "Wait until a run completes, fails, or waits for input, then show its per-step logs (instead of polling runs/logs)",
        args: [{ name: "run-id", description: "Workflow run ID" }],
        options: [
          {
            name: "timeout",
            description: `Give up after this many seconds (default ${DEFAULT_WAIT_SECONDS}, at most ${MAX_WAIT_SECONDS})`,
          },
        ],
        handler: buildWaitHandler(scriptCtx, waitOptions),
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
 * Fetches the server's advisory warnings (templates, secrets, trigger refs,
 * outcome coverage, ...) for the given definition. The definition is posted,
 * so the result never reflects a stale copy the server has loaded.
 * Returns null if the server is unavailable.
 */
async function fetchServerWarnings(
  scriptCtx: SkillScriptContext,
  definition: DagWorkflowDefinition,
): Promise<ApiTemplateWarning[] | null> {
  try {
    const resp = await scriptCtx.fetch(`${scriptCtx.baseUrl}/meta/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(definition),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { warnings?: ApiTemplateWarning[] };
    return data.warnings ?? null;
  } catch {
    return null;
  }
}

/**
 * The warnings the sandbox can compute without the server: template
 * expressions, outcome coverage, and agent results read as data.
 */
async function localWarnings(definition: DagWorkflowDefinition): Promise<ApiTemplateWarning[]> {
  return [
    ...(await validateDagWorkflowTemplates(definition, { workflowName: definition.name })),
    ...getOutcomeCoverageWarnings(definition),
    // Without the server no step type schema is known, so only the design
    // warnings that need none are reported here.
    ...getDesignWarnings(definition, () => null),
  ];
}

/**
 * The server's warnings for a definition, or the local ones when the server
 * is unavailable.
 */
async function collectWarnings(
  scriptCtx: SkillScriptContext,
  definition: DagWorkflowDefinition,
): Promise<ApiTemplateWarning[]> {
  return (await fetchServerWarnings(scriptCtx, definition)) ?? (await localWarnings(definition));
}

/**
 * Runs authoritative server-side validation for a workflow definition, which
 * includes custom step-type config checks against registered handler schemas
 * (not available locally in the sandbox). Returns the list of blocking errors,
 * or `null` if the server is unavailable (in which case the caller should fall
 * back to local validation only).
 */
async function fetchServerValidationErrors(
  scriptCtx: SkillScriptContext,
  definition: DagWorkflowDefinition,
): Promise<string[] | null> {
  try {
    const resp = await scriptCtx.fetch(`${scriptCtx.baseUrl}/meta/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(definition),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { valid?: boolean; errors?: string[] };
    return data.errors ?? [];
  } catch {
    return null;
  }
}

/** Outcome of {@link checkDefinition}: the validated definition, or the error output. */
type CheckResult = { ok: true; definition: DagWorkflowDefinition } | { ok: false; stderr: string; codes: string[] };

/**
 * The one validation path of `write`, `validate`, and the editing commands:
 * normalizes prompt arrays (in place), checks the schema, the DAG structure
 * and control-flow edges, then the server's hard errors (custom step-type
 * config, which the sandbox cannot check; skipped when the server is
 * unavailable). Advisory warnings are not part of it.
 *
 * @param scriptCtx - Skill script context (server validation)
 * @param parsed - The parsed definition; prompt arrays are normalized in place
 * @param schemaErrorTitle - Heading of schema errors (`validate` says "Schema validation failed")
 * @returns The validated definition, or the error text plus the structural error codes
 */
async function checkDefinition(
  scriptCtx: SkillScriptContext,
  parsed: Record<string, unknown>,
  schemaErrorTitle = "Validation failed",
): Promise<CheckResult> {
  if (parsed.steps && typeof parsed.steps === "object" && !Array.isArray(parsed.steps)) {
    for (const step of Object.values(parsed.steps as Record<string, Record<string, unknown>>)) {
      if (step?.type === "agent" && Array.isArray(step.prompt)) {
        step.prompt = normalizePrompt(step.prompt as string[]);
      }
    }
  }

  if (!Value.Check(DagWorkflowDefinitionSchema, parsed)) {
    return {
      ok: false,
      stderr: `${schemaErrorTitle}:\n${formatValidationErrors(DagWorkflowDefinitionSchema, parsed, "\n")}`,
      codes: [],
    };
  }

  // Structural DAG validation (cycles, connectivity, CF-edge rules)
  const definition = parsed as unknown as DagWorkflowDefinition;
  const structuralErrors = [...validateDag(definition), ...validateCfEdges(definition)];
  if (structuralErrors.length > 0) {
    return {
      ok: false,
      stderr: `DAG validation failed:\n${structuralErrors.map((e) => `  ${e.message}`).join("\n")}`,
      codes: structuralErrors.map((e) => e.code),
    };
  }

  // Authoritative server-side validation (includes custom step-type config
  // checks against registered handler schemas, which are not available
  // locally). If the server is unavailable, the local checks above stand.
  const serverErrors = await fetchServerValidationErrors(scriptCtx, definition);
  if (serverErrors && serverErrors.length > 0) {
    return { ok: false, stderr: `Validation failed:\n${serverErrors.map((e) => `  ${e}`).join("\n")}`, codes: [] };
  }

  return { ok: true, definition };
}

/**
 * Formats advisory warnings into a human-readable block for shell output.
 */
function formatWarnings(warnings: ApiTemplateWarning[]): string {
  if (warnings.length === 0) return "";
  const lines = warnings.map((w) => `  [${w.stepSlug}.${w.field}] ${w.message}`);
  return `\nWarnings:\n${lines.join("\n")}`;
}

/**
 * Fetches why workflow files are not loaded by the server.
 *
 * @param scriptCtx - Skill script context
 * @returns The load errors by file name; empty when the server cannot be asked
 */
async function fetchLoadErrors(scriptCtx: SkillScriptContext): Promise<Map<string, WorkflowLoadError>> {
  try {
    const resp = await scriptCtx.fetch(`${scriptCtx.baseUrl}/meta/load-errors`);
    if (!resp.ok) return new Map();
    const errors = (await resp.json()) as WorkflowLoadError[];
    return new Map(errors.map((e) => [e.file, e]));
  } catch {
    return new Map();
  }
}

function buildListHandler(scriptCtx: SkillScriptContext) {
  return async (ctx: CommandContext): Promise<ExecResult> => {
    const { fs, cwd } = ctx;
    await ensureDir(fs, cwd);
    const dir = getWorkflowsDir(fs, cwd);
    const allEntries = await fs.readdir(dir);
    const entries = allEntries.filter((e) => e.endsWith(".json5")).sort();

    if (entries.length === 0) {
      return { exitCode: 0, stdout: `No workflows found in ${dir}`, stderr: "" };
    }

    const loadErrors = await fetchLoadErrors(scriptCtx);
    const lines: string[] = ["Workflows:"];
    for (const entry of entries) {
      const loadError = loadErrors.get(entry);
      if (loadError) {
        lines.push(`  ${loadError.name ?? "(unnamed)"} (${entry}) - NOT LOADED: ${loadError.error}`);
        continue;
      }
      try {
        const content = await fs.readFile(fs.resolvePath(dir, entry));
        const parsed = Bun.JSON5.parse(content) as Record<string, unknown>;
        const name = (parsed?.name as string) ?? "(unnamed)";
        const stepCount =
          parsed?.steps && typeof parsed.steps === "object" && !Array.isArray(parsed.steps)
            ? Object.keys(parsed.steps as Record<string, unknown>).length
            : 0;
        const trigger = (parsed?.trigger as Record<string, unknown>)?.type ?? "?";
        const enabled = parsed?.enabled !== false;
        const status = !enabled ? " [disabled]" : parsed?.draft === true ? " [draft]" : "";
        lines.push(`  ${name} (${entry}) - ${stepCount} steps, trigger: ${trigger}${status}`);
      } catch {
        lines.push(`  ${entry} - (parse error)`);
      }
    }
    lines.push("", "Use `workflow read <name>` to read a workflow definition.");
    if (loadErrors.size > 0) {
      lines.push(
        "Files marked NOT LOADED cannot run and their triggers do not fire until fixed; `workflow validate <name>` checks a fix.",
      );
    }

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

/**
 * Tells whether the workflow file at a path currently holds a draft.
 *
 * @param fs - The sandbox filesystem
 * @param filePath - Resolved path of the workflow file
 * @returns True when the file exists, parses, and has `draft: true`
 */
async function isDraftOnDisk(fs: IFileSystem, filePath: string): Promise<boolean> {
  try {
    if (!(await fs.exists(filePath))) return false;
    const existing = Bun.JSON5.parse(await fs.readFile(filePath)) as Record<string, unknown> | null;
    return existing?.draft === true;
  } catch {
    return false;
  }
}

function buildWriteHandler(scriptCtx: SkillScriptContext) {
  return async (ctx: CommandContext, args: ParsedArgs): Promise<ExecResult> => {
    const { fs, cwd } = ctx;
    const name = args.get("name");
    const source = await readContentSource(ctx, args, "content");
    if (!source.ok) return { exitCode: 1, stdout: "", stderr: source.stderr };
    const content = source.text;

    await ensureDir(fs, cwd);

    // Validate before writing
    let parsed: Record<string, unknown>;
    try {
      parsed = Bun.JSON5.parse(content) as Record<string, unknown>;
    } catch (err) {
      return { exitCode: 1, stdout: "", stderr: `JSON5 parse error: ${(err as Error).message}` };
    }

    // `--draft` marks the workflow as a draft. A workflow that is already a
    // draft on disk stays one whatever the new content says: rewriting it (e.g.
    // to fix it after a test run) must not put it live. Only the user activates.
    const dir = getWorkflowsDir(fs, cwd);
    const filePath = fs.resolvePath(dir, `${name}.json5`);
    const keptDraft = !args.flag("draft") && (await isDraftOnDisk(fs, filePath));
    if ((args.flag("draft") || keptDraft) && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      parsed.draft = true;
    }

    const checked = await checkDefinition(scriptCtx, parsed);
    if (!checked.ok) return { exitCode: 1, stdout: "", stderr: checked.stderr };
    const { definition } = checked;

    await fs.writeFile(filePath, `${Bun.JSON5.stringify(parsed, null, 2)}`);

    // Advisory warnings for the definition just written (server-side when
    // available, which adds secret and trigger-ref checks)
    const warnings = await collectWarnings(scriptCtx, definition);
    const warningOutput = formatWarnings(warnings);
    const draftNote = keptDraft ? "\nIt was a draft and stays one; the user activates it in the workflow editor." : "";

    return {
      exitCode: 0,
      stdout: `Workflow "${name}" written to ${filePath}${draftNote}${warningOutput}`,
      stderr: "",
    };
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

    const checked = await checkDefinition(scriptCtx, parsed, "Schema validation failed");
    if (!checked.ok) return { exitCode: 1, stdout: "", stderr: checked.stderr };
    const { definition } = checked;

    // Advisory warnings (server-side when available, else local)
    const warnings = await collectWarnings(scriptCtx, definition);

    const stepCount = Object.keys(definition.steps).length;
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

/**
 * Reads JSON5 content from the `content` argument or from `--file` (a file in
 * the work directory, read through the sandbox filesystem). Exactly one of the
 * two must be given.
 *
 * @param ctx - Command context (filesystem and working directory)
 * @param args - Parsed arguments with `content` and the `file` option
 * @param what - What the content is, for messages
 * @returns The text, or the error output
 */
async function readContentSource(
  ctx: CommandContext,
  args: ParsedArgs,
  what: string,
): Promise<{ ok: true; text: string } | { ok: false; stderr: string }> {
  const content = args.get("content");
  const file = args.option("file");
  if (content && file) {
    return { ok: false, stderr: `Error: Give the ${what} either as an argument or with --file, not both` };
  }
  if (!content && !file) {
    return { ok: false, stderr: `Error: Missing ${what}: pass it as an argument or with --file "<path>"` };
  }
  if (content) return { ok: true, text: content };
  const path = ctx.fs.resolvePath(ctx.cwd, file);
  if (!(await ctx.fs.exists(path))) return { ok: false, stderr: `Error: File "${file}" not found` };
  try {
    return { ok: true, text: await ctx.fs.readFile(path) };
  } catch (err) {
    return { ok: false, stderr: `Error reading file "${file}": ${(err as Error).message}` };
  }
}

/**
 * Loads and parses a workflow file.
 *
 * @param ctx - Command context
 * @param name - Workflow name
 * @returns The file path and parsed definition, or the error output
 */
async function loadDefinition(
  ctx: CommandContext,
  name: string,
): Promise<{ ok: true; filePath: string; parsed: RawDefinition } | { ok: false; stderr: string }> {
  const filePath = ctx.fs.resolvePath(getWorkflowsDir(ctx.fs, ctx.cwd), `${name}.json5`);
  if (!(await ctx.fs.exists(filePath))) {
    return { ok: false, stderr: `Error: Workflow "${name}" not found at ${filePath}` };
  }
  try {
    const parsed = Bun.JSON5.parse(await ctx.fs.readFile(filePath));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, stderr: `Error: Workflow "${name}" is not a JSON5 object` };
    }
    return { ok: true, filePath, parsed: parsed as RawDefinition };
  } catch (err) {
    return { ok: false, stderr: `JSON5 syntax error: ${(err as Error).message}` };
  }
}

/** What to change first, per structural error code of a refused edit. */
const EDIT_HINTS: Record<string, string> = {
  orphaned_step:
    'Every step needs an edge: create a new step with --after "<slug>"; before removing a step in the middle, connect its neighbors with add-edge.',
  unreachable_steps: "Connect the unreachable steps to the rest of the workflow with add-edge first.",
  invalid_case_branch:
    "An edge uses a branch the case does not declare. To rename a path, go in this order: set-step the case with the new path next to the old one, add-edge with the new --branch, remove-edge with the old --branch, then set-step the case without the old path.",
  invalid_if_branch: 'Edges leaving an if step take --branch "then" or "else".',
  invalid_iterator_branch: 'Edges leaving an iterator take --branch "each".',
  cf_node_unconditional_edge: "Edges leaving an if, case, or iterator step need --branch.",
  non_cf_edge_has_branch: "Only edges leaving an if, case, or iterator step take --branch.",
  cycle_detected: "That edge would create a cycle; workflows must not loop back.",
};

/**
 * The root steps (no incoming edge) of a definition that may not be valid yet.
 *
 * @param definition - The parsed definition
 * @returns The root slugs (empty when steps or edges are malformed)
 */
function rootsOf(definition: RawDefinition): Set<string> {
  const { steps, edges } = definition;
  if (!steps || typeof steps !== "object" || Array.isArray(steps) || !Array.isArray(edges)) return new Set();
  const wellFormed = edges.filter(
    (e): e is { from: string; to: string } => typeof e?.from === "string" && typeof e?.to === "string",
  );
  return new Set(analyzeWorkflowGraph(steps as Record<string, { type?: unknown }>, wellFormed).roots);
}

/**
 * Applies one edit to a workflow file: load, edit, validate with
 * {@link checkDefinition}, write only when there is no hard error, then print
 * the outline with the warnings. Every field the edit does not touch
 * (including `draft`) is carried over. Notes are printed before the outline,
 * `after` lines below it.
 *
 * @param scriptCtx - Skill script context
 * @param ctx - Command context
 * @param name - Workflow name
 * @param edit - The edit; may return notes to print before and lines to print after the outline
 * @returns The command result
 */
async function runEdit(
  scriptCtx: SkillScriptContext,
  ctx: CommandContext,
  name: string,
  edit: (definition: RawDefinition) => EditResult & { notes?: string[]; after?: string[] },
): Promise<ExecResult> {
  const loaded = await loadDefinition(ctx, name);
  if (!loaded.ok) return { exitCode: 1, stdout: "", stderr: loaded.stderr };

  const edited = edit(loaded.parsed);
  if (!edited.ok) return { exitCode: 1, stdout: "", stderr: `Error: ${edited.error}\nNothing was written.` };

  const checked = await checkDefinition(scriptCtx, edited.definition);
  if (!checked.ok) {
    const hints = [...new Set(checked.codes.map((c) => EDIT_HINTS[c]).filter(Boolean))];
    const hintText = hints.length > 0 ? `\n${hints.join("\n")}` : "";
    return { exitCode: 1, stdout: "", stderr: `${checked.stderr}${hintText}\nNothing was written.` };
  }

  await ctx.fs.writeFile(loaded.filePath, `${Bun.JSON5.stringify(edited.definition, null, 2)}`);
  const warnings = await collectWarnings(scriptCtx, checked.definition);
  const notes = [...(edited.notes ?? [])];
  // An existing step that lost its last incoming edge is a second root now:
  // valid, but it runs at the start of every run.
  const rootsBefore = rootsOf(loaded.parsed);
  const stepsBefore = (loaded.parsed.steps ?? {}) as object;
  for (const slug of rootsOf(edited.definition)) {
    if (Object.hasOwn(stepsBefore, slug) && !rootsBefore.has(slug)) {
      notes.push(
        `Note: step "${slug}" has no incoming edge now, so it runs at the start of every run. If that is not intended, connect it with add-edge.`,
      );
    }
  }
  if (checked.definition.draft !== true && checked.definition.enabled !== false) {
    notes.push("The workflow is active: this change is live.");
  }
  const noteText = notes.map((n) => `\n${n}`).join("");
  return {
    exitCode: 0,
    stdout: `Workflow "${name}" updated.${noteText}\n\n${renderOutline(checked.definition, warnings)}${
      edited.after?.length ? `\n\n${edited.after.join("\n")}` : ""
    }`,
    stderr: "",
  };
}

function buildOutlineHandler(scriptCtx: SkillScriptContext) {
  return async (ctx: CommandContext, args: ParsedArgs): Promise<ExecResult> => {
    const name = args.get("name");
    const loaded = await loadDefinition(ctx, name);
    if (!loaded.ok) return { exitCode: 1, stdout: "", stderr: loaded.stderr };
    const checked = await checkDefinition(scriptCtx, loaded.parsed, "Schema validation failed");
    if (!checked.ok) return { exitCode: 1, stdout: "", stderr: checked.stderr };
    const warnings = await collectWarnings(scriptCtx, checked.definition);
    return { exitCode: 0, stdout: renderOutline(checked.definition, warnings), stderr: "" };
  };
}

function buildSetStepHandler(scriptCtx: SkillScriptContext) {
  return async (ctx: CommandContext, args: ParsedArgs): Promise<ExecResult> => {
    const slug = args.get("slug");
    const after = args.option("after");
    const branch = args.option("branch") || undefined;
    if (branch && !after) return { exitCode: 1, stdout: "", stderr: "Error: --branch needs --after" };

    const source = await readContentSource(ctx, args, "step");
    if (!source.ok) return { exitCode: 1, stdout: "", stderr: source.stderr };
    let step: unknown;
    try {
      step = Bun.JSON5.parse(source.text);
    } catch (err) {
      return { exitCode: 1, stdout: "", stderr: `JSON5 parse error: ${(err as Error).message}` };
    }

    return runEdit(scriptCtx, ctx, args.get("name"), (definition) => {
      const existed = Object.hasOwn((definition.steps ?? {}) as object, slug);
      const set = setStep(definition, slug, step);
      if (!set.ok) return set;
      const notes = [`Step "${slug}" ${existed ? "replaced" : "created"}.`];
      if (!after) return { ...set, notes };
      const edges = Array.isArray(set.definition.edges) ? (set.definition.edges as Record<string, unknown>[]) : [];
      if (edges.some((e) => e.from === after && e.to === slug && (e.branch || undefined) === branch)) {
        notes.push(`Edge ${describeEdge(after, slug, branch)} already exists; not added again.`);
        return { ...set, notes };
      }
      const linked = addEdge(set.definition, after, slug, branch);
      return linked.ok ? { ...linked, notes: [...notes, `Edge ${describeEdge(after, slug, branch)} added.`] } : linked;
    });
  };
}

function buildRemoveStepHandler(scriptCtx: SkillScriptContext) {
  return async (ctx: CommandContext, args: ParsedArgs): Promise<ExecResult> => {
    const slug = args.get("slug");
    return runEdit(scriptCtx, ctx, args.get("name"), (definition) => {
      const removed = removeStep(definition, slug);
      return removed.ok ? { ...removed, notes: [`Step "${slug}" and its edges removed.`] } : removed;
    });
  };
}

function buildEdgeHandler(scriptCtx: SkillScriptContext, mode: "add" | "remove") {
  return async (ctx: CommandContext, args: ParsedArgs): Promise<ExecResult> => {
    const from = args.get("from");
    const to = args.get("to");
    const branch = args.option("branch") || undefined;
    return runEdit(scriptCtx, ctx, args.get("name"), (definition) => {
      const result = mode === "add" ? addEdge(definition, from, to, branch) : removeEdge(definition, from, to, branch);
      const verb = mode === "add" ? "added" : "removed";
      return result.ok ? { ...result, notes: [`Edge ${describeEdge(from, to, branch)} ${verb}.`] } : result;
    });
  };
}

/**
 * Collects every string inside a JSON-like value.
 *
 * @param value - A step definition or part of one
 * @param into - Receives the strings
 */
function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, into);
  else if (value && typeof value === "object") for (const v of Object.values(value)) collectStrings(v, into);
}

/** Escapes a string for use inside a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches a reference to a step's result: `steps.<slug>.result` or
 * `steps["<slug>"].result`, where the slug is not the start of a longer one.
 *
 * @param slug - The step slug
 * @returns The pattern
 */
function resultRefPattern(slug: string): RegExp {
  const name = escapeRegExp(slug);
  return new RegExp(`steps(?:\\.${name}|\\[\\s*["']${name}["']\\s*\\])\\.result\\b`);
}

function buildAddLoopHandler(scriptCtx: SkillScriptContext) {
  return async (ctx: CommandContext, args: ParsedArgs): Promise<ExecResult> => {
    const slug = args.get("slug");
    const over = args.option("over");
    const from = args.option("from");
    const to = args.option("to");
    const as = args.option("as") || undefined;
    const missing = [!over && "--over", !from && "--from", !to && "--to"].filter(Boolean);
    if (missing.length > 0) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Error: add-loop needs ${missing.join(", ")}. Example: workflow add-loop "<name>" "each-item" --over "{{steps.<slug>.result.<list>}}" --as item --from "<first-body-step>" --to "<last-body-step>"`,
      };
    }
    return runEdit(scriptCtx, ctx, args.get("name"), (definition) => {
      const result = addLoop(definition, { slug, over, as, from, to });
      if (!result.ok) return result;
      const alias = as ?? "item";
      const steps = result.definition.steps as Record<string, unknown>;
      const stringsOf = (slug: string): string[] => {
        const strings: string[] = [];
        collectStrings(steps[slug], strings);
        return strings;
      };
      const results = `{{steps.${result.aggregator}.result.results}}`;
      // The list path, not followed by more of a name (`messagesCount`) or a member (`.length`).
      const overRef = new RegExp(`${escapeRegExp(result.over.slice(2, -2))}(?![\\w$.-])`);
      const stale = result.body.filter((s) => stringsOf(s).some((text) => overRef.test(text)));
      // Steps after the loop that read a body step get only the last pass's result.
      const loopSteps = new Set([...result.body, slug, result.aggregator]);
      const outsideReaders = Object.keys(steps)
        .filter((s) => !loopSteps.has(s))
        .flatMap((reader) => {
          const texts = stringsOf(reader);
          const read = result.body.filter((b) => texts.some((text) => resultRefPattern(b).test(text)));
          return read.length > 0 ? [{ reader, read }] : [];
        });
      const after = [
        stale.length + outsideReaders.length > 0 ? "Loop added. Now change these steps:" : "Loop added.",
        ...stale.map((s) => `- Replace ${result.over} in "${s}" with {{${alias}}} or {{${alias}.<field>}}.`),
        ...outsideReaders.map(
          ({ reader, read }) =>
            `- "${reader}" is after the loop but reads ${read.map((b) => `"${b}"`).join(", ")}. Move it into the loop, or read ${results}.`,
        ),
        `- Results of all passes: ${results}.`,
      ];
      return {
        ok: true,
        definition: result.definition,
        notes: [
          `Iterator "${slug}" and aggregator "${result.aggregator}" added around ${result.body.map((s) => `"${s}"`).join(", ")}.`,
        ],
        after,
      };
    });
  };
}

function buildSetMetaHandler(scriptCtx: SkillScriptContext) {
  return async (ctx: CommandContext, args: ParsedArgs): Promise<ExecResult> => {
    let patch: unknown;
    try {
      patch = Bun.JSON5.parse(args.get("content"));
    } catch (err) {
      return { exitCode: 1, stdout: "", stderr: `JSON5 parse error: ${(err as Error).message}` };
    }
    return runEdit(scriptCtx, ctx, args.get("name"), (definition) => setMeta(definition, patch));
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

/** A single JSON Schema property definition (subset we render). */
interface SchemaProperty {
  type?: string;
  description?: string;
  title?: string;
  const?: unknown;
  anyOf?: SchemaProperty[];
  items?: SchemaProperty;
  properties?: Record<string, SchemaProperty>;
  required?: string[];
  /** Name of the provider whose live values the server put into `availableItems`. */
  dynamicItems?: string;
  availableItems?: unknown[];
}

/** An object JSON Schema (subset we render). */
interface ObjectSchema {
  properties?: Record<string, SchemaProperty>;
  required?: string[];
}

/** Response shape for a single entry from GET /ext/workflows/meta/step-types */
interface StepTypeMetaEntry {
  type: string;
  label: string;
  description?: string;
  docs?: string;
  extensionName: string;
  terminal?: boolean;
  category?: string;
  configSchema?: ObjectSchema;
  outputSchema?: ObjectSchema;
}

/** Owner of the engine-evaluated step types, listed first in the index. */
const ENGINE_OWNER = "workflows";

/**
 * Describes a JSON Schema property's type for a field line, e.g. `string`,
 * `array of string`, `"GET" | "POST"` for a union of literals, or
 * `string | null` for a union of types.
 *
 * @param def - The property schema
 * @returns A short type description (`any` when none is declared)
 */
function describeType(def: SchemaProperty | undefined): string {
  if (def?.anyOf?.length) {
    const members = def.anyOf.map((v) => (v.const !== undefined ? JSON.stringify(v.const) : describeType(v)));
    return [...new Set(members)].join(" | ");
  }
  if (def?.type === "array" && def.items) return `array of ${describeType(def.items)}`;
  return def?.type ?? "any";
}

/** How many levels of fields `workflow step-types <type>` prints: the top-level fields and two levels below. */
const MAX_FIELD_DEPTH = 3;

/** How many live values of a `dynamicItems` field `workflow step-types <type>` lists. */
const MAX_LIVE_VALUES = 30;

/**
 * Lists the values a field accepts right now, for a field whose values come
 * from the running system (`dynamicItems`, e.g. connected accounts or table
 * names). The server resolves them into `availableItems`. Static suggestion
 * lists are not printed: they are long and the description covers them.
 *
 * @param def - The property schema
 * @returns The line to print under the field, or `undefined` when the field has no live values
 */
function formatLiveValues(def: SchemaProperty | undefined): string | undefined {
  if (typeof def?.dynamicItems !== "string" || !Array.isArray(def.availableItems)) return undefined;
  const values = def.availableItems.map((v) => JSON.stringify(v));
  if (values.length === 0) return "available now: none (nothing set up yet)";
  const shown = values.slice(0, MAX_LIVE_VALUES).join(", ");
  const more = values.length > MAX_LIVE_VALUES ? `, ... (${values.length - MAX_LIVE_VALUES} more)` : "";
  return `available now: ${shown}${more}`;
}

/**
 * Finds the object schema whose fields belong under a field line: the field
 * itself, or the only object member of a union such as `object | null`.
 *
 * @param def - The property schema
 * @returns The schema with `properties`, or `undefined` when there is none
 */
function objectFieldsOf(def: SchemaProperty | undefined): SchemaProperty | undefined {
  if (def?.properties && Object.keys(def.properties).length > 0) return def;
  const members = (def?.anyOf ?? []).filter((v) => v.properties && Object.keys(v.properties).length > 0);
  return members.length === 1 ? members[0] : undefined;
}

/**
 * Finds the item schema of an array of objects (also inside a union such as
 * `array | null`).
 *
 * @param def - The property schema
 * @returns The item schema with `properties`, or `undefined` when the field is not an array of objects
 */
function arrayItemFieldsOf(def: SchemaProperty | undefined): SchemaProperty | undefined {
  if (def?.type === "array") return objectFieldsOf(def.items);
  const arrays = (def?.anyOf ?? []).filter((v) => v.type === "array");
  return arrays.length === 1 ? objectFieldsOf(arrays[0]?.items) : undefined;
}

/**
 * Formats an object schema into per-field description lines, e.g.:
 *
 *   - command (string, required): Shell command to execute in the sandbox...
 *   - skills (array of string): Skill names to mount...
 *
 * Includes each field's `description` (falling back to `title`) so an author
 * knows what to put in each field without opening the extension source. Returns
 * an empty array when the schema declares no properties.
 *
 * The fields of a nested object, and of the items of an array of objects
 * (under an `each item:` line), follow their parent line, indented four more
 * spaces. Below {@link MAX_FIELD_DEPTH} levels a `...` line stands in for
 * the fields that are cut.
 *
 * @param schema - The serialized JSON Schema (a step's config or result)
 * @param indent - Leading whitespace applied to each rendered line
 * @param depth - Level of these fields (1 for the top-level fields)
 * @returns The formatted lines: one per field, plus the lines of nested fields
 */
function formatSchemaFields(schema: ObjectSchema | undefined, indent: string, depth = 1): string[] {
  const properties = schema?.properties;
  if (!properties || typeof properties !== "object") return [];
  const required = new Set(schema?.required ?? []);
  const nestedIndent = `${indent}    `;
  const lines: string[] = [];
  for (const [key, def] of Object.entries(properties)) {
    const req = required.has(key) ? ", required" : "";
    const desc = def?.description ?? def?.title;
    const descSuffix = desc ? `: ${desc}` : "";
    lines.push(`${indent}- ${key} (${describeType(def)}${req})${descSuffix}`);
    const live = formatLiveValues(def);
    if (live) lines.push(`${nestedIndent}${live}`);

    const items = arrayItemFieldsOf(def);
    const nested = items ?? objectFieldsOf(def);
    if (!nested) continue;
    if (depth >= MAX_FIELD_DEPTH) {
      lines.push(`${nestedIndent}...`);
      continue;
    }
    if (items) lines.push(`${nestedIndent}each item:`);
    lines.push(...formatSchemaFields(nested, nestedIndent, depth + 1));
  }
  return lines;
}

/**
 * Tells the author how to read the item fields of each result field that is
 * a list of objects, once a loop runs over it.
 *
 * @param schema - The step type's result schema
 * @returns One line per top-level array-of-objects field
 */
function formatIteratorHints(schema: ObjectSchema | undefined): string[] {
  return Object.entries(schema?.properties ?? {})
    .filter(([, def]) => arrayItemFieldsOf(def))
    .map(([key]) => `Inside an iterator over ${key} with as: "item", read these as {{item.<field>}}.`);
}

/**
 * Renders the compact index: one line per step type, grouped by owning
 * extension (engine types first).
 *
 * @param entries - The step types to list
 * @returns The index lines
 */
function formatStepTypeIndex(entries: StepTypeMetaEntry[]): string[] {
  const groups = new Map<string, StepTypeMetaEntry[]>();
  for (const entry of entries) {
    groups.set(entry.extensionName, [...(groups.get(entry.extensionName) ?? []), entry]);
  }
  const owners = [...groups.keys()].sort((a, b) =>
    a === ENGINE_OWNER ? -1 : b === ENGINE_OWNER ? 1 : a.localeCompare(b),
  );
  const width = typeColumnWidth(entries);
  const lines: string[] = [];
  for (const owner of owners) {
    lines.push("", owner === ENGINE_OWNER ? "Engine (agent and control flow):" : `From extension ${owner}:`);
    for (const entry of groups.get(owner) ?? []) lines.push(formatIndexLine(entry, width));
  }
  return lines;
}

/**
 * Renders search results as a flat list in rank order, naming each type's owner.
 *
 * @param entries - The matching step types, best first
 * @returns The result lines
 */
function formatStepTypeMatches(entries: StepTypeMetaEntry[]): string[] {
  const width = typeColumnWidth(entries);
  return entries.map((entry) => `${formatIndexLine(entry, width)} (${entry.extensionName})`);
}

/** Width of the type column: the longest type plus a gap. */
function typeColumnWidth(entries: StepTypeMetaEntry[]): number {
  return Math.max(0, ...entries.map((e) => e.type.length)) + 2;
}

/** One index line: type, description (or label), and the terminal flag. */
function formatIndexLine(entry: StepTypeMetaEntry, width: number): string {
  const terminal = entry.terminal ? " [terminal]" : "";
  return `  ${entry.type.padEnd(width)}${entry.description ?? entry.label}${terminal}`;
}

/**
 * Renders the full reference of one step type: summary, config fields,
 * result fields, and the Markdown docs.
 *
 * @param entry - The step type
 * @returns The rendered reference
 */
function formatStepTypeDetail(entry: StepTypeMetaEntry): string {
  const flags = [entry.terminal ? "terminal" : "", entry.category ?? ""].filter(Boolean).join(", ");
  const lines = [`${entry.type} - ${entry.label} (from ${entry.extensionName})${flags ? ` [${flags}]` : ""}`];
  if (entry.description) lines.push(entry.description);

  const configLines = formatSchemaFields(entry.configSchema, "  ");
  if (configLines.length > 0) lines.push("", "Config fields:", ...configLines);

  const resultLines = formatSchemaFields(entry.outputSchema, "  ");
  if (resultLines.length > 0) {
    lines.push("", "Result fields ({{steps.<slug>.result.<field>}}):", ...resultLines);
    lines.push(...formatIteratorHints(entry.outputSchema));
  } else if (entry.outputSchema) lines.push("", "Produces a result ({{steps.<slug>.result}}).");

  if (entry.docs?.trim()) lines.push("", entry.docs.trim());
  return lines.join("\n");
}

/**
 * Ranks step types against search terms. Every term must occur (case-
 * insensitively) in the type, label, description, owning extension, a config
 * field name or description, or the docs. Matches in the type, label, or
 * description rank before matches found only in fields or docs.
 *
 * @param entries - The step types to search
 * @param query - Whitespace-separated search terms
 * @returns The matching step types, best first
 */
function searchStepTypes(entries: StepTypeMetaEntry[], query: string): StepTypeMetaEntry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored: Array<{ entry: StepTypeMetaEntry; score: number }> = [];
  for (const entry of entries) {
    const summary = [entry.type, entry.label, entry.description ?? "", entry.extensionName].join(" ").toLowerCase();
    const fields = Object.entries(entry.configSchema?.properties ?? {}).map(
      ([key, def]) => `${key} ${def?.title ?? ""} ${def?.description ?? ""}`,
    );
    const detail = [...fields, entry.docs ?? ""].join(" ").toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (summary.includes(term)) score += 2;
      else if (detail.includes(term)) score += 1;
      else {
        score = -1;
        break;
      }
    }
    if (score >= 0) scored.push({ entry, score });
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.entry);
}

function buildStepTypesHandler(scriptCtx: SkillScriptContext) {
  return async (_ctx: CommandContext, args: ParsedArgs): Promise<ExecResult> => {
    let entries: StepTypeMetaEntry[];
    try {
      const resp = await scriptCtx.fetch(`${scriptCtx.baseUrl}/meta/step-types`);
      if (!resp.ok) {
        return { exitCode: 1, stdout: "", stderr: `Error: HTTP ${resp.status} fetching step types` };
      }
      entries = (await resp.json()) as StepTypeMetaEntry[];
    } catch (err) {
      return { exitCode: 1, stdout: "", stderr: formatFetchError(err as Error) };
    }

    const type = args.get("type");
    if (type) {
      const entry = entries.find((e) => e.type === type);
      if (entry) return { exitCode: 0, stdout: formatStepTypeDetail(entry), stderr: "" };
      const similar = searchStepTypes(entries, type)
        .map((e) => e.type)
        .slice(0, 5);
      const hint = similar.length > 0 ? ` Similar: ${similar.join(", ")}.` : "";
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Error: Unknown step type "${type}".${hint} Run 'workflow step-types' for the full list.`,
      };
    }

    const query = args.option("search").trim();
    if (query) {
      const matches = searchStepTypes(entries, query);
      if (matches.length === 0) {
        return {
          exitCode: 0,
          stdout: `No step types match "${query}". Run 'workflow step-types' for the full list.`,
          stderr: "",
        };
      }
      const lines = [`Step types matching "${query}" (best first):`, ...formatStepTypeMatches(matches)];
      lines.push("", "Run 'workflow step-types <type>' for fields, examples, and behavior.");
      return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
    }

    const lines = [`Available workflow step types (${entries.length}):`, ...formatStepTypeIndex(entries)];
    lines.push(
      "",
      "Run 'workflow step-types <type>' for fields, examples, and behavior.",
      "Run 'workflow step-types --search <terms>' to find step types by keyword.",
    );
    return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
  };
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
        // A broken file comes back with the reason (`loadError`); say that instead of "not found".
        const { error, loadError } = result as { error?: string; loadError?: WorkflowLoadError };
        const message = loadError && error ? error : `Workflow "${name}" not found`;
        return { exitCode: 1, stdout: "", stderr: `Error: ${message}` };
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

/**
 * Fetches a run's per-step logs and renders them as `workflow logs` prints them.
 *
 * @param scriptCtx - Skill script context
 * @param runId - The run ID
 * @returns The rendered logs, or `null` when the run does not exist
 * @throws When the server cannot be reached
 */
async function fetchRunLogsText(scriptCtx: SkillScriptContext, runId: string): Promise<string | null> {
  const resp = await scriptCtx.fetch(`${scriptCtx.baseUrl}/runs/${encodeURIComponent(runId)}/logs`);
  if (!resp.ok) return null;
  const result = (await resp.json()) as WorkflowRunLogsResponse;
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
  return lines.join("\n");
}

function buildLogsHandler(scriptCtx: SkillScriptContext) {
  return async (_ctx: CommandContext, args: ParsedArgs): Promise<ExecResult> => {
    const runId = args.get("run-id");
    try {
      const text = await fetchRunLogsText(scriptCtx, runId);
      if (text === null) return { exitCode: 1, stdout: "", stderr: `Error: Run "${runId}" not found` };
      return { exitCode: 0, stdout: text, stderr: "" };
    } catch (err) {
      return { exitCode: 1, stdout: "", stderr: formatFetchError(err as Error) };
    }
  };
}

/** How long `workflow wait` waits when `--timeout` is not given, in seconds. */
const DEFAULT_WAIT_SECONDS = 300;

/** The longest `--timeout` `workflow wait` accepts, in seconds. */
const MAX_WAIT_SECONDS = 1800;

/** Timing of `workflow wait`; tests shorten the poll interval. */
export interface WaitOptions {
  /** Pause between two status checks, in milliseconds. */
  pollIntervalMs: number;
}

const DEFAULT_WAIT_OPTIONS: WaitOptions = { pollIntervalMs: 2000 };

/**
 * Sleeps for a while, ending early when the signal aborts.
 *
 * @param ms - How long to sleep
 * @param signal - Aborts the sleep (the command was cancelled)
 */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Describes what each step that waits for input waits for.
 *
 * @param run - The run, as `GET /runs/:runId` describes it
 * @returns One line per waiting step
 */
function describeWaitingSteps(run: WorkflowRunResponse): string[] {
  return run.steps
    .filter((s) => s.status === "waiting-signal")
    .map((s) => {
      if (s.humanTask) {
        const who = [...s.humanTask.assignees.users, ...s.humanTask.assignees.roles.map((r) => `role ${r}`)];
        const assignees = who.length > 0 ? ` assigned to ${who.join(", ")}` : "";
        return `  ${s.slug}: human task "${s.humanTask.title}"${assignees} (answered in the portal)`;
      }
      return `  ${s.slug}: signal "${s.waitEvent ?? "?"}"`;
    });
}

function buildWaitHandler(scriptCtx: SkillScriptContext, options: WaitOptions) {
  return async (ctx: CommandContext, args: ParsedArgs): Promise<ExecResult> => {
    const runId = args.get("run-id");
    const timeoutRaw = args.option("timeout");
    const timeoutSeconds = timeoutRaw ? Number(timeoutRaw) : DEFAULT_WAIT_SECONDS;
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > MAX_WAIT_SECONDS) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Error: --timeout must be a number of seconds above 0 and at most ${MAX_WAIT_SECONDS}`,
      };
    }
    const deadline = Date.now() + timeoutSeconds * 1000;
    const signal = (ctx as { signal?: AbortSignal }).signal;

    try {
      for (;;) {
        const resp = await scriptCtx.fetch(`${scriptCtx.baseUrl}/runs/${encodeURIComponent(runId)}`);
        if (resp.status === 404) return { exitCode: 1, stdout: "", stderr: `Error: Run "${runId}" not found` };
        if (!resp.ok) return { exitCode: 1, stdout: "", stderr: `Error: HTTP ${resp.status} reading run "${runId}"` };
        const run = (await resp.json()) as WorkflowRunResponse;

        if (run.status === "completed" || run.status === "failed") {
          const logs = (await fetchRunLogsText(scriptCtx, runId)) ?? "";
          const reason = run.failureReason ? `\nReason: ${run.failureReason}` : "";
          return {
            exitCode: run.status === "completed" ? 0 : 1,
            stdout: `Run ${runId} of "${run.workflowName}" ${run.status}.${reason}\n\n${logs}`,
            stderr: "",
          };
        }

        if (run.status === "waiting-signal") {
          const waiting = describeWaitingSteps(run);
          return {
            exitCode: 0,
            stdout: [
              `Run ${runId} of "${run.workflowName}" is waiting for input; it continues when that arrives:`,
              ...waiting,
              "",
              `Run \`workflow wait "${runId}"\` again once it has arrived, or \`workflow logs "${runId}"\` for the steps so far.`,
            ].join("\n"),
            stderr: "",
          };
        }

        if (signal?.aborted || Date.now() + options.pollIntervalMs > deadline) {
          const steps = run.steps.map((s) => `  ${s.slug} [${s.status}]`).join("\n");
          return {
            exitCode: 1,
            stdout: `Run ${runId} of "${run.workflowName}" is still ${run.status} after ${timeoutSeconds}s:\n${steps}\n\nRun \`workflow wait "${runId}"\` again to keep waiting, or \`workflow cancel "${runId}"\` to stop it.`,
            stderr: "",
          };
        }
        await sleep(options.pollIntervalMs, signal);
      }
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
  failureReason?: string;
  steps: Array<{
    slug: string;
    type: string;
    status: string;
    jobId: string;
    waitEvent?: string;
    humanTask?: { title: string; assignees: { users: string[]; roles: string[] } };
  }>;
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
