/**
 * TypeBox schemas for workflow JSON5 definitions.
 *
 * Validates workflow structure at load time: trigger config,
 * step definitions, and the root workflow object.
 */

import { type Static, Type } from "@sinclair/typebox";

/**
 * Recursive schema for describing the shape of a node's output.
 *
 * Used by the frontend autocomplete to suggest deep property paths.
 * Values are either a type-hint string (leaf/terminal, e.g. "string", "number")
 * or a nested object describing sub-properties (non-terminal).
 *
 * Example:
 * ```json
 * { "filename": "string", "metadata": { "size": "number", "type": "string" } }
 * ```
 */
export const OutputSchemaSchema: ReturnType<typeof Type.Recursive> = Type.Recursive(
  (Self) =>
    Type.Record(Type.String(), Type.Union([Type.String(), Self]), {
      description: "Output schema: keys are property names, values are type hints or nested schemas",
    }),
  { $id: "OutputSchema" },
);

/** TypeScript type for a node output schema definition. */
export type OutputSchema = { [key: string]: string | OutputSchema };

/** Trigger configuration - how a workflow is started. */
export const TriggerSchema = Type.Object(
  {
    type: Type.Union([
      Type.Literal("webhook"),
      Type.Literal("schedule"),
      Type.Literal("manual"),
      Type.Literal("filewatcher"),
    ]),
    ref: Type.Optional(Type.String({ minLength: 1 })),
    outputSchema: Type.Optional(OutputSchemaSchema),
  },
  { additionalProperties: false },
);

/**
 * Prompt field accepts a single string or an array of strings.
 * Arrays are joined with `\n` at load time via {@link normalizePrompt}.
 */
export const PromptSchema = Type.Union([Type.String({ minLength: 1 }), Type.Array(Type.String(), { minItems: 1 })]);

/** An agent step - runs an LLM prompt via {@link runAgent}. */
export const AgentStepSchema = Type.Object(
  {
    slug: Type.String({ minLength: 1, pattern: "^[a-z][a-z0-9-]*$" }),
    type: Type.Literal("agent"),
    prompt: PromptSchema,
    tools: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    skills: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    outputSchema: Type.Optional(OutputSchemaSchema),
  },
  { additionalProperties: false },
);

/**
 * A generic step for custom (extension-registered) step types.
 *
 * Requires `slug` and `type` fields; allows any additional properties
 * since the extension's own schema handles detailed validation.
 * The `type` field must not match built-in types (enforced at load time).
 */
export const GenericStepSchema = Type.Intersect([
  Type.Object({
    slug: Type.String({ minLength: 1, pattern: "^[a-z][a-z0-9-]*$" }),
    type: Type.String({ minLength: 1 }),
  }),
  Type.Record(Type.String(), Type.Unknown()),
]);

/**
 * Discriminated union of all supported step types.
 *
 * The `agent` type is validated strictly with a closed schema.
 * Custom step types (including `http-request`) fall through to
 * `GenericStepSchema` which requires only `slug` + `type` and allows
 * additional properties for extension-specific config.
 */
export const StepSchema = Type.Union([AgentStepSchema, GenericStepSchema]);

/** Root workflow definition schema. */
export const WorkflowDefinitionSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, pattern: "^[a-z][a-z0-9-]*$" }),
    description: Type.Optional(Type.String()),
    trigger: TriggerSchema,
    enabled: Type.Optional(Type.Boolean()),
    steps: Type.Array(StepSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

/** TypeScript type for a validated workflow definition. */
export type WorkflowDefinition = Static<typeof WorkflowDefinitionSchema>;

/** TypeScript type for a single workflow step. */
export type WorkflowStep = AgentStep | GenericStep;

/** TypeScript type for an agent step. */
export type AgentStep = Static<typeof AgentStepSchema>;

/** TypeScript type for a generic (custom extension) step. */
export type GenericStep = Static<typeof GenericStepSchema>;

/** TypeScript type for a trigger configuration. */
export type Trigger = Static<typeof TriggerSchema>;

/**
 * Normalizes a prompt value (string or string[]) into a single string.
 * Arrays are joined with newline characters.
 *
 * @param prompt - The raw prompt value from the parsed definition
 * @returns A single string suitable for agent execution
 */
export function normalizePrompt(prompt: string | string[]): string {
  return Array.isArray(prompt) ? prompt.join("\n") : prompt;
}
