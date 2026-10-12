/**
 * Pure helpers backing the workflow detail page's edit mode: converting loaded
 * steps into editable drafts, minting step ids/templates, translating graph
 * edges back into draft edges, and maintaining derived validation errors.
 */
import { BUILTIN_STEP_TYPES } from "$shared/workflowBuilder";
import type { OutputSchemaShorthand } from "$shared/workflows";
import { translateCore as t } from "./i18nCore";
import { buildInitialValues } from "./schemaForm";
import type { WorkflowDetail, WorkflowWarning } from "./workflowDetail";
import {
  computeOrphanedStepIndices,
  disconnectedStepError,
  type EdgeDraft,
  type StepDraft,
  validateSlug,
  validateStepSlugsUnique,
  type WorkflowDraft,
} from "./workflowValidation";

/** Minimal shape of an extension step type needed to seed config defaults. */
export interface CustomStepTypeSchema {
  type?: string;
  configSchema?: Record<string, unknown>;
}

/**
 * Monotonic counter backing {@link nextStepId}. Module-scoped so ids stay
 * unique across every workflow opened in the session.
 */
let stepIdCounter = 0;

/**
 * Mints a fresh, process-unique synthetic step id (e.g. "node-1"). Used as the
 * graph node identity so selection, position, and click resolution survive slug
 * edits (including cleared or duplicated slugs). Never persisted to the backend.
 *
 * @returns A new synthetic step id.
 */
export function nextStepId(): string {
  stepIdCounter += 1;
  return `node-${stepIdCounter}`;
}

/**
 * Converts a raw workflow step (as loaded from backend) into a StepDraft.
 * For custom extension step types, extracts non-standard fields into a nested
 * `config` object so frontend validation can check them properly.
 *
 * @param s - The loaded step (with synthetic `id`, `slug`, `type`).
 * @returns A deep-enough copy suitable for editing.
 */
export function toStepDraft(s: Record<string, unknown>): StepDraft {
  const raw = s;
  const slug = raw.slug as string;
  const type = raw.type as string;
  // Preserve the synthetic node id from the source step, or mint one if absent
  // (e.g. a step that somehow lacks it). This keeps graph node identity stable
  // between view mode and edit mode.
  const id = (raw.id as string | undefined) ?? nextStepId();

  // Agent steps: extract known fields
  if (type === "agent") {
    const { prompt, tools, skills, outputSchema } = raw as {
      prompt?: string;
      tools?: string[];
      skills?: string[];
      outputSchema?: OutputSchemaShorthand;
    };
    return {
      id,
      slug,
      type,
      prompt,
      tools: tools ? [...tools] : undefined,
      skills: skills ? [...skills] : undefined,
      ...(outputSchema ? { outputSchema: JSON.parse(JSON.stringify(outputSchema)) as OutputSchemaShorthand } : {}),
    };
  }

  // Control flow: if - preserve condition + optional branch label overrides
  // (branches themselves are edges, not nested arrays)
  if (type === "if") {
    const result: StepDraft = {
      id,
      slug,
      type,
      condition: JSON.parse(JSON.stringify(raw.condition ?? {})),
    };
    const bl = raw.branchLabels as { then?: string; else?: string } | undefined;
    if (bl && (typeof bl.then === "string" || typeof bl.else === "string")) {
      result.branchLabels = { ...bl };
    }
    return result;
  }

  // Control flow: case - preserve match, paths (string[] of keys), default (string)
  if (type === "case") {
    const result: StepDraft = {
      id,
      slug,
      type,
      match: raw.match as string,
      paths: Array.isArray(raw.paths) ? [...(raw.paths as string[])] : [],
    };
    if (typeof raw.default === "string") {
      result.default = raw.default;
    }
    return result;
  }

  // Control flow: waitFor - preserve event + optional timeout / inputSchema / scope / correlate
  if (type === "waitFor") {
    const result: StepDraft = { id, slug, type, event: raw.event as string };
    if (typeof raw.timeout === "number") {
      result.timeout = raw.timeout;
    }
    if (raw.inputSchema && typeof raw.inputSchema === "object") {
      result.inputSchema = JSON.parse(JSON.stringify(raw.inputSchema));
    }
    if (raw.scope === "broadcast" || raw.scope === "instance") {
      result.scope = raw.scope;
    }
    if (typeof raw.correlate === "string") {
      result.correlate = raw.correlate;
    }
    return result;
  }

  // Control flow: emit - preserve event + optional payload / correlate / targetRun
  if (type === "emit") {
    const result: StepDraft = { id, slug, type, event: raw.event as string };
    if (raw.payload !== undefined) {
      result.payload = raw.payload;
    }
    if (typeof raw.correlate === "string") {
      result.correlate = raw.correlate;
    }
    if (typeof raw.targetRun === "string") {
      result.targetRun = raw.targetRun;
    }
    return result;
  }

  // Control flow: iterator - preserve items + optional as
  if (type === "iterator") {
    const result: StepDraft = { id, slug, type, items: raw.items as string };
    if (typeof raw.as === "string") {
      result.as = raw.as;
    }
    return result;
  }

  // Control flow: aggregator - preserve iterator reference
  if (type === "aggregator") {
    return { id, slug, type, iterator: raw.iterator as string };
  }

  // Human task: flat fields, copied as-is (deep copy so edits don't touch the source)
  if (type === "humanTask") {
    const { id: _id, slug: _s, type: _t, ...fields } = raw;
    return { id, slug, type, ...(JSON.parse(JSON.stringify(fields)) as Record<string, unknown>) };
  }

  // Custom extension step types: rebuild config from non-standard fields.
  // Only `id` (synthetic frontend id), `slug`, and `type` are non-config; every
  // other top-level field is part of the step's config (which is stored
  // flattened on the persisted step). Do NOT strip `input`/`output` here - those
  // are not reserved step fields, and stripping them would silently drop a
  // legitimate config field named `input` or `output` (e.g. the `chunk` step).
  // `outputSchema` is a reserved step field (edited in its own panel), not config.
  const { id: _id, slug: _s, type: _t, outputSchema, ...config } = raw;
  return {
    id,
    slug,
    type,
    config: Object.keys(config).length > 0 ? (config as Record<string, unknown>) : undefined,
    ...(outputSchema && typeof outputSchema === "object"
      ? { outputSchema: JSON.parse(JSON.stringify(outputSchema)) as OutputSchemaShorthand }
      : {}),
  };
}

