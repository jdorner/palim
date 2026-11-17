/**
 * Finds config keys a step sets although its step type's config schema does
 * not declare them, at any depth.
 *
 * A step type's schema check only rejects an unknown key where the schema says
 * `additionalProperties: false`. An extension that composes schemas easily
 * loses that flag on a nested object (TypeBox `Type.Composite` drops it), and
 * the handler then ignores a misspelt key without a word: a filter such as
 * `search: { unseen: true }` is simply not applied.
 *
 * @module
 */

import type { TemplateWarning } from "./dagTemplateValidation";
import type { DagWorkflowDefinition } from "./schemas";

/** A config key that its schema does not declare. */
export interface UndeclaredKey {
  /** Dotted path of the key inside the step config (e.g. `search.unseen`, `rows[0].nme`). */
  path: string;
  /** The keys the enclosing object schema declares. */
  declared: string[];
  /**
   * True when the enclosing object says `additionalProperties: false`, so the
   * step type's own schema check already rejects the key.
   */
  rejectedBySchema: boolean;
}

/** Step keys that are not part of a step type's config. */
const NON_CONFIG_KEYS = new Set(["type", "slug", "outputSchema"]);

/** How many declared fields a warning lists before it cuts off. */
const MAX_LISTED_FIELDS = 12;

/**
 * Collects the keys of a value that its JSON Schema does not declare.
 *
 * Only object schemas that declare `properties` are judged. An object that
 * sets `additionalProperties` to `true` or to a schema, or sets
 * `patternProperties`, was left open on purpose and is skipped, as are unions
 * and values without a schema.
 *
 * @param value - The config value
 * @param schema - Its JSON Schema
 * @param path - Dotted path of `value` (empty for the config root)
 * @param into - Receives the undeclared keys
 */
function collectUndeclared(value: unknown, schema: unknown, path: string, into: UndeclaredKey[]): void {
  if (schema === null || typeof schema !== "object") return;
  const node = schema as {
    properties?: unknown;
    additionalProperties?: unknown;
    patternProperties?: unknown;
    items?: unknown;
  };
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) collectUndeclared(item, node.items, `${path}[${i}]`, into);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (node.properties === null || typeof node.properties !== "object") return;
  const properties = node.properties as Record<string, unknown>;
  const declared = Object.keys(properties);
  if (declared.length === 0) return;
  const additional = node.additionalProperties;
  const open =
    additional === true ||
    (additional !== null && typeof additional === "object") ||
    node.patternProperties !== undefined;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (Object.hasOwn(properties, key)) collectUndeclared(child, properties[key], childPath, into);
    else if (!open) into.push({ path: childPath, declared, rejectedBySchema: additional === false });
  }
}

/**
 * Finds the config keys of one step that its step type's config schema does
 * not declare.
 *
 * @param step - The step definition (`type`, `slug` and `outputSchema` are not config)
 * @param configSchema - The step type's config JSON Schema
 * @returns The undeclared keys, in config order
 */
export function findUndeclaredConfigKeys(
  step: Readonly<Record<string, unknown>>,
  configSchema: unknown,
): UndeclaredKey[] {
  const config = Object.fromEntries(Object.entries(step).filter(([key]) => !NON_CONFIG_KEYS.has(key)));
  const found: UndeclaredKey[] = [];
  collectUndeclared(config, configSchema, "", found);
  return found;
}

/**
 * Warns about config keys a step sets that its step type does not declare and
 * that the step type's schema check does not reject already (those are
 * reported as invalid config, so they are left out here).
 *
 * @param definition - The workflow definition
 * @param getConfigSchema - Returns a step type's config schema, or `undefined` when it has none
 * @returns One warning per undeclared key, on the step, with the key's path as field
 */
export function getUndeclaredConfigKeyWarnings(
  definition: DagWorkflowDefinition,
  getConfigSchema: (type: string) => unknown,
): TemplateWarning[] {
  const warnings: TemplateWarning[] = [];
  for (const [slug, step] of Object.entries(definition.steps)) {
    const schema = getConfigSchema(step.type);
    if (!schema) continue;
    for (const key of findUndeclaredConfigKeys(step as Record<string, unknown>, schema)) {
      if (key.rejectedBySchema) continue;
      const listed = key.declared.slice(0, MAX_LISTED_FIELDS).join(", ");
      const extra = key.declared.length - MAX_LISTED_FIELDS;
      const more = extra > 0 ? ` and ${extra} more` : "";
      warnings.push({
        stepSlug: slug,
        field: key.path,
        message: `Step "${slug}" sets "${key.path}", which ${step.type} does not declare. Declared fields: ${listed}${more}. Run: workflow step-types ${step.type}`,
      });
    }
  }
  return warnings;
}
