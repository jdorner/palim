/**
 * Infers the output-schema shorthand from a sample value.
 *
 * Used to generate a trigger's or step's `outputSchema` from the data of a
 * previous workflow run, so authors don't have to write it by hand. Pure and
 * dependency-free, so both backend and frontend can import it.
 *
 * @module
 */

import type { OutputSchemaShorthand, OutputSchemaShorthandValue } from "./workflows";

/** Maximum nesting depth; deeper values collapse to `"any"`. */
const MAX_DEPTH = 8;

/** Maximum number of array elements sampled to infer the item shape. */
const MAX_ARRAY_SAMPLES = 20;

/**
 * Infers the shorthand for a single value.
 *
 * - strings, finite numbers, booleans map to `"string"`, `"number"`, `"boolean"`
 * - `null`/`undefined` and other values map to `"any"`
 * - an empty object maps to `"object"` (open object)
 * - an object maps to a nested map
 * - an array maps to `[item]`, where `item` merges the shapes of the first
 *   {@link MAX_ARRAY_SAMPLES} elements (`["any"]` when empty)
 *
 * @param value - The sample value
 * @param depth - Current nesting depth
 * @returns The inferred shorthand value
 */
function inferValue(value: unknown, depth: number): OutputSchemaShorthandValue {
  if (depth > MAX_DEPTH) return "any";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return Number.isFinite(value) ? "number" : "any";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) {
    let item: OutputSchemaShorthandValue | undefined;
    for (const element of value.slice(0, MAX_ARRAY_SAMPLES)) {
      const inferred = inferValue(element, depth + 1);
      item = item === undefined ? inferred : mergeValues(item, inferred);
    }
    return [item ?? "any"];
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return "object";
    const map: OutputSchemaShorthand = {};
    for (const key of keys) {
      map[key] = inferValue((value as Record<string, unknown>)[key], depth + 1);
    }
    return map;
  }
  return "any";
}

/**
 * Merges two inferred shapes (e.g. two array elements) into one that covers both.
 *
 * Maps merge key-wise (union of keys), arrays merge their items, `"any"` yields
 * to the other side, and any other mismatch widens to `"any"`.
 *
 * @param a - The first shape
 * @param b - The second shape
 * @returns The merged shape
 */
function mergeValues(a: OutputSchemaShorthandValue, b: OutputSchemaShorthandValue): OutputSchemaShorthandValue {
  if (a === "any") return b;
  if (b === "any") return a;
  if (typeof a === "string" || typeof b === "string") {
    if (a === b) return a;
    // An empty object merged with a populated one keeps the populated shape.
    if (a === "object" && isMap(b)) return b;
    if (b === "object" && isMap(a)) return a;
    return "any";
  }
  if (Array.isArray(a) && Array.isArray(b)) return [mergeValues(a[0], b[0])];
  if (isMap(a) && isMap(b)) {
    const merged: OutputSchemaShorthand = { ...a };
    for (const [key, value] of Object.entries(b)) {
      merged[key] = key in merged ? mergeValues(merged[key]!, value) : value;
    }
    return merged;
  }
  return "any";
}

/**
 * Reports whether a shorthand value is a nested map.
 *
 * @param value - The shorthand value
 * @returns True when the value is a map (not a leaf string or item array)
 */
function isMap(value: OutputSchemaShorthandValue): value is OutputSchemaShorthand {
  return typeof value === "object" && !Array.isArray(value);
}

/**
 * Infers an `outputSchema` shorthand from a sample value.
 *
 * The shorthand's top level is always a map, so a non-object sample (a string
 * payload, an array) cannot be described and yields `null`.
 *
 * @param value - The sample value (e.g. a run's trigger payload or step result)
 * @returns The inferred shorthand, or `null` when the value is not a plain object
 */
export function inferOutputShorthand(value: unknown): OutputSchemaShorthand | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const inferred = inferValue(value, 0);
  return isMap(inferred) ? inferred : {};
}
