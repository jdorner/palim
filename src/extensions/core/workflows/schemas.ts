/**
 * TypeBox schemas for workflow JSON5 definitions.
 *
 * Validates workflow structure at load time: trigger config,
 * step definitions (a map keyed by slug), and the edges between them.
 */

import { PORTAL_UPLOAD_MAX_MB } from "@shared/portal";
import {
  EMIT_EVENT_PATTERN,
  EVENT_NAME_PATTERN,
  type OutputSchemaShorthand,
  TRIGGER_TYPE_PATTERN,
} from "@shared/workflows";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/**
 * Recursive schema for a single output-schema shorthand value: a type-hint
 * string, a nested map, or a one-element array describing the array items.
 */
const OutputSchemaValueSchema = Type.Recursive(
  (Self) =>
    Type.Union([Type.String(), Type.Record(Type.String(), Self), Type.Array(Self, { minItems: 1, maxItems: 1 })]),
  { $id: "OutputSchemaValue" },
);

/**
 * Schema for describing the shape of a node's output.
 *
 * Used by the frontend autocomplete to suggest deep property paths.
 * Values are either a type-hint string (leaf/terminal, e.g. "string", "number",
 * "object", "any"), a nested object describing sub-properties (non-terminal),
 * or a one-element array describing the array items.
 *
 * Example:
 * ```json
 * { "filename": "string", "metadata": { "size": "number" }, "tags": ["string"] }
 * ```
 */
export const OutputSchemaSchema = Type.Record(Type.String(), OutputSchemaValueSchema, {
  $id: "OutputSchema",
  description: "Output schema: keys are property names, values are type hints, nested schemas, or [item] arrays",
});

/**
 * TypeScript type for the type-hint shorthand used to author a node's output
 * shape in JSON5 workflow definitions. Defined in `shared/workflows.ts` so the
 * frontend can produce it too; re-exported here for backend callers.
 */
export type { OutputSchemaShorthand, OutputSchemaShorthandValue } from "@shared/workflows";

/**
 * Configuration of a `portal` trigger: how the workflow is offered in the
 * portal (title, accepted upload, form fields) and who may start it. The
 * account the run executes as is deliberately NOT part of the definition (a
 * file anyone with work-dir access can write): it is bound to the operator who
 * last saved the workflow in the editor (`portalRunAs.ts`).
 */
const PortalTriggerConfigSchema = Type.Object(
  {
    title: Type.Optional(Type.String({ maxLength: 200 })),
    description: Type.Optional(Type.String({ maxLength: 2000 })),
    /** Role names that may start the workflow; empty or absent = everyone with `portal:start`. */
    roles: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 50 })),
    /** Accepted file types (`accept` attribute syntax, e.g. `image/*,application/pdf`). */
    accept: Type.Optional(Type.String({ maxLength: 500 })),
    /** Whether a file must be uploaded (default true). */
    fileRequired: Type.Optional(Type.Boolean()),
    /** Upload size limit in MB (default 20). */
    maxSizeMb: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: PORTAL_UPLOAD_MAX_MB })),
    /** JSON Schema (object) of additional form fields, passed as `trigger.payload.data`. */
    fields: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

// The TypeScript shape of a portal trigger is the shared `PortalTriggerConfig`
// (`@shared/workflows`); schemas.test.ts asserts it matches this schema.

/**
 * Trigger configuration - how a workflow is started. `type` is a built-in
 * type (`BUILTIN_TRIGGER_TYPES`) or one an extension registers
 * (`ctx.triggerTypes`); whether a non-built-in type is registered is checked
 * by the analysis (a warning), not here, so a workflow stays loadable while
 * its extension is disabled.
 */
const TriggerSchema = Type.Object(
  {
    type: Type.String({ pattern: TRIGGER_TYPE_PATTERN }),
    ref: Type.Optional(Type.String({ minLength: 1 })),
    /** Only for `type: "portal"`. */
    portal: Type.Optional(PortalTriggerConfigSchema),
    outputSchema: Type.Optional(OutputSchemaSchema),
  },
  { additionalProperties: false },
);

/** Prompt of an agent step: one string, lines separated by `\n`. */
const PromptSchema = Type.String({ minLength: 1 });

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

/**
 * Delivery scope of a `waitFor` signal: `instance` (default) can only be resumed
 * by direct delivery (signal ID or run + step), `broadcast` additionally by
 * `emit` steps.
 */
const SignalScopeSchema = Type.Union([Type.Literal("broadcast"), Type.Literal("instance")]);

/** Correlation key template shared by `waitFor` and `emit` nodes. */
const CorrelateSchema = Type.String({ minLength: 1, maxLength: 512 });

/** TypeScript type for a trigger configuration. */
export type Trigger = Static<typeof TriggerSchema>;

