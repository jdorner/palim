/**
 * Shared validation functions for workflow editing and creation forms.
 * Pure TypeScript module with no Svelte dependencies.
 */

/** Result of a single validation check. */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/** Draft workflow being edited or created. */
export interface WorkflowDraft {
  name: string;
  description: string;
  trigger: { type: string; ref: string };
  enabled: boolean;
  steps: StepDraft[];
}

/** Draft step within a workflow. */
export interface StepDraft {
  [key: string]: unknown;
  slug: string;
  type: string;
  prompt?: string;
  tools?: string[];
  skills?: string[];
  /** Raw JSON config for custom (extension-registered) step types. */
  config?: Record<string, unknown>;
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
    return { valid: false, error: "Slug is required" };
  }
  if (value.length > MAX_SLUG_LENGTH) {
    return { valid: false, error: `Slug must not exceed ${MAX_SLUG_LENGTH} characters` };
  }
  if (!SLUG_PATTERN.test(value)) {
    return {
      valid: false,
      error: "Slug must start with a lowercase letter and contain only lowercase letters, digits, and hyphens",
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
    return { valid: false, error: "Workflow name is required" };
  }
  if (value.length > MAX_SLUG_LENGTH) {
    return { valid: false, error: `Workflow name must not exceed ${MAX_SLUG_LENGTH} characters` };
  }
  if (!SLUG_PATTERN.test(value)) {
    return {
      valid: false,
      error: "Workflow name must start with a lowercase letter and contain only lowercase letters, digits, and hyphens",
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
      return { valid: false, error: `Duplicate step slug: ${slug}` };
    }
    seen.add(slug);
  }
  return { valid: true };
}

/**
 * Validates a custom step's config values against a JSON Schema.
 * Checks required fields, minLength for strings, and minimum/maximum for numbers.
 *
 * @param config - The step config values to validate
 * @param schema - The JSON Schema object describing expected config fields
 * @returns Array of [fieldName, errorMessage] tuples for each violation
 */
export function validateStepConfig(
  config: Record<string, unknown>,
  schema: Record<string, unknown>,
): [string, string][] {
  const errors: [string, string][] = [];
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required ?? []) as string[];

  for (const key of required) {
    const value = config[key];
    if (value === undefined || value === null || value === "") {
      const prop = properties[key];
      const label = (prop?.title as string) ?? key;
      errors.push([key, `${label} is required`]);
    }
  }

  for (const [key, prop] of Object.entries(properties)) {
    const value = config[key];

    // Skip fields that are absent and not required (already caught above if required)
    if (value === undefined || value === null || value === "") continue;

    if (prop.type === "string" && typeof value === "string") {
      const minLength = prop.minLength as number | undefined;
      if (minLength && value.length < minLength) {
        const label = (prop.title as string) ?? key;
        errors.push([key, `${label} must be at least ${minLength} characters`]);
      }
      const maxLength = prop.maxLength as number | undefined;
      if (maxLength && value.length > maxLength) {
        const label = (prop.title as string) ?? key;
        errors.push([key, `${label} must not exceed ${maxLength} characters`]);
      }
    }

    if ((prop.type === "number" || prop.type === "integer") && typeof value === "number") {
      const minimum = prop.minimum as number | undefined;
      if (minimum !== undefined && value < minimum) {
        const label = (prop.title as string) ?? key;
        errors.push([key, `${label} must be at least ${minimum}`]);
      }
      const maximum = prop.maximum as number | undefined;
      if (maximum !== undefined && value > maximum) {
        const label = (prop.title as string) ?? key;
        errors.push([key, `${label} must not exceed ${maximum}`]);
      }
    }
  }

  return errors;
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
    errors.set("description", `Description must not exceed ${MAX_DESCRIPTION_LENGTH} characters`);
  }

  // Validate trigger type
  if (!draft.trigger.type || !VALID_TRIGGER_TYPES.includes(draft.trigger.type)) {
    errors.set("trigger.type", "Trigger type must be one of: webhook, schedule, manual, filewatcher");
  }

  // Manual triggers must not have a ref
  if (draft.trigger.type === "manual" && draft.trigger.ref && draft.trigger.ref.trim().length > 0) {
    errors.set("trigger.ref", "Manual triggers do not support a ref value");
  }

  // Non-manual triggers require a ref
  if (draft.trigger.type !== "manual" && (!draft.trigger.ref || draft.trigger.ref.trim().length === 0)) {
    errors.set("trigger.ref", `Trigger type "${draft.trigger.type}" requires a ref`);
  }

  // Validate steps - at least one required
  if (!draft.steps || draft.steps.length === 0) {
    errors.set("steps", "At least one step is required");
    return errors;
  }

  // Validate each step slug and type-specific required fields
  const slugs: string[] = [];
  for (let i = 0; i < draft.steps.length; i++) {
    const step = draft.steps[i];
    validateStepRecursive(step, `steps[${i}]`, slugs, errors, stepTypeSchemas);
  }

  // Validate step slugs uniqueness
  const uniqueResult = validateStepSlugsUnique(slugs);
  if (!uniqueResult.valid && uniqueResult.error) {
    errors.set("steps.slugs", uniqueResult.error);
  }

  return errors;
}

/**
 * Recursively validates a step and its branch children.
 * Collects slugs for uniqueness checking and populates the errors map.
 */
