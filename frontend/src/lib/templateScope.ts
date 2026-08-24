/**
 * Template Scope Registry -- Pure TypeScript module for computing
 * autocomplete suggestions for workflow template expressions.
 *
 * Mirrors the scope rules from the backend templateValidation.ts.
 * No Svelte or DOM dependencies.
 */

import {
  DEFAULT_ENV_ALLOWLIST,
  type OutputSchema,
  type OutputSchemas,
  walkSchemaPath,
} from "../../../shared/workflows";
import { getEnumOptions, isEnum } from "./schemaForm";

export type { OutputSchema, OutputSchemas };
export { DEFAULT_ENV_ALLOWLIST };

/**
 * A single autocomplete suggestion with classification metadata.
 */
export interface Suggestion {
  /** Display label (e.g. "trigger", "fetch", "WEB_HOST") */
  label: string;
  /** Whether selecting this completes the expression (appends `}}`) */
  terminal: boolean;
  /** Optional description for display */
  description?: string;
  /** JSON Schema `type` of the property, when declared. */
  schemaType?: string;
  /** Allowed values, when the property declares an enum. */
  enumValues?: string[];
  /** Declared default value, when present. */
  defaultValue?: unknown;
}

/**
 * Configuration for the scope registry.
 */
export interface ScopeConfig {
  /** All steps in the workflow draft (full step definitions for config introspection) */
  steps: Array<{ slug: string; [key: string]: unknown }>;
  /** Zero-based index of the step currently being edited */
  currentStepIndex: number;
  /** Prefetched secret key names */
  secretKeys: string[];
  /** Environment variable allowlist (defaults to built-in set) */
  envAllowlist?: readonly string[];
  /** Resolved output schemas from the workflow API */
  outputSchemas?: OutputSchemas;
}

/** Fixed set of top-level namespace names. */
const TOP_LEVEL_NAMESPACES = ["trigger", "steps", "env", "secret"] as const;

/**
 * Returns top-level namespace suggestions, filtered by prefix.
 * Always returns from: ["trigger", "steps", "env", "secret"].
 * Uses case-sensitive startsWith matching. All are non-terminal.
 *
 * @param prefix - The currently typed text used for filtering
 * @returns Array of matching suggestions
 */
export function getTopLevelSuggestions(prefix: string): Suggestion[] {
  return TOP_LEVEL_NAMESPACES.filter((name) => name.startsWith(prefix)).map((name) => ({
    label: name,
    terminal: false,
  }));
}

/**
 * Returns preceding step slugs for the steps namespace.
 * Only includes steps with index < currentStepIndex.
 * Uses case-sensitive startsWith filtering. All are non-terminal.
 *
 * @param steps - All steps in the workflow draft
 * @param currentStepIndex - Zero-based index of the step being edited
 * @param prefix - The currently typed text used for filtering
 * @returns Array of matching step slug suggestions
 */
export function getStepSlugs(steps: Array<{ slug: string }>, currentStepIndex: number, prefix: string): Suggestion[] {
  return steps
    .slice(0, currentStepIndex)
    .filter((step) => step.slug.startsWith(prefix))
    .map((step) => ({
      label: step.slug,
      terminal: false,
    }));
}

/**
 * Returns env variable suggestions filtered by case-insensitive substring match.
 * Results are sorted alphabetically (case-insensitive). All are terminal.
 *
 * @param envAllowlist - List of allowed environment variable names
 * @param prefix - The currently typed text used for filtering
 * @returns Array of matching env variable suggestions, sorted alphabetically
 */
export function getEnvSuggestions(envAllowlist: readonly string[], prefix: string): Suggestion[] {
  const lowerPrefix = prefix.toLowerCase();
  return envAllowlist
    .filter((name) => name.toLowerCase().includes(lowerPrefix))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((name) => ({
      label: name,
      terminal: true,
    }));
}

/**
 * Returns secret key suggestions filtered by case-insensitive substring match.
 * Results are sorted alphabetically (case-insensitive). All are terminal.
 *
 * @param secretKeys - List of available secret key names
 * @param prefix - The currently typed text used for filtering
 * @returns Array of matching secret key suggestions, sorted alphabetically
 */
export function getSecretSuggestions(secretKeys: string[], prefix: string): Suggestion[] {
  const lowerPrefix = prefix.toLowerCase();
  return secretKeys
    .filter((key) => key.toLowerCase().includes(lowerPrefix))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((key) => ({
      label: key,
      terminal: true,
    }));
}