// ---------------------------------------------------------------------------
// DAG Workflow Schemas (steps map + edges array)
// ---------------------------------------------------------------------------

/** Unanchored slug pattern for DAG step map keys, for embedding in larger patterns. */
export const DAG_SLUG_SOURCE = "[a-z][a-z0-9-]*";

/** Slug pattern for DAG step map keys (same constraints as before). */
const DagSlugPattern = `^${DAG_SLUG_SOURCE}$`;

/**
 * An agent step definition for DAG format (no slug field — slug is the map key).
 */
const DagAgentStepSchema = Type.Object(
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
const IfBranchLabelsSchema = Type.Object(
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
    event: Type.String({ minLength: 1, maxLength: 128, pattern: EVENT_NAME_PATTERN }),
    timeout: Type.Optional(Type.Integer({ minimum: 1000, maximum: 604800000 })),
    inputSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    scope: Type.Optional(SignalScopeSchema),
    correlate: Type.Optional(CorrelateSchema),
  },
  { additionalProperties: false },
);

/** Outcome of a `humanTask` step (an answer button). */
const HumanTaskOutcomeSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9_-]*$" }),
    label: Type.String({ minLength: 1, maxLength: 64 }),
    style: Type.Optional(Type.Union([Type.Literal("primary"), Type.Literal("danger"), Type.Literal("default")])),
  },
  { additionalProperties: false },
);

/**
 * A `humanTask` step definition for DAG format.
 *
 * Creates a human task in the portal and pauses its branch until a person
 * answers it (or it times out). The answer becomes the step result.
 * `title`, `body`, string values in `context`, and the assignee entries
 * support `{{template}}` expressions.
 */
export const DagHumanTaskStepSchema = Type.Object(
  {
    type: Type.Literal("humanTask"),
    title: Type.String({ minLength: 1, maxLength: 500 }),
    body: Type.Optional(Type.String({ maxLength: 20_000 })),
    context: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    assignees: Type.Object(
      {
        users: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 50 })),
        roles: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 50 })),
      },
      { additionalProperties: false },
    ),
    outcomes: Type.Optional(Type.Array(HumanTaskOutcomeSchema, { minItems: 1, maxItems: 10 })),
    form: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    requireComment: Type.Optional(Type.Boolean()),
    priority: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("normal"), Type.Literal("high")])),
    /** Timeout in milliseconds (1 second to 7 days). */
    timeout: Type.Optional(Type.Integer({ minimum: 1000, maximum: 604800000 })),
    /** On timeout: fail the run (default) or resume with `outcome: "expired"`. */
    onTimeout: Type.Optional(Type.Union([Type.Literal("fail"), Type.Literal("expire")])),
  },
  { additionalProperties: false },
);

/**
 * An `emit` step definition for DAG format (no slug field).
 */
