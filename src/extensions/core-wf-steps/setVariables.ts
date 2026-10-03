/**
 * Set Variables step type handler.
 *
 * Defines workflow-local variables: an ordered list of `name -> value` entries
 * where each value is a literal or a `{{template}}` expression. Successor steps
 * reference the values via `{{steps.<slug>.result.<name>}}`. The step's output
 * schema is derived from its configured entries, so the editor can complete and
 * validate those references.
 *
 * Each entry has an optional `type` (`string` by default, or `number`,
 * `boolean`, `json`); the resolved template string is coerced to that type.
 *
 * Entries are evaluated in order, and inside the step a self-reference
 * `{{steps.<slug>.result.<name>}}` resolves to the variable's current value:
 * the value assigned by an earlier entry of this execution, else the value from
 * the step's previous execution (e.g. the previous iteration of an iterator
 * body), else the type's zero value (`""`, `0`, `false`, `null`). Outside an
 * iterator body there is no previous execution, so the validator warns about a
 * self-reference there. Inside one, a variable can accumulate across iterations:
 *
 * ```json5
 * {
 *   type: "set-variables",
 *   variables: [
 *     { name: "text", value: "{{steps.acc.result.text}}{{item.name}}, " },
 *   ]
 * }
 * ```
 */

import type { OutputSchemaContext, StepExecutionContext, StepTypeHandler } from "@ext/types";
import { type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { formatValidationErrors } from "@src/utils/validation";

/** Pattern for variable names: identifier-like so they work in dot-paths and expressions. */
const VARIABLE_NAME_PATTERN = "^[A-Za-z_][A-Za-z0-9_]*$";
const VARIABLE_NAME_REGEX = new RegExp(VARIABLE_NAME_PATTERN);

/** Matches a value that is exactly one `{{<dot-path>}}` reference. */
const SINGLE_REFERENCE_REGEX = /^\s*\{\{\s*([A-Za-z0-9_$.-]+)\s*\}\}\s*$/;

/** Supported variable value types. */
export type VariableType = "string" | "number" | "boolean" | "json";

/** TypeBox schema for a single variable entry. */
const VariableEntrySchema = Type.Object(
  {
    name: Type.String({
      pattern: VARIABLE_NAME_PATTERN,
      title: "Name",
      description:
        "Variable name (letters, digits, underscore; not starting with a digit). " +
        "Referenced as {{steps.<slug>.result.<name>}}.",
    }),
    value: Type.String({
      title: "Value",
      description:
        "Literal value or {{template}} expression. Inside this step, " +
        "{{steps.<slug>.result.<name>}} refers to the variable's current value.",
    }),
    type: Type.Optional(
      Type.Union([Type.Literal("string"), Type.Literal("number"), Type.Literal("boolean"), Type.Literal("json")], {
        title: "Type",
        description: "Type the resolved value is converted to. Defaults to string.",
        default: "string",
      }),
    ),
  },
  { additionalProperties: false },
);

/** TypeBox schema for the set-variables step configuration (excluding slug and type). */
export const SetVariablesStepConfigSchema = Type.Object(
  {
    variables: Type.Array(VariableEntrySchema, {
      minItems: 1,
      title: "Variables",
      description: "Variables to set, evaluated in order.",
    }),
  },
  { additionalProperties: false },
);

/** A single configured variable entry. */
interface VariableEntry {
  name: string;
  value: string;
  type?: VariableType;
}

/**
 * Returns the zero value used for a variable that has no current value.
 *
 * @param type - The variable type
 * @returns The type's zero value
 */
function zeroValue(type: VariableType): unknown {
  switch (type) {
    case "number":
      return 0;
    case "boolean":
      return false;
    case "json":
      return null;
    default:
      return "";
  }
}

/**
 * Converts a resolved template string to the variable's declared type.
 *
 * @param name - The variable name (for error messages)
 * @param raw - The resolved template string
 * @param type - The declared variable type
 * @returns The converted value
 * @throws {Error} When the string cannot be converted to the declared type
 */
function coerce(name: string, raw: string, type: VariableType): unknown {
  switch (type) {
    case "number": {
      const trimmed = raw.trim();
      const num = Number(trimmed);
      if (trimmed === "" || Number.isNaN(num)) {
        throw new Error(`Variable "${name}": "${raw}" is not a number`);
      }
      return num;
    }
    case "boolean": {
      const trimmed = raw.trim();
      if (trimmed === "true") return true;
      if (trimmed === "false") return false;
      throw new Error(`Variable "${name}": "${raw}" is not a boolean (expected "true" or "false")`);
    }
    case "json": {
      if (raw.trim() === "") return null;
      try {
        return JSON.parse(raw);
      } catch (err) {
        throw new Error(`Variable "${name}": invalid JSON (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    default:
      return raw;
  }
}

/**
 * Derives the output schema of a single variable entry.
 *
 * @param entry - The (possibly partial) variable entry
 * @param ctx - Optional workflow-scoped schema context
 * @returns The schema of the variable's value
 */
function entrySchema(entry: Partial<VariableEntry>, ctx: OutputSchemaContext | undefined): TSchema {
  switch (entry.type) {
    case "number":
      return Type.Number();
    case "boolean":
      return Type.Boolean();
    case "json": {
      // A value that copies exactly one reference inherits its schema.
      const match = typeof entry.value === "string" ? SINGLE_REFERENCE_REGEX.exec(entry.value) : null;
      const inherited = match && ctx ? ctx.resolveReferenceSchema(match[1]!) : undefined;
      return inherited ?? Type.Unknown();
    }
    default:
      return Type.String();
  }
}

/**
 * Derives the step's output schema from its configured entries.
 *
 * Defensive against partial/invalid configs (as encountered while editing):
 * entries without a valid name are skipped, and an empty or missing variable
 * list yields an empty object schema.
 *
 * @param stepDef - The serialized step definition
 * @param ctx - Optional workflow-scoped schema context
 * @returns An object schema with one property per variable
 */
export function deriveSetVariablesOutputSchema(stepDef: Record<string, unknown>, ctx?: OutputSchemaContext): TSchema {
  const properties: Record<string, TSchema> = {};
  const variables = Array.isArray(stepDef.variables) ? stepDef.variables : [];
  for (const raw of variables) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Partial<VariableEntry>;
    if (typeof entry.name !== "string" || !VARIABLE_NAME_REGEX.test(entry.name)) continue;
    properties[entry.name] = entrySchema(entry, ctx);
  }
  return Type.Object(properties);
}

/**
 * Creates the Set Variables step type handler.
 *
 * @returns A {@link StepTypeHandler} for the `set-variables` step type
 */
export function createSetVariablesHandler(): StepTypeHandler {
  return {
    schema: SetVariablesStepConfigSchema,
    outputSchema: deriveSetVariablesOutputSchema,
    label: "Set Variables",
    icon: "BracketsCurlyIcon",
    category: "action",
    selfReference: true,

    async execute(stepDef: Record<string, unknown>, ctx: StepExecutionContext): Promise<Record<string, unknown>> {
      const { slug: _slug, type: _type, outputSchema: _os, ...configFields } = stepDef;

      if (!Value.Check(SetVariablesStepConfigSchema, configFields)) {
        const errorMsg = formatValidationErrors(SetVariablesStepConfigSchema, configFields);
        throw new Error(`Invalid set-variables step configuration: ${errorMsg}`);
      }

      const { variables } = configFields as { variables: VariableEntry[] };

      const seen = new Set<string>();
      for (const { name } of variables) {
        if (seen.has(name)) throw new Error(`Duplicate variable name "${name}"`);
        seen.add(name);
      }

      // Seed the current values from the previous execution's result (e.g. the
      // previous iterator pass), falling back to each type's zero value.
      const slug = ctx.stepSlug;
      const previous = slug ? ctx.stepResults?.[slug] : undefined;
      const previousValues =
        previous && typeof previous === "object" && !Array.isArray(previous)
          ? (previous as Record<string, unknown>)
          : {};
      const current: Record<string, unknown> = {};
      for (const { name, type = "string" } of variables) {
        current[name] = name in previousValues ? previousValues[name] : zeroValue(type);
      }

      for (const { name, value, type = "string" } of variables) {
        // Expose the current values as this step's result so self-references
        // resolve to them (snapshot, so later assignments do not leak back).
        const { resolved, warnings } = await ctx.resolveTemplate(
          value,
          slug ? { stepResults: { [slug]: { ...current } } } : undefined,
        );
        for (const w of warnings) {
          await ctx.jobLog(`Warning (${name}): ${w}`);
        }
        current[name] = coerce(name, resolved, type);
      }

      await ctx.jobLog(`Set ${variables.length} variable(s): ${variables.map((v) => v.name).join(", ")}`);

      return current;
    },
  };
}
