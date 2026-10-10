/**
 * Shared validation functions for workflow editing and creation forms.
 * Pure TypeScript module with no Svelte dependencies.
 */

import type { OutputSchemaShorthand } from "$shared/workflows";
import { translateCore as t } from "./i18nCore";
import type { SlugEdge } from "./templateScope";

/** Result of a single validation check. */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * An edge in a DAG workflow draft.
 *
 * `from`/`to` reference the steps' SYNTHETIC IDS (`StepDraft.id`), not slugs.
 * Id-based edges keep connections stable while the user edits slugs (which may
 * be empty or duplicated mid-edit). They are translated back to slugs only at
 * serialize time (`serializeWorkflowDraft`).
 */
export interface EdgeDraft {
  from: string;
  to: string;
  branch?: string;
}

/** Draft trigger: type, ref, and an optional hand-authored output schema. */
export interface DraftTrigger {
  type: string;
  ref: string;
  /** Hand-authored payload shape for autocomplete/validation. */
  outputSchema?: OutputSchemaShorthand;
}

/** Draft workflow being edited or created (DAG model). */
export interface WorkflowDraft {
  name: string;
  description: string;
  trigger: DraftTrigger;
  enabled: boolean;
  /** Steps as a flat array with slug (converted to a map on serialize). */
  steps: StepDraft[];
  /** DAG edges connecting steps by synthetic id (converted to slugs on serialize). */
  edges: EdgeDraft[];
}

/** Draft step within a workflow (DAG node; branches are edges, not nested arrays). */
export interface StepDraft {
  [key: string]: unknown;
  /**
   * Stable synthetic identity for the editor graph, independent of the slug.
   * Never serialized to the backend (see `serializeStep`); it only keeps node
   * identity/selection/position stable while the user edits the slug. Optional
   * here so pure validation/serialization callers need not mint one; the editor
   * always populates it.
   */
  id?: string;
  slug: string;
  type: string;
  prompt?: string;
  tools?: string[];
  skills?: string[];
  /**
   * Display-only override for an `if` step's then/else branch edge labels.
   * Branch routing keys stay "then"/"else"; only the edge text changes.
   */
  branchLabels?: { then?: string; else?: string };
  /** Raw JSON config for custom (extension-registered) step types. */
  config?: Record<string, unknown>;
  /** Hand-authored result shape (agent and custom steps) for autocomplete/validation. */
  outputSchema?: OutputSchemaShorthand;
}

/**
 * Translates id-based draft edges to slug-based edges using each step's id→slug
 * map. The editor keeps connections stable while slugs are edited by referencing
 * synthetic step ids; the template precedence rule (and the serialized API) works
 * in slug space, so the conversion must happen before those consumers run.
 *
 * Returns an empty array when a referenced id has no matching step, so a
 * partially-edited draft yields no spurious edges rather than a broken reference.
 * Each edge's optional `branch` label is preserved on the slug edge.
 *
 * @param steps - Draft steps carrying both `id` and `slug`
 * @param edges - Draft edges referencing synthetic step ids
 * @returns Edges expressed in slugs, each carrying its `branch` label when present
 */
export function edgesToSlugEdges(steps: Array<{ id?: string; slug: string }>, edges: EdgeDraft[]): SlugEdge[] {
  const idToSlug = new Map(steps.filter((s) => s.id !== undefined).map((s) => [s.id, s.slug] as const));
  const result: SlugEdge[] = [];
  for (const e of edges) {
    const from = idToSlug.get(e.from);
    const to = idToSlug.get(e.to);
    // Preserve the branch label so slug-space consumers (e.g. iterator body
    // detection in the template scope) can identify structural branches like
    // the iterator `each` edge. Omit it when absent rather than storing
    // `undefined`, matching the serialized edge shape.
    if (from !== undefined && to !== undefined) {
      result.push(e.branch !== undefined ? { from, to, branch: e.branch } : { from, to });
    }
  }
  return result;
}

const SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;
const MAX_SLUG_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 256;
const VALID_TRIGGER_TYPES = ["webhook", "schedule", "manual", "filewatcher"];

/**
 * Validates a slug value against the required pattern, length, and presence rules.
 * @param value - The slug string to validate
 * @returns Validation result with error message if invalid
 */
export function validateSlug(value: string): ValidationResult {
  if (!value || value.length === 0) {
    return { valid: false, error: t("validation.slugRequired") };
  }
  if (value.length > MAX_SLUG_LENGTH) {
    return { valid: false, error: t("validation.slugTooLong", { max: MAX_SLUG_LENGTH }) };
  }
  if (!SLUG_PATTERN.test(value)) {
    return {
      valid: false,
      error: t("validation.slugPattern"),
    };
  }
  return { valid: true };
}

/**
 * Validates a workflow name using the same rules as slug validation.
 * @param value - The workflow name to validate
 * @returns Validation result with error message if invalid
 */
export function validateWorkflowName(value: string): ValidationResult {
  if (!value || value.length === 0) {
    return { valid: false, error: t("validation.nameRequired") };
  }
  if (value.length > MAX_SLUG_LENGTH) {
    return { valid: false, error: t("validation.nameTooLong", { max: MAX_SLUG_LENGTH }) };
  }
  if (!SLUG_PATTERN.test(value)) {
    return {
      valid: false,
      error: t("validation.namePattern"),
    };
  }
  return { valid: true };
}

/**
 * Checks that all step slugs in the array are unique.
 * @param slugs - Array of step slug strings to check for duplicates
 * @returns Validation result with error indicating the first duplicate found
 */
export function validateStepSlugsUnique(slugs: string[]): ValidationResult {
  const seen = new Set<string>();
  for (const slug of slugs) {
    if (seen.has(slug)) {
      return { valid: false, error: t("validation.duplicateSlug", { slug }) };
    }
    seen.add(slug);
  }
  return { valid: true };
}

/**
 * Validates a custom step's config values against a JSON Schema.
 * Checks required fields, minLength/maxLength/pattern for strings, and
 * minimum/maximum for numbers. Recurses into nested objects and arrays of
 * objects, keying their errors the way the config form routes them
 * (`headers.X-Id`, `variables[2].name`).
 *
 * At the top level an empty string counts as "not set" (the form's convention
 * for optional inputs). Inside nested objects and list items every field is
 * materialized by the form, so an empty string is a real value: it is only an
 * error when it violates a string constraint, and is then reported as required.
 *
 * @param config - The step config values to validate
 * @param schema - The JSON Schema object describing expected config fields
 * @param prefix - Key prefix for nested errors (internal)
 * @returns Array of [fieldName, errorMessage] tuples for each violation
 */
export function validateStepConfig(
  config: Record<string, unknown>,
  schema: Record<string, unknown>,
  prefix = "",
): [string, string][] {
  const errors: [string, string][] = [];
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required ?? []) as string[];
  const nested = prefix !== "";
  const labelOf = (key: string): string => (properties[key]?.title as string | undefined) ?? key;

  for (const key of required) {
    const value = config[key];
    if (value === undefined || value === null || (!nested && value === "")) {
      errors.push([`${prefix}${key}`, t("validation.fieldRequired", { label: labelOf(key) })]);
    }
  }

  for (const [key, prop] of Object.entries(properties)) {
    const value = config[key];
    const field = `${prefix}${key}`;
    const label = labelOf(key);

    // Skip fields that are absent and not required (already caught above if required)
    if (value === undefined || value === null || (!nested && value === "")) continue;

    if (prop.type === "string" && typeof value === "string") {
      const message = stringConstraintError(value, prop, label);
      if (message) {
        errors.push([
          field,
          value === "" && required.includes(key) ? t("validation.fieldRequired", { label }) : message,
        ]);
      }
    }

    if ((prop.type === "number" || prop.type === "integer") && typeof value === "number") {
      const minimum = prop.minimum as number | undefined;
      if (minimum !== undefined && value < minimum) {
        errors.push([field, t("validation.minValue", { label, min: minimum })]);
      }
      const maximum = prop.maximum as number | undefined;
      if (maximum !== undefined && value > maximum) {
        errors.push([field, t("validation.maxValue", { label, max: maximum })]);
      }
    }

    if (prop.type === "object" && prop.properties && isPlainObject(value)) {
      errors.push(...validateStepConfig(value, prop, `${field}.`));
    }

    const items = prop.items as Record<string, unknown> | undefined;
    if (prop.type === "array" && Array.isArray(value) && items?.type === "object" && items.properties) {
      value.forEach((item, i) => {
        if (isPlainObject(item)) errors.push(...validateStepConfig(item, items, `${field}[${i}].`));
      });
    }
  }

  return errors;
}

