/**
 * TypeBox schemas for workflow JSON5 definitions.
 *
 * Validates workflow structure at load time: trigger config,
 * step definitions, and the root workflow object.
 *
 * Control flow nodes (`if`, `case`, `waitFor`, `emit`) use a recursive
 * step schema so that branches can nest arbitrary step types.
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

/** Slug pattern shared by all step types. */
const SlugPattern = "^[a-z][a-z0-9-]*$";

/** An agent step - runs an LLM prompt via {@link runAgent}. */
export const AgentStepSchema = Type.Object(
  {
    slug: Type.String({ minLength: 1, pattern: SlugPattern }),
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
    slug: Type.String({ minLength: 1, pattern: SlugPattern }),
    type: Type.String({ minLength: 1 }),
  }),
  Type.Record(Type.String(), Type.Unknown()),
]);

// ---------------------------------------------------------------------------
// Control Flow Schemas
// ---------------------------------------------------------------------------

/**
 * Condition schema for `if` nodes.
 *
 * Contains a `ref` template expression and exactly one comparison operator.
 * Operator uniqueness is enforced at runtime by the condition evaluator.
 */
export const ConditionSchema = Type.Object({
  /** Template expression that resolves to the value to test. */
  ref: Type.String({ minLength: 1 }),
  /** Strict equality after String() coercion. */
  eq: Type.Optional(Type.Unknown()),
  /** Logical negation of eq. */
  neq: Type.Optional(Type.Unknown()),
  /** Greater than (numeric if both parseable, otherwise lexicographic). */
  gt: Type.Optional(Type.Unknown()),
  /** Greater than or equal. */
  gte: Type.Optional(Type.Unknown()),
  /** Less than. */
  lt: Type.Optional(Type.Unknown()),
  /** Less than or equal. */
  lte: Type.Optional(Type.Unknown()),
  /** Membership check: resolved value is in the array (String() coercion). */
  in: Type.Optional(Type.Array(Type.Unknown())),
  /** Case-sensitive substring check. */
  contains: Type.Optional(Type.Unknown()),
  /** Truthiness check: not null, not undefined, not empty string. */
  exists: Type.Optional(Type.Boolean()),
  /** Regular expression test against String(resolvedValue). */
  matches: Type.Optional(Type.String()),
});

/** TypeScript type for a condition object. */
export type ConditionDef = Static<typeof ConditionSchema>;

/** Event name pattern shared by `waitFor` and `emit` nodes. */
const EventNamePattern = "^[a-z][a-z0-9._-]*$";

/**
 * WaitFor node schema - pauses execution until an external signal arrives.
 */
