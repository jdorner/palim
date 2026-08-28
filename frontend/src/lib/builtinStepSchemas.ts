/**
 * JSON Schema definitions for the built-in workflow control-flow step types
 * (`waitFor`, `emit`, `case`).
 *
 * These schemas mirror the backend TypeBox definitions in
 * `src/extensions/core/workflows/schemas.ts` but are expressed as plain JSON
 * Schema objects so they can be fed directly to `StepConfigForm.svelte`, the
 * same schema-driven renderer used for extension-registered step types.
 *
 * Unlike custom step types, the built-in control-flow types store their config
 * as flat fields directly on the step object (e.g. `step.event`) rather than
 * nested under `step.config`. The sidebar bridges between the two conventions.
 *
 * The `if` step is intentionally NOT covered here: its `condition` is a nested
 * object (a `ref` plus exactly one comparison operator) that the generic form
 * renderer cannot express, so it uses the dedicated `ConditionForm` component.
 *
 * @module
 */

/** Event name pattern shared by `waitFor` and `emit` nodes (mirrors backend). */
const EVENT_NAME_PATTERN = "^[a-z][a-z0-9._-]*$";

/**
 * Config schema for the `waitFor` step: pauses execution until a named signal
 * arrives. The optional `inputSchema` is a JSON Schema object and is therefore
 * left as a complex field (edited via "Edit as JSON").
 */
export const WaitForConfigSchema: Record<string, unknown> = {
  type: "object",
  required: ["event"],
  properties: {
    event: {
      type: "string",
      title: "Event",
      description: "Signal event name to wait for. Lowercase letters, digits, dots, dashes, underscores.",
      minLength: 1,
      maxLength: 128,
      pattern: EVENT_NAME_PATTERN,
    },
    timeout: {
      type: "integer",
      title: "Timeout (ms)",
      description:
        "How long to wait before failing, in milliseconds (1 second to 7 days). Leave empty to wait indefinitely.",
      minimum: 1000,
      maximum: 604800000,
    },
    inputSchema: {
      type: "object",
      title: "Input Schema",
      description: "Optional JSON Schema used to validate the incoming signal payload.",
    },
  },
};

/**
 * Config schema for the `emit` step: sends a named signal to waiting workflows.
 */
export const EmitConfigSchema: Record<string, unknown> = {
  type: "object",
  required: ["event"],
  properties: {
    event: {
      type: "string",
      title: "Event",
      description: "Signal event name to emit. Lowercase letters, digits, dots, dashes, underscores.",
      minLength: 1,
      maxLength: 128,
      pattern: EVENT_NAME_PATTERN,
    },
    payload: {
      type: "string",
      title: "Payload",
      description: "Optional payload. Supports {{template}} expressions.",
      multiline: true,
    },
  },
};

/**
 * Config schema for the `case` step: multi-way branch on a match expression.
 *
 * `paths` lists the branch key names; the actual branch targets are wired
 * through graph edges (`branch: "<key>"`), not stored on the step.
 */
export const CaseConfigSchema: Record<string, unknown> = {
  type: "object",
  required: ["match"],
  properties: {
    match: {
      type: "string",
      title: "Match",
      description: "Expression to evaluate. Supports {{template}} expressions. Its resolved value selects a branch.",
      minLength: 1,
    },
    paths: {
      type: "array",
      title: "Paths",
      description: "Branch key names. Connect each key to a target step via graph edges.",
      items: { type: "string" },
    },
    default: {
      type: "string",
      title: "Default",
      description: "Optional branch key to use when no path matches.",
    },
  },
};

/**
 * Config schema for the `iterator` step: splits an array into per-item execution.
 */
export const IteratorConfigSchema: Record<string, unknown> = {
  type: "object",
  required: ["items"],
  properties: {
    items: {
      type: "string",
      title: "Items",
      description: "Template expression resolving to a JSON array (e.g. '{{trigger.payload}}').",
      minLength: 1,
    },
    as: {
      type: "string",
      title: "Item Variable",
      description: "Variable name for the current element in body step templates. Default: 'item'.",
      pattern: "^[a-zA-Z][a-zA-Z0-9_]*$",
    },
  },
};

/**
 * Config schema for the `aggregator` step: collects per-iteration results.
 */
export const AggregatorConfigSchema: Record<string, unknown> = {
  type: "object",
  required: ["iterator"],
  properties: {
    iterator: {
      type: "string",
      title: "Iterator",
      description: "Slug of the paired iterator node.",
      minLength: 1,
    },
  },
};

/**
 * Registry mapping a built-in control-flow step type to its config schema.
 * Types absent from this map (currently only `if`) use a bespoke form instead.
 */
export const BUILTIN_STEP_CONFIG_SCHEMAS: Record<string, Record<string, unknown>> = {
  waitFor: WaitForConfigSchema,
  emit: EmitConfigSchema,
  case: CaseConfigSchema,
  iterator: IteratorConfigSchema,
  aggregator: AggregatorConfigSchema,
};

/**
 * Returns the config schema for a built-in control-flow step type, or
 * `undefined` if the type has no schema-driven form.
 *
 * @param type - The step type identifier (e.g. "waitFor")
 * @returns The JSON Schema for the type, or undefined
 */
export function builtinConfigSchema(type: string): Record<string, unknown> | undefined {
  return BUILTIN_STEP_CONFIG_SCHEMAS[type];
}