/**
 * Returns a default step template for a given type (DAG: no nested branches).
 * The slug is left empty for the caller to assign.
 *
 * @param type - Built-in or custom step type.
 * @param customStepTypes - Extension step types, used to seed custom config.
 * @returns A fresh step draft with a new synthetic id.
 */
export function stepTemplate(type: string, customStepTypes: CustomStepTypeSchema[]): StepDraft {
  const id = nextStepId();
  switch (type) {
    case "agent":
      return { id, slug: "", type: "agent", prompt: "" };
    case "if":
      return { id, slug: "", type: "if", condition: { ref: "" } };
    case "case":
      return { id, slug: "", type: "case", match: "", paths: [] };
    case "waitFor":
      return { id, slug: "", type: "waitFor", event: "" };
    case "humanTask":
      return { id, slug: "", type: "humanTask", title: "", assignees: { users: [], roles: [] } };
    case "emit":
      return { id, slug: "", type: "emit", event: "" };
    case "iterator":
      return { id, slug: "", type: "iterator", items: "", as: "item" };
    case "aggregator":
      return { id, slug: "", type: "aggregator", iterator: "" };
    default: {
      // Custom extension step type. Seed the config with all supported
      // properties (schema defaults or type-appropriate empty values) so the
      // JSON editor shows the full property set immediately, instead of an
      // empty object until the user first edits a field in the form view.
      const configSchema = customStepTypes.find((st) => st.type === type)?.configSchema;
      if (configSchema) {
        return { id, slug: "", type, config: buildInitialValues(configSchema, undefined) };
      }
      return { id, slug: "", type };
    }
  }
}

/**
 * Seeds custom (extension) steps that have no config yet with their schema's
 * initial values. Built-in steps and steps that already carry a config pass
 * through untouched.
 *
 * @param steps - Draft steps, typically fresh from a builder operation.
 * @param customStepTypes - Extension step types with optional config schemas.
 * @returns The steps with config defaults applied.
 */
export function withConfigDefaults(steps: StepDraft[], customStepTypes: CustomStepTypeSchema[]): StepDraft[] {
  return steps.map((s) => {
    if (s.config !== undefined || BUILTIN_STEP_TYPES.some((bt) => bt.type === s.type)) return s;
    const schemaInfo = customStepTypes.find((st) => st.type === s.type);
    if (schemaInfo?.configSchema) {
      return { ...s, config: buildInitialValues(schemaInfo.configSchema, undefined) };
    }
    return s;
  });
}

/**
 * Extracts the branch label from a CF node's source handle ID.
 *
 * Handle ids are prefixed with the synthetic source node id (see
 * `ControlFlowNode.svelte`, which builds `<Handle id>` from the node id).
 *
 * @param sourceId - The edge's synthetic source node id.
 * @param sourceHandle - The SvelteFlow source handle id, or null/undefined.
 * @returns The branch label, or undefined for non-CF edges.
 */