export const WaitForStepSchema = Type.Object(
  {
    slug: Type.String({ minLength: 1, pattern: SlugPattern }),
    type: Type.Literal("waitFor"),
    /** Signal event name to wait for. */
    event: Type.String({ minLength: 1, maxLength: 128, pattern: EventNamePattern }),
    /** Timeout in milliseconds (1 second to 7 days). */
    timeout: Type.Optional(Type.Integer({ minimum: 1000, maximum: 604800000 })),
    /** JSON Schema for validating the incoming signal payload. */
    inputSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

/**
 * Emit node schema - sends a named signal to other waiting workflows.
 */
export const EmitStepSchema = Type.Object(
  {
    slug: Type.String({ minLength: 1, pattern: SlugPattern }),
    type: Type.Literal("emit"),
    /** Signal event name to emit. */
    event: Type.String({ minLength: 1, maxLength: 128, pattern: EventNamePattern }),
    /** Optional payload template expression. */
    payload: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/**
 * Recursive step schema that supports nested control flow.
 *
 * TypeBox `Type.Recursive()` is used so that `if` and `case` branches
 * can contain arbitrary steps (including nested control flow nodes).
 */
export const StepSchema = Type.Recursive(
  (Self) => {
    const IfStep = Type.Object(
      {
        slug: Type.String({ minLength: 1, pattern: SlugPattern }),
        type: Type.Literal("if"),
        condition: ConditionSchema,
        // biome-ignore lint/suspicious/noThenProperty: "then" is the workflow branch keyword, not a thenable
        then: Type.Array(Self, { minItems: 1 }),
        else: Type.Optional(Type.Array(Self, { minItems: 1 })),
      },
      { additionalProperties: false },
    );

    const CaseStep = Type.Object(
      {
        slug: Type.String({ minLength: 1, pattern: SlugPattern }),
        type: Type.Literal("case"),
        match: Type.String({ minLength: 1 }),
        paths: Type.Record(Type.String(), Type.Array(Self, { minItems: 1 })),
        default: Type.Optional(Type.Array(Self, { minItems: 1 })),
      },
      { additionalProperties: false },
    );

    return Type.Union([AgentStepSchema, IfStep, CaseStep, WaitForStepSchema, EmitStepSchema, GenericStepSchema]);
  },
  { $id: "WorkflowStep" },
);

/**
 * Non-recursive `IfStepSchema` exported for direct usage in validation messages and type checking.
 * Uses `Type.Any()` for nested step arrays since full recursion is handled by `StepSchema`.
 */
export const IfStepSchema = Type.Object(
  {
    slug: Type.String({ minLength: 1, pattern: SlugPattern }),
    type: Type.Literal("if"),
    condition: ConditionSchema,
    // biome-ignore lint/suspicious/noThenProperty: "then" is the workflow branch keyword, not a thenable
    then: Type.Array(Type.Any(), { minItems: 1 }),
    else: Type.Optional(Type.Array(Type.Any(), { minItems: 1 })),
  },
  { additionalProperties: false },
);

/**
 * Non-recursive `CaseStepSchema` exported for direct usage in validation messages and type checking.
 * Uses `Type.Any()` for nested step arrays since full recursion is handled by `StepSchema`.
 */
export const CaseStepSchema = Type.Object(
  {
    slug: Type.String({ minLength: 1, pattern: SlugPattern }),
    type: Type.Literal("case"),
    match: Type.String({ minLength: 1 }),
    paths: Type.Record(Type.String(), Type.Array(Type.Any(), { minItems: 1 })),
    default: Type.Optional(Type.Array(Type.Any(), { minItems: 1 })),
  },
  { additionalProperties: false },
);

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

/** TypeScript type for an `if` step. */
export interface IfStep {
  slug: string;
  type: "if";
  condition: ConditionDef;
  then: WorkflowStep[];
  else?: WorkflowStep[];
}

/** TypeScript type for a `case` step. */
export interface CaseStep {
  slug: string;
  type: "case";
  match: string;
  paths: Record<string, WorkflowStep[]>;
  default?: WorkflowStep[];
}

/** TypeScript type for a `waitFor` step. */
export interface WaitForStep {
  slug: string;
  type: "waitFor";
  event: string;
  timeout?: number;
  inputSchema?: Record<string, unknown>;
}

/** TypeScript type for an `emit` step. */
export interface EmitStep {
  slug: string;
  type: "emit";
  event: string;
  payload?: string;
}

/** TypeScript type for a single workflow step (all types). */
export type WorkflowStep = AgentStep | IfStep | CaseStep | WaitForStep | EmitStep | GenericStep;

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

// ---------------------------------------------------------------------------
// Global Slug Uniqueness Validator
// ---------------------------------------------------------------------------

/**
 * Recursively collects all step slugs from a step list, including slugs
 * nested inside `then`, `else`, `default`, and `paths` branches of
 * control flow nodes.
 *
 * @param steps - The top-level or nested step array
 * @param seen - Accumulator set of all found slugs
 * @param duplicates - Accumulator set of duplicate slugs
 */
function collectSlugs(steps: WorkflowStep[], seen: Set<string>, duplicates: Set<string>): void {
  for (const step of steps) {
    if (seen.has(step.slug)) {
      duplicates.add(step.slug);
    } else {
      seen.add(step.slug);
    }

    if (step.type === "if") {
      const ifStep = step as IfStep;
      collectSlugs(ifStep.then, seen, duplicates);
      if (ifStep.else) {
        collectSlugs(ifStep.else, seen, duplicates);
      }
    } else if (step.type === "case") {
      const caseStep = step as CaseStep;
      for (const pathSteps of Object.values(caseStep.paths)) {
        collectSlugs(pathSteps, seen, duplicates);
      }
      if (caseStep.default) {
        collectSlugs(caseStep.default, seen, duplicates);
      }
    }
  }
}

/**
 * Validates that all step slugs in a workflow are globally unique,
 * including those nested in control flow branches (`then`, `else`,
 * `default`, `paths`).
 *
 * @param steps - The workflow's top-level step array
 * @returns Array of duplicate slug names (empty if no duplicates)
 */
export function validateGlobalSlugUniqueness(steps: WorkflowStep[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  collectSlugs(steps, seen, duplicates);
  return [...duplicates];
}

/**
 * Warning produced when a terminal step has unreachable successors.
 */
export interface TerminalSuccessorWarning {
  /** Slug of the terminal step that should not have successors. */
  terminalSlug: string;
  /** Slugs of the unreachable successor steps. */
  unreachableSlugs: string[];
}

/**
 * Validates that no terminal step type has successor steps in the same scope.
 * Recursively checks all branches (then, else, paths, default).
 *
 * @param steps - The workflow's top-level step array
 * @param terminalTypes - Set of step type identifiers that are terminal (e.g. "fail")
 * @returns Array of warnings for terminal steps with unreachable successors
 */
export function validateTerminalStepSuccessors(
  steps: WorkflowStep[],
  terminalTypes: Set<string>,
): TerminalSuccessorWarning[] {
  const warnings: TerminalSuccessorWarning[] = [];
  checkStepsArray(steps, terminalTypes, warnings);
  return warnings;
}

/**
 * Recursively checks a step array for terminal steps with successors.
 */
function checkStepsArray(
  steps: WorkflowStep[],
  terminalTypes: Set<string>,
  warnings: TerminalSuccessorWarning[],
): void {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;

    // If this step is terminal and has successors in the same scope, warn
    if (terminalTypes.has(step.type) && i < steps.length - 1) {
      const unreachable = steps.slice(i + 1).map((s) => s.slug);
      warnings.push({ terminalSlug: step.slug, unreachableSlugs: unreachable });
    }

    // Recurse into control flow branches
    if (step.type === "if") {
      const ifStep = step as IfStep;
      checkStepsArray(ifStep.then, terminalTypes, warnings);
      if (ifStep.else) {
        checkStepsArray(ifStep.else, terminalTypes, warnings);
      }
    } else if (step.type === "case") {
      const caseStep = step as CaseStep;
      for (const pathSteps of Object.values(caseStep.paths)) {
        checkStepsArray(pathSteps, terminalTypes, warnings);
      }
      if (caseStep.default) {
        checkStepsArray(caseStep.default, terminalTypes, warnings);
      }
    }
  }
}