/**
 * Checks a string value against its schema's length and pattern constraints.
 * The pattern is not applied to values containing a `{{...}}` template, since
 * step types may resolve templates before validating.
 *
 * @param value - The string value
 * @param prop - The property's JSON Schema
 * @param label - The field label used in messages
 * @returns The first violation's message, or undefined when the value is valid
 */
function stringConstraintError(value: string, prop: Record<string, unknown>, label: string): string | undefined {
  const minLength = prop.minLength as number | undefined;
  if (minLength && value.length < minLength) return t("validation.minLength", { label, min: minLength });
  const maxLength = prop.maxLength as number | undefined;
  if (maxLength && value.length > maxLength) return t("validation.maxLength", { label, max: maxLength });
  const pattern = prop.pattern as string | undefined;
  if (pattern && !value.includes("{{")) {
    let regex: RegExp | undefined;
    try {
      regex = new RegExp(pattern);
    } catch {
      // An invalid pattern cannot be checked client-side; the backend reports it.
    }
    if (regex && !regex.test(value)) return t("validation.pattern", { label, pattern });
  }
  return undefined;
}

/** Whether a value is a plain (non-array) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Schema metadata for a custom step type, used for config validation. */
export interface StepTypeSchema {
  /** The step type identifier. */
  type: string;
  /** JSON Schema describing the step's config fields. */
  configSchema?: Record<string, unknown>;
}

/**
 * Validates a complete workflow draft and returns a map of field paths to error messages.
 * An empty map indicates the draft is valid.
 * @param draft - The workflow draft to validate
 * @param stepTypeSchemas - Optional array of custom step type schemas for config validation
 * @returns Map where keys are field paths (e.g. "name", "steps[0].slug") and values are error messages
 */
