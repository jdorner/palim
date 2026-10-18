/**
 * JSON and encoding template functions.
 */

import { toInt, toStr } from "./coerce";

/**
 * Remove a leading data URI prefix (`data:<mediatype>;base64,`) from a string,
 * yielding the raw base64 payload. Returns the input unchanged (coerced to a
 * string) when no such prefix is present.
 *
 * @param value - A data URI string or plain string
 * @returns The base64 payload without the data URI prefix
 */
export function stripDataUri(value: unknown): string {
  const s = toStr(value);
  const match = /^data:[^;,]*(?:;[^;,]+)*;base64,(.*)$/s.exec(s);
  return match ? match[1]! : s;
}

/**
 * Decode a base64 string to its UTF-8 text form.
 *
 * @param value - A base64-encoded string
 * @returns The decoded UTF-8 text
 */
export function base64Decode(value: unknown): string {
  return Buffer.from(toStr(value), "base64").toString("utf-8");
}

/**
 * Encode a UTF-8 string to its base64 form.
 *
 * @param value - A UTF-8 string (non-string values are coerced first)
 * @returns The base64-encoded text
 */
export function base64Encode(value: unknown): string {
  return Buffer.from(toStr(value), "utf-8").toString("base64");
}

/**
 * Escape a value so it is safe to embed inside a JSON string literal. The
 * returned text contains the inner escapes only (no surrounding quotes), so it
 * can be placed directly between quotes in a JSON body template, e.g.
 * `{"data": "{{ jsonEscape(value) }}"}`.
 *
 * @param value - The value to escape
 * @returns The JSON-escaped inner string (without surrounding quotes)
 */
export function jsonEscape(value: unknown): string {
  const json = JSON.stringify(toStr(value));
  // JSON.stringify wraps in quotes; strip the outer pair to yield inner escapes.
  return json.slice(1, -1);
}

/**
 * Serialize a value as JSON (strings are quoted, unlike plain substitution).
 *
 * @param value - The value
 * @param indent - Spaces per indentation level (default 0, at most 10)
 * @returns The JSON text ("null" for missing values)
 */
export function toJson(value: unknown, indent?: unknown): string {
  return JSON.stringify(value ?? null, null, Math.min(Math.max(toInt(indent, 0), 0), 10)) ?? "null";
}

/**
 * Parse JSON text into a value.
 *
 * @param value - The JSON text
 * @returns The parsed value, or null when the text is not valid JSON
 */
export function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Percent-encode a text for use in a URL component.
 *
 * @param value - The text
 * @returns The encoded text
 */
export function urlEncode(value: unknown): string {
  return encodeURIComponent(toStr(value));
}

/**
 * Decode a percent-encoded URL component.
 *
 * @param value - The encoded text
 * @returns The decoded text, or the input unchanged when it is malformed
 */
export function urlDecode(value: unknown): string {
  const s = toStr(value);
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
