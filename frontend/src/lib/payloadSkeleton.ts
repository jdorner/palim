/**
 * Builds the starting JSON for the "Run with payload" dialog from a trigger's
 * `outputSchema` shorthand.
 *
 * @module
 */

import type { OutputSchemaShorthand, OutputSchemaShorthandValue } from "$shared/workflows";

/**
 * Returns the placeholder value for one shorthand entry: `""` for strings, `0`
 * for numbers, `false` for booleans, `[]` for arrays, `{}` for open objects,
 * `null` for `any` or an unknown hint, and nested maps recursed.
 *
 * @param value - A shorthand value
 * @returns Its placeholder
 */
function placeholder(value: OutputSchemaShorthandValue): unknown {
  if (Array.isArray(value)) return [];
  if (value !== null && typeof value === "object") return payloadSkeleton(value);
  switch (value) {
    case "string":
      return "";
    case "number":
      return 0;
    case "boolean":
      return false;
    case "object":
      return {};
    default:
      return null;
  }
}

/**
 * Builds a payload skeleton with one placeholder per declared field.
 *
 * @param schema - The trigger's `outputSchema` shorthand, when one is declared
 * @returns The skeleton object (`{}` without a schema)
 */
export function payloadSkeleton(schema: OutputSchemaShorthand | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return out;
  for (const [key, value] of Object.entries(schema)) out[key] = placeholder(value);
  return out;
}

/** Result of parsing the dialog's text. */
export type PayloadParseResult = { ok: true; value: unknown } | { ok: false };

/**
 * Parses the dialog's JSON text. Empty text is invalid; any JSON value is accepted.
 *
 * @param text - The text the user entered
 * @returns The parsed value, or `{ ok: false }` when the text is not valid JSON
 */
export function parsePayloadText(text: string): PayloadParseResult {
  if (text.trim() === "") return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}
