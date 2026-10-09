/**
 * Workflow pipeline types shared between backend and frontend.
 *
 * @module
 */

/**
 * Canonical machine-readable output schema for a workflow step or trigger.
 *
 * This is the single source of truth for the canonical output schema shape: a
 * JSON Schema object (represented as an untyped record of JSON Schema keywords
 * such as `type`, `properties`, `enum`, `description`). It is distinct from the
 * backend type-hint shorthand used in `*.json5` workflow files, which is
 * compiled into this canonical form.
 */
export type OutputSchema = Record<string, unknown>;

/**
 * The `outputSchemas` payload returned by the workflow detail API.
 *
 * Carries the resolved canonical JSON Schemas for the workflow trigger and for
 * every step, keyed by step slug.
 */
export interface OutputSchemas {
  /** Resolved trigger output schema as JSON Schema, or null when unavailable. */
  trigger: OutputSchema | null;
  /** Per-step output schemas keyed by step slug, as JSON Schema. */
  steps: Record<string, OutputSchema>;
}

/**
 * Canonical default env-var allowlist for workflow templates.
 *
 * These are the environment variable NAMES that workflow templates may reference
 * by default (via `{{env.NAME}}`), before any per-instance additions are unioned
 * in. This is the single source of truth shared by the backend template engine,
 * the backend DAG validator, and the frontend template scope.
 */
export const DEFAULT_ENV_ALLOWLIST: readonly string[] = ["WEB_HOST", "WEB_PORT", "AGENT_WORK_DIR", "NODE_ENV"];

/**
 * The node a dot-path resolves to within an {@link OutputSchema}, plus what is
 * reachable from it.
 *
 * Returned by {@link walkSchemaPath}. Used by the frontend autocomplete engine
 * (to derive suggestions from `children` and metadata from `node`) and by the
 * backend template validator (to decide path existence from `resolved`), so both
 * callers share a single resolution.
 */
export interface ResolvedExpression {
  /** Whether the path resolves to a node in the schema. */
  resolved: boolean;
  /** The resolved JSON Schema node, when resolved. */
  node?: OutputSchema;
  /** Immediate child property names, when the resolved node is an object. */
  children: string[];
}

/**
 * Resolves a dot-path against a canonical {@link OutputSchema}.
 *
 * Descends object nodes segment by segment via their `properties` map. A node is
 * treated as an object when its `type` is `"object"` or when it exposes a
 * `properties` map. Leaf/primitive nodes, unconstrained `{}` nodes, and malformed
 * nodes have no known children.
 *
 * Behavior:
 * - A `null` schema yields `{ resolved: false, children: [] }`.
 * - A segment that is not present under the current node's `properties` yields
 *   `resolved: false` with no children, unless the object node is open:
 *   `additionalProperties: true` resolves the rest of the path to an
 *   unconstrained `{}` node, and an `additionalProperties` schema is walked with
 *   the remaining segments.
 * - On an array node, `length` resolves to an integer and a numeric segment
 *   (`rows.0.name`) descends into the element schema.
 * - When the whole path lands on a node (object or leaf), it resolves
 *   (`resolved: true`). For object nodes, `children` lists the immediate
 *   `properties` keys; for leaf nodes, `children` is empty.
 *
 * This function is pure and dependency-free so both the frontend autocomplete
 * engine and the backend template validator can import the single implementation.
 *
 * @param schema - The canonical JSON Schema to walk, or `null` when unavailable.
 * @param path - The dot-path segments to descend, in order.
 * @returns The resolution result: whether the path resolved, the resolved node,
 *   and the immediate child property names.
 */
export function walkSchemaPath(schema: OutputSchema | null, path: string[]): ResolvedExpression {
  if (schema === null || typeof schema !== "object") {
    return { resolved: false, children: [] };
  }

  let node: OutputSchema = schema;

  for (const [i, segment] of path.entries()) {
    // Arrays: `length` and numeric indices (`rows.0.name`) are valid at runtime.
    if (node.type === "array" || unwrapArrayItems(node) !== null) {
      const element = unwrapArrayItems(node);
      if (segment === "length") {
        node = { type: "integer" };
        continue;
      }
      if (element !== null && /^\d+$/.test(segment)) {
        node = element;
        continue;
      }
      return { resolved: false, children: [] };
    }
    const next = getProperties(node)?.[segment];
    if (next !== undefined && next !== null && typeof next === "object") {
      node = next as OutputSchema;
      continue;
    }
    if (!isObjectSchemaNode(node)) {
      return { resolved: false, children: [] };
    }
    // Open object: unknown keys are allowed. `additionalProperties: true`
    // admits anything below, so the rest of the path cannot be checked.
    const additional = node.additionalProperties;
    if (additional === true) {
      return { resolved: true, node: {}, children: [] };
    }
    if (additional !== null && typeof additional === "object") {
      return walkSchemaPath(additional as OutputSchema, path.slice(i + 1));
    }
    return { resolved: false, children: [] };
  }

  return { resolved: true, node, children: listChildren(node) };
}

/**
 * Reports whether a schema node is an object node (i.e. it can have children).
 *
 * A node counts as an object when its `type` is `"object"` or when it exposes a
 * `properties` map (regardless of `type`). Leaf/primitive nodes, unconstrained
 * `{}` nodes, and malformed nodes are not object nodes.
 *
 * This is the single classification rule shared by {@link walkSchemaPath} (to
 * decide whether to descend) and by the frontend autocomplete engine (to decide
 * whether a completion is terminal). Anchoring both on this one predicate keeps
 * completion and diagnostics from diverging.
 *
 * @param node - The schema node to inspect.
 * @returns True when the node is an object node, false for leaf/malformed nodes.
 */
