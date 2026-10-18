/**
 * Shared input coercion for the built-in template functions.
 *
 * Template values arrive as strings, numbers, objects, arrays, or nothing at
 * all, so every function coerces its inputs through these helpers instead of
 * throwing. Property reads go through {@link ownProp}: functions access data
 * in plain JavaScript, outside the evaluator's sandbox, so they must never
 * follow a data-supplied key such as `constructor` up the prototype chain.
 */

/**
 * Coerce an arbitrary template value to a string for text operations.
 * `null`/`undefined` become the empty string; objects are JSON-serialized.
 *
 * @param value - The value to coerce
 * @returns A string representation
 */
export function toStr(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * Convert a value to a number. Numeric strings (surrounding whitespace
 * ignored) and booleans convert; empty or non-numeric values yield `NaN`.
 *
 * @param value - The value to convert
 * @returns The numeric value, or `NaN` when it is not a number
 */
export function toNum(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value !== "string") return Number.NaN;
  const s = value.trim();
  return s === "" ? Number.NaN : Number(s);
}

/**
 * Coerce a value to an array: arrays pass through, anything else is empty.
 *
 * @param value - The value to coerce
 * @returns The array, or an empty array
 */
export function toList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Convert an optional integer argument (index, length, digit count).
 *
 * @param value - The argument value
 * @param fallback - Used when the argument is missing or not a finite number
 * @returns The argument truncated to an integer, or the fallback
 */
export function toInt(value: unknown, fallback: number): number {
  const n = toNum(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/**
 * Read an own property of a plain object or array. Inherited properties
 * (`constructor`, `__proto__`, methods) are never returned, so a key taken
 * from workflow data cannot reach host functions.
 *
 * @param target - The object to read from
 * @param key - The property key
 * @returns The own property value, or undefined
 */
export function ownProp(target: unknown, key: unknown): unknown {
  if (target === null || typeof target !== "object") return undefined;
  const k = toStr(key);
  return Object.hasOwn(target, k) ? (target as Record<string, unknown>)[k] : undefined;
}

/**
 * Whether a value counts as a real number (finite after {@link toNum}).
 *
 * @param value - The value to test
 * @returns True for finite numeric values
 */
export function isFiniteNum(value: unknown): boolean {
  return Number.isFinite(toNum(value));
}
