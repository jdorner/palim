/**
 * Helpers for the step detail panel: built-in step config extraction, empty
 * value stripping, and the index-keyed validation error map
 * (`steps[<i>].<field>`, `steps[<i>].config.<field>`).
 *
 * @module
 */

import type { OutputSchemaShorthand } from "$shared/workflows";
import type { OutputSchemas, SlugEdge } from "./templateScope";
import { type StepDraft, validateStepConfig } from "./workflowValidation";

/**
 * Built-in control-flow step types. Their config lives in flat fields on the
 * step (not under `config`) and is edited against a built-in schema.
 */
export const CF_TYPES = new Set(["if", "case", "iterator", "aggregator", "waitFor", "humanTask", "emit"]);

/** A step type as the step panel needs it (custom types registered by extensions). */
export interface PanelStepType {
  type: string;
  label: string;
  icon?: string;
  /** Owning extension (scopes translations of the config form). */
  extensionName?: string;
  configSchema?: Record<string, unknown>;
}

/** A saved step as the step panel shows it in view mode. */
export interface PanelStep {
  /** Stable synthetic node id (matches the page's StepDef), used for removal. */
  id: string;
  slug: string;
  type: string;
  outputSchema?: OutputSchemaShorthand;
  prompt?: string;
  tools?: string[];
  skills?: string[];
  url?: string;
  method?: string;
  body?: string;
  input?: string;
  output?: string;
}

/** Template autocomplete context shared by the step editors' template-aware fields. */
export interface StepTemplateContext {
  steps: StepDraft[];
  currentStepIndex: number;
  secretKeys: string[];
  variableKeys: string[];
  outputSchemas?: OutputSchemas;
  edges: SlugEdge[];
}

/**
 * Extracts the editable config of a built-in control-flow step (every field
 * except slug, type, and id).
 *
 * @param step - The step
 * @returns The config fields
 */
export function cfStepConfig(step: StepDraft): Record<string, unknown> {
  const { slug: _s, type: _t, id: _i, editorFormError: _e, ...rest } = step;
  return rest as Record<string, unknown>;
}

/**
 * Drops the empty optional values a form renderer synthesizes (empty strings,
 * `null`/`undefined`, `0`, empty arrays and objects). Persisted, they would
 * fail backend range or pattern validation (e.g. an unset `timeout` as `0`).
 *
 * @param values - Form values
 * @returns The values without empty entries
 */
export function stripEmptyOptionals(values: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === "" || v === null || v === undefined) continue;
    if (typeof v === "number" && v === 0) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0) continue;
    result[k] = v;
  }
  return result;
}

/**
 * Replaces a built-in control-flow step's config fields with form values,
 * skipping empty optionals. Mutates the step (use inside a draft updater).
 *
 * @param step - The step copy to update
 * @param values - Form values
 */
export function applyCfValues(step: StepDraft, values: Record<string, unknown>): void {
  for (const key of Object.keys(step)) {
    if (key !== "slug" && key !== "type" && key !== "id") delete step[key];
  }
  Object.assign(step, stripEmptyOptionals(values));
}

/**
 * Field errors of one step, for a form's `fieldErrors`.
 *
 * @param errors - The validation error map
 * @param index - Step index
 * @param scope - `"flat"` for built-in fields (`steps[i].<field>`, no nested
 *   paths), `"config"` for custom step config (`steps[i].config.<path>`)
 * @returns Errors keyed by field path relative to the scope
 */
export function stepFieldErrors(
  errors: Map<string, string>,
  index: number,
  scope: "flat" | "config",
): Map<string, string> {
  const prefix = scope === "flat" ? `steps[${index}].` : `steps[${index}].config.`;
  const result = new Map<string, string>();
  for (const [k, v] of errors) {
    if (!k.startsWith(prefix)) continue;
    const field = k.slice(prefix.length);
    if (scope === "flat" && field.includes(".")) continue;
    result.set(field, v);
  }
  return result;
}

/**
 * Returns the error map without `key`, or the same map when it has no such error.
 *
 * @param errors - The validation error map
 * @param key - Error key to clear
 * @returns The (possibly unchanged) map
 */
export function withoutError(errors: Map<string, string>, key: string): Map<string, string> {
  if (!errors.has(key)) return errors;
  const next = new Map(errors);
  next.delete(key);
  return next;
}

/**
 * Re-validates a built-in control-flow step against its config schema: clears
 * the step's built-in field errors (`event`, `match`, `condition`, `config`,
 * and every schema property) and adds fresh ones for the effective values.
 *
 * @param errors - The validation error map
 * @param index - Step index
 * @param values - Form values (empty optionals are ignored)
 * @param schema - The step type's config schema
 * @returns The updated map
 */
export function revalidateCfStep(
  errors: Map<string, string>,
  index: number,
  values: Record<string, unknown>,
  schema: Record<string, unknown>,
): Map<string, string> {
  const prefix = `steps[${index}].`;
  const next = new Map(errors);
  const props = (schema.properties ?? {}) as Record<string, unknown>;
  for (const field of ["event", "match", "condition", "config", ...Object.keys(props)]) {
    next.delete(`${prefix}${field}`);
  }
  for (const [field, msg] of validateStepConfig(stripEmptyOptionals(values), schema)) {
    next.set(`${prefix}${field}`, msg);
  }
  return next;
}

/**
 * Re-validates a custom step's config: clears its `steps[i].config.*` errors
 * and adds fresh ones from the schema (none when the type has no schema).
 *
 * @param errors - The validation error map
 * @param index - Step index
 * @param config - The step's config
 * @param schema - The step type's config schema, if any
 * @returns The updated map
 */
export function revalidateCustomConfig(
  errors: Map<string, string>,
  index: number,
  config: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
): Map<string, string> {
  const prefix = `steps[${index}].config.`;
  const next = new Map(errors);
  for (const k of [...next.keys()]) {
    if (k.startsWith(prefix)) next.delete(k);
  }
  if (schema) {
    for (const [field, msg] of validateStepConfig(config, schema)) {
      next.set(`${prefix}${field}`, msg);
    }
  }
  return next;
}
