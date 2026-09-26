/**
 * Template Scope Registry -- Pure TypeScript module for computing
 * autocomplete suggestions for workflow template expressions.
 *
 * Mirrors the scope rules from the backend templateValidation.ts.
 * No Svelte or DOM dependencies.
 */

import { TEMPLATE_FUNCTION_META } from "../../../shared/templateFunctionMeta";
import {
  DEFAULT_ENV_ALLOWLIST,
  isObjectSchemaNode,
  type OutputSchema,
  type OutputSchemas,
  unwrapArrayItems,
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
}

/** Fixed set of top-level namespace names. */
const TOP_LEVEL_NAMESPACES = ["trigger", "steps", "env", "secret", "var"] as const;

/**
 * Returns top-level namespace suggestions, filtered by prefix.
 * Always returns from: ["trigger", "steps", "env", "secret", "var"].
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
    description: meta.description,
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

/** Matches a single leading `{{ ... }}` template expression and captures its body. */
const SINGLE_TEMPLATE_EXPR = /^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/;

/**
 * Resolves the element schema of an iterator's `items` expression.
 *
 * The iterator's `items` is a template expression resolving to an array (e.g.
 * `{{steps.fetch.result.messages}}` or `{{trigger.payload.rows}}`). This resolves
 * the referenced array's JSON Schema via the workflow `outputSchemas`, then
 * unwraps it to the array element schema so `{{item.<path>}}` completions can be
 * derived from the element's `properties`.
 *
 * Only plain single-expression `items` are supported (a lone `{{ ... }}` naming a
 * `steps.<slug>.result[.<path>]` or `trigger.payload[.<path>]`). Anything else -
 * a function call, a literal, a compound string, an unresolved reference, or a
 * non-array target - yields `null`, and the caller offers no `item` completions.
 *
 * @param config - The scope configuration (carries `outputSchemas`)
 * @param itemsExpr - The iterator's raw `items` field value
 * @returns The element JSON Schema, or `null` when it cannot be derived
 */
function resolveIteratorItemSchema(config: ScopeConfig, itemsExpr: string): OutputSchema | null {
  const match = SINGLE_TEMPLATE_EXPR.exec(itemsExpr);
  if (!match) return null;

  const inner = match[1]!.trim();
  // Reject function-call syntax and anything that is not a plain dot-path.
  // Step slugs may contain hyphens (e.g. "fetch-mails"), so hyphens are allowed
  // within segments alongside identifier characters.
  if (!/^[A-Za-z_$][A-Za-z0-9_$.-]*$/.test(inner)) return null;

  const parts = inner.split(".");
  let arraySchema: OutputSchema | null = null;

  if (parts[0] === "steps" && parts[2] === "result" && parts.length >= 3) {
    const slug = parts[1]!;
    const stepSchema = config.outputSchemas?.steps[slug];
    if (!stepSchema) return null;
    const walked = walkSchemaPath(stepSchema, parts.slice(3));
    arraySchema = walked.resolved && walked.node !== undefined ? walked.node : null;
  } else if (parts[0] === "trigger" && parts[1] === "payload") {
    const triggerSchema = config.outputSchemas?.trigger;
    if (!triggerSchema) return null;
    const walked = walkSchemaPath(triggerSchema, parts.slice(2));
    arraySchema = walked.resolved && walked.node !== undefined ? walked.node : null;
  } else {
    return null;
  }

  return unwrapArrayItems(arraySchema);
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
            terminal: resolveIteratorItemSchema(config, iterator.itemsExpr) === null,
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
      const elementSchema = resolveIteratorItemSchema(config, iterator.itemsExpr);
      if (!elementSchema) return [];
      const subPath = path.slice(1); // segments after the loop variable
      return getOutputSchemaSuggestions(elementSchema, subPath, prefix);
    }
  }

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
      // "result" is offered only for steps whose result is guaranteed available here:
      // steps that are both ancestors (run before) and dominators (guaranteed to run,
      // never on a skippable conditional branch) of the current step. This is derived
      // from the DAG edges, so a step declared later in the file but executing earlier
      // (e.g. a root step feeding a later node) still qualifies. Declaration order
      // alone is insufficient and would wrongly hide such references.
      const slug = path[1]!;
      const currentSlug = config.steps[config.currentStepIndex]?.slug;
      const validResultRefs = computeValidResultRefs(config.steps, config.edges, currentSlug);
      const isPreceding = slug !== currentSlug && validResultRefs.has(slug);
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

  if (namespace === "var") {
    if (path.length === 1) {
      // path=["var"] -> show variable keys
      return getVariableSuggestions(config.variableKeys, prefix);
    }
    return [];
  }

  // Unknown namespace
  return [];
}
