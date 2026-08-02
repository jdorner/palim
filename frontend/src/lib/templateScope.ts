/**
 * Template Scope Registry -- Pure TypeScript module for computing
 * autocomplete suggestions for workflow template expressions.
 *
 * Mirrors the scope rules from the backend templateValidation.ts.
 * No Svelte or DOM dependencies.
 */

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
}

/**
 * Configuration for the scope registry.
 */
export interface ScopeConfig {
  /** All steps in the workflow draft */
  steps: Array<{ slug: string }>;
  /** Zero-based index of the step currently being edited */
  currentStepIndex: number;
  /** Prefetched secret key names */
  secretKeys: string[];
  /** Environment variable allowlist (defaults to built-in set) */
  envAllowlist?: string[];
}

/**
 * Default environment variable allowlist matching backend.
 */
export const DEFAULT_ENV_ALLOWLIST: string[] = ["AGENT_WORK_DIR", "NODE_ENV", "WEB_HOST", "WEB_PORT"];

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
export function getEnvSuggestions(envAllowlist: string[], prefix: string): Suggestion[] {
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
      if (s.label === "steps" && config.currentStepIndex === 0) return false;
      if (s.label === "secret" && config.secretKeys.length === 0) return false;
      return true;
    });
  }

  const namespace = path[0];

  if (namespace === "steps") {
    if (path.length === 1) {
      // path=["steps"] -> show step slugs
      return getStepSlugs(config.steps, config.currentStepIndex, prefix);
    }
    if (path.length === 2) {
      // path=["steps", slug] -> show result/config
      const suggestions: Suggestion[] = [
        { label: "result", terminal: true },
        { label: "config", terminal: true },
      ];
      return suggestions.filter((s) => s.label.startsWith(prefix));
    }
    return [];
  }

  if (namespace === "trigger") {
    if (path.length === 1) {
      // path=["trigger"] -> show payload
      const suggestions: Suggestion[] = [{ label: "payload", terminal: true }];
      return suggestions.filter((s) => s.label.startsWith(prefix));
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
