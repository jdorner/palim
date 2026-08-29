/**
 * Built-in functions callable from workflow template expressions.
 *
 * These are pure, deterministic, side-effect-free helpers exposed to the
 * expression evaluator (see {@link ./templateEval}). They perform string, data,
 * and date transformations only - never I/O, network, filesystem, or any
 * environment/secret access. The registry is the single source of truth for
 * which function names are valid, shared by the runtime evaluator and the
 * load-time validator (`dagTemplateValidation.ts`) so the two cannot diverge.
 *
 * Functions are intentionally tolerant of non-string inputs (they coerce via
 * {@link toStr}) because template values may arrive as numbers, objects, etc.
 */

/**
 * Coerce an arbitrary template value to a string for text operations.
 * `null`/`undefined` become the empty string; objects are JSON-serialized.
 *
 * @param value - The value to coerce
 * @returns A string representation
 */
function toStr(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

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
 * Trim leading and trailing whitespace from a value.
 *
 * @param value - The value to trim
 * @returns The trimmed string
 */
export function trim(value: unknown): string {
  return toStr(value).trim();
}

/**
 * Return the current time as an ISO 8601 string.
 *
 * Deterministic-testable: honors an injected clock via {@link setClock} so
 * tests can fix "now". Defaults to `Date.now()`.
 *
 * @returns The current time in ISO 8601 format
 */
export function nowIso(): string {
  return new Date(currentClock()).toISOString();
}

/** Injectable clock (milliseconds since epoch). Defaults to `Date.now`. */
let _clock: () => number = () => Date.now();

/**
 * Override the clock used by time functions. Intended for tests.
 *
 * @param clock - A function returning milliseconds since epoch, or null to reset
 */
export function setClock(clock: (() => number) | null): void {
  _clock = clock ?? (() => Date.now());
}

/**
 * Read the current clock value (milliseconds since epoch).
 *
 * @returns Milliseconds since epoch from the active clock
 */
function currentClock(): number {
  return _clock();
}

/**
 * The registry of built-in template functions, keyed by the name authors call
 * in expressions. This object is the single source of truth for valid function
 * names; the validator imports {@link TEMPLATE_FUNCTION_NAMES} to accept them.
 *
 * Note: this is a plain object literal (with an `Object` prototype). It is NOT
 * used directly as the evaluation scope - the evaluator copies these entries
 * into a null-prototype scope so that prototype-chain lookups cannot reach host
 * objects. See {@link ./templateEval}.
 */
export const TEMPLATE_FUNCTIONS: Record<string, (...args: unknown[]) => unknown> = {
  stripDataUri,
  base64Decode,
  jsonEscape,
  after,
  before,
  trim,
  nowIso,
};

/** The set of valid built-in template function names (shared with the validator). */
export const TEMPLATE_FUNCTION_NAMES: ReadonlySet<string> = new Set(Object.keys(TEMPLATE_FUNCTIONS));
