/**
 * Static analysis of workflow definitions: output schema resolution and the
 * advisory warnings shown in the editor (missing dependencies, invalid step
 * config, trigger refs, templates).
 *
 * @module
 */

import type { ExtensionContext, OutputSchemaContext } from "@ext/types";
import { type OutputSchema, type OutputSchemas, walkSchemaPath } from "@shared/workflows";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { resolveHandlerOutputSchema } from "@src/extensions/engine/stepTypeSerialization";
import { SANDBOX_TOOL_NAMES } from "@src/tools/file";
import type { TemplateVariableResolver } from "@src/variables";
import { type TemplateWarning, validateDagWorkflowTemplates } from "./dagTemplateValidation";
import { validateIteratorPairing } from "./dagValidation";
import { humanTaskOutputSchema } from "./humanTask";
import { compileOutputSchema, resolveTriggerOutputSchemaJson } from "./outputSchemaCompiler";
import type { DagHumanTaskStep, DagWorkflowDefinition, OutputSchemaShorthand } from "./schemas";
import { DagHumanTaskStepSchema } from "./schemas";
import type { TemplateSecretResolver } from "./template";
import { getTriggerRefWarnings, type TriggerRefLookup } from "./triggerRefs";

/** Built-in step types handled directly by the workflow engine. */
const BUILTIN_STEP_TYPES = new Set(["agent", "if", "case", "iterator", "aggregator", "waitFor", "humanTask", "emit"]);

/** Result of validating tool and skill availability for a workflow. */
export interface WorkflowValidationResult {
  /** Whether all referenced tools and skills are available. */
  valid: boolean;
  /** Tool names referenced in steps that are not available. */
  missingTools: string[];
  /** Skill names referenced in steps that are not available. */
  missingSkills: string[];
}

/**
 * Validates that all tools and skills referenced by a workflow's agent steps
 * are currently available.
 *
 * @param definition - The DAG workflow definition to validate
 * @param ctx - Extension context for querying available tools and skills
 * @returns Validation result with lists of missing tools and skills
 */
export function validateWorkflowDependencies(
  definition: DagWorkflowDefinition,
  ctx: ExtensionContext,
): WorkflowValidationResult {
  const availableTools = new Set([...ctx.tools.names(), ...SANDBOX_TOOL_NAMES]);
  const availableSkills = new Set(ctx.skills.names());

  const missingTools = new Set<string>();
  const missingSkills = new Set<string>();

  for (const stepDef of Object.values(definition.steps)) {
    if (stepDef.type !== "agent") continue;
    const agentStep = stepDef as { tools?: string[]; skills?: string[] };

    if (agentStep.tools) {
      for (const tool of agentStep.tools) {
        if (!availableTools.has(tool)) missingTools.add(tool);
      }
    }
    if (agentStep.skills) {
      for (const skill of agentStep.skills) {
        if (!availableSkills.has(skill)) missingSkills.add(skill);
      }
    }
  }

  return {
    valid: missingTools.size === 0 && missingSkills.size === 0,
    missingTools: [...missingTools].sort(),
    missingSkills: [...missingSkills].sort(),
  };
}

/**
 * The resolved `outputSchemas` payload together with any warnings accumulated
 * while building it (unrecognized type hints, per-step failures).
 */
interface BuildOutputSchemasResult {
  /** Canonical JSON Schema payload for the workflow trigger and steps. */
  outputSchemas: OutputSchemas;
  /** Non-fatal warnings produced during compilation/resolution. */
  warnings: TemplateWarning[];
}

/**
 * Serializes a live TypeBox schema into a plain JSON Schema record.
 *
 * The handler-declared `outputSchema` is a TypeBox `TSchema`; the wire payload
 * requires a plain JSON Schema object. A structural clone via JSON round-trip
 * mirrors the registry's own serialization, so completion and validation see
 * the identical shape the registry ships as `StepTypeInfo.outputSchema`.
 *
 * @param schema - The live TypeBox schema declared by a step-type handler
 * @returns A plain JSON Schema record
 */
function serializeHandlerSchema(schema: TSchema): OutputSchema {
  return JSON.parse(JSON.stringify(schema)) as OutputSchema;
}

