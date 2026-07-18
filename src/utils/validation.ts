/**
 * Shared validation error formatting for TypeBox schemas.
 *
 * Centralises the `[...Value.Errors(schema, value)].map(...).join(...)` pattern
 * used across route handlers, extensions, and CLI commands.
 *
 * @module
 */

import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/**
 * Collects TypeBox validation errors for a value against a schema and
 * returns a single formatted string.
 *
 * Each error is rendered as `path: message` by default. The separator
 * between errors defaults to `", "`.
 *
 * @param schema - The TypeBox schema to validate against
 * @param value - The value that failed validation
 * @param separator - String used to join individual error messages (default `", "`)
 * @returns A human-readable string describing all validation errors
 *
 * @example
 * ```ts
 * if (!Value.Check(MySchema, body)) {
 *   return status(400, {
 *     error: `Validation failed: ${formatValidationErrors(MySchema, body)}`,
 *   });
 * }
 * ```
 */
export function formatValidationErrors(schema: TSchema, value: unknown, separator = ", "): string {
  const errors = [...Value.Errors(schema, value)];
  return errors.map((e) => `${e.path}: ${e.message}`).join(separator);
}
