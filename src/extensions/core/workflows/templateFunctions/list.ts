/**
 * List template functions. Non-list inputs count as an empty list; element
 * fields are read with {@link ownProp} only.
 */

import { ownProp, toInt, toList, toNum, toStr } from "./coerce";

/** Upper bound for lists built by {@link range}. */
const MAX_RANGE = 10_000;

/**
 * The first element of a list.
 *
 * @param list - The list
 * @returns The first element, or null when the list is empty
 */
export function first(list: unknown): unknown {
  return toList(list)[0] ?? null;
}

/**
 * The last element of a list.
 *
 * @param list - The list
 * @returns The last element, or null when the list is empty
 */
export function last(list: unknown): unknown {
  return toList(list).at(-1) ?? null;
}

/**
 * The element at a position. Negative positions count from the end.
 *
 * @param list - The list
 * @param index - The position
 * @returns The element, or null when there is none
 */
export function at(list: unknown, index: unknown): unknown {
  return toList(list).at(toInt(index, 0)) ?? null;
}

/**
 * Number of elements of a list.
 *
 * @param list - The list
 * @returns The element count (0 for non-lists)
 */
export function count(list: unknown): number {
  return toList(list).length;
}

/**
 * The numeric elements of a list, optionally read from a field of each element.
 *
 * @param list - The list
 * @param key - Optional field name
 * @returns The finite numbers
 */
function numbers(list: unknown, key: unknown): number[] {
  const items = toList(list);
  const values = key === undefined ? items : items.map((item) => ownProp(item, key));
  return values.map(toNum).filter(Number.isFinite);
}

/**
 * Sum of the numbers in a list. Non-numeric elements are skipped.
 *
 * @param list - The list
 * @param key - Optional field to sum (`sum(rows, "price")`)
 * @returns The sum (0 for an empty list)
 */
export function sum(list: unknown, key?: unknown): number {
  return numbers(list, key).reduce((acc, n) => acc + n, 0);
}

/**
 * Average of the numbers in a list. Non-numeric elements are skipped.
 *
 * @param list - The list
 * @param key - Optional field to average
 * @returns The average, or `NaN` when there is no number
 */
export function avg(list: unknown, key?: unknown): number {
  const nums = numbers(list, key);
  return nums.length === 0 ? Number.NaN : nums.reduce((acc, n) => acc + n, 0) / nums.length;
}

/**
 * A field of every element (`pluck(rows, "price")` → list of prices).
 *
 * @param list - A list of objects
 * @param key - The field name
 * @returns The field values (null where an element lacks the field)
 */
export function pluck(list: unknown, key: unknown): unknown[] {
  return toList(list).map((item) => ownProp(item, key) ?? null);
}

/**
 * The list without duplicates (compared by value, first occurrence kept).
 *
 * @param list - The list
 * @returns The distinct elements in their original order
 */
export function unique(list: unknown): unknown[] {
  const seen = new Set<string>();
  return toList(list).filter((item) => {
    const id = typeof item === "string" ? `s:${item}` : `j:${JSON.stringify(item)}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * Compare two values for sorting: numbers numerically, everything else as
 * text (locale-aware); missing values last.
 *
 * @param a - First value
 * @param b - Second value
 * @returns Negative, zero, or positive
 */
function compare(a: unknown, b: unknown): number {
  const aMissing = a === null || a === undefined;
  const bMissing = b === null || b === undefined;
  if (aMissing || bMissing) return Number(aMissing) - Number(bMissing);
  const an = toNum(a);
  const bn = toNum(b);
  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
  return toStr(a).localeCompare(toStr(b));
}

/**
 * A sorted copy of a list, ascending.
 *
 * @param list - The list
 * @param key - Optional field to sort objects by
 * @returns The sorted copy
 */
export function sort(list: unknown, key?: unknown): unknown[] {
  const items = [...toList(list)];
  return key === undefined ? items.sort(compare) : items.sort((a, b) => compare(ownProp(a, key), ownProp(b, key)));
}

/**
 * A reversed copy of a list.
 *
 * @param list - The list
 * @returns The elements in reverse order
 */
export function reverse(list: unknown): unknown[] {
  return [...toList(list)].reverse();
}

/**
 * Part of a list by position. Negative positions count from the end.
 *
 * @param list - The list
 * @param start - Start position (inclusive)
 * @param end - End position (exclusive, default: end of list)
 * @returns The selected elements
 */
export function slice(list: unknown, start: unknown, end?: unknown): unknown[] {
  const items = toList(list);
  return items.slice(toInt(start, 0), end === undefined ? undefined : toInt(end, items.length));
}

/**
 * The field names of an object.
 *
 * @param value - The object
 * @returns Its own field names (empty for non-objects and lists)
 */
export function keys(value: unknown): string[] {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
}

/**
 * The field values of an object.
 *
 * @param value - The object
 * @returns Its own field values (empty for non-objects and lists)
 */
export function values(value: unknown): unknown[] {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.values(value) : [];
}

/**
 * A list of consecutive integers: `range(3)` → `[0, 1, 2]`,
 * `range(2, 5)` → `[2, 3, 4]`. At most 10000 elements.
 *
 * @param startOrCount - The count (one argument) or the start (two arguments)
 * @param end - The end (exclusive)
 * @returns The integers
 */
export function range(startOrCount: unknown, end?: unknown): number[] {
  const from = end === undefined ? 0 : toInt(startOrCount, 0);
  const to = end === undefined ? toInt(startOrCount, 0) : toInt(end, 0);
  const n = Math.min(Math.max(to - from, 0), MAX_RANGE);
  return Array.from({ length: n }, (_, i) => from + i);
}
