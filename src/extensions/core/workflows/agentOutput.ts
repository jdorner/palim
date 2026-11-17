/**
 * Structured answers for `agent` steps that declare an `outputSchema`.
 *
 * Without this, the schema only fed validation and autocomplete: the step's
 * result stayed the model's free text, so `{{steps.<agent>.result.<field>}}`
 * never resolved at run time. The worker appends {@link outputInstruction} to
 * the prompt, parses the answer with {@link parseAgentOutput}, and stores the
 * parsed object as the step result.
 *
 * Answers are checked against the schema compiled by `compileOutputSchema`, so
 * the meaning of each type hint is defined in one place.
 *
 * Pure: no I/O, never throws.
 */

import type { OutputSchemaShorthand } from "@shared/workflows";
import { compileOutputSchema } from "./outputSchemaCompiler";

/** At most this many mismatches are reported, so a repair prompt stays short. */
const MAX_ERRORS = 5;

/** Result of {@link parseAgentOutput}. */
export type AgentOutputResult = { ok: true; value: Record<string, unknown> } | { ok: false; errors: string[] };

/** A compiled JSON Schema node, as produced by `compileOutputSchema`. */
type SchemaNode = {
  type?: string;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
};

/**
 * Builds the prompt lines that tell the model to answer with JSON of the declared shape.
 *
 * @param shorthand - The step's `outputSchema` (type-hint shorthand)
 * @returns Text to append to the step prompt
 */
export function outputInstruction(shorthand: OutputSchemaShorthand): string {
  return [
    "Your final answer must be only one JSON object, with no other text and no code fence.",
    'It must have exactly these fields (the values here are the types; ["x"] is a list of x):',
    JSON.stringify(shorthand),
  ].join("\n");
}

/**
 * Builds the follow-up message sent when an answer does not match the shape.
 *
 * @param errors - Mismatches from {@link parseAgentOutput}
 * @returns The repair prompt
 */
export function repairInstruction(errors: string[]): string {
  return [
    "Your answer is not the JSON object this step needs:",
    ...errors.map((e) => `- ${e}`),
    "Answer again with only the JSON object.",
  ].join("\n");
}

/**
 * Finds the JSON object in an agent answer that matches the shorthand.
 *
 * The whole trimmed answer is tried first. Otherwise every top-level `{...}` in
 * the text is a candidate, and the last one that matches wins: a model that
 * repeats the requested shape before its answer, or cites `[1]` in prose, still
 * gets its real answer read. When none matches, the mismatches of the last
 * object are reported.
 *
 * Every declared field must be present with the declared type (`null` only
 * where the hint is `"any"`); extra fields are kept.
 *
 * @param answer - The agent's final text
 * @param shorthand - The step's `outputSchema`
 * @returns The parsed object, or the mismatches found
 */
export function parseAgentOutput(answer: string, shorthand: OutputSchemaShorthand): AgentOutputResult {
  const schema = compileOutputSchema(shorthand) as SchemaNode;
  const whole = tryParse(answer.trim());
  if (Array.isArray(whole)) return { ok: false, errors: ["the answer is a JSON list, not an object"] };
  const candidates = isPlainObject(whole) ? [whole] : findObjects(answer);
  if (candidates.length === 0) return { ok: false, errors: ["the answer contains no JSON object"] };
  let lastErrors: string[] = [];
  for (let i = candidates.length - 1; i >= 0; i--) {
    const errors: string[] = [];
    checkNode(candidates[i], schema, "", errors);
    if (errors.length === 0) return { ok: true, value: candidates[i]! };
    if (i === candidates.length - 1) lastErrors = errors;
  }
  return { ok: false, errors: lastErrors.slice(0, MAX_ERRORS) };
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns every top-level JSON object in the text, in order. An object nested
 * in another is part of its parent, not a candidate of its own; a `{` that does
 * not start valid JSON is skipped.
 */
function findObjects(text: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  let from = 0;
  while (from < text.length) {
    const start = text.indexOf("{", from);
    if (start === -1) break;
    const end = balancedEnd(text, start);
    const parsed = end === -1 ? undefined : tryParse(text.slice(start, end + 1));
    if (isPlainObject(parsed)) {
      found.push(parsed);
      from = end + 1;
    } else {
      from = start + 1;
    }
  }
  return found;
}

/** Index of the `}` closing the `{` at `start`, respecting JSON strings; -1 if unbalanced. */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
    } else if (inString) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}" && --depth === 0) {
      return i;
    }
  }
  return -1;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  return typeof value;
}

function checkNode(value: unknown, node: SchemaNode, path: string, errors: string[]): void {
  const at = path || "the answer";
  switch (node.type) {
    case "string":
    case "number":
    case "boolean":
      if (typeof value !== node.type) errors.push(`"${at}" must be a ${node.type}, got ${describe(value)}`);
      return;
    case "array":
      if (!Array.isArray(value)) {
        errors.push(`"${at}" must be a list, got ${describe(value)}`);
        return;
      }
      if (node.items) {
        const items = node.items;
        value.forEach((element, i) => {
          checkNode(element, items, `${path}[${i}]`, errors);
        });
      }
      return;
    case "object": {
      if (!isPlainObject(value)) {
        errors.push(`"${at}" must be an object, got ${describe(value)}`);
        return;
      }
      for (const [key, child] of Object.entries(node.properties ?? {})) {
        const childPath = path ? `${path}.${key}` : key;
        if (!Object.hasOwn(value, key)) errors.push(`"${childPath}" is missing`);
        else checkNode(value[key], child, childPath, errors);
      }
      return;
    }
    default:
      // `{}`: "any" or an unknown hint accepts every value.
      return;
  }
}
