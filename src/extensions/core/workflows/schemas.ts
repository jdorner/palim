/**
 * TypeBox schemas for workflow JSON5 definitions.
 *
 * Validates workflow structure at load time: trigger config,
 * step definitions, and the root workflow object.
 */

import { type Static, Type } from "@sinclair/typebox";

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
  },
  { additionalProperties: false },
);

/** A webhook step - makes an outbound HTTP request. */
export const WebhookStepSchema = Type.Object(
  {
    slug: Type.String({ minLength: 1, pattern: "^[a-z][a-z0-9-]*$" }),
    type: Type.Literal("webhook"),
    url: Type.String({ minLength: 1 }),
    method: Type.Optional(Type.String()),
    body: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Discriminated union of all supported step types. */
export const StepSchema = Type.Union([AgentStepSchema, WebhookStepSchema]);

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
export type WorkflowStep = Static<typeof StepSchema>;

/** TypeScript type for an agent step. */
export type AgentStep = Static<typeof AgentStepSchema>;

/** TypeScript type for a webhook step. */
export type WebhookStep = Static<typeof WebhookStepSchema>;

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