export function branchFromHandle(sourceId: string, sourceHandle: string | null | undefined): string | undefined {
  if (!sourceHandle) return undefined;
  // if-node handles: "${id}-then" / "${id}-else"
  // case-node handles: "${id}-path-${key}" / "${id}-default"
  const pathPrefix = `${sourceId}-path-`;
  if (sourceHandle.startsWith(pathPrefix)) {
    return sourceHandle.slice(pathPrefix.length);
  }
  const prefix = `${sourceId}-`;
  if (sourceHandle.startsWith(prefix)) {
    return sourceHandle.slice(prefix.length);
  }
  return undefined;
}

/**
 * Translates the graph's SvelteFlow edges into the draft's DAG edges.
 *
 * Both the graph edges and the draft edges are id-based (source/target are the
 * steps' synthetic ids), so endpoints pass through unchanged; only synthetic
 * nodes (trigger, addStep) are filtered out. The `sourceHandle` encodes the
 * branch for CF nodes (see {@link branchFromHandle}).
 *
 * @param edges - Graph edges as reported by SvelteFlow.
 * @param stepIds - Synthetic ids of the draft's real steps.
 * @returns Draft edges between real steps.
 */
export function graphEdgesToDraftEdges(
  edges: Array<{ source: string; target: string; sourceHandle?: string | null }>,
  stepIds: Set<string>,
): EdgeDraft[] {
  const draftEdges: EdgeDraft[] = [];
  for (const edge of edges) {
    // Skip edges to/from synthetic nodes (trigger, addStep).
    if (!stepIds.has(edge.source) || !stepIds.has(edge.target)) continue;

    const branch = branchFromHandle(edge.source, edge.sourceHandle);
    draftEdges.push(
      branch !== undefined ? { from: edge.source, to: edge.target, branch } : { from: edge.source, to: edge.target },
    );
  }
  return draftEdges;
}

/**
 * Whether a message is a "step is not connected" error for any slug, in the
 * active locale (the slug may have changed since the message was set).
 *
 * @param message - Validation message
 * @returns True for a connectivity error
 */
function isDisconnectedMessage(message: string): boolean {
  const [prefix = "", suffix = ""] = t("validation.disconnected", { slug: "\u0000" }).split("\u0000");
  return message.length > prefix.length + suffix.length && message.startsWith(prefix) && message.endsWith(suffix);
}

/**
 * Re-evaluates the "step is not connected" validation errors against the
 * draft's current edges.
 *
 * Only touches errors whose message is the disconnected-step message, so a
 * genuine slug-format error sharing the same `steps[i].slug` key is preserved.
 * Newly-orphaned steps gain the error; reconnected steps lose it.
 *
 * @param draft - The draft whose steps/edges are evaluated.
 * @param errors - Current validation errors (not mutated).
 * @returns A new error map.
 */
export function reconcileConnectivityErrors(draft: WorkflowDraft, errors: Map<string, string>): Map<string, string> {
  const orphaned = new Set(computeOrphanedStepIndices(draft));
  const next = new Map(errors);

  for (let i = 0; i < draft.steps.length; i++) {
    const key = `steps[${i}].slug`;
    const current = next.get(key);
    // A connectivity error for this key, regardless of the slug embedded in the
    // message (the slug may have changed since it was set).
    const isConnectivityError = current !== undefined && isDisconnectedMessage(current);

    if (orphaned.has(i)) {
      // Add/refresh the connectivity error, but never clobber a genuine
      // slug-format error already occupying this key.
      if (current === undefined || isConnectivityError) {
        next.set(key, disconnectedStepError(draft.steps[i]!.slug));
      }
    } else if (isConnectivityError) {
      // Step is connected now and the only error here was connectivity.
      next.delete(key);
    }
  }

  return next;
}

/**
 * Validation errors to keep after a step removal. Step-indexed errors
 * (`steps[N].*`) are dropped since indices shift; they are re-populated by the
 * next validation pass. A `steps.removeWarning` is set if another step's prompt
 * still references the removed slug.
 *
 * @param errors - Errors before removal.
 * @param remainingSteps - Draft steps after removal.
 * @param removedSlug - Slug of the step the user removed.
 * @returns A new error map.
 */
export function errorsAfterStepRemoval(
  errors: Map<string, string>,
  remainingSteps: StepDraft[],
  removedSlug: string,
): Map<string, string> {
  const next = new Map<string, string>();
  for (const [key, val] of errors) {
    if (!/^steps\[\d+\]\./.test(key)) next.set(key, val);
  }

  if (removedSlug) {
    const referencingSteps = remainingSteps.filter((s) => s.prompt?.includes(`steps.${removedSlug}.`));
    if (referencingSteps.length > 0) {
      const slugs = referencingSteps.map((s) => s.slug || t("validation.unnamed")).join(", ");
      next.set("steps.removeWarning", t("validation.referencedIn", { slug: removedSlug, steps: slugs }));
    } else {
      next.delete("steps.removeWarning");
    }
  }

  return next;
}

