/**
 * Helpers for editing a trigger's or step's `outputSchema` shorthand in the
 * workflow editor: parsing/validating the textarea JSON. Pure (no browser
 * dependencies) so it can be unit-tested.
 */
import type { OutputSchemaShorthand, OutputSchemaShorthandValue } from "$shared/workflows";
import { translateCore as t } from "./i18nCore";

/** Result of parsing the shorthand textarea. */
export type ShorthandParseResult =
  | { ok: true; value: OutputSchemaShorthand | undefined }
  | { ok: false; error: string };

/**
 * Checks a shorthand value: a string, a nested map, or a one-element array.
 *
 * @param value - The value to check
 * @param path - Dot-path of the value (for error messages)
 * @returns An error message, or null when valid
 */
function checkValue(value: unknown, path: string): string | null {
  if (typeof value === "string") return null;
  if (Array.isArray(value)) {
    if (value.length !== 1) return t("outputSchema.arrayOneEntry", { path });
    return checkValue(value[0], `${path}[]`);
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const error = checkValue(child, path ? `${path}.${key}` : key);
      if (error) return error;
    }
    return null;
  }
  return t("outputSchema.expectedType", { path });
}

/**
 * Parses the shorthand textarea content. Empty text means "no explicit schema".
 *
 * @param text - The JSON text
 * @returns The parsed shorthand, or an error message
 */
export function parseShorthand(text: string): ShorthandParseResult {
  if (text.trim() === "") return { ok: true, value: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      error: t("outputSchema.invalidJson", { error: err instanceof Error ? err.message : String(err) }),
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: t("outputSchema.mustBeObject") };
  }
  const error = checkValue(parsed as OutputSchemaShorthandValue, "");
  return error ? { ok: false, error } : { ok: true, value: parsed as OutputSchemaShorthand };
}

/**
 * Formats a shorthand for the textarea.
 *
 * @param value - The shorthand, or undefined
 * @returns Pretty-printed JSON, or an empty string
 */
export function formatShorthand(value: OutputSchemaShorthand | undefined): string {
  return value ? JSON.stringify(value, null, 2) : "";
}

/** Where to infer the schema from. */
export type InferSource = { kind: "trigger" } | { kind: "step"; slug: string };
