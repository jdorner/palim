/**
 * Value coercion for data table cells.
 *
 * Every write path (UI edits, imports, workflow steps, the sandbox program)
 * funnels values through {@link coerceValue}/{@link coerceRow}, so strings from
 * templates, CSV files, and the command line end up stored with the column's
 * declared type.
 *
 * @module
 */

import type { ColumnDef, ColumnType } from "./types";

/** Result of coercing a single value. */
export type CoerceResult = { ok: true; value: unknown } | { ok: false; error: string };

/** Result of coercing a row. */
export interface CoerceRowResult {
  /** The coerced row (only valid when {@link errors} is empty). */
  row: Record<string, unknown>;
  /** Validation errors, one message per problem. */
  errors: string[];
}

const TRUE_STRINGS = new Set(["true", "yes", "y", "ja", "j", "1", "wahr", "x"]);
const FALSE_STRINGS = new Set(["false", "no", "n", "nein", "0", "falsch"]);

/**
 * Parses a numeric string, accepting `.` or `,` decimal separators and
 * `1.234,56` / `1,234.56` style thousands separators.
 *
 * @param input - The trimmed string
 * @returns The number, or `undefined` when the string is not numeric
 */
export function parseNumber(input: string): number | undefined {
  const s = input.replace(/\s/g, "");
  if (s === "") return undefined;
  if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return Number(s);
  // German style: 1.234,56 or 1234,56
  if (/^[+-]?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s) || /^[+-]?\d+,\d+$/.test(s)) {
    return Number(s.replace(/\./g, "").replace(",", "."));
  }
  // English thousands: 1,234.56 or 1,234
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) {
    return Number(s.replace(/,/g, ""));
  }
  return undefined;
}

/**
 * Builds a `YYYY-MM-DD` string after checking that the date exists.
 *
 * @returns The date string, or `undefined` for impossible dates
 */
function formatDate(year: number, month: number, day: number): string | undefined {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return undefined;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Parses a date string in ISO (`2024-03-01`, optionally with a time part),
 * `2024/03/01`, or German (`01.03.2024`, `1.3.24`) notation.
 *
 * @param input - The trimmed string
 * @returns A `YYYY-MM-DD` string, or `undefined` when not a valid date
 */
export function parseDate(input: string): string | undefined {
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ].*)?$/.exec(input);
  if (m) return formatDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/.exec(input);
  if (m) {
    let year = Number(m[3]);
    if (m[3]!.length === 2) year += year < 70 ? 2000 : 1900;
    return formatDate(year, Number(m[2]), Number(m[1]));
  }
  return undefined;
}

/**
 * Parses a date-time string. Accepts ISO 8601 (with `T` or space, with or
 * without offset; values without offset are interpreted in server local time),
 * German `01.03.2024 14:30[:00]`, and date-only values (midnight UTC).
 *
 * @param input - The trimmed string
 * @returns A full ISO string (UTC), or `undefined` when not a valid date-time
 */
export function parseDateTime(input: string): string | undefined {
  const iso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(input);
  if (iso) {
    if (!formatDate(Number(iso[1]), Number(iso[2]), Number(iso[3]))) return undefined;
    const t = new Date(input.replace(" ", "T")).getTime();
    return Number.isNaN(t) ? undefined : new Date(t).toISOString();
  }
  const de = /^(\d{1,2})\.(\d{1,2})\.(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(input);
  if (de) {
    if (!formatDate(Number(de[3]), Number(de[2]), Number(de[1]))) return undefined;
    const d = new Date(
      Number(de[3]),
      Number(de[2]) - 1,
      Number(de[1]),
      Number(de[4]),
      Number(de[5]),
      Number(de[6] ?? 0),
    );
    return d.toISOString();
  }
  const dateOnly = parseDate(input);
  return dateOnly ? `${dateOnly}T00:00:00.000Z` : undefined;
}

/**
 * Whether a raw value counts as empty (stored as `null`).
 *
 * @param raw - The raw value
 * @returns `true` for `null`, `undefined`, and blank strings
 */
export function isEmpty(raw: unknown): boolean {
  return raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "");
}

/**
 * Coerces a non-empty raw value to a column type.
 *
 * @param type - Target column type
 * @param raw - The raw value (string, number, boolean, Date, object, ...)
 * @returns The coerced value or an error message
 */