/**
 * Builds the canonical `outputSchemas` payload (JSON Schema everywhere) for a
 * DAG workflow, applying the source-precedence rules and isolating per-step
 * failures so a single bad step never aborts the whole build.
 *
 * Per-step precedence (highest wins):
 * 1. A hand-authored Type_Hint_Shorthand `outputSchema` on the step, compiled to
 *    JSON Schema via {@link compileOutputSchema}.
 * 2. The step-type handler's declared `outputSchema` (a live TypeBox schema),
 *    serialized to JSON Schema.
 * 3. Neither: the slug is left absent from `outputSchemas.steps`.
 *
 * Step schemas are resolved lazily and memoized, so a config-derived handler
 * schema can look up other steps' (or the trigger's) schemas through the
 * {@link OutputSchemaContext} it receives. A reference that leads back to a step
 * currently being resolved (a self-reference or a cycle) resolves to `undefined`.
 *
 * The trigger schema is resolved via {@link resolveTriggerOutputSchemaJson},
 * preferring an explicit shorthand over the built-in default and compiling the
 * chosen shorthand to JSON Schema.
 *
 * This function is pure and NEVER throws: each step is wrapped in a try/catch so
 * a failure skips that slug and processing continues, and all warnings are
 * accumulated into the returned array rather than surfaced as exceptions.
 *
 * @param definition - The DAG workflow definition whose schemas are being built
 * @param getHandlerOutputSchema - Resolver returning the handler-declared TypeBox
 *   schema already resolved for THIS step instance, or `undefined` when no handler
 *   (or no schema) exists. Receives the step type, the full step definition, and
 *   the workflow-scoped {@link OutputSchemaContext} so the caller can resolve a
 *   config-derived (function-form) `outputSchema` against the instance's config.
 *   Because the resolution happens in the injected resolver,
 *   {@link buildOutputSchemas} stays agnostic of the static-vs-function distinction.
 * @returns The resolved `outputSchemas` payload and any accumulated warnings
 */
export function buildOutputSchemas(
  definition: DagWorkflowDefinition,
  getHandlerOutputSchema: (
    type: string,
    stepDef: Record<string, unknown>,
    schemaCtx: OutputSchemaContext,
  ) => TSchema | undefined,
): BuildOutputSchemasResult {
  const warnings: TemplateWarning[] = [];

  let trigger: OutputSchema | null = null;
  try {
    trigger = resolveTriggerOutputSchemaJson(
      definition.trigger.type,
      definition.trigger.outputSchema as OutputSchemaShorthand | undefined,
      (message) => {
        warnings.push({ stepSlug: "trigger", field: "outputSchema", message });
      },
    );
  } catch {
    // Trigger resolution is best-effort: fall back to null on any failure.
    trigger = null;
  }

  // Memoized per-step resolution. `null` marks a slug resolved to "no schema".
  const resolvedSteps = new Map<string, OutputSchema | null>();
  const visiting = new Set<string>();

  const schemaCtx: OutputSchemaContext = {
    resolveReferenceSchema(expr: string): TSchema | undefined {
      const parts = expr.trim().split(".");
      let root: OutputSchema | null = null;
      let path: string[];
      if (parts[0] === "trigger" && parts[1] === "payload") {
        root = trigger;
        path = parts.slice(2);
      } else if (parts[0] === "steps" && parts.length >= 3 && parts[2] === "result") {
        root = resolveStep(parts[1]!);
        path = parts.slice(3);
      } else {
        return undefined;
      }
      const walked = walkSchemaPath(root, path);
      return walked.resolved && walked.node ? (walked.node as TSchema) : undefined;
    },
  };

  function resolveStep(slug: string): OutputSchema | null {
    if (resolvedSteps.has(slug)) return resolvedSteps.get(slug)!;
    const stepDef = definition.steps[slug];
    // Unknown slug, self-reference, or cycle: no schema (not memoized for the
    // in-progress slug so its own resolution still completes normally).
    if (!stepDef || visiting.has(slug)) return null;

    visiting.add(slug);
    let schema: OutputSchema | null = null;
    try {
      const handAuthored = (stepDef as { outputSchema?: OutputSchemaShorthand }).outputSchema;
      if (handAuthored) {
        // Precedence 1: hand-authored shorthand wins, compiled to JSON Schema.
        schema = compileOutputSchema(handAuthored, (message) => {
          warnings.push({ stepSlug: slug, field: "outputSchema", message });
        });
      } else if ((stepDef as { type: string }).type === "humanTask") {
        // Built-in node with a config-derived result shape (outcomes, form).
        schema = humanTaskOutputSchema(stepDef as DagHumanTaskStep);
      } else {
        // Precedence 2: handler-declared TypeBox schema (static or config-derived),
        // resolved for this instance and serialized to JSON Schema.
        const handlerSchema = getHandlerOutputSchema(
          (stepDef as { type: string }).type,
          stepDef as Record<string, unknown>,
          schemaCtx,
        );
        if (handlerSchema) schema = serializeHandlerSchema(handlerSchema);
        // Precedence 3: neither -> slug absent, no action.
      }
    } catch {
      // Per-step resilience: skip this slug and continue with the rest.
      schema = null;
    } finally {
      visiting.delete(slug);
    }
    resolvedSteps.set(slug, schema);
    return schema;
  }

  const steps: Record<string, OutputSchema> = {};
  for (const slug of Object.keys(definition.steps)) {
    const schema = resolveStep(slug);
    if (schema) steps[slug] = schema;
  }

  return { outputSchemas: { trigger, steps }, warnings };
}

