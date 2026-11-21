/**
 * Checks of the workflow design eval: pure functions from a written workflow
 * definition (plus what the eval server said about it) to pass/fail per check.
 *
 * Graph questions ("is this step inside an iterator body") are answered by
 * `analyzeWorkflowGraph`, the single source of the graph rules.
 *
 * @module
 */

import { analyzeWorkflowGraph, type TopologyEdge } from "@shared/workflowTopology";
import { findUndeclaredConfigKeys } from "@src/extensions/core/workflows/configKeys";
import { findFreeTextReadAsData } from "@src/extensions/core/workflows/designWarnings";
import type { DagStepDef } from "@src/extensions/core/workflows/schemas";
import type { ScenarioExpectations } from "./scenarios";

/** The checks, in report order, with the column header and what a pass means. */
export const CHECKS = [
  { id: "file", label: "file", description: "a workflow file was written and parses" },
  { id: "valid", label: "valid", description: "the definition has no validation errors" },
  { id: "draft", label: "draft", description: "the workflow is a draft, as every prompt asks" },
  { id: "loop", label: "loop", description: "loop as expected (iterator with an agent step inside, or no iterator)" },
  { id: "steps", label: "steps", description: "every step type the scenario asks for is used" },
  {
    id: "schema",
    label: "schema",
    description:
      "every agent step whose result fields are read (directly or through an aggregator) has an outputSchema",
  },
  {
    id: "config",
    label: "config",
    description: "no step sets a config field its step type does not declare",
  },
  {
    id: "prompt",
    label: "prompt",
    description:
      "no agent step with an outputSchema describes the answer shape in its prompt (the engine adds it from the schema)",
  },
  {
    id: "nullable",
    label: "nullable",
    description: 'every result field the scenario says may be empty has the hint "any" in an agent outputSchema',
  },
  {
    id: "count",
    label: "count",
    description: "no agent step reads a loop's aggregated results (counts and totals use template functions)",
  },
  { id: "warnings", label: "no-warn", description: "the analyzer reports zero warnings" },
  { id: "types", label: "types", description: "every step type used is registered" },
] as const;

/** Id of one check. */
export type CheckId = (typeof CHECKS)[number]["id"];

/** Result per check: passed, failed, or `null` when the check does not apply to the scenario. */
export type CheckResults = Record<CheckId, boolean | null>;

/** What is known about one run's written workflow. */
export interface RunFacts {
  /** The parsed workflow file, or `null` when no file was written or it does not parse. */
  definition: unknown;
  /** Errors of the server's validation; `null` when it was not asked (no definition). */
  validationErrors: readonly string[] | null;
  /** Number of analyzer warnings; `null` when the analyzer was not asked or the definition is invalid. */
  warningCount: number | null;
  /**
   * Step types the eval deployment offers (engine and extension-registered),
   * each with its config JSON Schema when it declares one.
   */
  stepTypes: ReadonlyMap<string, unknown>;
}

/** A step as far as the checks read it. */
type LooseStep = Record<string, unknown>;

/**
 * Reads the steps of a possibly invalid definition.
 *
 * @param definition - The parsed workflow file
 * @returns The step records keyed by slug (empty when there are none)
 */
function stepsOf(definition: unknown): Record<string, LooseStep> {
  const steps = (definition as { steps?: unknown } | null)?.steps;
  if (steps === null || typeof steps !== "object" || Array.isArray(steps)) return {};
  const out: Record<string, LooseStep> = {};
  for (const [slug, step] of Object.entries(steps)) {
    if (step !== null && typeof step === "object" && !Array.isArray(step)) out[slug] = step as LooseStep;
  }
  return out;
}

/**
 * Reads the edges of a possibly invalid definition.
 *
 * @param definition - The parsed workflow file
 * @returns The well-formed edges (empty when there are none)
 */
function edgesOf(definition: unknown): TopologyEdge[] {
  const edges = (definition as { edges?: unknown } | null)?.edges;
  if (!Array.isArray(edges)) return [];
  return edges.filter(
    (e): e is TopologyEdge =>
      e !== null && typeof e === "object" && typeof e.from === "string" && typeof e.to === "string",
  );
}

/**
 * Collects every string value inside a JSON-like value.
 *
 * @param value - Any parsed JSON5 value
 * @param into - Receives the strings
 */
function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, into);
  else if (value !== null && typeof value === "object") for (const v of Object.values(value)) collectStrings(v, into);
}