function validateStepRecursive(
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

  // Type-specific validation
  if (step.type === "agent" && (!step.prompt || step.prompt.trim().length === 0)) {
    errors.set(`${path}.prompt`, "Prompt is required for agent steps");
  }

  // Control flow: if
  if (step.type === "if") {
    if (!step.condition || !(step.condition as Record<string, unknown>).ref) {
      errors.set(`${path}.condition`, "Condition ref is required");
    }
    const thenSteps = (step.then as StepDraft[] | undefined) ?? [];
    for (let i = 0; i < thenSteps.length; i++) {
      validateStepRecursive(thenSteps[i], `${path}.then[${i}]`, slugs, errors, stepTypeSchemas);
    }
    const elseSteps = (step.else as StepDraft[] | undefined) ?? [];
    for (let i = 0; i < elseSteps.length; i++) {
      validateStepRecursive(elseSteps[i], `${path}.else[${i}]`, slugs, errors, stepTypeSchemas);
    }
  }

  // Control flow: case
  if (step.type === "case") {
    if (!step.match || (step.match as string).trim().length === 0) {
      errors.set(`${path}.match`, "Match expression is required");
    }
    const paths = (step.paths as Record<string, StepDraft[]>) ?? {};
    for (const [key, pathSteps] of Object.entries(paths)) {
      for (let i = 0; i < pathSteps.length; i++) {
        validateStepRecursive(pathSteps[i], `${path}.paths.${key}[${i}]`, slugs, errors, stepTypeSchemas);
      }
    }
    const defaultSteps = (step.default as StepDraft[] | undefined) ?? [];
    for (let i = 0; i < defaultSteps.length; i++) {
      validateStepRecursive(defaultSteps[i], `${path}.default[${i}]`, slugs, errors, stepTypeSchemas);
    }
  }

  // Control flow: waitFor
  if (step.type === "waitFor") {
    if (!step.event || (step.event as string).trim().length === 0) {
      errors.set(`${path}.event`, "Event name is required");
    }
  }

  // Control flow: emit
  if (step.type === "emit") {
    if (!step.event || (step.event as string).trim().length === 0) {
      errors.set(`${path}.event`, "Event name is required");
    }
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
 * Serializes a single StepDraft into a clean object containing only the fields
 * valid for the step's type. This prevents the backend's `additionalProperties: false`
 * rejection when extra fields are present.
 * @param step - The step draft to serialize
 * @returns A plain object with only the fields appropriate for the step's type
 */
export function serializeStep(step: StepDraft): Record<string, unknown> {
  if (step.type === "agent") {
    const result: Record<string, unknown> = {
      slug: step.slug,
      type: "agent",
      prompt: step.prompt,
    };
    if (step.tools && step.tools.length > 0) {
      result.tools = step.tools;
    }
    if (step.skills && step.skills.length > 0) {
      result.skills = step.skills;
    }
    return result;
  }

  // Control flow: if
  if (step.type === "if") {
    const result: Record<string, unknown> = {
      slug: step.slug,
      type: "if",
      condition: step.condition,
    };
    const thenSteps = step.then as StepDraft[] | undefined;
    if (thenSteps && thenSteps.length > 0) {
      // biome-ignore lint/suspicious/noThenProperty: "then" is the workflow branch keyword, not a thenable
      result.then = thenSteps.map(serializeStep);
    }
    const elseSteps = step.else as StepDraft[] | undefined;
    if (elseSteps && elseSteps.length > 0) {
      result.else = elseSteps.map(serializeStep);
    }
    return result;
  }

  // Control flow: case
  if (step.type === "case") {
    const result: Record<string, unknown> = {
      slug: step.slug,
      type: "case",
      match: step.match,
    };
    const paths = step.paths as Record<string, StepDraft[]> | undefined;
    if (paths) {
      const serializedPaths: Record<string, unknown[]> = {};
      for (const [key, pathSteps] of Object.entries(paths)) {
        if (pathSteps.length > 0) {
          serializedPaths[key] = pathSteps.map(serializeStep);
        }
      }
      if (Object.keys(serializedPaths).length > 0) {
        result.paths = serializedPaths;
      }
    }
    const defaultSteps = step.default as StepDraft[] | undefined;
    if (defaultSteps && defaultSteps.length > 0) {
      result.default = defaultSteps.map(serializeStep);
    }
    return result;
  }

  // Control flow: waitFor
  if (step.type === "waitFor") {
    const result: Record<string, unknown> = {
      slug: step.slug,
      type: "waitFor",
      event: step.event,
    };
    if (step.timeout) result.timeout = step.timeout;
    if (step.inputSchema) result.inputSchema = step.inputSchema;
    return result;
  }

  // Control flow: emit
  if (step.type === "emit") {
    const result: Record<string, unknown> = {
      slug: step.slug,
      type: "emit",
      event: step.event,
    };
    if (step.payload) result.payload = step.payload;
    return result;
  }

  // Custom (extension-registered) step type: merge slug + type + config
  return {
    slug: step.slug,
    type: step.type,
    ...(step.config ?? {}),
  };
}

/**
 * Serializes a complete WorkflowDraft into a clean object suitable for sending
 * to the backend API. Strips empty optional fields and ensures each step only
 * includes fields valid for its type.
 * @param draft - The workflow draft to serialize
 * @returns A plain object matching the backend's WorkflowDefinitionSchema
 */
export function serializeWorkflowDraft(draft: WorkflowDraft): Record<string, unknown> {
  const result: Record<string, unknown> = {
    name: draft.name,
    trigger: {
      type: draft.trigger.type,
      ...(draft.trigger.ref && draft.trigger.type !== "manual" ? { ref: draft.trigger.ref } : {}),
    },
    enabled: draft.enabled,
    steps: draft.steps.map(serializeStep),
  };
  if (draft.description) {
    result.description = draft.description;
  }
  return result;
}
