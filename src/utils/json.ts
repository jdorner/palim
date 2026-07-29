/**
 * Utilities for extracting and validating JSON from LLM output.
 *
 * LLMs frequently wrap JSON in markdown code fences, add surrounding prose,
 * or produce slightly malformed output. These utilities handle common cases
 * so that extension authors don't need to reimplement JSON extraction logic.
 */

import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { StepInputValidation } from "@src/extensions/types";
import { formatValidationErrors } from "./validation";

/**
 * Extracts a JSON value (array or object) from a string that may contain
 * surrounding prose, markdown fences, or other non-JSON text.
 *
 * The function tries each candidate `[` or `{` position in the string:
 * it extracts a balanced substring using bracket-depth counting (respecting
 * JSON string literals), then validates it with `JSON.parse`. If parsing
 * fails (e.g. the bracket was part of prose), it moves on to the next
 * candidate.
 *
 * @param input - The raw string potentially containing JSON among other text
 * @returns The extracted and validated JSON substring
 * @throws Error if no valid JSON structure is found
 *
 * @example
 * ```ts
 * import { extractJson } from "@ext/sdk";
 *
 * const raw = 'Here is the data:\n```json\n[{"a": 1}]\n```';
 * const json = extractJson(raw); // '[{"a": 1}]'
 * ```
 */
export function extractJson(input: string): string {
  let searchFrom = 0;

  while (searchFrom < input.length) {
    const startIndex = input.slice(searchFrom).search(/[[{]/);
    if (startIndex === -1) break;

    const absStart = searchFrom + startIndex;
    const openChar = input[absStart];
    const closeChar = openChar === "[" ? "]" : "}";

    let depth = 0;
    let inString = false;
    let escaped = false;
    let endIndex = -1;

    for (let i = absStart; i < input.length; i++) {
      const ch = input[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (ch === "\\") {
        if (inString) escaped = true;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (ch === openChar) {
        depth++;
      } else if (ch === closeChar) {
        depth--;
        if (depth === 0) {
          endIndex = i;
          break;
        }
      }
    }

    if (endIndex !== -1) {
      const candidate = input.slice(absStart, endIndex + 1);
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        // Not valid JSON at this position — try the next bracket
      }
    }

    searchFrom = absStart + 1;
  }

  throw new Error("No valid JSON array or object found in input");
}

/** Successful result from {@link validateJsonOutput}. */
export interface JsonValidationSuccess {
  /** Validation passed. */
  valid: true;
  /** The parsed JSON data. */
  data: unknown;
}

/** Failed result from {@link validateJsonOutput}. */
export interface JsonValidationFailure {
  /** Validation failed. */
  valid: false;
  /** Diagnostic messages suitable for feeding back to an LLM as repair instructions. */
  diagnostics: string[];
}

/** Result of {@link validateJsonOutput}. */
export type JsonValidationResult = JsonValidationSuccess | JsonValidationFailure;

/**
 * Validates that LLM output contains valid JSON conforming to a TypeBox schema.
 *
 * Combines the common pipeline of:
 * 1. Checking the output is a string
 * 2. Extracting JSON from surrounding prose/fences via {@link extractJson}
 * 3. Parsing the JSON
 * 4. Validating the parsed value against the provided TypeBox schema
 *
 * On success, returns the parsed data. On failure, returns diagnostics
 * suitable for use in a {@link StepInputValidation} response or repair prompt.
 *
 * @param output - The raw output from the preceding step (typically a string)
 * @param schema - A TypeBox schema to validate the parsed JSON against
 * @returns Validation result with parsed data on success or diagnostics on failure
 *
 * @example
 * ```ts
 * import { validateJsonOutput } from "@ext/sdk";
 * import { Type } from "@sinclair/typebox";
 *
 * const RowSchema = Type.Array(Type.Object({ name: Type.String(), age: Type.Number() }));
 *
 * const result = validateJsonOutput(agentOutput, RowSchema);
 * if (!result.valid) {
 *   return { valid: false, diagnostics: result.diagnostics };
 * }
 * const rows = result.data; // typed as unknown, cast as needed
 * ```
 */
export function validateJsonOutput(output: unknown, schema: TSchema): JsonValidationResult {
  if (typeof output !== "string") {
    return {
      valid: false,
      diagnostics: [`Expected a string containing JSON, but received ${typeof output}.`],
    };
  }

  let jsonStr: string;
  try {
    jsonStr = extractJson(output);
  } catch {
    return {
      valid: false,
      diagnostics: [
        "Output must contain a valid JSON array or object. No JSON structure found in the response.",
        "Respond with ONLY valid JSON, no surrounding text or markdown fences.",
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    return {
      valid: false,
      diagnostics: [`JSON syntax error: ${(err as Error).message}`, "Ensure the output is valid JSON."],
    };
  }

  if (Value.Check(schema, parsed)) {
    return { valid: true, data: parsed };
  }

  const errorLines = formatValidationErrors(schema, parsed, "\n")
    .split("\n")
    .filter((line) => line.trim().length > 0);

  return { valid: false, diagnostics: errorLines };
}

/**
 * Convenience wrapper around {@link validateJsonOutput} that returns a
 * {@link StepInputValidation} directly — suitable for use as the return
 * value of a `StepTypeHandler.validateInput` implementation.
 *
 * @param output - The raw output from the preceding step
 * @param schema - A TypeBox schema to validate the parsed JSON against
 * @returns A `StepInputValidation` compatible result
 *
 * @example
 * ```ts
 * import { validateJsonInput } from "@ext/sdk";
 * import { Type } from "@sinclair/typebox";
 *
 * const handler: StepTypeHandler = {
 *   // ...
 *   validateInput(output, stepDef) {
 *     const schema = Type.Array(Type.Object({ name: Type.String() }), { minItems: 1 });
 *     return validateJsonInput(output, schema);
 *   },
 * };
 * ```
 */
export function validateJsonInput(output: unknown, schema: TSchema): StepInputValidation {
  const result = validateJsonOutput(output, schema);
  if (result.valid) {
    return { valid: true };
  }
  return { valid: false, diagnostics: result.diagnostics };
}