export function validateWorkflowDraft(draft: WorkflowDraft, stepTypeSchemas?: StepTypeSchema[]): Map<string, string> {
  const errors = new Map<string, string>();

  // Validate name
  const nameResult = validateWorkflowName(draft.name);
  if (!nameResult.valid && nameResult.error) {
    errors.set("name", nameResult.error);
  }

  // Validate description (optional, max 256 chars)
  if (draft.description && draft.description.length > MAX_DESCRIPTION_LENGTH) {
    errors.set("description", t("validation.descriptionTooLong", { max: MAX_DESCRIPTION_LENGTH }));
  }

  // Validate trigger type
  if (!draft.trigger.type || !VALID_TRIGGER_TYPES.includes(draft.trigger.type)) {
    errors.set("trigger.type", t("validation.triggerType"));
  }

  // Manual triggers must not have a ref
  if (draft.trigger.type === "manual" && draft.trigger.ref && draft.trigger.ref.trim().length > 0) {
    errors.set("trigger.ref", t("validation.manualNoRef"));
  }

  // Non-manual triggers require a ref
  if (draft.trigger.type !== "manual" && (!draft.trigger.ref || draft.trigger.ref.trim().length === 0)) {
    errors.set("trigger.ref", t("validation.triggerNeedsRef", { type: draft.trigger.type }));
  }

  // Validate steps - at least one required
  if (!draft.steps || draft.steps.length === 0) {
    errors.set("steps", t("validation.stepRequired"));
    return errors;
  }

  // Validate each step slug and type-specific required fields
  const slugs: string[] = [];
  for (let i = 0; i < draft.steps.length; i++) {
    validateStepFields(draft.steps[i], `steps[${i}]`, slugs, errors, stepTypeSchemas);
  }

  // Validate step slugs uniqueness
  const uniqueResult = validateStepSlugsUnique(slugs);
  if (!uniqueResult.valid && uniqueResult.error) {
    errors.set("steps.slugs", uniqueResult.error);
  }

  // Validate edges reference existing steps. Edges are keyed by the step
  // identity (`id` when present, else `slug` for callers that don't mint ids).
  const stepIdentity = (s: StepDraft): string => s.id ?? s.slug;
  const identitySet = new Set(draft.steps.map(stepIdentity));
  const identityToSlug = new Map(draft.steps.map((s) => [stepIdentity(s), s.slug]));
  const edges = draft.edges ?? [];
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i]!;
    if (!identitySet.has(edge.from)) {
      errors.set(
        `edges[${i}].from`,
        t("validation.edgeUnknownStep", { step: identityToSlug.get(edge.from) ?? edge.from }),
      );
    }
    if (!identitySet.has(edge.to)) {
      errors.set(`edges[${i}].to`, t("validation.edgeUnknownStep", { step: identityToSlug.get(edge.to) ?? edge.to }));
    }
  }

  // Flag orphaned steps (no incoming or outgoing edges) when the graph has more
  // than one step. A single-step workflow legitimately has no edges.
  for (const i of computeOrphanedStepIndices(draft)) {
    errors.set(`steps[${i}].slug`, disconnectedStepError(draft.steps[i]!.slug));
  }

  return errors;
}

/**
 * Builds the standard "not connected" validation message for a step. Kept as a
 * single source of truth so callers that incrementally clear this error (e.g.
 * after an edge is drawn) can identify it unambiguously.
 *
 * @param slug - The step's slug (may be empty mid-edit).
 * @returns The disconnected-step error message.
 */
export function disconnectedStepError(slug: string): string {
  return t("validation.disconnected", { slug });
}

/**
 * Returns the indices of steps that are orphaned: not touched by any edge as
 * either endpoint. Connectivity is keyed by step identity (`id` when present,
 * else `slug`), matching how draft edges reference steps.
 *
 * Only meaningful when the draft has more than one step; a single-step workflow
 * legitimately has no edges, so this returns an empty array in that case.
 *
 * @param draft - The workflow draft to inspect.
 * @returns Indices (into `draft.steps`) of disconnected steps.
 */
export function computeOrphanedStepIndices(draft: WorkflowDraft): number[] {
  if (draft.steps.length <= 1) return [];
  const stepIdentity = (s: StepDraft): string => s.id ?? s.slug;
  const connected = new Set<string>();
  for (const edge of draft.edges ?? []) {
    connected.add(edge.from);
    connected.add(edge.to);
  }
  const orphaned: number[] = [];
  for (let i = 0; i < draft.steps.length; i++) {
    if (!connected.has(stepIdentity(draft.steps[i]!))) {
      orphaned.push(i);
    }
  }
  return orphaned;
}

/**
 * Validates a single step's fields (slug, type-specific requirements, custom config).
 * DAG steps have no nested branches — branches are expressed as edges.
 */