/**
 * Tells whether a text references the result of the given step, as
 * `steps.<slug>.result` or `steps["<slug>"].result`.
 *
 * @param text - A template string
 * @param slug - The referenced step
 * @returns True when the text reads that step's result
 */
function referencesResult(text: string, slug: string): boolean {
  return (
    text.includes(`steps.${slug}.result`) ||
    text.includes(`steps["${slug}"].result`) ||
    text.includes(`steps['${slug}'].result`)
  );
}

/**
 * Finds the agent steps that have no `outputSchema` although another step
 * reads a field of their result: directly, or through the aggregator that
 * collects them. A bare `{{steps.<agent>.result}}` (free text handed on) does
 * not count. The rule is the analyzer's own (`findFreeTextReadAsData`, the
 * "free text read as data" warning), so check and warning agree.
 *
 * @param definition - The parsed workflow file
 * @returns The slugs of those agent steps
 */
export function agentStepsMissingSchema(definition: unknown): string[] {
  const steps = stepsOf(definition);
  const topology = analyzeWorkflowGraph(steps, edgesOf(definition));
  return [...findFreeTextReadAsData(steps as Record<string, DagStepDef>, topology).keys()];
}

/**
 * Finds the agent steps that read an aggregator's result, i.e. that are handed
 * all items of a loop at once. For a report of counts or totals that is the
 * LLM doing arithmetic; template functions (`count`, `sum`, `where`) do it
 * exactly.
 *
 * @param definition - The parsed workflow file
 * @returns The slugs of those agent steps
 */
export function agentStepsReadingAggregates(definition: unknown): string[] {
  const steps = stepsOf(definition);
  const aggregators = Object.keys(steps).filter((slug) => steps[slug]!.type === "aggregator");
  const found: string[] = [];
  for (const [slug, step] of Object.entries(steps)) {
    if (step.type !== "agent") continue;
    const strings: string[] = [];
    collectStrings(step, strings);
    if (aggregators.some((agg) => strings.some((s) => referencesResult(s, agg)))) found.push(slug);
  }
  return found;
}

/**
 * Finds config fields that a step sets although its step type's config schema
 * does not declare them (for example `search.unseen` on `imap-fetch`, whose
 * field is `seen`). Step types without a config schema are skipped. The rule
 * is the server's own (`findUndeclaredConfigKeys`); this check also counts
 * the keys a closed schema rejects.
 *
 * @param definition - The parsed workflow file
 * @param stepTypes - Config JSON Schema per step type
 * @returns `<slug>.<path>` of every undeclared field
 */
export function undeclaredConfigFields(definition: unknown, stepTypes: ReadonlyMap<string, unknown>): string[] {
  const found: string[] = [];
  for (const [slug, step] of Object.entries(stepsOf(definition))) {
    const schema = typeof step.type === "string" ? stepTypes.get(step.type) : undefined;
    if (!schema) continue;
    for (const key of findUndeclaredConfigKeys(step, schema)) found.push(`${slug}.${key.path}`);
  }
  return found;
}

/** Phrases that ask for an answer format, which the engine already adds from `outputSchema`. */
const FORMAT_INSTRUCTION =
  /\bjson\b|\b(respond|reply|answer)\s+(only\s+)?with\b|\b(in|use)\s+(this|the following)\s+(format|structure)\b/i;

/**
 * Reads a step's prompt.
 *
 * @param step - The step
 * @returns The prompt text, or "" when there is none
 */
function promptText(step: LooseStep): string {
  return typeof step.prompt === "string" ? step.prompt : "";
}

/**
 * Finds the agent steps with an `outputSchema` whose prompt still describes
 * the answer shape: asks for JSON, says "respond with" or "in this format",
 * or spells out a schema field as a JSON key (`"label":`). The engine adds the
 * shape from the schema, and a second description in the prompt can
 * contradict it (e.g. allow `null` where the schema says `"string"`).
 *
 * @param definition - The parsed workflow file
 * @returns The slugs of those agent steps
 */
export function agentPromptsWithFormat(definition: unknown): string[] {
  const found: string[] = [];
  for (const [slug, step] of Object.entries(stepsOf(definition))) {
    const schema = step.outputSchema;
    if (step.type !== "agent" || schema === null || typeof schema !== "object") continue;
    const prompt = promptText(step);
    const spellsOutField = Object.keys(schema).some(
      (key) => prompt.includes(`"${key}":`) || prompt.includes(`'${key}':`),
    );
    if (FORMAT_INSTRUCTION.test(prompt) || spellsOutField) found.push(slug);
  }
  return found;
}

