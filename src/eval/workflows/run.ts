/**
 * Workflow design eval: `bun run eval:workflows`.
 *
 * Sends each scenario prompt to the chat agent of a throwaway deployment,
 * several times, and prints how often the written workflow passed each check.
 * Needs the configured LLM endpoint and is not deterministic, so it is not
 * part of `bun run test`.
 *
 * Options:
 * - `--runs <n>`: runs per scenario (default 3)
 * - `--scenario <name>`: run only this scenario (repeatable)
 * - `--timeout <minutes>`: limit for one chat turn (default 20)
 * - `--model <id>`: model to use (default: `EVAL_MODEL`, else the model selected
 *   in the configured deployment, else `OPENAI_DEFAULT_MODEL`)
 *
 * When a turn ends without a workflow file, the agent gets one "Yes, go ahead."
 * in the same chat; the table counts those runs under "asked first".
 *
 * Every run keeps its work directory, server log, job log and facts under a
 * directory in the system temp folder, printed at the start.
 *
 * @module
 */

import "@dotenvx/dotenvx/config";
import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DATA_DIR, EXTERNAL_EXTENSIONS_DIR } from "@src/config";
import { CHECKS, type CheckId, type CheckResults, evaluateChecks } from "./checks";
import { type AnalyzerWarning, type ChatOutcome, type EvalDeployment, startEvalDeployment } from "./deployment";
import { EVAL_EXTENSIONS, SCENARIOS, type Scenario } from "./scenarios";

/** What one run produced, as written to `result.json`. */
interface RunRecord {
  scenario: string;
  run: number;
  outcome: ChatOutcome | "harness-error";
  seconds: number;
  /** Name of the evaluated workflow file, or `null` when none was written. */
  file: string | null;
  checks: CheckResults;
  validationErrors: readonly string[] | null;
  warnings: readonly AnalyzerWarning[] | null;
  /** The agent's last message, or the error text. */
  finalText: string;
  /** True when the agent asked for permission instead of writing and got one "go ahead". */
  confirmed: boolean;
}

/**
 * Sent once when a turn ends without a workflow file. The `workflow-writing`
 * skill tells the agent to ask for permission before any change, which wins
 * over "do not ask questions" in some runs; a user would simply say yes.
 */
const CONFIRMATION = "Yes, go ahead.";

/**
 * Reads the model the configured deployment has selected, without touching
 * its database (opened read-only).
 *
 * @returns The selected model, or `null` when there is no database or selection
 */