function validateStepFields(
  step: StepDraft,
  path: string,
  slugs: string[],
  errors: Map<string, string>,
  stepTypeSchemas?: StepTypeSchema[],
): void {
  const slugResult = validateSlug(step.slug);
  if (!slugResult.valid && slugResult.error) {
    errors.set(`${path}.slug`, slugResult.error);
  }
  slugs.push(step.slug);

  if (step.type === "agent" && (!step.prompt || step.prompt.trim().length === 0)) {
    errors.set(`${path}.prompt`, t("validation.promptRequired"));
  }

  if (step.type === "if") {
    if (!step.condition || !(step.condition as Record<string, unknown>).ref) {
      errors.set(`${path}.condition`, t("validation.conditionRequired"));
    }
  }

  if (step.type === "case") {
    if (!step.match || (step.match as string).trim().length === 0) {
      errors.set(`${path}.match`, t("validation.matchRequired"));
    }
  }

  if (step.type === "waitFor" && (!step.event || (step.event as string).trim().length === 0)) {
    errors.set(`${path}.event`, t("validation.eventRequired"));
  }

  if (step.type === "emit" && (!step.event || (step.event as string).trim().length === 0)) {
    errors.set(`${path}.event`, t("validation.eventRequired"));
  }

  if (step.type === "iterator" && (!step.items || (step.items as string).trim().length === 0)) {
    errors.set(`${path}.items`, t("validation.itemsRequired"));
  }

  if (step.type === "aggregator" && (!step.iterator || (step.iterator as string).trim().length === 0)) {
    errors.set(`${path}.iterator`, t("validation.iteratorRequired"));
  }

  // Custom step type config validation
  if (!["agent", "if", "case", "waitFor", "emit"].includes(step.type) && stepTypeSchemas) {
    const schemaInfo = stepTypeSchemas.find((s) => s.type === step.type);
    if (schemaInfo?.configSchema) {
      const configErrors = validateStepConfig(step.config ?? {}, schemaInfo.configSchema);
      for (const [field, message] of configErrors) {
        errors.set(`${path}.config.${field}`, message);
      }
    }
  }
}

/**
/**
 * Normalizes an `if` step's branch-label overrides for persistence.
 *
 * Trims each label and drops empty ones. Returns an object with only the
 * non-empty labels, or `undefined` when neither is set (so no `branchLabels`
 * key is written). Keeps the persisted shape minimal and matches the backend's
 * `additionalProperties: false` on the labels object.
 *
 * @param branchLabels - The draft's raw then/else label overrides.
 * @returns A minimal `{ then?, else? }` object, or undefined when empty.
 */
export function normalizeIfBranchLabels(
  branchLabels: { then?: string; else?: string } | undefined,
): { then?: string; else?: string } | undefined {
  if (!branchLabels) return undefined;
  const result: { then?: string; else?: string } = {};
  const then = branchLabels.then?.trim();
  const els = branchLabels.else?.trim();
  // biome-ignore lint/suspicious/noThenProperty: "then" is the workflow branch keyword, not a thenable
  if (then) result.then = then;
  if (els) result.else = els;
  return result.then || result.else ? result : undefined;
}

/**
 * Serializes a single StepDraft into a clean object containing only the fields
 * valid for the step's type. This prevents the backend's `additionalProperties: false`
 * rejection when extra fields are present.
 * @param step - The step draft to serialize
 * @returns A plain object with only the fields appropriate for the step's type
 */
