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

/**
 * TypeScript type for the legacy type-hint shorthand used to author a node's
 * output shape in JSON5 workflow definitions.
 *
 * Keys are property names; values are either a type-hint string (leaf/terminal,
 * e.g. "string", "number") or a nested shorthand map (non-terminal). This is the
 * authoring format validated by {@link OutputSchemaSchema}; it is distinct from
 * the canonical JSON Schema `OutputSchema` type defined in `shared/workflows.ts`,
 * which is what the shorthand compiles to.
 */
export type OutputSchemaShorthand = { [key: string]: string | OutputSchemaShorthand };

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
// DAG Workflow Schemas (steps map + edges array)
// ---------------------------------------------------------------------------

/** Slug pattern for DAG step map keys (same constraints as before). */
export const DagSlugPattern = "^[a-z][a-z0-9-]*$";

/**
 * An agent step definition for DAG format (no slug field — slug is the map key).
 */
export const DagAgentStepSchema = Type.Object(
  {
    type: Type.Literal("agent"),
    prompt: PromptSchema,
    tools: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    skills: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    outputSchema: Type.Optional(OutputSchemaSchema),
  },
  { additionalProperties: false },
);

/**
 * Optional display-only labels for an `if` node's branch edges.
 *
 * The branch routing keys stay canonical ("then"/"else") on the edges; these
 * labels only override the TEXT shown on the branch edge in the graph editor.
 * Either may be omitted, in which case the default "then"/"else" text is used.
 */
export const IfBranchLabelsSchema = Type.Object(
  {
    // biome-ignore lint/suspicious/noThenProperty: "then" is the workflow branch keyword, not a thenable
    then: Type.Optional(Type.String({ maxLength: 64 })),
    else: Type.Optional(Type.String({ maxLength: 64 })),
  },
  { additionalProperties: false },
);

/**
 * An `if` step definition for DAG format.
 *
 * Contains the condition — branches are expressed through edges with
 * `branch: "then"` / `branch: "else"` properties. `branchLabels` optionally
 * overrides the display text of those branch edges (display-only; the branch
 * routing keys remain "then"/"else").
 */
export const DagIfStepSchema = Type.Object(
  {
    type: Type.Literal("if"),
    condition: ConditionSchema,
    branchLabels: Type.Optional(IfBranchLabelsSchema),
  },
  { additionalProperties: false },
);

/**
 * A `case` step definition for DAG format.
 *
 * Contains the match expression and path keys — branch steps are separate
 * top-level nodes connected via edges with `branch: "<key>"` properties.
 */
