/**
 * Output_Schema_Compiler: converts the legacy Type_Hint_Shorthand authoring
 * format into canonical JSON Schema (the shared `OutputSchema` shape).
 *
 * This module is pure and dependency-free at runtime: it takes a shorthand map
 * (or a trigger's resolved shorthand) and produces a plain JSON Schema record.
 * It never throws - per-property failures are isolated so the workflow load is
 * never blocked - and it reports unrecognized type hints through an optional
 * best-effort warning sink.
 *
 * Note: the produced value is a plain JSON Schema record
 * (`OutputSchema = Record<string, unknown>`), NOT a TypeBox schema.
 */

import type { OutputSchema } from "@shared/workflows";
import type { OutputSchemaShorthand } from "./schemas";
import { BUILTIN_TRIGGER_SCHEMAS } from "./triggerSchemas";

/**
 * Recognized leaf type-hint strings and their JSON Schema `type` mapping.
 *
 * Any leaf string outside this closed set is treated as unrecognized and
 * compiled to an unconstrained JSON Schema node.
 */
const RECOGNIZED_LEAF_TYPES = new Set(["string", "number", "boolean"]);

/**
 * Compiles a single shorthand value (leaf type-hint string or nested map) into
 * a canonical JSON Schema node.
 *
 * Best effort: any failure to build a nested node is isolated by the caller, so
 * this helper focuses on the mapping rules. Unrecognized leaf strings produce an
 * unconstrained node and record a warning via the sink.
 *
 * @param key - The property name being compiled (used for warning messages)
 * @param value - The shorthand value: a type-hint string or a nested shorthand map
 * @param sink - Optional best-effort warning sink for unrecognized type hints
 * @returns A JSON Schema node describing the value
 */
function compileValue(
  key: string,
  value: string | OutputSchemaShorthand,
  sink?: (message: string) => void,
): OutputSchema {
  if (typeof value === "string") {
    if (RECOGNIZED_LEAF_TYPES.has(value)) {
      return { type: value };
    }
    // Unrecognized leaf: unconstrained node plus a best-effort warning.
    invokeSink(
      sink,
      `Unrecognized output schema type hint "${value}" for property "${key}"; treating as unconstrained.`,
    );
    return {};
  }
  // Nested shorthand map: compile recursively, preserving the hierarchy.
  return compileOutputSchema(value, sink);
}

/**
 * Invokes the warning sink without ever propagating an exception.
 *
 * @param sink - Optional warning sink
 * @param message - The warning message to record
 */
function invokeSink(sink: ((message: string) => void) | undefined, message: string): void {
  if (!sink) {
    return;
  }
  try {
    sink(message);
  } catch {
    // Swallow sink failures: recording a warning must never block the load.
  }
}

/**
 * Compiles a Type_Hint_Shorthand output schema into canonical JSON Schema.
 *
 * Mapping rules:
 * - `"string"`  -> `{ type: "string" }`
 * - `"number"`  -> `{ type: "number" }`
 * - `"boolean"` -> `{ type: "boolean" }`
 * - nested map  -> `{ type: "object", properties: { ...recursively compiled... } }`
 *   with the property hierarchy preserved exactly (same keys, same nesting depth).
 * - unrecognized leaf string -> `{}` (unconstrained node) plus a Template_Warning
 *   recorded through the sink.
 *
 * The top-level result is always an object node
 * (`{ type: "object", properties: { ... } }`).
 *
 * Never throws: each property build and each sink invocation is wrapped so a
 * failure to build a node or to invoke the sink still returns a usable (possibly
 * partial) schema and processing continues with the remaining properties.
 *
 * @param shorthand - The hand-authored type-hint map from JSON5
 * @param sink - Optional best-effort warning sink invoked for unrecognized type hints
 * @returns A canonical JSON Schema object describing the same property hierarchy
 */
export function compileOutputSchema(shorthand: OutputSchemaShorthand, sink?: (message: string) => void): OutputSchema {
  const properties: Record<string, OutputSchema> = {};

  for (const key of Object.keys(shorthand ?? {})) {
    try {
      properties[key] = compileValue(key, shorthand[key]!, sink);
    } catch {
      // Isolate per-property failures: skip this property, keep the rest.
    }
  }

  return { type: "object", properties };
}

/**
 * Resolves a trigger's effective output schema as canonical JSON Schema.
 *
 * Precedence: an explicit user-defined shorthand wins over the built-in default
 * for the trigger type. The chosen shorthand is then compiled to JSON Schema. If
 * neither an explicit shorthand nor a built-in default is available, returns
 * `null`.
 *
 * Never throws: compilation is delegated to {@link compileOutputSchema}, which is
 * itself non-throwing and reports unrecognized hints via the sink.
 *
 * @param triggerType - The trigger type (e.g. "filewatcher", "schedule", "webhook", "manual")
 * @param explicitShorthand - User-defined shorthand from the workflow definition, if any
 * @param sink - Optional best-effort warning sink forwarded to the compiler
 * @returns The resolved canonical JSON Schema, or `null` when no shorthand is available
 */
export function resolveTriggerOutputSchemaJson(
  triggerType: string,
  explicitShorthand: OutputSchemaShorthand | undefined,
  sink?: (message: string) => void,
): OutputSchema | null {
  const chosen = explicitShorthand ?? BUILTIN_TRIGGER_SCHEMAS[triggerType];
  if (!chosen) {
    return null;
  }
  return compileOutputSchema(chosen, sink);
}