function readDeploymentModel(): { id: string; reasoning: boolean } | null {
  try {
    const db = new Database(join(DATA_DIR, "palim.db"), { readonly: true });
    try {
      const get = (key: string) =>
        (db.query("SELECT value FROM app_config WHERE key = ?").get(key) as { value: string } | null)?.value;
      const id = get("selected_model");
      return id ? { id, reasoning: get("model_reasoning") === "true" } : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * Picks the workflow file a run wrote: the most recently modified `*.json5`
 * in the deployment's `workflows/` directory.
 *
 * @param workDir - The deployment's work directory
 * @returns File name and parsed content (`null` content when it does not parse), or `null` when no file exists
 */
async function readWrittenWorkflow(workDir: string): Promise<{ file: string; definition: unknown } | null> {
  const dir = join(workDir, "workflows");
  let newest: { file: string; mtime: number } | null = null;
  try {
    for await (const file of new Bun.Glob("*.json5").scan({ cwd: dir, onlyFiles: true })) {
      const mtime = Bun.file(join(dir, file)).lastModified;
      if (!newest || mtime > newest.mtime) newest = { file, mtime };
    }
  } catch {
    return null; // no workflows directory
  }
  if (!newest) return null;
  try {
    return { file: newest.file, definition: Bun.JSON5.parse(await Bun.file(join(dir, newest.file)).text()) };
  } catch {
    return { file: newest.file, definition: null };
  }
}

/**
 * Runs one scenario once in its own deployment.
 *
 * @param scenario - The scenario
 * @param run - 1-based run number
 * @param runDir - Directory for this run's artifacts
 * @param model - Model the chat agent runs on
 * @param timeoutMs - Limit for the chat turn
 * @returns The run record (also written to `result.json`)
 */
async function runOnce(
  scenario: Scenario,
  run: number,
  runDir: string,
  model: { id: string; reasoning: boolean },
  timeoutMs: number,
): Promise<RunRecord> {
  const started = Date.now();
  const noFacts = {
    definition: null,
    validationErrors: null,
    warningCount: null,
    stepTypes: new Map<string, unknown>(),
  };
  const record: RunRecord = {
    scenario: scenario.name,
    run,
    outcome: "harness-error",
    seconds: 0,
    file: null,
    checks: evaluateChecks(noFacts, scenario.checks),
    validationErrors: null,
    warnings: null,
    finalText: "",
    confirmed: false,
  };

  let deployment: EvalDeployment | undefined;
  try {
    deployment = await startEvalDeployment({
      runDir,
      extensions: EVAL_EXTENSIONS,
      externalExtensionsDir: EXTERNAL_EXTENSIONS_DIR,
      model,
    });
    for (const skipped of deployment.skippedExtensions) {
      if (run === 1) console.log(`  note: extension "${skipped.name}" not enabled (${skipped.reason})`);
    }

    let chat = await deployment.chat(scenario.prompt, timeoutMs);
    await Bun.write(join(runDir, "job-log.json"), JSON.stringify(await deployment.jobLogs(chat.jobId), null, 2));
    let written = await readWrittenWorkflow(deployment.workDir);
    if (!written && chat.outcome === "done") {
      record.confirmed = true;
      chat = await deployment.chat(CONFIRMATION, timeoutMs, chat.sessionId);
      await Bun.write(
        join(runDir, "job-log-confirmed.json"),
        JSON.stringify(await deployment.jobLogs(chat.jobId), null, 2),
      );
      written = await readWrittenWorkflow(deployment.workDir);
    }
    record.outcome = chat.outcome;
    record.finalText = chat.text;

    record.file = written?.file ?? null;
    const definition = written?.definition ?? null;
    if (definition !== null) {
      record.validationErrors = await deployment.validate(definition);
      record.warnings = record.validationErrors.length === 0 ? await deployment.analyze(definition) : null;
    }
    record.checks = evaluateChecks(
      {
        definition,
        validationErrors: record.validationErrors,
        warningCount: record.warnings?.length ?? null,
        stepTypes: await deployment.stepTypes(),
      },
      scenario.checks,
    );
  } catch (err) {
    record.finalText = err instanceof Error ? err.message : String(err);
  } finally {
    await deployment?.stop();
  }

  record.seconds = Math.round((Date.now() - started) / 1000);
  await Bun.write(join(runDir, "result.json"), JSON.stringify(record, null, 2));
  return record;
}

/**
 * Formats the pass counts per scenario and check as a text table.
 *
 * @param records - All run records
 * @param scenarios - The scenarios that were run, in order
 * @returns The table
 */
function formatTable(records: readonly RunRecord[], scenarios: readonly Scenario[]): string {
  const cell = (scenario: string, check: CheckId): string => {
    const results = records.filter((r) => r.scenario === scenario).map((r) => r.checks[check]);
    const applicable = results.filter((r) => r !== null);
    return applicable.length === 0 ? "-" : `${applicable.filter(Boolean).length}/${applicable.length}`;
  };
  const rows = [
    ["scenario", "loop expected", "asked first", ...CHECKS.map((c) => c.label)],
    ...scenarios.map((s) => {
      const own = records.filter((r) => r.scenario === s.name);
      return [
        s.name,
        s.checks.loop === "required" ? "yes" : "no",
        `${own.filter((r) => r.confirmed).length}/${own.length}`,
        ...CHECKS.map((c) => cell(s.name, c.id)),
      ];
    }),
  ];
  const widths = rows[0]!.map((_, col) => Math.max(...rows.map((row) => row[col]!.length)));
  const line = (row: string[]) => row.map((text, col) => text.padEnd(widths[col]!)).join("  ");
  return [line(rows[0]!), widths.map((w) => "-".repeat(w)).join("  "), ...rows.slice(1).map(line)].join("\n");
}

const { values: args } = parseArgs({
  options: {
    runs: { type: "string", default: "3" },
    scenario: { type: "string", multiple: true },
    timeout: { type: "string", default: "20" },
    model: { type: "string" },
  },
});

const runs = Number.parseInt(args.runs, 10);
const timeoutMs = Number.parseFloat(args.timeout) * 60_000;
if (!Number.isInteger(runs) || runs < 1 || !(timeoutMs > 0)) {
  console.error("--runs must be a positive integer and --timeout a positive number of minutes");
  process.exit(2);
}

const scenarios = args.scenario ? SCENARIOS.filter((s) => args.scenario!.includes(s.name)) : SCENARIOS;
const unknown = (args.scenario ?? []).filter((name) => !SCENARIOS.some((s) => s.name === name));
if (unknown.length > 0 || scenarios.length === 0) {
  console.error(`Unknown scenario: ${unknown.join(", ")}. Available: ${SCENARIOS.map((s) => s.name).join(", ")}`);
  process.exit(2);
}

const explicitModel = args.model ?? process.env.EVAL_MODEL;
const model = explicitModel
  ? { id: explicitModel, reasoning: false }
  : (readDeploymentModel() ??
    (process.env.OPENAI_DEFAULT_MODEL ? { id: process.env.OPENAI_DEFAULT_MODEL, reasoning: false } : null));
if (!model) {
  console.error("No model: pass --model, set EVAL_MODEL, or select a model in the configured deployment.");
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(tmpdir(), `palim-eval-workflows-${stamp}`);
await mkdir(outDir, { recursive: true });

console.log(`Model: ${model.id}${model.reasoning ? " (reasoning)" : ""}`);
console.log(`Runs per scenario: ${runs}, limit per run: ${args.timeout} min`);
console.log(`Artifacts: ${outDir}\n`);

const records: RunRecord[] = [];
for (const scenario of scenarios) {
  for (let run = 1; run <= runs; run++) {
    console.log(`${scenario.name} run ${run}/${runs} ...`);
    const record = await runOnce(scenario, run, join(outDir, `${scenario.name}-${run}`), model, timeoutMs);
    records.push(record);
    const failed = CHECKS.filter((c) => record.checks[c.id] === false).map((c) => c.label);
    console.log(
      `  ${record.outcome} after ${record.seconds}s, file: ${record.file ?? "none"}, failed: ${failed.join(", ") || "none"}${record.confirmed ? " (asked first, got one go-ahead)" : ""}`,
    );
    if (record.outcome === "harness-error") console.log(`  ${record.finalText}`);
  }
}

await Bun.write(join(outDir, "results.json"), JSON.stringify({ model, runs, records }, null, 2));

console.log(`\n${formatTable(records, scenarios)}\n`);
console.log(`asked first: runs where the agent asked for permission and got one "${CONFIRMATION}" (not a check)`);
for (const check of CHECKS) console.log(`${check.label}: ${check.description}`);
console.log(`\nPer-run details: ${join(outDir, "results.json")}`);
process.exit(0);