export function serializeStep(step: StepDraft): Record<string, unknown> {
  if (step.type === "agent") {
    const result: Record<string, unknown> = {
      type: "agent",
      prompt: step.prompt,
    };
    if (step.tools && step.tools.length > 0) {
      result.tools = step.tools;
    }
    if (step.skills && step.skills.length > 0) {
      result.skills = step.skills;
    }
    if (step.outputSchema) result.outputSchema = step.outputSchema;
    return result;
  }

  // Control flow: if (branches are edges, not nested arrays)
  if (step.type === "if") {
    const result: Record<string, unknown> = {
      type: "if",
      condition: step.condition,
    };
    // Persist branch label overrides only when at least one is a non-empty
    // string, so empty sidebar inputs don't write an empty object (which would
    // still be valid but is noise) or blank keys.
    const branchLabels = normalizeIfBranchLabels(step.branchLabels);
    if (branchLabels) result.branchLabels = branchLabels;
    return result;
  }

  // Control flow: case (paths is a string array of branch keys; branches are edges)
  if (step.type === "case") {
    const result: Record<string, unknown> = {
      type: "case",
      match: step.match,
    };
    if (Array.isArray(step.paths)) {
      result.paths = step.paths;
    }
    if (typeof step.default === "string" && step.default.length > 0) {
      result.default = step.default;
    }
    return result;
  }

  // Control flow: waitFor
  if (step.type === "waitFor") {
    const result: Record<string, unknown> = {
      type: "waitFor",
      event: step.event,
    };
    if (step.timeout) result.timeout = step.timeout;
    if (step.inputSchema) result.inputSchema = step.inputSchema;
    // "instance" is the default, so only the non-default scope is written.
    if (step.scope === "broadcast") result.scope = "broadcast";
    if (typeof step.correlate === "string" && step.correlate.length > 0) result.correlate = step.correlate;
    return result;
  }

  // Control flow: emit
  if (step.type === "emit") {
    const result: Record<string, unknown> = {
      type: "emit",
      event: step.event,
    };
    if (step.payload) result.payload = step.payload;
    if (typeof step.correlate === "string" && step.correlate.length > 0) result.correlate = step.correlate;
    if (typeof step.targetRun === "string" && step.targetRun.length > 0) result.targetRun = step.targetRun;
    return result;
  }

  // Control flow: iterator
  if (step.type === "iterator") {
    const result: Record<string, unknown> = {
      type: "iterator",
      items: step.items,
    };
    if (step.as) result.as = step.as;
    return result;
  }

  // Control flow: aggregator
  if (step.type === "aggregator") {
    return {
      type: "aggregator",
      iterator: step.iterator,
    };
  }

  // Custom (extension-registered) step type: merge type + config (no slug)
  return {
    type: step.type,
    ...(step.config ?? {}),
    ...(step.outputSchema ? { outputSchema: step.outputSchema } : {}),
  };
}

/**
 * Serializes a complete WorkflowDraft into a DAG object suitable for the
 * backend API: `steps` as a map keyed by slug (slug stripped from each value)
 * plus a top-level `edges` array.
 *
 * Draft edges reference steps by synthetic id; the persisted format references
 * them by slug, so each endpoint is translated id -> slug here. Edges whose
 * endpoints no longer resolve to a step are dropped.
 *
 * @param draft - The workflow draft to serialize
 * @returns A plain object matching the backend's DagWorkflowDefinitionSchema
 */
export function serializeWorkflowDraft(draft: WorkflowDraft): Record<string, unknown> {
  const steps: Record<string, unknown> = {};
  for (const step of draft.steps) {
    steps[step.slug] = serializeStep(step);
  }

  // Map each step's identity (id when present, else slug) to its slug so
  // id-based draft edges can be written back in the slug-based persisted format.
  const identityToSlug = new Map(draft.steps.map((s) => [s.id ?? s.slug, s.slug]));
  const edges = (draft.edges ?? [])
    .map((e) => {
      const from = identityToSlug.get(e.from);
      const to = identityToSlug.get(e.to);
      if (from === undefined || to === undefined) return null;
      return e.branch !== undefined ? { from, to, branch: e.branch } : { from, to };
    })
    .filter((e): e is { from: string; to: string; branch?: string } => e !== null);

  const result: Record<string, unknown> = {
    name: draft.name,
    trigger: {
      type: draft.trigger.type,
      ...(draft.trigger.ref && draft.trigger.type !== "manual" ? { ref: draft.trigger.ref } : {}),
      ...(draft.trigger.outputSchema ? { outputSchema: draft.trigger.outputSchema } : {}),
    },
    enabled: draft.enabled,
    steps,
    edges,
  };
  if (draft.description) {
    result.description = draft.description;
  }
  return result;
}