/**
 * Returns suggestions from an output schema at a given sub-path.
 *
 * Walks the canonical JSON Schema via `walkSchemaPath` to resolve the sub-path,
 * then offers the resolved node's immediate `properties` keys as suggestions.
 * A path that hits a leaf node or a missing key yields no suggestions. Each
 * suggestion carries schema metadata (`schemaType`, `description`, `enumValues`,
 * `defaultValue`) verbatim when declared, omitting any absent field. Child
 * properties are non-terminal when they are object nodes and terminal otherwise
 * (primitive, enum-only, or unconstrained `{}` leaf nodes).
 *
 * @param schema - The canonical JSON Schema to traverse
 * @param subPath - Path segments below the schema root (e.g. ["metadata"] for trigger.payload.metadata.)
 * @param prefix - The currently typed text used for filtering (case-sensitive)
 * @returns Array of matching suggestions derived from schema `properties`
 */
export function getOutputSchemaSuggestions(schema: OutputSchema, subPath: string[], prefix: string): Suggestion[] {
  const resolved = walkSchemaPath(schema, subPath);
  // A path that fails to resolve, or resolves to a leaf/non-object node (no
  // children), offers no further suggestions.
  if (!resolved.resolved || resolved.node === undefined || resolved.children.length === 0) {
    return [];
  }

  const properties = resolved.node.properties as Record<string, unknown> | undefined;
  if (properties === undefined) {
    return [];
  }

  return resolved.children
    .filter((key) => key.startsWith(prefix))
    .sort((a, b) => a.localeCompare(b))
    .map((key) => {
      const childNode = properties[key] as Record<string, unknown> | undefined;
      return buildSchemaSuggestion(key, childNode);
    });
}

/**
 * Builds a single suggestion from a child JSON Schema node, computing
 * terminal-ness and attaching declared metadata verbatim (absent fields omitted).
 *
 * @param key - The child property name (used as the suggestion label)
 * @param childNode - The child JSON Schema node, when present
 * @returns The suggestion with metadata populated from the child node
 */
function buildSchemaSuggestion(key: string, childNode: Record<string, unknown> | undefined): Suggestion {
  const isObjectNode =
    childNode !== undefined &&
    (childNode.type === "object" || (childNode.properties !== null && typeof childNode.properties === "object"));

  const suggestion: Suggestion = {
    label: key,
    terminal: !isObjectNode,
  };

  if (childNode === undefined) {
    return suggestion;
  }

  if (typeof childNode.type === "string") {
    suggestion.schemaType = childNode.type;
  }

  if (typeof childNode.description === "string") {
    suggestion.description = childNode.description;
  }

  const enumValues = extractEnumValues(childNode);
  if (enumValues !== undefined) {
    suggestion.enumValues = enumValues;
  }

  if ("default" in childNode) {
    suggestion.defaultValue = childNode.default;
  }

  return suggestion;
}

/**
 * Extracts declared enum values from a JSON Schema node.
 *
 * Supports the `anyOf`-of-`const` form via the shared `schemaForm` helpers and a
 * direct `enum` array fallback. Every declared value is included (none absent).
 *
 * @param childNode - The child JSON Schema node to inspect
 * @returns The enum values as strings, or `undefined` when the node declares none
 */
function extractEnumValues(childNode: Record<string, unknown>): string[] | undefined {
  if (isEnum(childNode)) {
    const options = getEnumOptions(childNode);
    if (options.length > 0) {
      return options;
    }
  }

  if (Array.isArray(childNode.enum) && childNode.enum.length > 0) {
    return childNode.enum.map((value) => String(value));
  }

  return undefined;
}

/** Step definition keys excluded from config suggestions (internal/structural). */
const CONFIG_EXCLUDED_KEYS = new Set(["slug", "type"]);

/**
 * Returns suggestions by introspecting a runtime value (step config object or sub-value).
 * Navigates into nested objects and arrays using dot-separated path segments,
 * including numeric indices for array access (e.g. "0", "1").
 *
 * @param value - The runtime value to introspect (object, array, or primitive)
 * @param subPath - Path segments to navigate into (e.g. ["sheets", "0", "columns"])
 * @param prefix - The currently typed text used for filtering
 * @param excludeKeys - Optional set of keys to exclude from suggestions at the top level
 * @returns Array of matching suggestions derived from the value's structure
 */
export function getConfigSuggestions(
  value: unknown,
  subPath: string[],
  prefix: string,
  excludeKeys?: Set<string>,
): Suggestion[] {
  let current: unknown = value;

  // Navigate into the value following the sub-path
  for (const segment of subPath) {
    if (current === null || current === undefined) return [];
    if (Array.isArray(current)) {
      const idx = Number.parseInt(segment, 10);
      if (Number.isNaN(idx) || idx < 0 || idx >= current.length) return [];
      current = current[idx];
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return [];
    }
  }

  if (current === null || current === undefined) return [];

  // If current is an array, suggest numeric indices
  if (Array.isArray(current)) {
    return current
      .map((_, i) => String(i))
      .filter((idx) => idx.startsWith(prefix))
      .map((idx) => ({
        label: idx,
        terminal: typeof current[Number.parseInt(idx, 10)] !== "object" || current[Number.parseInt(idx, 10)] === null,
      }));
  }

  // If current is an object, suggest its keys
  if (typeof current === "object") {
    const entries = Object.entries(current as Record<string, unknown>);
    const filtered = entries.filter(([key, val]) => {
      if (val === undefined) return false;
      if (excludeKeys?.has(key)) return false;
      if (!key.startsWith(prefix)) return false;
      return true;
    });

    return filtered
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => ({
        label: key,
        terminal: val === null || typeof val !== "object",
        description: val !== null && typeof val !== "object" ? typeof val : undefined,
      }));
  }

  // Primitive — no further suggestions
  return [];
}

