/**
 * Chunk step type handler.
 *
 * A generic, reusable primitive that splits a large input into fixed-size
 * batches so downstream steps can process it in manageable pieces (typically
 * by feeding the produced `batches` array into an `iterator` node).
 *
 * The input may be:
 * - a string, which is split into lines (blank lines are dropped by default),
 *   or split on a caller-supplied `separator`; or
 * - an array, which is grouped directly.
 *
 * Both `input` and `separator` support `{{template}}` expressions, so the input
 * is usually wired from a previous step's result, e.g. the stdout of a
 * `sandbox-exec` step running `find`:
 *
 * ```json5
 * {
 *   type: "chunk",
 *   input: "{{steps.list-files.result.stdout}}",
 *   size: 200
 * }
 * ```
 *
 * The result is `{ batches, count, itemCount }` where `batches` is an array of
 * arrays (each inner array has at most `size` items). This shape is designed to
 * be consumed by an iterator: `items: "{{steps.chunk.result.batches}}"`.
 */

import type { StepExecutionContext, StepTypeHandler } from "@ext/types";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { formatValidationErrors } from "@src/utils/validation";

/** TypeBox schema for the chunk step configuration (excluding slug and type). */
export const ChunkStepConfigSchema = Type.Object(
  {
    input: Type.String({
      minLength: 1,
      title: "Input",
      multiline: true,
      description:
        "The value to split into batches. Supports {{template}} expressions. " +
        "A string is split into lines (or on `separator`); a template resolving " +
        "to a JSON array is grouped directly.",
    }),
    size: Type.Integer({
      minimum: 1,
      maximum: 100000,
      title: "Batch Size",
      description: "Maximum number of items per batch.",
    }),
    separator: Type.Optional(
      Type.String({
        minLength: 1,
        title: "Separator",
        description:
          "String to split the input on. Supports {{template}} expressions. " +
          "Defaults to newline splitting when omitted.",
      }),
    ),
    trim: Type.Optional(
      Type.Boolean({
        title: "Trim Items",
        description: "Trim whitespace from each item and drop empty items. Defaults to true.",
        default: true,
      }),
    ),
  },
  { additionalProperties: false },
);

/** Result shape returned by the chunk step. */
export interface ChunkStepResult {
  /** The input grouped into batches, each with at most `size` items. */
  batches: string[][];
  /** Number of batches produced. */
  count: number;
  /** Total number of items across all batches. */
  itemCount: number;
}

/**
 * Coerces a resolved input value into a flat array of string items.
 *
 * When the resolved string parses as a JSON array, its elements are used
 * directly (stringifying any non-string elements). Otherwise the string is
 * split on the separator (or into lines when no separator is given).
 *
 * @param resolvedInput - The template-resolved input string
 * @param separator - Optional explicit separator; newline splitting when undefined
 * @param trim - Whether to trim each item and drop empties
 * @returns The flat list of items
 */
function toItems(resolvedInput: string, separator: string | undefined, trim: boolean): string[] {
  // Prefer a JSON array when the input resolves to one (e.g. an upstream step
  // whose result is already an array). Fall back to string splitting otherwise.
  const asArray = tryParseJsonArray(resolvedInput);
  let raw: string[];
  if (asArray !== null) {
    raw = asArray.map((el) => (typeof el === "string" ? el : JSON.stringify(el)));
  } else if (separator !== undefined) {
    raw = resolvedInput.split(separator);
  } else {
    // Normalize CRLF/CR to LF before splitting so callers do not have to.
    raw = resolvedInput.replace(/\r\n?/g, "\n").split("\n");
  }

  if (!trim) return raw;
  return raw.map((item) => item.trim()).filter((item) => item.length > 0);
}

/**
 * Attempts to parse a string as a JSON array.
 *
 * @param value - The candidate string
 * @returns The parsed array, or null when the value is not a JSON array
 */
function tryParseJsonArray(value: string): unknown[] | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Groups a flat list into batches of at most `size` items.
 *
 * @param items - The flat list of items
 * @param size - Maximum items per batch
 * @returns The list of batches
 */
function batchItems(items: string[], size: number): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

/**
 * Creates the Chunk step type handler.
 *
 * @returns A {@link StepTypeHandler} for the `chunk` step type
 */
export function createChunkHandler(): StepTypeHandler {
  return {
    schema: ChunkStepConfigSchema,
    outputSchema: Type.Object({
      batches: Type.Array(Type.Array(Type.String()), {
        description: "The input grouped into batches, each with at most `size` items.",
      }),
      count: Type.Number({ description: "Number of batches produced." }),
      itemCount: Type.Number({ description: "Total number of items across all batches." }),
    }),
    label: "Chunk",
    icon: "KnifeIcon",
    category: "action",

    async execute(stepDef: Record<string, unknown>, ctx: StepExecutionContext): Promise<ChunkStepResult> {
      const { slug: _slug, type: _type, outputSchema: _os, ...configFields } = stepDef;

      if (!Value.Check(ChunkStepConfigSchema, configFields)) {
        const errorMsg = formatValidationErrors(ChunkStepConfigSchema, configFields);
        throw new Error(`Invalid chunk step configuration: ${errorMsg}`);
      }

      const config = configFields as {
        input: string;
        size: number;
        separator?: string;
        trim?: boolean;
      };

      const { resolved: input, warnings: inputWarnings } = await ctx.resolveTemplate(config.input);
      for (const w of inputWarnings) {
        await ctx.jobLog(`Warning (input): ${w}`);
      }

      let separator = config.separator;
      if (separator !== undefined) {
        const { resolved, warnings } = await ctx.resolveTemplate(separator);
        for (const w of warnings) {
          await ctx.jobLog(`Warning (separator): ${w}`);
        }
        separator = resolved;
      }

      const trim = config.trim !== false;
      const items = toItems(input, separator, trim);
      const batches = batchItems(items, config.size);

      await ctx.jobLog(`Chunked ${items.length} item(s) into ${batches.length} batch(es) of up to ${config.size}`);

      return { batches, count: batches.length, itemCount: items.length };
    },
  };
}