export const DagCaseStepSchema = Type.Object(
  {
    type: Type.Literal("case"),
    match: Type.String({ minLength: 1 }),
    paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    default: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

/**
 * A `waitFor` step definition for DAG format (no slug field).
 */
export const DagWaitForStepSchema = Type.Object(
  {
    type: Type.Literal("waitFor"),
    event: Type.String({ minLength: 1, maxLength: 128, pattern: EventNamePattern }),
    timeout: Type.Optional(Type.Integer({ minimum: 1000, maximum: 604800000 })),
    inputSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

/**
 * An `emit` step definition for DAG format (no slug field).
 */
export const DagEmitStepSchema = Type.Object(
  {
    type: Type.Literal("emit"),
    event: Type.String({ minLength: 1, maxLength: 128, pattern: EventNamePattern }),
    payload: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/**
 * An `iterator` step definition for DAG format.
 *
 * Splits an array into per-item execution scope. Paired with an aggregator
 * that collects results and drives iteration. The `each` branch edge
 * connects to the first body step.
 */
export const DagIteratorStepSchema = Type.Object(
  {
    type: Type.Literal("iterator"),
    items: Type.String({ minLength: 1, description: "Template expression resolving to a JSON array" }),
    as: Type.Optional(Type.String({ minLength: 1, pattern: "^[a-zA-Z][a-zA-Z0-9_]*$" })),
  },
  { additionalProperties: false },
);

/**
 * An `aggregator` step definition for DAG format.
 *
 * Paired to an iterator via the `iterator` field. Collects per-iteration
 * results, drives the loop by resetting the body subgraph between iterations
 * or completing when all items are exhausted. Has regular (unlabeled) outgoing
 * edges to downstream steps.
 */
export const DagAggregatorStepSchema = Type.Object(
  {
    type: Type.Literal("aggregator"),
    iterator: Type.String({ minLength: 1, description: "Slug of the paired iterator node" }),
  },
  { additionalProperties: false },
);

/**
 * A generic step for custom (extension-registered) step types in DAG format.
 *
 * Requires `type`; allows any additional properties since the extension's
 * own schema handles detailed validation.
 */
export const DagGenericStepSchema = Type.Intersect([
  Type.Object({
    type: Type.String({ minLength: 1 }),
  }),
  Type.Record(Type.String(), Type.Unknown()),
]);

/**
 * Union of all DAG step definition types.
 *
 * Each step in the DAG `steps` map must match one of these schemas.
 */
export const DagStepDefSchema = Type.Union([
  DagAgentStepSchema,
  DagIfStepSchema,
  DagCaseStepSchema,
  DagWaitForStepSchema,
  DagEmitStepSchema,
  DagIteratorStepSchema,
  DagAggregatorStepSchema,
  DagGenericStepSchema,
]);

/** TypeScript type for a DAG step definition (without slug — slug is the map key). */
export type DagStepDef = Static<typeof DagStepDefSchema>;

/** Optional display-only labels for an `if` node's then/else branch edges. */
export interface IfBranchLabels {
  then?: string;
  else?: string;
}

/** TypeScript type for a DAG `if` step. */
export interface DagIfStep {
  type: "if";
  condition: ConditionDef;
  /** Optional display-only override for the then/else branch edge labels. */
  branchLabels?: IfBranchLabels;
}

/** TypeScript type for a DAG `case` step. */
export interface DagCaseStep {
  type: "case";
  match: string;
  paths: string[];
  default?: string;
}

/** TypeScript type for a DAG `waitFor` step. */
export interface DagWaitForStep {
  type: "waitFor";
  event: string;
  timeout?: number;
  inputSchema?: Record<string, unknown>;
}

/** TypeScript type for a DAG `emit` step. */
export interface DagEmitStep {
  type: "emit";
  event: string;
  payload?: string;
}

/** TypeScript type for a DAG `iterator` step. */
export interface DagIteratorStep {
  type: "iterator";
  /** Template expression resolving to a JSON array. */
  items: string;
  /** Variable name for the current element (default: "item"). */
  as?: string;
}

/** TypeScript type for a DAG `aggregator` step. */
export interface DagAggregatorStep {
  type: "aggregator";
  /** Slug of the paired iterator node. */
  iterator: string;
}

/** TypeScript type for a DAG agent step. */
export interface DagAgentStep {
  type: "agent";
  prompt: string | string[];
  tools?: string[];
  skills?: string[];
  outputSchema?: OutputSchemaShorthand;
}

/** TypeScript type for a DAG generic step. */
export interface DagGenericStep {
  type: string;
  [key: string]: unknown;
}

/** Union of all typed DAG step definitions. */
export type DagStep =
  | DagAgentStep
  | DagIfStep
  | DagCaseStep
  | DagWaitForStep
  | DagEmitStep
  | DagIteratorStep
  | DagAggregatorStep
  | DagGenericStep;

/**
 * Edge definition in a DAG workflow.
 *
 * `from` and `to` reference step slugs (keys in the steps map).
 * `branch` is required and only valid on edges from CF nodes (if/case).
 */
export const EdgeSchema = Type.Object(
  {
    from: Type.String({ minLength: 1 }),
    to: Type.String({ minLength: 1 }),
    branch: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

/** TypeScript type for an edge. */
export type Edge = Static<typeof EdgeSchema>;

/**
 * Root DAG workflow definition schema.
 *
 * Steps are a map keyed by slug. Edges define the execution graph.
 * Structural and semantic validation (cycles, connectivity, CF rules)
 * is performed separately by {@link validateDag}.
 */
export const DagWorkflowDefinitionSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, pattern: "^[a-z][a-z0-9-]*$" }),
    description: Type.Optional(Type.String()),
    trigger: TriggerSchema,
    enabled: Type.Optional(Type.Boolean()),
    steps: Type.Record(Type.String({ pattern: DagSlugPattern }), DagStepDefSchema, { minProperties: 1 }),
    edges: Type.Array(EdgeSchema),
  },
  { additionalProperties: false },
);

/** TypeScript type for a validated DAG workflow definition. */
export type DagWorkflowDefinition = Static<typeof DagWorkflowDefinitionSchema>;

/** Control flow step types in DAG format. */
export const DAG_CF_TYPES = new Set(["if", "case", "iterator"]);

// ---------------------------------------------------------------------------
// Global Slug Uniqueness Validator (legacy sequential format)
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