/**
 * Tells whether any agent step has an `outputSchema` object.
 *
 * @param definition - The parsed workflow file
 * @returns True when at least one agent step declares a result shape
 */
function hasAgentSchema(definition: unknown): boolean {
  return Object.values(stepsOf(definition)).some(
    (step) => step.type === "agent" && step.outputSchema !== null && typeof step.outputSchema === "object",
  );
}

/**
 * Finds the result fields that may be empty but are not declared with the
 * hint `"any"` (the only hint that accepts `null`). A field counts as declared
 * when a top-level key of some agent step's `outputSchema` has its name.
 *
 * @param definition - The parsed workflow file
 * @param fields - Field names the scenario says may be empty
 * @returns The fields that are missing or have another hint
 */
export function nullableFieldsNotAny(definition: unknown, fields: readonly string[]): string[] {
  const hints = new Map<string, unknown>();
  for (const step of Object.values(stepsOf(definition))) {
    const schema = step.outputSchema;
    if (step.type !== "agent" || schema === null || typeof schema !== "object") continue;
    for (const [key, hint] of Object.entries(schema)) if (!hints.has(key) || hint === "any") hints.set(key, hint);
  }
  return fields.filter((field) => hints.get(field) !== "any");
}

/**
 * Tells whether at least one `agent` step lies inside an iterator body.
 *
 * @param definition - The parsed workflow file
 * @returns True when an iterator exists and an agent step is in its body
 */
export function hasAgentInLoop(definition: unknown): boolean {
  const steps = stepsOf(definition);
  const topology = analyzeWorkflowGraph(steps, edgesOf(definition));
  return Object.entries(steps).some(
    ([slug, step]) => step.type === "agent" && topology.enclosingIterator(slug) !== undefined,
  );
}

/**
 * Evaluates all checks for one run.
 *
 * Without a definition every check fails: a run that wrote nothing has not
 * met any expectation.
 *
 * @param facts - The written definition and what the eval server said about it
 * @param expected - The scenario's expectations
 * @returns Pass/fail per check, `null` where the check does not apply
 */
export function evaluateChecks(facts: RunFacts, expected: ScenarioExpectations): CheckResults {
  const applies = (applicable: boolean, passed: boolean): boolean | null => (applicable ? passed : null);
  const wantsSteps = (expected.stepTypes?.length ?? 0) > 0;
  const wantsNullable = (expected.nullableFields?.length ?? 0) > 0;
  const wantsCount = expected.countWithFunctions === true;

  if (facts.definition === null || facts.definition === undefined) {
    return {
      file: false,
      valid: false,
      draft: false,
      loop: false,
      steps: applies(wantsSteps, false),
      schema: applies(expected.structuredHandoff, false),
      config: false,
      prompt: false,
      nullable: applies(wantsNullable, false),
      count: applies(wantsCount, false),
      warnings: false,
      types: false,
    };
  }

  const steps = stepsOf(facts.definition);
  const usedTypes = new Set(Object.values(steps).map((s) => (typeof s.type === "string" ? s.type : "")));
  const valid = facts.validationErrors !== null && facts.validationErrors.length === 0;

  return {
    file: true,
    valid,
    draft: (facts.definition as { draft?: unknown }).draft === true,
    loop: expected.loop === "required" ? hasAgentInLoop(facts.definition) : !usedTypes.has("iterator"),
    steps: applies(
      wantsSteps,
      (expected.stepTypes ?? []).every((type) => usedTypes.has(type)),
    ),
    schema: applies(expected.structuredHandoff, agentStepsMissingSchema(facts.definition).length === 0),
    config: undeclaredConfigFields(facts.definition, facts.stepTypes).length === 0,
    prompt: applies(hasAgentSchema(facts.definition), agentPromptsWithFormat(facts.definition).length === 0),
    nullable: applies(
      wantsNullable,
      nullableFieldsNotAny(facts.definition, expected.nullableFields ?? []).length === 0,
    ),
    count: applies(wantsCount, agentStepsReadingAggregates(facts.definition).length === 0),
    warnings: valid && facts.warningCount === 0,
    types: usedTypes.size > 0 && [...usedTypes].every((type) => facts.stepTypes.has(type)),
  };
}
