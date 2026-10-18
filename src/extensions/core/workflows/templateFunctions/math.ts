/**
 * Math template functions: number conversion, rounding, limits, formatting.
 */

import { toInt, toList, toNum } from "./coerce";

/**
 * Convert a value to a number, so arithmetic on string values (global
 * variables, payload fields) adds instead of concatenating. Surrounding
 * whitespace is ignored; an empty or non-numeric value yields `NaN`, which the
 * resolver reports with a warning.
 *
 * @param value - The value to convert
 * @returns The numeric value, or `NaN` when it is not a number
 */
export function num(value: unknown): number {
  return toNum(value);
}

/**
 * Convert a value to an integer, truncating toward zero (see {@link num}).
 *
 * @param value - The value to convert
 * @returns The integer value, or `NaN` when it is not a number
 */
export function int(value: unknown): number {
  return Math.trunc(toNum(value));
}

/**
 * Round half away from zero to a number of decimal places. Uses exponent
 * shifting rather than multiplication so values like `1.005` round correctly.
 *
 * @param value - The number to round
 * @param digits - Decimal places (default 0; negative rounds to tens, hundreds, ...)
 * @returns The rounded number
 */
export function round(value: unknown, digits?: unknown): number {
  const n = toNum(value);
  if (!Number.isFinite(n)) return n;
  const d = toInt(digits, 0);
  const shifted = Number(`${Math.abs(n)}e${d}`);
  return Math.sign(n) * Number(`${Math.round(shifted)}e${-d}`);
}

/**
 * Round down to the next integer.
 *
 * @param value - The number
 * @returns The largest integer less than or equal to the value
 */
export function floor(value: unknown): number {
  return Math.floor(toNum(value));
}

/**
 * Round up to the next integer.
 *
 * @param value - The number
 * @returns The smallest integer greater than or equal to the value
 */
export function ceil(value: unknown): number {
  return Math.ceil(toNum(value));
}

/**
 * Absolute value.
 *
 * @param value - The number
 * @returns The value without its sign
 */
export function abs(value: unknown): number {
  return Math.abs(toNum(value));
}

/**
 * Collect the numeric arguments of a variadic call: either several values or
 * a single list. Non-numeric values are skipped.
 *
 * @param args - The call arguments
 * @returns The finite numbers among them
 */
function numericArgs(args: unknown[]): number[] {
  const values = args.length === 1 && Array.isArray(args[0]) ? toList(args[0]) : args;
  return values.map(toNum).filter(Number.isFinite);
}

/**
 * The smallest of several numbers or of a list.
 *
 * @param args - Numbers, or one list of numbers
 * @returns The minimum, or `NaN` when there is no number
 */
export function min(...args: unknown[]): number {
  const nums = numericArgs(args);
  return nums.length === 0 ? Number.NaN : Math.min(...nums);
}

/**
 * The largest of several numbers or of a list.
 *
 * @param args - Numbers, or one list of numbers
 * @returns The maximum, or `NaN` when there is no number
 */
export function max(...args: unknown[]): number {
  const nums = numericArgs(args);
  return nums.length === 0 ? Number.NaN : Math.max(...nums);
}

/**
 * Limit a number to a range.
 *
 * @param value - The number
 * @param lo - Lower bound
 * @param hi - Upper bound
 * @returns The value, raised to `lo` or lowered to `hi` when outside the range
 */
export function clamp(value: unknown, lo: unknown, hi: unknown): number {
  return Math.min(Math.max(toNum(value), toNum(lo)), toNum(hi));
}

/**
 * Format a number for display, with grouping separators.
 *
 * @param value - The number
 * @param digits - Fixed decimal places (default: as many as needed, up to 3)
 * @param locale - BCP 47 locale (default `de-DE`)
 * @returns The formatted number, or "" when the value is not a number
 */
export function formatNumber(value: unknown, digits?: unknown, locale?: unknown): string {
  const n = toNum(value);
  if (!Number.isFinite(n)) return "";
  const d = digits === undefined ? undefined : Math.min(Math.max(toInt(digits, 0), 0), 20);
  const options: Intl.NumberFormatOptions =
    d === undefined ? {} : { minimumFractionDigits: d, maximumFractionDigits: d };
  try {
    return new Intl.NumberFormat(locale === undefined ? "de-DE" : String(locale), options).format(n);
  } catch {
    return new Intl.NumberFormat("de-DE", options).format(n);
  }
}
