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
 *   `resolved: false` with no children.
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

  for (const segment of path) {
    const properties = getProperties(node);
    if (properties === null) {
      return { resolved: false, children: [] };
    }
    const next = properties[segment];
    if (next === undefined || next === null || typeof next !== "object") {
      return { resolved: false, children: [] };
    }
    node = next as OutputSchema;
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
  | { type: "workflow_deleted"; workflowName: string };