export function coerceToType(type: ColumnType, raw: unknown): CoerceResult {
  const str = typeof raw === "string" ? raw.trim() : undefined;
  switch (type) {
    case "text":
      if (typeof raw === "string") return { ok: true, value: raw };
      if (raw instanceof Date) return { ok: true, value: raw.toISOString() };
      if (typeof raw === "object") return { ok: true, value: JSON.stringify(raw) };
      return { ok: true, value: String(raw) };
    case "number":
    case "integer": {
      let n: number | undefined;
      if (typeof raw === "number") n = raw;
      else if (typeof raw === "boolean") n = raw ? 1 : 0;
      else if (str !== undefined) n = parseNumber(str);
      if (n === undefined || !Number.isFinite(n)) return { ok: false, error: `"${String(raw)}" is not a number` };
      if (type === "integer" && !Number.isInteger(n)) {
        return { ok: false, error: `"${String(raw)}" is not an integer` };
      }
      return { ok: true, value: n };
    }
    case "boolean": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      if (raw === 1 || raw === 0) return { ok: true, value: raw === 1 };
      if (str !== undefined) {
        const lower = str.toLowerCase();
        if (TRUE_STRINGS.has(lower)) return { ok: true, value: true };
        if (FALSE_STRINGS.has(lower)) return { ok: true, value: false };
      }
      return { ok: false, error: `"${String(raw)}" is not a boolean` };
    }
    case "date": {
      if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
        return { ok: true, value: raw.toISOString().slice(0, 10) };
      }
      const d = str !== undefined ? parseDate(str) : undefined;
      return d ? { ok: true, value: d } : { ok: false, error: `"${String(raw)}" is not a date (YYYY-MM-DD)` };
    }
    case "datetime": {
      if (raw instanceof Date && !Number.isNaN(raw.getTime())) return { ok: true, value: raw.toISOString() };
      if (typeof raw === "number" && Number.isFinite(raw)) return { ok: true, value: new Date(raw).toISOString() };
      const d = str !== undefined ? parseDateTime(str) : undefined;
      return d ? { ok: true, value: d } : { ok: false, error: `"${String(raw)}" is not a date-time (ISO 8601)` };
    }
    case "json": {
      if (str !== undefined) {
        try {
          return { ok: true, value: JSON.parse(str) };
        } catch {
          return { ok: true, value: raw };
        }
      }
      if (raw instanceof Date) return { ok: true, value: raw.toISOString() };
      return { ok: true, value: raw };
    }
  }
}

/**
 * Coerces a raw value for a column. Empty values become `null`.
 *
 * @param column - The target column
 * @param raw - The raw value
 * @returns The coerced value or an error message (prefixed with the column key)
 */
export function coerceValue(column: ColumnDef, raw: unknown): CoerceResult {
  if (isEmpty(raw)) return { ok: true, value: null };
  const result = coerceToType(column.type, raw);
  return result.ok ? result : { ok: false, error: `${column.key}: ${result.error}` };
}

/**
 * Coerces and validates a row against a table's columns.
 *
 * Keys starting with `_` (row metadata such as `_id`) are ignored so rows read
 * from a query can be written back unchanged. Unknown keys are errors.
 *
 * @param columns - The table's columns
 * @param input - The raw row object
 * @param options - `partial`: only validate the provided keys (updates); otherwise
 *   missing columns get their default (or `null`) and `required` is enforced
 * @returns The coerced row and any errors
 */
export function coerceRow(
  columns: readonly ColumnDef[],
  input: Record<string, unknown>,
  options: { partial?: boolean } = {},
): CoerceRowResult {
  const errors: string[] = [];
  const row: Record<string, unknown> = {};
  const byKey = new Map(columns.map((c) => [c.key, c]));

  for (const key of Object.keys(input)) {
    if (key.startsWith("_")) continue;
    if (!byKey.has(key)) errors.push(`unknown column "${key}"`);
  }

  for (const column of columns) {
    const provided = Object.hasOwn(input, column.key);
    if (!provided && options.partial) continue;
    const raw = provided ? input[column.key] : column.default;
    const result = coerceValue(column, raw);
    if (!result.ok) {
      errors.push(result.error);
      continue;
    }
    if (result.value === null && column.required) {
      errors.push(`${column.key}: value is required`);
      continue;
    }
    row[column.key] = result.value;
  }

  return { row, errors };
}

/**
 * Formats a stored value for display or CSV export.
 *
 * @param value - The stored value
 * @returns A display string (`""` for null)
 */
export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