export const DagEmitStepSchema = Type.Object(
  {
    type: Type.Literal("emit"),
    // Templates allowed (e.g. a name set once in a variables step); the handler checks the resolved name.
    event: Type.String({ minLength: 1, pattern: EMIT_EVENT_PATTERN }),
    payload: Type.Optional(Type.String()),
    correlate: Type.Optional(CorrelateSchema),
    targetRun: Type.Optional(Type.String({ minLength: 1 })),
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
const DagIteratorStepSchema = Type.Object(
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
const DagAggregatorStepSchema = Type.Object(
  {
    type: Type.Literal("aggregator"),
    iterator: Type.String({ minLength: 1, description: "Slug of the paired iterator node" }),
  },
  { additionalProperties: false },
);

/** The schema of each built-in step type, keyed by its `type`. */
const BUILTIN_STEP_SCHEMAS: Record<string, TSchema> = {
  agent: DagAgentStepSchema,
  if: DagIfStepSchema,
  case: DagCaseStepSchema,
  waitFor: DagWaitForStepSchema,
  humanTask: DagHumanTaskStepSchema,
  emit: DagEmitStepSchema,
  iterator: DagIteratorStepSchema,
  aggregator: DagAggregatorStepSchema,
};

/** The built-in step types (handled by the engine, not by an extension). */
export const BUILTIN_STEP_TYPES: ReadonlySet<string> = new Set(Object.keys(BUILTIN_STEP_SCHEMAS));

/**
 * A generic step for custom (extension-registered) step types in DAG format.
 *
 * Requires `type`; allows any additional properties since the extension's
 * own schema handles detailed validation. Built-in types are excluded, so a
 * malformed built-in step fails instead of passing as a custom one.
 */
const DagGenericStepSchema = Type.Intersect([
  Type.Object({
    type: Type.String({ minLength: 1, pattern: `^(?!(?:${[...BUILTIN_STEP_TYPES].join("|")})$)` }),
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
  DagHumanTaskStepSchema,
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
  /** Delivery scope (default `instance`); only `broadcast` waits can be resumed by `emit`. */
  scope?: "broadcast" | "instance";
  /** Correlation key template, resolved when the wait is registered. */
  correlate?: string;
}

/** TypeScript type for a DAG `humanTask` step. */
export type DagHumanTaskStep = Static<typeof DagHumanTaskStepSchema>;

/** TypeScript type for a DAG `emit` step. */
export interface DagEmitStep {
  type: "emit";
  event: string;
  payload?: string;
  /** Correlation key template; narrows delivery to waits with an equal key. */
  correlate?: string;
  /** Run ID template; narrows delivery to a single run. */
  targetRun?: string;
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
  prompt: string;
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
  | DagHumanTaskStep
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

/** Maximum length of a workflow's `group` name. */
const WORKFLOW_GROUP_MAX_LENGTH = 64;

/** A workflow's free-text group name: non-empty, no leading or trailing whitespace. */
export const WorkflowGroupSchema = Type.String({
  minLength: 1,
  maxLength: WORKFLOW_GROUP_MAX_LENGTH,
  pattern: "^\\S(.*\\S)?$",
});

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
    /** Free-text group name used to organize related workflows in the UI. */
    group: Type.Optional(WorkflowGroupSchema),
    trigger: TriggerSchema,
    enabled: Type.Optional(Type.Boolean()),
    /**
     * A draft is loaded, listed, and can be run by hand, but no event trigger,
     * other workflow, or the portal starts it. See {@link isAutoStartable}.
     */
    draft: Type.Optional(Type.Boolean()),
    steps: Type.Record(Type.String({ pattern: DagSlugPattern }), DagStepDefSchema, {
      minProperties: 1,
      // Without this, keys that do not match the slug pattern are accepted unchecked.
      additionalProperties: false,
    }),
    edges: Type.Array(EdgeSchema),
  },
  { additionalProperties: false },
);

/** TypeScript type for a validated DAG workflow definition. */
export type DagWorkflowDefinition = Static<typeof DagWorkflowDefinitionSchema>;

/** One schema error of a workflow definition. */
export interface DefinitionError {
  /** JSON pointer of the offending value, e.g. `/steps/summarize/prompt`; `""` for the root. */
  path: string;
  message: string;
}

/**
 * Lists the schema errors of a workflow definition. A step that matches no
 * step schema is reported against the schema its `type` selects (e.g.
 * `/steps/a/prompt: Expected string`), not as a bare "Expected union value".
 *
 * @param value - The parsed definition
 * @returns The errors; empty when the definition is valid
 */
export function workflowDefinitionErrors(value: unknown): DefinitionError[] {
  const steps = (value as { steps?: unknown } | null)?.steps;
  const errors: DefinitionError[] = [];
  for (const e of Value.Errors(DagWorkflowDefinitionSchema, value)) {
    const slug = /^\/steps\/([^/]+)$/.exec(e.path)?.[1];
    const step =
      slug !== undefined && steps && typeof steps === "object" ? (steps as Record<string, unknown>)[slug] : undefined;
    const type = (step as { type?: unknown } | undefined)?.type;
    const schema = typeof type === "string" ? BUILTIN_STEP_SCHEMAS[type] : undefined;
    if (!schema) {
      errors.push({ path: e.path, message: e.message });
      continue;
    }
    for (const inner of Value.Errors(schema, step)) {
      errors.push({ path: `${e.path}${inner.path}`, message: inner.message });
    }
  }
  return errors;
}

/**
 * Formats {@link workflowDefinitionErrors} as `path: message` lines.
 *
 * @param value - The parsed definition
 * @param separator - Joins the errors
 * @returns The formatted errors; `""` when the definition is valid
 */
export function formatWorkflowDefinitionErrors(value: unknown, separator = ", "): string {
  return workflowDefinitionErrors(value)
    .map((e) => `${e.path || "(root)"}: ${e.message}`)
    .join(separator);
}

/**
 * Decides whether a workflow may start without a person asking for it: from
 * its event trigger, from another workflow (`start-workflow`,
 * `ctx.workflows.dispatch`), or from the portal. A manual run from the editor
 * or the API is always allowed. This is the only place that rule lives.
 *
 * @param def - The workflow definition
 * @returns True when event triggers, other workflows, and the portal may start this workflow
 */
export function isAutoStartable(def: Pick<DagWorkflowDefinition, "enabled" | "draft">): boolean {
  return def.enabled !== false && def.draft !== true;
}

/** Control flow step types in DAG format. */
export const DAG_CF_TYPES = new Set(["if", "case", "iterator"]);
