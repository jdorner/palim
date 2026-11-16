/**
 * Pure edits of a parsed workflow definition, used by the `workflow` editing
 * commands (`set-step`, `remove-step`, `add-edge`, `remove-edge`, `set-meta`).
 *
 * Each helper returns a new definition object (the input is never mutated) or
 * an error message. They check only what the edit itself needs (an unknown
 * slug, a duplicate edge); the caller validates the result as a whole.
 *
 * @module
 */

/** A parsed (not yet validated) workflow definition. */
export type RawDefinition = Record<string, unknown>;

/** An edge as stored in a definition. */
interface RawEdge {
  from: string;
  to: string;
  branch?: string;
  [key: string]: unknown;
}

/** Result of an edit: the new definition, or why the edit was refused. */
export type EditResult = { ok: true; definition: RawDefinition } | { ok: false; error: string };

/** The top-level fields `set-meta` may change. */
export const META_FIELDS = ["description", "group", "trigger"] as const;

/** The steps map of a definition (empty when missing or malformed). */
function stepsOf(definition: RawDefinition): Record<string, unknown> {
  const steps = definition.steps;
  return steps && typeof steps === "object" && !Array.isArray(steps) ? (steps as Record<string, unknown>) : {};
}

/** The edges of a definition (empty when missing or malformed). */
function edgesOf(definition: RawDefinition): RawEdge[] {
  return Array.isArray(definition.edges) ? (definition.edges as RawEdge[]) : [];
}

/** Whether a value is a plain object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Error for a slug that names no step. */
function unknownStep(slug: string, definition: RawDefinition): EditResult {
  const known = Object.keys(stepsOf(definition));
  return {
    ok: false,
    error: `Unknown step "${slug}"${known.length > 0 ? ` (steps: ${known.join(", ")})` : ""}`,
  };
}

/** Describes an edge for messages, e.g. `"route" -> "notify" (branch "approve")`. */
export function describeEdge(from: string, to: string, branch?: string): string {
  return `"${from}" -> "${to}"${branch ? ` (branch "${branch}")` : ""}`;
}

/**
 * Creates a step or replaces it as a whole.
 *
 * @param definition - The definition to edit
 * @param slug - The step slug
 * @param step - The complete step object (must be an object)
 * @returns The edited definition, or an error
 */
export function setStep(definition: RawDefinition, slug: string, step: unknown): EditResult {
  if (!isObject(step)) return { ok: false, error: `The step "${slug}" must be a JSON5 object` };
  return { ok: true, definition: { ...definition, steps: { ...stepsOf(definition), [slug]: step } } };
}

/**
 * Removes a step together with every edge from or to it.
 *
 * @param definition - The definition to edit
 * @param slug - The step slug
 * @returns The edited definition, or an error for an unknown slug
 */
export function removeStep(definition: RawDefinition, slug: string): EditResult {
  const steps = stepsOf(definition);
  if (!Object.hasOwn(steps, slug)) return unknownStep(slug, definition);
  const { [slug]: _removed, ...rest } = steps;
  return {
    ok: true,
    definition: {
      ...definition,
      steps: rest,
      edges: edgesOf(definition).filter((e) => e.from !== slug && e.to !== slug),
    },
  };
}

/**
 * Adds an edge.
 *
 * @param definition - The definition to edit
 * @param from - Source step slug
 * @param to - Target step slug
 * @param branch - Branch key (for edges leaving `if`, `case`, or `iterator` steps)
 * @returns The edited definition, or an error for an unknown slug or an existing edge
 */
export function addEdge(definition: RawDefinition, from: string, to: string, branch?: string): EditResult {
  const steps = stepsOf(definition);
  if (!Object.hasOwn(steps, from)) return unknownStep(from, definition);
  if (!Object.hasOwn(steps, to)) return unknownStep(to, definition);
  const edges = edgesOf(definition);
  if (edges.some((e) => e.from === from && e.to === to && (e.branch ?? undefined) === (branch || undefined))) {
    return { ok: false, error: `Edge ${describeEdge(from, to, branch)} already exists` };
  }
  const edge: RawEdge = branch ? { from, to, branch } : { from, to };
  return { ok: true, definition: { ...definition, edges: [...edges, edge] } };
}

/**
 * Removes the edges from `from` to `to`; with a branch, only the edge with that branch.
 *
 * @param definition - The definition to edit
 * @param from - Source step slug
 * @param to - Target step slug
 * @param branch - Optional branch key to match
 * @returns The edited definition, or an error when no edge matches
 */
export function removeEdge(definition: RawDefinition, from: string, to: string, branch?: string): EditResult {
  const edges = edgesOf(definition);
  const matches = (e: RawEdge) => e.from === from && e.to === to && (!branch || e.branch === branch);
  if (!edges.some(matches)) {
    const existing = edges.filter((e) => e.from === from).map((e) => describeEdge(e.from, e.to, e.branch));
    const hint = existing.length > 0 ? ` (edges from "${from}": ${existing.join(", ")})` : "";
    return { ok: false, error: `No edge ${describeEdge(from, to, branch)}${hint}` };
  }
  return { ok: true, definition: { ...definition, edges: edges.filter((e) => !matches(e)) } };
}

/**
 * Shallow-merges `description`, `group`, and `trigger` into the definition. A
 * `null` value removes `description` or `group`. Every other field is refused:
 * `name`, `draft`, `enabled`, `steps`, and `edges` have their own commands or
 * belong to the user.
 *
 * @param definition - The definition to edit
 * @param patch - The fields to set
 * @returns The edited definition, or an error naming the refused fields
 */
export function setMeta(definition: RawDefinition, patch: unknown): EditResult {
  if (!isObject(patch)) return { ok: false, error: "The meta fields must be a JSON5 object" };
  const allowed = new Set<string>(META_FIELDS);
  const refused = Object.keys(patch).filter((key) => !allowed.has(key));
  if (refused.length > 0) {
    return {
      ok: false,
      error: `Cannot set ${refused.map((k) => `"${k}"`).join(", ")} with set-meta (allowed: ${META_FIELDS.join(", ")})`,
    };
  }
  if (Object.keys(patch).length === 0) {
    return { ok: false, error: `Nothing to set (allowed: ${META_FIELDS.join(", ")})` };
  }
  const next: RawDefinition = { ...definition };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null && key !== "trigger") delete next[key];
    else next[key] = value;
  }
  return { ok: true, definition: next };
}
