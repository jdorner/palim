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
    description: "every agent step whose result is referenced (directly or through an aggregator) has an outputSchema",
  },
  {
    id: "config",
    label: "config",
    description: "no step sets a config field its step type does not declare (the server does not always reject these)",
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
 * reads their result: directly, or through the aggregator that collects them
 * (an agent step that ends an iterator body, whose aggregator is referenced).
 *
 * @param definition - The parsed workflow file
 * @returns The slugs of those agent steps
 */
export function agentStepsMissingSchema(definition: unknown): string[] {
  const steps = stepsOf(definition);
  const topology = analyzeWorkflowGraph(steps, edgesOf(definition));

  /** Whether any step other than `slug` references the result of `slug`. */
  const isReferenced = (slug: string): boolean =>
    Object.entries(steps).some(([other, otherStep]) => {
      if (other === slug) return false;
      const strings: string[] = [];
      collectStrings(otherStep, strings);
      return strings.some((s) => referencesResult(s, slug));
    });

  /** The aggregator that collects `slug`, when `slug` ends an iterator body. */
  const collectingAggregator = (slug: string): string | undefined => {
    const iterator = topology.enclosingIterator(slug);
    const body = iterator ? topology.iteratorBody(iterator) : null;
    return body?.terminals.includes(slug) ? body.aggregator : undefined;
  };

  const missing: string[] = [];
  for (const [slug, step] of Object.entries(steps)) {
    if (step.type !== "agent" || step.outputSchema !== undefined) continue;
    const aggregator = collectingAggregator(slug);
    if (isReferenced(slug) || (aggregator !== undefined && isReferenced(aggregator))) missing.push(slug);
  }
  return missing;
}

/** Step keys that are not part of a step type's config. */
const NON_CONFIG_KEYS = new Set(["type", "slug", "outputSchema"]);

/**
 * Collects the fields of a value that its JSON Schema does not declare.
 * Only closed shapes are judged: an object schema with declared `properties`
 * and no `additionalProperties`/`patternProperties` schema. Unions and
 * schema-less values are left alone.
 *
 * @param value - The config value
 * @param schema - Its JSON Schema
 * @param path - Dotted path of `value`, for the report
 * @param into - Receives the dotted paths of undeclared fields
 */
function collectUndeclared(value: unknown, schema: unknown, path: string, into: string[]): void {
  if (schema === null || typeof schema !== "object") return;
  const node = schema as {
    properties?: Record<string, unknown>;
    additionalProperties?: unknown;
    patternProperties?: unknown;
    items?: unknown;
  };
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) collectUndeclared(item, node.items, `${path}[${i}]`, into);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const properties = node.properties;
  if (!properties || Object.keys(properties).length === 0) return;
  const open = typeof node.additionalProperties === "object" || node.patternProperties !== undefined;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (Object.hasOwn(properties, key)) collectUndeclared(child, properties[key], childPath, into);
    else if (!open) into.push(childPath);
  }
}

/**
 * Finds config fields that a step sets although its step type's config schema
 * does not declare them (for example `search.unseen` on `imap-fetch`, whose
 * field is `seen`). Step types without a config schema are skipped.
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
    const config = Object.fromEntries(Object.entries(step).filter(([key]) => !NON_CONFIG_KEYS.has(key)));
    const paths: string[] = [];
    collectUndeclared(config, schema, "", paths);
    for (const path of paths) found.push(`${slug}.${path}`);
  }
  return found;
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

  if (facts.definition === null || facts.definition === undefined) {
    return {
      file: false,
      valid: false,
      draft: false,
      loop: false,
      steps: applies(wantsSteps, false),
      schema: applies(expected.structuredHandoff, false),
      config: false,
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
    warnings: valid && facts.warningCount === 0,
    types: usedTypes.size > 0 && [...usedTypes].every((type) => facts.stepTypes.has(type)),
  };
}
