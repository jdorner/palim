/**
 * Logic template functions. Unlike the `? :` operator, a function receives
 * all its arguments already evaluated, so `if` cannot guard a member access
 * on a missing value (`if(x != null, x.name, "")` fails when `x` is missing;
 * `x != null ? x.name : ""` does not).
 */

import { isFiniteNum, toNum, toStr } from "./coerce";

/**
 * Pick one of two values by a condition (like a spreadsheet `IF`).
 *
 * @param condition - The condition (truthy/falsy)
 * @param then - Result when the condition is truthy
 * @param otherwise - Result when it is falsy (default null)
 * @returns `then` or `otherwise`
 */
export function ifFn(condition: unknown, then: unknown, otherwise?: unknown): unknown {
  return condition ? then : (otherwise ?? null);
}

/**
 * Map a value to a result by cases, like `switch`:
 * `choose(status, "ok", "✓", "error", "✗", "?")`. Cases compare as text; a
 * trailing unpaired argument is the fallback.
 *
 * @param value - The value to match
 * @param cases - Alternating case and result, optionally followed by a fallback
 * @returns The result of the first matching case, else the fallback, else null
 */
export function choose(value: unknown, ...cases: unknown[]): unknown {
  const v = toStr(value);
  for (let i = 0; i + 1 < cases.length; i += 2) {
    if (toStr(cases[i]) === v) return cases[i + 1];
  }
  return cases.length % 2 === 1 ? cases.at(-1) : null;
}

/**
 * Whether a value is empty: null, missing, "", an empty list, or an object
 * without fields. Whitespace-only text is not empty (use `trim` first).
 *
 * @param value - The value to test
 * @returns True when empty
 */
export function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

/**
 * Whether a value is a number or numeric text.
 *
 * @param value - The value to test
 * @returns True when it converts to a finite number
 */
export function isNumber(value: unknown): boolean {
  return isFiniteNum(value);
}

/**
 * Whether a number lies within a range, bounds included.
 *
 * @param value - The number
 * @param lo - Lower bound
 * @param hi - Upper bound
 * @returns True when `lo <= value <= hi`
 */
export function between(value: unknown, lo: unknown, hi: unknown): boolean {
  const n = toNum(value);
  return n >= toNum(lo) && n <= toNum(hi);
}