/**
 * Computes autocomplete suggestions for a given path and typed prefix.
 * Dispatches to the correct sub-function based on path segments.
 *
 * @param config - Scope configuration (steps, current index, secrets, env)
 * @param path - Resolved path segments so far (e.g. ["steps", "fetch"])
 * @param prefix - The currently typed text after the last `.` (used for filtering)
 * @returns Array of matching suggestions, sorted appropriately
 */
export function getSuggestions(config: ScopeConfig, path: string[], prefix: string): Suggestion[] {
  // Top-level: no path segments yet
  if (path.length === 0) {
    // Filter out namespaces that would have no sub-items
    return getTopLevelSuggestions(prefix).filter((s) => {
      if (s.label === "steps" && config.steps.length <= 1) return false;
      if (s.label === "secret" && config.secretKeys.length === 0) return false;
      return true;
    });
  }

  const namespace = path[0];

  if (namespace === "steps") {
    if (path.length === 1) {
      // path=["steps"] -> show all step slugs except the current step.
      // Config is accessible from any step (static); result only from preceding steps.
      // We show all slugs and rely on backend validation to flag forward result references.
      return config.steps
        .filter((_, i) => i !== config.currentStepIndex)
        .filter((step) => step.slug.startsWith(prefix))
        .map((step) => ({
          label: step.slug,
          terminal: false,
        }));
    }
    if (path.length === 2) {
      // path=["steps", slug] -> show result/config
      // "result" is only available for preceding steps (forward references are invalid at runtime)
      const slug = path[1]!;
      const stepIndex = config.steps.findIndex((s) => s.slug === slug);
      const isPreceding = stepIndex !== -1 && stepIndex < config.currentStepIndex;
      const stepSchema = config.outputSchemas?.steps[slug];
      const suggestions: Suggestion[] = [
        ...(isPreceding ? [{ label: "result", terminal: !stepSchema }] : []),
        { label: "config", terminal: false },
      ];
      return suggestions.filter((s) => s.label.startsWith(prefix));
    }
    if (path.length >= 3 && path[2] === "result") {
      // path=["steps", slug, "result", ...] -> drill into step output schema
      const slug = path[1]!;
      const stepSchema = config.outputSchemas?.steps[slug];
      if (!stepSchema) return [];
      const subPath = path.slice(3); // segments after "result"
      return getOutputSchemaSuggestions(stepSchema, subPath, prefix);
    }
    if (path.length >= 3 && path[2] === "config") {
      // path=["steps", slug, "config", ...] -> introspect step definition
      const slug = path[1]!;
      const step = config.steps.find((s) => s.slug === slug);
      if (!step) return [];
      // For custom step types, the edit draft wraps extra fields in a `config` property.
      // Use that nested object if present; otherwise introspect the step itself.
      const configSource =
        step.config && typeof step.config === "object" && !Array.isArray(step.config)
          ? (step.config as Record<string, unknown>)
          : step;
      const subPath = path.slice(3); // segments after "config"
      return getConfigSuggestions(
        configSource,
        subPath,
        prefix,
        subPath.length === 0 ? CONFIG_EXCLUDED_KEYS : undefined,
      );
    }
    return [];
  }

  if (namespace === "trigger") {
    if (path.length === 1) {
      // path=["trigger"] -> show payload
      const triggerSchema = config.outputSchemas?.trigger;
      const suggestions: Suggestion[] = [{ label: "payload", terminal: !triggerSchema }];
      return suggestions.filter((s) => s.label.startsWith(prefix));
    }
    if (path.length >= 2 && path[1] === "payload") {
      // path=["trigger", "payload", ...] -> drill into trigger output schema
      const triggerSchema = config.outputSchemas?.trigger;
      if (!triggerSchema) return [];
      const subPath = path.slice(2); // segments after "payload"
      return getOutputSchemaSuggestions(triggerSchema, subPath, prefix);
    }
    return [];
  }

  if (namespace === "env") {
    if (path.length === 1) {
      // path=["env"] -> show env vars
      return getEnvSuggestions(config.envAllowlist ?? DEFAULT_ENV_ALLOWLIST, prefix);
    }
    return [];
  }

  if (namespace === "secret") {
    if (path.length === 1) {
      // path=["secret"] -> show secret keys
      return getSecretSuggestions(config.secretKeys, prefix);
    }
    return [];
  }

  // Unknown namespace
  return [];
}
