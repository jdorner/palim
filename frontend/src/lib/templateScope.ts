/**
 * Template Scope Registry -- Pure TypeScript module for computing
 * autocomplete suggestions for workflow template expressions.
 *
 * Mirrors the scope rules from the backend templateValidation.ts.
 * No Svelte or DOM dependencies.
 */

import { resolvedSelfFields, type SelfReferenceOrder } from "../../../shared/extensions";
import { TEMPLATE_FUNCTION_CATEGORIES, TEMPLATE_FUNCTION_META } from "../../../shared/templateFunctionMeta";
import {
  DEFAULT_ENV_ALLOWLIST,
  isObjectSchemaNode,
  type OutputSchema,
  type OutputSchemas,
  RUN_TEMPLATE_FIELDS,
  resolveIteratorItemSchema,
  walkSchemaPath,
} from "../../../shared/workflows";
import { type CoreKey, translateCore } from "./i18nCore";
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
  /**
   * Suggestion flavor. Defaults to `"value"` (namespaces, paths, keys). A
   * `"function"` suggestion is a callable built-in: accepting it inserts
   * `name(` and keeps the popup open so the author can fill in arguments.
   */
  kind?: "value" | "function";
  /** Optional human-readable signature, shown for function suggestions. */
  signature?: string;
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
 * An edge in a workflow DAG, expressed in slugs (matching the serialized
 * backend workflow representation rather than the editor's id-based draft edges).
 */
export interface SlugEdge {
  from: string;
  to: string;
  /**
   * Optional branch label carried from the draft edge (e.g. `"each"` on an
   * iterator's body edge, `"then"`/`"else"` on an `if`). Preserved so scope
   * computation can identify structural branches - notably the iterator `each`
   * edge that starts a loop body. Dominator/ancestor computation ignores it.
   */
  branch?: string;
}

/**
 * Configuration for the scope registry.
 */
export interface ScopeConfig {
  /** All steps in the workflow draft (full step definitions for config introspection) */
  steps: Array<{ slug: string; [key: string]: unknown }>;
  /** Zero-based index of the step currently being edited */
  currentStepIndex: number;
  /**
   * DAG edges in slug space, used to determine which steps run before the
   * current step. Supplied by the editor (converted from id-based draft edges).
   * When omitted, every step is treated as an entry node with no predecessors,
   * so no step qualifies as a preceding dominator and `result` references are
   * never offered (a conservative default, stricter than declaration order).
   */
  edges?: SlugEdge[];
  /** Prefetched secret key names */
  secretKeys: string[];
  /** Prefetched variable key names */
  variableKeys: string[];
  /** Environment variable allowlist (defaults to built-in set) */
  envAllowlist?: readonly string[];
  /** Resolved output schemas from the workflow API */
  outputSchemas?: OutputSchemas;
  /**
   * Whether a step type may reference its own result (the step type's
   * `selfReference` flag). When omitted, no step type may.
   */
  allowsSelfReference?: (stepType: string) => boolean;
  /**
   * The order in which a self-referencing step type sets its result fields
   * (the step type's `selfReferenceOrder`). With {@link fieldPath}, limits the
   * own result fields offered outside an iterator body to those already set.
   */
  selfReferenceOrder?: (stepType: string) => SelfReferenceOrder | undefined;
  /**
   * Dotted path of the field being edited within the step config, as the
   * backend validator names it (e.g. `variables.2.value`).
   */
  fieldPath?: string;
}

/** Fixed set of top-level namespace names. */
const TOP_LEVEL_NAMESPACES = ["trigger", "steps", "env", "secret", "var", "run"] as const;

/**
 * Returns top-level namespace suggestions, filtered by prefix.
 * Always returns from: ["trigger", "steps", "env", "secret", "var", "run"].
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
 * Returns built-in function suggestions, filtered by prefix (case-sensitive
 * startsWith, matching namespace filtering). The names and documentation are
 * sourced from the shared metadata table ({@link TEMPLATE_FUNCTION_META}), the
 * same source the runtime evaluator uses, so completions cannot drift from the
 * functions actually available at runtime. Each suggestion is a non-terminal
 * `"function"` flavor: accepting it inserts `name(` and keeps the popup open.
 *
 * @param prefix - The currently typed text used for filtering
 * @returns Array of matching function suggestions, in metadata declaration order
 */
export function getFunctionSuggestions(prefix: string): Suggestion[] {
  return TEMPLATE_FUNCTION_META.filter((meta) => meta.name.startsWith(prefix)).map((meta) => ({
    label: meta.name,
    terminal: false,
    kind: "function",
    signature: meta.signature,
    description: translateCore(`templateFunctions.${meta.name}` as CoreKey, { default: meta.description }),
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
 * Returns variable key suggestions filtered by case-insensitive substring match.
 * Results are sorted alphabetically (case-insensitive). All are terminal.
 *
 * @param variableKeys - List of available variable key names
 * @param prefix - The currently typed text used for filtering
 * @returns Array of matching variable key suggestions, sorted alphabetically
 */
export function getVariableSuggestions(variableKeys: string[], prefix: string): Suggestion[] {
  const lowerPrefix = prefix.toLowerCase();
  return variableKeys
    .filter((key) => key.toLowerCase().includes(lowerPrefix))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((key) => ({
      label: key,
      terminal: true,
    }));
}

/**
 * Returns `run` namespace field suggestions (`id`, `workflow`, `createdBy`, `baseUrl`, `url`),
 * filtered by prefix. All are terminal.
 *
 * @param prefix - The currently typed text used for filtering
 * @returns Array of matching run field suggestions, in declaration order
 */
export function getRunSuggestions(prefix: string): Suggestion[] {
  return RUN_TEMPLATE_FIELDS.filter((field) => field.startsWith(prefix)).map((field) => ({
    label: field,
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
 * Builds a single suggestion from a child JSON Schema node, deriving
 * terminal-ness from the shared node classification and attaching declared
 * metadata verbatim (absent fields omitted).
 *
 * The child is non-terminal exactly when {@link isObjectSchemaNode} classifies
 * it as an object node -- the identical rule {@link walkSchemaPath} uses to
 * decide whether to descend. Reusing that one predicate (rather than a private
 * object-detection check) means the completion engine and the backend template
 * validator classify the same node the same way by construction, so completion
 * and diagnostics cannot diverge.
 *
 * @param key - The child property name (used as the suggestion label)
 * @param childNode - The child JSON Schema node, when present
 * @returns The suggestion with metadata populated from the child node
 */
function buildSchemaSuggestion(key: string, childNode: Record<string, unknown> | undefined): Suggestion {
  const suggestion: Suggestion = {
    label: key,
    terminal: childNode === undefined || !isObjectSchemaNode(childNode),
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
 * Computes the set of step slugs whose `result` is guaranteed available when
 * referenced from `currentSlug`. A slug qualifies only when it is both an
 * ancestor of (runs before) and a dominator of (guaranteed to execute, i.e. not
 * sitting on a skippable conditional branch) the current step. This mirrors the
 * backend rule in `dagTemplateValidation.ts` exactly, so autocomplete offers the
 * same references the runtime is guaranteed to resolve and never offers a
 * forward / branch-skippable reference.
 *
 * Dominators use the classic iterative fixpoint: dom(entry) = {entry}, and for
 * every other node dom(n) = {n} ∩ dom(pred) over all predecessors, iterated to a
 * fixpoint. A dominator is always an ancestor, so the dominator test alone is
 * sufficient.
 *
 * @param steps - Steps carrying a slug (order is irrelevant; precedence is DAG-derived)
 * @param edges - DAG edges in slug space; when undefined every step is treated as
 *   an entry node, so only `currentSlug` dominates itself and no other step qualifies
 * @param currentSlug - Slug of the step currently being edited
 * @returns Set of valid result-reference slugs (includes `currentSlug`; callers exclude it)
 */
export function computeValidResultRefs(
  steps: Array<{ slug: string }>,
  edges: SlugEdge[] | undefined,
  currentSlug: string | undefined,
): Set<string> {
  const slugs = steps.map((s) => s.slug);
  if (!currentSlug || slugs.length === 0) return new Set();

  // Direct predecessors of each step (from edges in slug space).
  const preds = new Map<string, Set<string>>();
  for (const s of slugs) preds.set(s, new Set());
  if (edges) {
    for (const e of edges) {
      if (preds.has(e.to)) preds.get(e.to)!.add(e.from);
    }
  }
  // Entry nodes have no incoming edges.
  const entries = slugs.filter((s) => preds.get(s)?.size === 0);

  // Iterative dominator fixpoint. Entry nodes are dominated only by themselves;
  // every other node starts pessimistically dominated by all nodes, then is
  // narrowed by intersecting the dominator sets of its predecessors.
  const dom = new Map<string, Set<string>>();
  for (const s of slugs) {
    dom.set(s, entries.includes(s) ? new Set([s]) : new Set(slugs));
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of slugs) {
      if (entries.includes(s)) continue;
      let intersection: Set<string> | null = null;
      for (const p of [...(preds.get(s) ?? [])]) {
        const pDom = dom.get(p)!;
        if (intersection === null) {
          intersection = new Set(pDom);
        } else {
          for (const d of [...intersection]) {
            if (!pDom.has(d)) intersection.delete(d);
          }
        }
      }
      const merged: Set<string> = intersection ? new Set(intersection) : new Set<string>();
      merged.add(s);
      const prev = dom.get(s)!;
      if (prev.size !== merged.size || [...merged].some((d) => !prev.has(d))) {
        dom.set(s, merged);
        changed = true;
      }
    }
  }

  const curDom = dom.get(currentSlug) ?? new Set([currentSlug]);
  return curDom;
}

/**
 * Whether `{{steps.<slug>.result}}` is a valid reference from the step being
 * edited: the referenced step must be a preceding dominator (see
 * {@link computeValidResultRefs}), or the current step itself when its type
 * supports self-reference (`config.allowsSelfReference`): it then reads values
 * set earlier in the same execution (e.g. set-variables entries above the
 * field) or, inside an iterator body, the previous pass's result.
 *
 * @param config - The scope configuration
 * @param slug - Slug of the referenced step
 * @returns True when the step's result is guaranteed available
 */
function isResultReferenceable(config: ScopeConfig, slug: string): boolean {
  const current = config.steps[config.currentStepIndex];
  if (!current) return false;
  if (slug === current.slug) {
    const allowed = ownResultFields(config);
    return allowed === null || allowed.length > 0;
  }
  return computeValidResultRefs(config.steps, config.edges, current.slug).has(slug);
}

/**
 * The own result fields the step being edited may reference from the current
 * field, mirroring the backend validator: inside an iterator body every field
 * (the previous pass's result); outside one only the fields set earlier in the
 * same execution, per the step type's `selfReferenceOrder` and the edited
 * field's position. Step types without `selfReference` get none.
 *
 * @param config - The scope configuration
 * @returns The allowed field names, or null when every field is allowed
 */
function ownResultFields(config: ScopeConfig): string[] | null {
  const current = config.steps[config.currentStepIndex];
  if (!current || typeof current.type !== "string") return [];
  if (config.allowsSelfReference?.(current.type) !== true) return [];
  if (findEnclosingIterator(config) !== undefined) return null;
  const order = config.selfReferenceOrder?.(current.type);
  if (!order || config.fieldPath === undefined) return [];
  // Custom step drafts wrap their fields in a `config` object.
  const stepConfig =
    current.config && typeof current.config === "object" && !Array.isArray(current.config)
      ? (current.config as Record<string, unknown>)
      : current;
  return resolvedSelfFields(order, stepConfig, config.fieldPath);
}

/**
 * The iterator binding in scope for a given step: the loop-variable name and the
 * `items` template expression whose array element the variable ranges over.
 */
interface IteratorBinding {
  /** The loop-variable name (the iterator's `as`, default "item"). */
  as: string;
  /** The iterator's `items` field: a template expression resolving to an array. */
  itemsExpr: string;
}

/**
 * Finds the iterator binding in scope for the current step, if any.
 *
 * A step is "in scope" of an iterator when it sits on the iterator body: the
 * subgraph forward-reachable from the iterator's `each` branch edge and
 * backward-reachable from the paired aggregator (the aggregator whose
 * `iterator` field names the iterator). This mirrors the backend's
 * `computeBodySubgraph`/`getIterationPrefixesForStep`, so the editor offers the
 * loop variable exactly where the runtime binds it. When branch labels are
 * absent from the edges (older drafts), the `each` edge cannot be identified and
 * no binding is returned - a conservative miss rather than a wrong offer.
 *
 * @param config - The scope configuration (steps, edges, current step index)
 * @returns The in-scope iterator binding, or `undefined` when the current step is not in any iterator body
 */
function findEnclosingIterator(config: ScopeConfig): IteratorBinding | undefined {
  const currentSlug = config.steps[config.currentStepIndex]?.slug;
  if (!currentSlug || !config.edges) return undefined;

  // Forward adjacency in slug space.
  const forward = new Map<string, SlugEdge[]>();
  for (const step of config.steps) forward.set(step.slug, []);
  for (const e of config.edges) forward.get(e.from)?.push(e);

  for (const iterStep of config.steps) {
    if (iterStep.type !== "iterator") continue;
    const iteratorSlug = iterStep.slug;

    // The paired aggregator names this iterator via its `iterator` field.
    const aggregator = config.steps.find((s) => s.type === "aggregator" && s.iterator === iteratorSlug);
    if (!aggregator) continue;

    // Forward BFS from the iterator's `each` target(s), stopping at (not through)
    // the aggregator. Any visited step is inside this iterator's body.
    const body = new Set<string>();
    const queue: string[] = [];
    for (const e of forward.get(iteratorSlug) ?? []) {
      if (e.branch === "each") queue.push(e.to);
    }
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur === aggregator.slug || body.has(cur)) continue;
      body.add(cur);
      for (const e of forward.get(cur) ?? []) queue.push(e.to);
    }

    if (body.has(currentSlug)) {
      const itemsExpr = typeof iterStep.items === "string" ? iterStep.items : "";
      const as = typeof iterStep.as === "string" && iterStep.as.length > 0 ? iterStep.as : "item";
      return { as, itemsExpr };
    }
  }

  return undefined;
}

/**
 * Computes autocomplete suggestions for a given path and typed prefix.
 * Dispatches to the correct sub-function based on path segments.
 *
 * @param config - Scope configuration (steps, current index, secrets, variables, env)
 * @param path - Resolved path segments so far (e.g. ["steps", "fetch"])
 * @param prefix - The currently typed text after the last `.` (used for filtering)
 * @returns Array of matching suggestions, sorted appropriately
 */
export function getSuggestions(config: ScopeConfig, path: string[], prefix: string): Suggestion[] {
  // Top-level value position (no path segments yet): offer namespaces plus
  // built-in functions. This position is reached both at the start of the
  // top-level expression (`{{ `) and at the start of a call argument
  // (`{{ trim(`), where both a `namespace.path` lookup and a function call are
  // grammatically valid.
  if (path.length === 0) {
    // Filter out namespaces that would have no sub-items
    const namespaces = getTopLevelSuggestions(prefix).filter((s) => {
      if (s.label === "steps" && config.steps.length <= 1) return false;
      if (s.label === "secret" && config.secretKeys.length === 0) return false;
      if (s.label === "var" && config.variableKeys.length === 0) return false;
      return true;
    });
    // Inside an iterator body, the loop variable (the iterator's `as`, e.g.
    // "item") and "itemIndex" are also in scope, mirroring the runtime binding.
    const iterator = findEnclosingIterator(config);
    const iterationVars: Suggestion[] = iterator
      ? [
          // The loop variable is non-terminal only when its element type is a
          // known object (so there are sub-properties to drill into).
          {
            label: iterator.as,
            terminal: resolveIteratorItemSchema(config.outputSchemas, iterator.itemsExpr) === null,
          },
          { label: "itemIndex", terminal: true, schemaType: "number" },
        ].filter((s) => s.label.startsWith(prefix))
      : [];
    return [...namespaces, ...iterationVars, ...getFunctionSuggestions(prefix)];
  }

  const namespace = path[0];

  // Iterator loop variable: `{{<as>.<path>}}` drills into the array element
  // schema of the iterator's `items` expression. Checked before the fixed
  // namespaces so a loop variable named like one of them is not shadowed only
  // when actually in an iterator body; outside a body this falls through.
  {
    const iterator = findEnclosingIterator(config);
    if (iterator && namespace === iterator.as) {
      const elementSchema = resolveIteratorItemSchema(config.outputSchemas, iterator.itemsExpr);
      if (!elementSchema) return [];
      const subPath = path.slice(1); // segments after the loop variable
      return getOutputSchemaSuggestions(elementSchema, subPath, prefix);
    }
  }

  if (namespace === "steps") {
    if (path.length === 1) {
      // path=["steps"] -> show all step slugs, sorted alphabetically. The current
      // step is listed only when it may reference its own result (a
      // self-referencing step type such as set-variables).
      // Config is accessible from any step (static); result only from preceding steps.
      // We show all slugs and rely on backend validation to flag forward result references.
      return config.steps
        .filter((step, i) => i !== config.currentStepIndex || isResultReferenceable(config, step.slug))
        .filter((step) => step.slug.startsWith(prefix))
        .map((step) => ({
          label: step.slug,
          terminal: false,
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
    }
    if (path.length === 2) {
      // path=["steps", slug] -> show result/config
      // "result" is offered only for steps whose result is guaranteed available here:
      // steps that are both ancestors (run before) and dominators (guaranteed to run,
      // never on a skippable conditional branch) of the current step. This is derived
      // from the DAG edges, so a step declared later in the file but executing earlier
      // (e.g. a root step feeding a later node) still qualifies. Declaration order
      // alone is insufficient and would wrongly hide such references.
      const slug = path[1]!;
      if (!config.steps.some((s) => s.slug === slug)) return [];
      const stepSchema = config.outputSchemas?.steps[slug];
      const suggestions: Suggestion[] = [
        ...(isResultReferenceable(config, slug) ? [{ label: "result", terminal: !stepSchema }] : []),
        { label: "config", terminal: false },
      ];
      return suggestions.filter((s) => s.label.startsWith(prefix));
    }
    if (path.length >= 3 && path[2] === "result") {
      // path=["steps", slug, "result", ...] -> drill into step output schema.
      // Gated like the `result` suggestion itself, so typing `.result.` by hand
      // does not reveal the schema of a step that runs later or may be skipped.
      const slug = path[1]!;
      if (!isResultReferenceable(config, slug)) return [];
      const stepSchema = config.outputSchemas?.steps[slug];
      if (!stepSchema) return [];
      const subPath = path.slice(3); // segments after "result"
      // The step's own result: only the fields already set at this field.
      const allowed = slug === config.steps[config.currentStepIndex]?.slug ? ownResultFields(config) : null;
      if (allowed !== null) {
        if (subPath.length > 0 && !allowed.includes(subPath[0]!)) return [];
        if (subPath.length === 0) {
          return getOutputSchemaSuggestions(stepSchema, subPath, prefix).filter((s) => allowed.includes(s.label));
        }
      }
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

  if (namespace === "var") {
    if (path.length === 1) {
      // path=["var"] -> show variable keys
      return getVariableSuggestions(config.variableKeys, prefix);
    }
    return [];
  }

  if (namespace === "run") {
    if (path.length === 1) {
      // path=["run"] -> show run fields
      return getRunSuggestions(prefix);
    }
    return [];
  }

  // Unknown namespace
  return [];
}

/** A node of the variable picker tree: one referenceable value (or function). */
export interface ScopeTreeNode {
  /** Display label (the last path segment, or a step slug / function name). */
  label: string;
  /** Path segments of the expression this node inserts (e.g. ["steps", "fetch", "result", "id"]). */
  path: string[];
  /**
   * `"function"` for built-in functions (inserted as a call), `"category"` for a
   * function group heading (not insertable, only expands).
   */
  kind: "value" | "function" | "category";
  /** Step type, for step nodes (`steps.<slug>.result`). */
  stepType?: string;
  /** JSON Schema `type`, when declared. */
  schemaType?: string;
  /** Description (schema description or function documentation). */
  description?: string;
  /** Function signature, for function nodes. */
  signature?: string;
  /** Child nodes (absent for leaves). */
  children?: ScopeTreeNode[];
}

/** Tabs of the variable picker. */
export type ScopeTreeGroupId = "data" | "variables" | "functions";

/** One tab of the variable picker tree. */
export interface ScopeTreeGroup {
  id: ScopeTreeGroupId;
  nodes: ScopeTreeNode[];
}

/** Depth limit when expanding schemas, guarding against recursive schemas. */
const SCOPE_TREE_MAX_DEPTH = 8;

/**
 * Expands the children of a path by querying {@link getSuggestions} level by
 * level, so the tree offers exactly what autocomplete offers.
 */
function expandChildren(config: ScopeConfig, path: string[], depth: number): ScopeTreeNode[] | undefined {
  if (depth >= SCOPE_TREE_MAX_DEPTH) return undefined;
  const suggestions = getSuggestions(config, path, "");
  if (suggestions.length === 0) return undefined;
  return suggestions.map((s) => suggestionToNode(config, path, s, depth + 1));
}

function suggestionToNode(config: ScopeConfig, parent: string[], s: Suggestion, depth: number): ScopeTreeNode {
  const path = [...parent, s.label];
  const node: ScopeTreeNode = { label: s.label, path, kind: "value" };
  if (s.schemaType) node.schemaType = s.schemaType;
  if (s.description) node.description = s.description;
  if (!s.terminal) {
    const children = expandChildren(config, path, depth);
    if (children) node.children = children;
  }
  return node;
}

/**
 * Orders steps by execution (topological order of the DAG, draft order among
 * steps that are ready at the same time). Steps on a cycle keep draft order at
 * the end.
 */
function executionOrder<T extends { slug: string }>(steps: T[], edges: SlugEdge[] | undefined): T[] {
  const indegree = new Map(steps.map((s) => [s.slug, 0]));
  for (const e of edges ?? []) {
    if (indegree.has(e.to) && indegree.has(e.from)) indegree.set(e.to, indegree.get(e.to)! + 1);
  }
  const ordered: T[] = [];
  const done = new Set<string>();
  let ready = steps.filter((s) => indegree.get(s.slug) === 0);
  while (ready.length > 0) {
    const next: T[] = [];
    for (const step of ready) {
      ordered.push(step);
      done.add(step.slug);
      for (const e of edges ?? []) {
        if (e.from !== step.slug || !indegree.has(e.to)) continue;
        const left = indegree.get(e.to)! - 1;
        indegree.set(e.to, left);
        if (left === 0) next.push(steps.find((s) => s.slug === e.to)!);
      }
    }
    ready = steps.filter((s) => next.includes(s));
  }
  return [...ordered, ...steps.filter((s) => !done.has(s.slug))];
}

/**
 * Builds the variable picker tree for the step being edited: everything a
 * `{{...}}` expression in that step may reference, grouped into tabs.
 *
 * - **data**: the trigger payload, the result of every step guaranteed to run
 *   before this one (same DAG rule as autocomplete) in execution order, and the
 *   iterator loop variable inside an iterator body
 * - **variables**: global variables, secrets, allowlisted env vars, run fields
 * - **functions**: built-in template functions, grouped by category
 *
 * Empty namespaces are left out.
 *
 * @param config - The scope configuration (as for {@link getSuggestions})
 * @returns The groups, always in the order data, variables, functions
 */
export function buildScopeTree(config: ScopeConfig): ScopeTreeGroup[] {
  const top = getSuggestions(config, [], "");
  const data: ScopeTreeNode[] = [];

  const trigger: ScopeTreeNode = { label: "trigger", path: ["trigger"], kind: "value" };
  const payload = expandChildren(config, ["trigger"], 0);
  if (payload) trigger.children = payload;
  data.push(trigger);

  for (const step of executionOrder(config.steps, config.edges)) {
    // `result` is offered only when the step's result is guaranteed available here.
    const resultOffered = getSuggestions(config, ["steps", step.slug], "result").some((s) => s.label === "result");
    if (!resultOffered) continue;
    const path = ["steps", step.slug, "result"];
    const node: ScopeTreeNode = { label: step.slug, path, kind: "value" };
    if (typeof step.type === "string") node.stepType = step.type;
    const children = expandChildren(config, path, 0);
    if (children) node.children = children;
    data.push(node);
  }

  const namespaceNames = new Set<string>(TOP_LEVEL_NAMESPACES);
  for (const s of top) {
    // Iterator loop variable and itemIndex: top-level values that are neither a namespace nor a function.
    if (s.kind === "function" || namespaceNames.has(s.label)) continue;
    data.push(suggestionToNode(config, [], s, 0));
  }

  const variables: ScopeTreeNode[] = [];
  for (const ns of ["var", "secret", "env", "run"] as const) {
    const children = expandChildren(config, [ns], 0);
    if (children) variables.push({ label: ns, path: [ns], kind: "value", children });
  }

  const functionNodes = new Map<string, ScopeTreeNode>(
    getFunctionSuggestions("").map((s) => [
      s.label,
      {
        label: s.label,
        path: [s.label],
        kind: "function",
        ...(s.signature ? { signature: s.signature } : {}),
        ...(s.description ? { description: s.description } : {}),
      },
    ]),
  );
  const functions: ScopeTreeNode[] = TEMPLATE_FUNCTION_CATEGORIES.map((category) => ({
    label: translateCore(`templateFunctionCategories.${category}` as CoreKey, { default: category }),
    path: [category],
    kind: "category" as const,
    children: TEMPLATE_FUNCTION_META.filter((meta) => meta.category === category).map(
      (meta) => functionNodes.get(meta.name)!,
    ),
  })).filter((node) => node.children.length > 0);

  return [
    { id: "data", nodes: data },
    { id: "variables", nodes: variables },
    { id: "functions", nodes: functions },
  ];
}

/**
 * Filters a picker tree by a search query (case-insensitive substring of the
 * label or the dotted path). A matching node keeps its whole subtree; a
 * non-matching node is kept only when a descendant matches.
 *
 * @param nodes - The nodes to filter
 * @param query - The search text ("" keeps everything)
 * @returns The filtered nodes
 */
export function filterScopeTree(nodes: ScopeTreeNode[], query: string): ScopeTreeNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  const result: ScopeTreeNode[] = [];
  for (const node of nodes) {
    if (node.label.toLowerCase().includes(q) || node.path.join(".").toLowerCase().includes(q)) {
      result.push(node);
      continue;
    }
    const children = node.children ? filterScopeTree(node.children, q) : [];
    if (children.length > 0) result.push({ ...node, children });
  }
  return result;
}
