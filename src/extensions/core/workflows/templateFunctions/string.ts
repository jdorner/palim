/**
 * Text template functions. All work on plain strings (no regular expressions
 * from user input), coercing their inputs with {@link toStr}.
 */

import { toInt, toStr } from "./coerce";

/**
 * Return the substring after the first occurrence of a delimiter. Returns the
 * empty string when the delimiter is not found.
 *
 * @param value - The source string
 * @param delimiter - The delimiter to search for
 * @returns The substring following the first delimiter occurrence
 */
export function after(value: unknown, delimiter: unknown): string {
  const s = toStr(value);
  const d = toStr(delimiter);
  const idx = s.indexOf(d);
  return idx === -1 ? "" : s.slice(idx + d.length);
}

/**
 * Return the substring before the first occurrence of a delimiter. Returns the
 * whole string when the delimiter is not found.
 *
 * @param value - The source string
 * @param delimiter - The delimiter to search for
 * @returns The substring preceding the first delimiter occurrence
 */
export function before(value: unknown, delimiter: unknown): string {
  const s = toStr(value);
  const d = toStr(delimiter);
  const idx = s.indexOf(d);
  return idx === -1 ? s : s.slice(0, idx);
}

/**
 * Return the substring after the last occurrence of a delimiter. Returns the
 * empty string when the delimiter is not found.
 *
 * @param value - The source string
 * @param delimiter - The delimiter to search for
 * @returns The substring following the last delimiter occurrence
 */
export function afterLast(value: unknown, delimiter: unknown): string {
  const s = toStr(value);
  const d = toStr(delimiter);
  const idx = s.lastIndexOf(d);
  return idx === -1 ? "" : s.slice(idx + d.length);
}

/**
 * Return the substring before the last occurrence of a delimiter. Returns the
 * whole string when the delimiter is not found.
 *
 * @param value - The source string
 * @param delimiter - The delimiter to search for
 * @returns The substring preceding the last delimiter occurrence
 */
export function beforeLast(value: unknown, delimiter: unknown): string {
  const s = toStr(value);
  const d = toStr(delimiter);
  const idx = s.lastIndexOf(d);
  return idx === -1 ? s : s.slice(0, idx);
}

/**
 * Trim leading and trailing whitespace from a value.
 *
 * @param value - The value to trim
 * @returns The trimmed string
 */
export function trim(value: unknown): string {
  return toStr(value).trim();
}

/**
 * Convert to upper case.
 *
 * @param value - The text
 * @returns The text in upper case
 */
export function upper(value: unknown): string {
  return toStr(value).toUpperCase();
}

/**
 * Convert to lower case.
 *
 * @param value - The text
 * @returns The text in lower case
 */
export function lower(value: unknown): string {
  return toStr(value).toLowerCase();
}

/**
 * Upper-case the first character, leaving the rest unchanged.
 *
 * @param value - The text
 * @returns The text with its first character in upper case
 */
export function capitalize(value: unknown): string {
  const s = toStr(value);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Length of a text or a list (a list counts its elements). Objects and
 * missing values have length 0.
 *
 * @param value - A string, number, or list
 * @returns The number of characters or elements
 */
export function length(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean") return String(value).length;
  return 0;
}

/**
 * Part of a text by position. Negative positions count from the end.
 *
 * @param value - The text
 * @param start - Start position (inclusive)
 * @param end - End position (exclusive, default: end of text)
 * @returns The selected part
 */
export function substring(value: unknown, start: unknown, end?: unknown): string {
  const s = toStr(value);
  return s.slice(toInt(start, 0), end === undefined ? undefined : toInt(end, s.length));
}

/**
 * Replace every occurrence of a text (plain text, not a pattern).
 *
 * @param value - The source text
 * @param search - The text to find (an empty search leaves the source unchanged)
 * @param replacement - The text to insert
 * @returns The text with all occurrences replaced
 */
export function replace(value: unknown, search: unknown, replacement: unknown): string {
  const s = toStr(value);
  const find = toStr(search);
  return find === "" ? s : s.split(find).join(toStr(replacement));
}

/**
 * Split a text into a list at a separator (plain text, not a pattern).
 *
 * @param value - The text
 * @param separator - The separator (empty: split into characters)
 * @returns The parts; an empty text gives an empty list
 */
export function split(value: unknown, separator: unknown): string[] {
  const s = toStr(value);
  return s === "" ? [] : s.split(toStr(separator));
}

/**
 * Join a list into a text.
 *
 * @param list - The list (non-lists give "")
 * @param separator - Placed between elements (default ", ")
 * @returns The joined text
 */
export function join(list: unknown, separator?: unknown): string {
  if (!Array.isArray(list)) return "";
  return list.map(toStr).join(separator === undefined ? ", " : toStr(separator));
}

/**
 * Pad a text at the start to a minimum length.
 *
 * @param value - The text
 * @param len - The target length (at most 10000)
 * @param fill - The fill text (default " ")
 * @returns The padded text
 */
export function padStart(value: unknown, len: unknown, fill?: unknown): string {
  return toStr(value).padStart(Math.min(toInt(len, 0), 10_000), fill === undefined ? " " : toStr(fill));
}

/**
 * Pad a text at the end to a minimum length.
 *
 * @param value - The text
 * @param len - The target length (at most 10000)
 * @param fill - The fill text (default " ")
 * @returns The padded text
 */
export function padEnd(value: unknown, len: unknown, fill?: unknown): string {
  return toStr(value).padEnd(Math.min(toInt(len, 0), 10_000), fill === undefined ? " " : toStr(fill));
}

/**
 * Whether a text contains a part, or a list contains an element (compared as
 * text, so `contains(["1", "2"], 2)` is true).
 *
 * @param value - A text or a list
 * @param search - The part or element to find
 * @returns True when found
 */
export function contains(value: unknown, search: unknown): boolean {
  if (Array.isArray(value)) {
    const s = toStr(search);
    return value.some((item) => toStr(item) === s);
  }
  return toStr(value).includes(toStr(search));
}

/**
 * Whether a text starts with a prefix.
 *
 * @param value - The text
 * @param prefix - The prefix
 * @returns True when the text starts with the prefix
 */
export function startsWith(value: unknown, prefix: unknown): boolean {
  return toStr(value).startsWith(toStr(prefix));
}

/**
 * Whether a text ends with a suffix.
 *
 * @param value - The text
 * @param suffix - The suffix
 * @returns True when the text ends with the suffix
 */
export function endsWith(value: unknown, suffix: unknown): boolean {
  return toStr(value).endsWith(toStr(suffix));
}

/**
 * Shorten a text to a maximum length, ending with a marker when cut.
 *
 * @param value - The text
 * @param len - Maximum length, including the marker
 * @param suffix - The marker (default "…")
 * @returns The text, cut and marked when longer than `len`
 */
export function truncate(value: unknown, len: unknown, suffix?: unknown): string {
  const s = toStr(value);
  const max = Math.max(toInt(len, s.length), 0);
  if (s.length <= max) return s;
  const marker = suffix === undefined ? "…" : toStr(suffix);
  return marker.length >= max ? s.slice(0, max) : s.slice(0, max - marker.length) + marker;
}