/**
 * Produces per-step warnings for dependencies that are not currently available.
 *
 * @param definition - The DAG workflow definition to check
 * @param ctx - Extension context for querying available tools, skills, and step handlers
 * @returns Array of per-step warnings (empty if all dependencies are satisfied)
 */
export function getDependencyWarnings(definition: DagWorkflowDefinition, ctx: ExtensionContext): TemplateWarning[] {
  const availableTools = new Set([...ctx.tools.names(), ...SANDBOX_TOOL_NAMES]);
  const availableSkills = new Set(ctx.skills.names());
  const warnings: TemplateWarning[] = [];

  for (const [slug, stepDef] of Object.entries(definition.steps)) {
    // Built-in human task nodes: the generic step schema accepts any shape, so
    // check the node's own schema, and that the HITL service is available.
    if (stepDef.type === "humanTask") {
      if (!ctx.internal?.hitl) {
        warnings.push({
          stepSlug: slug,
          field: "type",
          message: "Human tasks are disabled (set HITL_ENABLED=true)",
        });
      }
      // One warning per field: a missing property also fails its type check.
      const reported = new Set<string>();
      for (const err of Value.Errors(DagHumanTaskStepSchema, stepDef)) {
        const field = err.path ? err.path.replace(/^\//, "").replace(/\//g, ".") : "humanTask";
        if (reported.has(field)) continue;
        reported.add(field);
        warnings.push({
          stepSlug: slug,
          field: field || "config",
          message: `Invalid "humanTask" step: ${err.message}${err.path ? ` (at ${err.path})` : ""}`,
        });
      }
      continue;
    }

    // Check custom (extension-registered) step types are available
    if (!BUILTIN_STEP_TYPES.has(stepDef.type)) {
      const handler = ctx.stepTypes.get(stepDef.type);
      if (!handler) {
        warnings.push({
          stepSlug: slug,
          field: "type",
          message: `Step type "${stepDef.type}" is not available (extension disabled or not installed)`,
        });
        continue;
      }
      // The step type exists: validate its config against the handler's own
      // TypeBox schema. Otherwise a malformed custom step (e.g. a field with
      // the wrong type) passes the generic DagStep schema at write time and
      // only fails when the step actually runs. Mirror the handler's own
      // validation contract: strip the keys the handler ignores (`type`,
      // `slug`, `outputSchema`) and check the remaining config fields.
      const { type: _type, slug: _slug, outputSchema: _os, ...configFields } = stepDef as Record<string, unknown>;
      if (!Value.Check(handler.schema, configFields)) {
        for (const err of Value.Errors(handler.schema, configFields)) {
          const field = err.path ? err.path.replace(/^\//, "").replace(/\//g, ".") : stepDef.type;
          warnings.push({
            stepSlug: slug,
            field: field || "config",
            message: `Invalid "${stepDef.type}" step config: ${err.message}${err.path ? ` (at ${err.path})` : ""}`,
          });
        }
      }
      continue;
    }

    if (stepDef.type !== "agent") continue;
    const agentStep = stepDef as { tools?: string[]; skills?: string[] };

    if (agentStep.tools) {
      for (const tool of agentStep.tools) {
        if (!availableTools.has(tool)) {
          warnings.push({
            stepSlug: slug,
            field: "tools",
            message: `Tool "${tool}" is not available (not registered or extension disabled)`,
          });
        }
      }
    }
    if (agentStep.skills) {
      for (const skill of agentStep.skills) {
        if (!availableSkills.has(skill)) {
          warnings.push({
            stepSlug: slug,
            field: "skills",
            message: `Skill "${skill}" is not available (not found or extension disabled)`,
          });
        }
      }
    }
  }

  return warnings;
}

/** Output schemas and advisory warnings of a workflow definition. */
export interface WorkflowAnalysis {
  outputSchemas: OutputSchemas;
  warnings: TemplateWarning[];
}

/**
 * Creates the analyzer shared by the list, detail, and draft-analysis routes,
 * so the three cannot diverge. It resolves a workflow's output schemas and
 * collects every advisory warning (trigger refs, templates, step dependencies,
 * iterator pairing, schema compiler).
 *
 * @param ctx - Extension context (step types, secrets, variables)
 * @returns The analyze function
 */
export function createWorkflowAnalyzer(
  ctx: ExtensionContext,
): (def: DagWorkflowDefinition, triggerRefs: TriggerRefLookup) => Promise<WorkflowAnalysis> {
  // Adapter: wrap ctx.internal.secrets into a TemplateSecretResolver for validation
  const secretResolver: TemplateSecretResolver | undefined = ctx.internal?.secrets
    ? {
        async resolve(name: string, consumer: string) {
          const value = await ctx.internal!.secrets.resolveAs(name, consumer);
          return { value, granted: value !== null, reason: value === null ? "denied or not found" : undefined };
        },
      }
    : undefined;

  // Adapter: wrap ctx.internal.variables into a TemplateVariableResolver for
  // load-time validation (existence checks). Undefined when the variable
  // store is not exposed, in which case var-existence checks are skipped.
  const variableResolver: TemplateVariableResolver | undefined = ctx.internal?.variables
    ? {
        resolve: (key: string) => ctx.internal!.variables.resolve(key),
        has: (key: string) => ctx.internal!.variables.has(key),
      }
    : undefined;

  return async function analyzeWorkflow(def, triggerRefs) {
    // Schemas are resolved BEFORE template validation so the validator and
    // the editor share one resolution.
    const { outputSchemas, warnings: schemaWarnings } = buildOutputSchemas(def, (type, stepDef, schemaCtx) =>
      resolveHandlerOutputSchema(ctx.stepTypes.get(type)?.outputSchema, stepDef, schemaCtx),
    );
    const templateWarnings = await validateDagWorkflowTemplates(def, {
      workflowName: def.name,
      secretStore: secretResolver,
      variableStore: variableResolver,
      resolveStepOutputSchema: (slug) => outputSchemas.steps[slug] ?? null,
      resolveTriggerOutputSchema: () => outputSchemas.trigger,
      allowsSelfReference: (type) => ctx.stepTypes.get(type)?.selfReference === true,
    });
    const pairingWarnings: TemplateWarning[] = validateIteratorPairing(def).map((e) => ({
      stepSlug: "",
      field: "pairing",
      message: e.message,
    }));
    return {
      outputSchemas,
      warnings: [
        ...getTriggerRefWarnings(def, triggerRefs),
        ...templateWarnings,
        ...getDependencyWarnings(def, ctx),
        ...pairingWarnings,
        ...schemaWarnings,
      ],
    };
  };
}