/**
 * Splits the backend's `details` string (individual validation failures joined
 * by "; ") into a list for display.
 *
 * @param details - The raw details string, if any.
 * @returns Trimmed, non-empty detail lines.
 */
export function parseSaveErrorDetails(details: string | undefined): string[] {
  if (!details) return [];
  return details
    .split("; ")
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
}

/**
 * Builds an edit draft from a loaded workflow, deep-copying everything the
 * editor mutates.
 *
 * @param workflow - The loaded workflow
 * @returns The edit draft
 */
export function draftFromWorkflow(workflow: WorkflowDetail): WorkflowDraft {
  return {
    name: workflow.name,
    description: workflow.description ?? "",
    group: workflow.group ?? "",
    trigger: {
      type: workflow.trigger.type,
      ref: workflow.trigger.ref ?? "",
      ...(workflow.trigger.portal ? { portal: JSON.parse(JSON.stringify(workflow.trigger.portal)) } : {}),
      ...(workflow.trigger.outputSchema
        ? { outputSchema: JSON.parse(JSON.stringify(workflow.trigger.outputSchema)) }
        : {}),
    },
    enabled: workflow.enabled ?? true,
    steps: workflow.steps.map((s) => toStepDraft({ ...s })),
    edges: (workflow.edges ?? []).map((e) => ({ ...e })),
  };
}

/**
 * Returns the first free placeholder slug `step-<n>`, starting at
 * `n = taken.size + 1`.
 *
 * @param taken - Slugs already in use (draft slugs plus ones handed out but not yet committed)
 * @returns An unused slug
 */
export function uniqueStepSlug(taken: Set<string>): string {
  let n = taken.size + 1;
  let candidate = `step-${n}`;
  while (taken.has(candidate)) {
    n++;
    candidate = `step-${n}`;
  }
  return candidate;
}

/**
 * Recomputes the slug errors after the slug of step `index` changed to
 * `value`: the format error of that step, and the duplicate errors of every
 * step sharing a slug (set for new duplicates, cleared once resolved).
 *
 * @param errors - Current validation errors
 * @param steps - Draft steps (with the edit applied)
 * @param index - Index of the edited step
 * @param value - The new slug
 * @returns The updated error map
 */
export function slugErrorsAfterEdit(
  errors: Map<string, string>,
  steps: StepDraft[],
  index: number,
  value: string,
): Map<string, string> {
  const next = new Map(errors);
  const duplicateMessage = t("workflows.slugUnique");
  const slugResult = validateSlug(value);
  if (!slugResult.valid && slugResult.error) {
    next.set(`steps[${index}].slug`, slugResult.error);
    return next;
  }
  next.delete(`steps[${index}].slug`);
  if (!validateStepSlugsUnique(steps.map((s) => s.slug)).valid) {
    const dupeIndexes = steps.map((s, i) => (s.slug === value ? i : -1)).filter((i) => i >= 0);
    if (dupeIndexes.length > 1) {
      for (const i of dupeIndexes) next.set(`steps[${i}].slug`, duplicateMessage);
    }
  } else {
    // No duplicates left: clear the duplicate errors that are resolved.
    for (let i = 0; i < steps.length; i++) {
      if (next.get(`steps[${i}].slug`) !== duplicateMessage) continue;
      const otherSlugs = steps.map((s, j) => (j !== i ? s.slug : null)).filter(Boolean);
      if (!otherSlugs.includes(steps[i]!.slug)) next.delete(`steps[${i}].slug`);
    }
  }
  return next;
}

/**
 * Synthetic node ids of draft steps that should show an error badge: steps with
 * a live validation error (`steps[<index>].…`) and steps a backend warning
 * names by slug. Matching on the id keeps the badge on the right node while a
 * slug is temporarily empty or duplicated; warnings for unknown slugs are dropped.
 *
 * @param draft - The edit draft
 * @param errors - Live validation errors
 * @param warnings - Backend warnings for the draft (or the saved workflow until analyzed)
 * @returns The node ids to badge
 */
export function draftErrorNodeIds(
  draft: WorkflowDraft,
  errors: Map<string, string>,
  warnings: WorkflowWarning[],
): Set<string> {
  const ids = new Set<string>();
  for (const key of errors.keys()) {
    const match = key.match(/^steps\[(\d+)\]\./);
    if (!match) continue;
    const id = draft.steps[Number.parseInt(match[1]!, 10)]?.id;
    if (id) ids.add(id);
  }
  const slugToId = new Map(draft.steps.map((s) => [s.slug, s.id]));
  for (const w of warnings) {
    const id = slugToId.get(w.stepSlug);
    if (id) ids.add(id);
  }
  return ids;
}