export function isObjectSchemaNode(node: OutputSchema): boolean {
  const properties = node.properties;
  const hasPropertiesMap = properties !== null && typeof properties === "object";
  return node.type === "object" || hasPropertiesMap;
}

/**
 * Unwraps a JSON Schema array node to its element (item) schema.
 *
 * A node counts as an array when its `type` is `"array"` or when it exposes an
 * `items` schema. The element schema is read from the `items` keyword, which for
 * a homogeneous array (the shape `Type.Array(X)` serializes to) is a single
 * schema object. Tuple form (`items` as an array of schemas) has no single
 * element type and yields `null`, as do leaf/object/malformed nodes.
 *
 * This is the array counterpart to {@link isObjectSchemaNode}/{@link walkSchemaPath}'s
 * object descent: those step into object `properties`, this steps into array
 * `items`. Kept as a shared, dependency-free helper so the frontend autocomplete
 * and any backend caller unwrap element types the same way.
 *
 * @param node - The schema node to inspect, or `null`/`undefined` when unavailable.
 * @returns The element schema, or `null` when the node is not a single-element array.
 */
export function unwrapArrayItems(node: OutputSchema | null | undefined): OutputSchema | null {
  if (node === null || node === undefined || typeof node !== "object") {
    return null;
  }
  const items = node.items;
  const isArrayNode = node.type === "array" || (items !== undefined && items !== null);
  if (!isArrayNode) {
    return null;
  }
  // Homogeneous array: `items` is a single schema object. Tuple form (an array
  // of per-position schemas) has no single element type.
  if (items === null || typeof items !== "object" || Array.isArray(items)) {
    return null;
  }
  return items as OutputSchema;
}

/**
 * Extracts the `properties` map from a schema node when the node is an object.
 *
 * A node counts as an object per {@link isObjectSchemaNode}. Returns `null` for
 * leaf/primitive, unconstrained, or malformed nodes, or when an object node
 * exposes no readable `properties` map.
 *
 * @param node - The schema node to inspect.
 * @returns The `properties` map, or `null` when the node is not an object.
 */
function getProperties(node: OutputSchema): Record<string, unknown> | null {
  const properties = node.properties;
  const hasPropertiesMap = properties !== null && typeof properties === "object";
  if (!isObjectSchemaNode(node) || !hasPropertiesMap) {
    return null;
  }
  return properties as Record<string, unknown>;
}

/**
 * Lists the immediate child property names of a schema node.
 *
 * @param node - The resolved schema node.
 * @returns The `properties` keys when the node is an object, otherwise an empty array.
 */
function listChildren(node: OutputSchema): string[] {
  const properties = getProperties(node);
  return properties === null ? [] : Object.keys(properties);
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
 * Shared by the frontend autocomplete and the backend template validator.
 *
 * @param outputSchemas - The workflow's resolved output schemas
 * @param itemsExpr - The iterator's raw `items` field value
 * @returns The element JSON Schema, or `null` when it cannot be derived
 */
export function resolveIteratorItemSchema(
  outputSchemas: OutputSchemas | null | undefined,
  itemsExpr: string,
): OutputSchema | null {
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
    const stepSchema = outputSchemas?.steps[slug];
    if (!stepSchema) return null;
    const walked = walkSchemaPath(stepSchema, parts.slice(3));
    arraySchema = walked.resolved && walked.node !== undefined ? walked.node : null;
  } else if (parts[0] === "trigger" && parts[1] === "payload") {
    const triggerSchema = outputSchemas?.trigger;
    if (!triggerSchema) return null;
    const walked = walkSchemaPath(triggerSchema, parts.slice(2));
    arraySchema = walked.resolved && walked.node !== undefined ? walked.node : null;
  } else {
    return null;
  }

  return unwrapArrayItems(arraySchema);
}

/** Step summary included in workflow WebSocket events. */
export interface WorkflowStepSummary {
  slug: string;
  type: string;
  jobId?: string;
}

/** WebSocket messages for workflow pipeline lifecycle events. */
export type WorkflowWebSocketEvent =
  | { type: "workflow_reload" }
  | { type: "workflow_started"; workflowRunId: string; workflowName: string; steps: WorkflowStepSummary[] }
  | { type: "workflow_step_started"; workflowRunId: string; stepSlug: string; jobId: string }
  | { type: "workflow_step_completed"; workflowRunId: string; stepSlug: string; jobId: string; chosenBranch?: string }
  | { type: "workflow_step_dead"; workflowRunId: string; stepSlug: string }
  | { type: "workflow_step_failed"; workflowRunId: string; stepSlug: string; jobId: string; error: string }
  | {
      type: "workflow_step_waiting";
      workflowRunId: string;
      stepSlug: string;
      event: string;
      inputSchema?: Record<string, unknown> | null;
    }
  | { type: "workflow_step_resumed"; workflowRunId: string; stepSlug: string; signalEvent: string }
  | { type: "workflow_completed"; workflowRunId: string }
  | { type: "workflow_failed"; workflowRunId: string; failedStep: string; error: string }
  | { type: "workflow_run_removed"; workflowRunId: string; workflowName?: string }
  | { type: "workflow_deleted"; workflowName: string };
