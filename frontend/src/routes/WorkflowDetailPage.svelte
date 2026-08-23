<script lang="ts">
import type { Edge } from "@xyflow/svelte";
import { Tabs } from "bits-ui";
import ArrowCounterClockwiseIcon from "phosphor-svelte/lib/ArrowCounterClockwiseIcon";
import CaretLeftIcon from "phosphor-svelte/lib/CaretLeftIcon";
import CaretRightIcon from "phosphor-svelte/lib/CaretRightIcon";
import PencilSimpleIcon from "phosphor-svelte/lib/PencilSimpleIcon";
import PlayIcon from "phosphor-svelte/lib/PlayIcon";
import TrashIcon from "phosphor-svelte/lib/TrashIcon";
import WarningIcon from "phosphor-svelte/lib/WarningIcon";
import { onDestroy, onMount } from "svelte";
import { slide } from "svelte/transition";
import { authFetch } from "$lib/auth";
import LoadingIndicator from "$lib/components/LoadingIndicator.svelte";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "$lib/components/ui/table";
import { extensions } from "$lib/extensionStore";
import { visualForStepType } from "$lib/nodeVisuals";
import type { OutputSchemas } from "$lib/templateScope";
import { aggregateStepStatus, formatTimestamp, isRunCancellable, statusVariant } from "$lib/utils";
import { type WorkflowEvent, workflowStore } from "$lib/workflowRunStore.svelte";
import {
  computeOrphanedStepIndices,
  disconnectedStepError,
  type EdgeDraft,
  type StepDraft,
  serializeWorkflowDraft,
  validateSlug,
  validateStepSlugsUnique,
  validateWorkflowDraft,
  type WorkflowDraft,
} from "$lib/workflowValidation";
import StatusDot from "../components/StatusDot.svelte";
import WorkflowGraph from "../components/WorkflowGraph.svelte";
import WorkflowStepSidebar from "../components/WorkflowStepSidebar.svelte";
import { navigate, route } from "../router";

interface StepDef {
  /**
   * Stable synthetic node identity for the editor graph, independent of the
   * user-editable slug. Minted client-side on load/add and never persisted.
   */
  id: string;
  slug: string;
  type: string;
  prompt?: string;
  tools?: string[];
  skills?: string[];
  url?: string;
  method?: string;
  body?: string;
  input?: string;
  output?: string;
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
 */
function nextStepId(): string {
  stepIdCounter += 1;
  return `node-${stepIdCounter}`;
}

interface WarningsDef {
  stepSlug: string;
  field: string;
  message: string;
}

interface WorkflowDetail {
  name: string;
  description?: string;
  trigger: { type: string; ref?: string };
  enabled?: boolean;
  /** DAG steps normalized to an array with slug + synthetic id (array editor). */
  steps: StepDef[];
  /**
   * DAG edges connecting steps by SYNTHETIC ID (not slug). Converted from the
   * slug-based API representation in `normalizeWorkflow` and back to slugs in
   * `serializeWorkflowDraft`. Id-based edges survive slug edits/collisions.
   */
  edges: Array<{ from: string; to: string; branch?: string }>;
  warnings: Array<WarningsDef>;
  outputSchemas?: OutputSchemas;
  runs: Array<{
    runId: string;
    status: string;
    startedAt: number;
    completedAt?: number;
    steps: Array<{ slug: string; status: string; jobId: string }>;
  }>;
}

/**
 * Normalizes a DAG workflow API response (steps map + edges array) into the
 * page's internal shape (steps array with slug + edges array).
 */
function normalizeWorkflow(raw: Record<string, unknown>): WorkflowDetail {
  const stepsMap = (raw.steps ?? {}) as Record<string, Record<string, unknown>>;
  const stepsArray = Object.entries(stepsMap).map(([slug, s]) => ({ id: nextStepId(), slug, ...s })) as StepDef[];

  // Persisted edges reference steps by slug. Convert them to the internal
  // id-based representation so the editor tracks connections by stable identity
  // (slugs are user-editable and can collide/empty mid-edit). Slugs are unique
  // in a saved definition, so this mapping is unambiguous at load time.
  const slugToId = new Map(stepsArray.map((s) => [s.slug, s.id]));
  const rawEdges = (raw.edges ?? []) as Array<{ from: string; to: string; branch?: string }>;
  const edges = rawEdges
    .map((e) => {
      const from = slugToId.get(e.from);
      const to = slugToId.get(e.to);
      if (from === undefined || to === undefined) return null;
      return e.branch !== undefined ? { from, to, branch: e.branch } : { from, to };
    })
    .filter((e): e is { from: string; to: string; branch?: string } => e !== null);

  return {
    ...(raw as Omit<WorkflowDetail, "steps" | "edges">),
    steps: stepsArray,
    edges,
  };
}

let workflow = $state<WorkflowDetail | null>(null);
let loading = $state(true);
let error = $state<string | null>(null);
let selectedStep = $state<StepDef | null>(null);
let sidebarOpen = $state(false);
let activeTab = $state("definition");

// Edit mode state
let editMode = $state(false);
let editDraft = $state<WorkflowDraft | null>(null);
let fitViewTrigger = $state(0);
let saving = $state(false);
let saveError = $state<string | null>(null);
/**
 * Per-item detail lines accompanying {@link saveError}, parsed from the
 * backend's `details` string (e.g. each invalid edge/branch on a case node).
 * Rendered as a bulleted list under the main error message.
 */
let saveErrorDetails = $state<string[]>([]);
let validationErrors = $state<Map<string, string>>(new Map());
/** Whether to show the raw JSON editor instead of the schema-driven form for custom step types. */
let editAsJson = $state(false);
/** Whether to show raw JSON in read-only view mode. */
let viewAsJson = $state(false);

// Meta endpoint state for tools/skills
let availableTools = $state<string[]>([]);
let availableSkills = $state<string[]>([]);
let availableTriggerRefs = $state<Record<string, string[]>>({
  webhook: [],
  schedule: [],
  filewatcher: [],
});
let metaLoading = $state(false);

// Cached secret keys for template autocomplete
let cachedSecretKeys = $state<string[]>([]);

/** Custom step types registered by extensions, derived from the extension store. */
let customStepTypes = $derived(
  $extensions.filter((ext) => ext.enabled && ext.ui?.stepTypes?.length).flatMap((ext) => ext.ui!.stepTypes!),
);

/** Fetch available tools and skills from meta endpoints. */
async function fetchMeta() {
  metaLoading = true;
  try {
    const [toolsRes, skillsRes, triggersRes] = await Promise.all([
      authFetch("/ext/workflows/meta/tools"),
      authFetch("/ext/workflows/meta/skills"),
      authFetch("/ext/workflows/meta/triggers"),
    ]);
    availableTools = toolsRes.ok ? await toolsRes.json() : [];
    availableSkills = skillsRes.ok ? await skillsRes.json() : [];
    availableTriggerRefs = triggersRes.ok ? await triggersRes.json() : { webhook: [], schedule: [], filewatcher: [] };
  } catch {
    availableTools = [];
    availableSkills = [];
    availableTriggerRefs = { webhook: [], schedule: [], filewatcher: [] };
  } finally {
    metaLoading = false;
  }
}

/** Prefetch secret keys for template autocomplete. Fails silently. */
async function fetchSecretKeys(): Promise<void> {
  try {
    const res = await authFetch("/api/secrets");
    if (res.ok) {
      const data: { secrets: Array<{ key: string }> } = await res.json();
      cachedSecretKeys = data.secrets.map((s) => s.key);
    } else {
      cachedSecretKeys = [];
    }
  } catch {
    cachedSecretKeys = [];
  }
}

/**
 * Converts a raw workflow step (as loaded from backend) into a StepDraft.
 * For custom extension step types, extracts non-standard fields into a nested
 * `config` object so frontend validation can check them properly.
 * For control-flow steps, recursively transforms nested branch steps.
 */
function toStepDraft(s: StepDef | Record<string, unknown>): StepDraft {
  const raw = s as Record<string, unknown>;
  const slug = raw.slug as string;
  const type = raw.type as string;
  // Preserve the synthetic node id from the source step, or mint one if absent
  // (e.g. a step that somehow lacks it). This keeps graph node identity stable
  // between view mode and edit mode.
  const id = (raw.id as string | undefined) ?? nextStepId();

  // Agent steps: extract known fields
  if (type === "agent") {
    const { prompt, tools, skills } = raw as { prompt?: string; tools?: string[]; skills?: string[] };
    return {
      id,
      slug,
      type,
      prompt,
      tools: tools ? [...tools] : undefined,
      skills: skills ? [...skills] : undefined,
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

  // Control flow: waitFor
  if (type === "waitFor") {
    return { id, slug, type, event: raw.event as string };
  }

  // Control flow: emit
  if (type === "emit") {
    return { id, slug, type, event: raw.event as string };
  }

  // Custom extension step types: rebuild config from non-standard fields
  const { id: _id, slug: _s, type: _t, input: _i, output: _o, ...config } = raw;
  return {
    id,
    slug,
    type,
    config: Object.keys(config).length > 0 ? (config as Record<string, unknown>) : undefined,
  };
}

/** Enter edit mode with a deep copy of the current workflow data. */
function enterEditMode() {
  if (!workflow) return;
  editDraft = {
    name: workflow.name,
    description: workflow.description ?? "",
    trigger: { type: workflow.trigger.type, ref: workflow.trigger.ref ?? "" },
    enabled: workflow.enabled ?? true,
    steps: workflow.steps.map(toStepDraft),
    edges: (workflow.edges ?? []).map((e) => ({ ...e })),
  };
  saveError = null;
  saveErrorDetails = [];
  validationErrors = new Map();
  editMode = true;
  fitViewTrigger++;
  fetchMeta();
  fetchSecretKeys();
}

/** Cancel edit mode, discard changes. */
function cancelEdit() {
  editMode = false;
  editDraft = null;
  saveError = null;
  saveErrorDetails = [];
  validationErrors = new Map();
  editAsJson = false;
  viewAsJson = false;
  fitViewTrigger++;
  // Re-point sidebar to the original workflow step data
  if (sidebarOpen && selectedStepIndex >= 0 && workflow?.steps[selectedStepIndex]) {
    selectedStep = workflow.steps[selectedStepIndex] as StepDef;
  } else {
    sidebarOpen = false;
    selectedStep = null;
    selectedStepIndex = -1;
  }
}

/** Get the draft step corresponding to the currently selected step. */
let selectedStepIndex = $state(-1);
/** Whether the trigger node is currently selected (sidebar shows trigger config). */
let triggerSelected = $state(false);

let editDraftStep = $derived.by(() => {
  if (!editMode || !editDraft || !selectedStep) return null;
  return editDraft.steps[selectedStepIndex] ?? null;
});

/** Update a field on the currently selected draft step. */
function updateDraftStep(index: number, updater: (step: StepDraft) => void) {
  if (!editDraft || index < 0 || index >= editDraft.steps.length) return;
  editDraft = {
    ...editDraft,
    steps: editDraft.steps.map((s, i) => {
      if (i !== index) return s;
      const copy = { ...s };
      updater(copy);
      return copy;
    }),
  };
}

/**
 * Generates a unique placeholder slug for a newly added step
 * (e.g. "step-1", "step-2", ...) that doesn't collide with existing slugs.
 */
function nextStepSlug(): string {
  if (!editDraft) return "step-1";
  const existing = new Set(editDraft.steps.map((s) => s.slug));
  let n = editDraft.steps.length + 1;
  let candidate = `step-${n}`;
  while (existing.has(candidate)) {
    n++;
    candidate = `step-${n}`;
  }
  return candidate;
}

/**
 * Add a new step to the draft with the given type (defaults to "agent").
 *
 * When `branchContext` is provided, the new step is wired into the graph:
 * - Main-chain tail or populated branch (`lastNodeId` set): append the new step
 *   sequentially after the source node (`lastNodeId -> newStep`). This is what
 *   the root "+" button uses (source = tail of the main chain), and what a
 *   branch "+" uses when the branch already has steps. Using a labeled branch
 *   edge here would give the branch two outgoing edges and corrupt the graph.
 * - Empty branch (`lastNodeId` null): connect the CF node to the new step via
 *   the labeled branch edge (`parentNodeId -> newStep [branch]`).
 *
 * Without `branchContext` (e.g. the very first step of an empty workflow, which
 * has no source node), the step is added unconnected; the trigger edge or a
 * manual connection wires it up.
 */
function addStep(
  type: string = "agent",
  branchContext?: { parentNodeId: string; branch?: string; lastNodeId: string | null },
) {
  if (!editDraft) return;

  const template = stepTemplate(type);
  template.slug = nextStepSlug();

  // Draft edges are id-based; branchContext ids and the new step's id are both
  // synthetic ids, so edges can be written directly with no slug translation.
  const newStepId = template.id!;
  const newEdges = [...editDraft.edges];
  if (branchContext) {
    if (branchContext.lastNodeId) {
      // Main-chain tail or populated branch: append after the source node via a
      // plain sequential edge so the new step stays attached to the graph.
      newEdges.push({ from: branchContext.lastNodeId, to: newStepId });
    } else if (branchContext.branch) {
      // Empty branch: connect the CF node to the new step via a labeled edge.
      newEdges.push({ from: branchContext.parentNodeId, to: newStepId, branch: branchContext.branch });
    }
  }

  editDraft = {
    ...editDraft,
    steps: [...editDraft.steps, template],
    edges: newEdges,
  };

  const newIndex = editDraft.steps.length - 1;
  const newErrors = new Map(validationErrors);
  if (type === "agent") {
    newErrors.set(`steps[${newIndex}].prompt`, "Prompt is required for agent steps");
  }
  validationErrors = newErrors;

  // Growing the graph with a new node is an intentional structural
  // change, so re-fit the view to bring the new step into frame. (Edge draws
  // do NOT bump this, so connecting nodes no longer re-fits the canvas.)
  fitViewTrigger++;

  // Auto-select the new step in the sidebar
  selectedStep = editDraft.steps[newIndex] as StepDef;
  selectedStepIndex = newIndex;
  triggerSelected = false;
  sidebarOpen = true;
}

/** Returns a default step template for a given type (DAG: no nested branches). */
function stepTemplate(type: string): StepDraft {
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
    case "emit":
      return { id, slug: "", type: "emit", event: "" };
    default:
      // Custom extension step type
      return { id, slug: "", type };
  }
}

/**
 * Translates the graph's SvelteFlow edges into the draft's DAG edges.
 *
 * Both the graph edges and the draft edges are id-based (source/target are the
 * steps' synthetic ids), so endpoints pass through unchanged; only synthetic
 * nodes (trigger, addStep) are filtered out. The `sourceHandle` encodes the
 * branch for CF nodes, prefixed with the synthetic source id:
 *  - if:    `${id}-then` / `${id}-else`
 *  - case:  `${id}-path-${key}` / `${id}-default`
 * Non-CF edges have no branch.
 */
function handleEdgesChange(edges: Edge[]) {
  if (!editDraft) return;

  const stepIds = new Set(editDraft.steps.map((s) => s.id));
  const draftEdges: EdgeDraft[] = [];

  for (const edge of edges) {
    // Skip edges to/from synthetic nodes (trigger, addStep).
    if (!stepIds.has(edge.source) || !stepIds.has(edge.target)) continue;

    const branch = branchFromHandle(edge.source, edge.sourceHandle);
    draftEdges.push(
      branch !== undefined ? { from: edge.source, to: edge.target, branch } : { from: edge.source, to: edge.target },
    );
  }

  editDraft = { ...editDraft, edges: draftEdges };

  // Connectivity errors are otherwise only recomputed on save, so drawing an
  // edge that reconnects an orphaned step would leave its stale "not connected"
  // error (and a disabled Save button) hanging. Reconcile that error class here
  // against the updated edge set.
  reconcileConnectivityErrors();
}

/**
 * Re-evaluates the "step is not connected" validation errors against the
 * current draft edges and updates {@link validationErrors} in place.
 *
 * Only touches errors whose message is the disconnected-step message, so a
 * genuine slug-format error sharing the same `steps[i].slug` key is preserved.
 * Newly-orphaned steps gain the error; reconnected steps lose it.
 */
function reconcileConnectivityErrors() {
  if (!editDraft) return;
  const orphaned = new Set(computeOrphanedStepIndices(editDraft));
  const next = new Map(validationErrors);

  for (let i = 0; i < editDraft.steps.length; i++) {
    const key = `steps[${i}].slug`;
    const current = next.get(key);
    // A connectivity error for this key, regardless of the slug embedded in the
    // message (the slug may have changed since it was set).
    const isConnectivityError = current?.endsWith("is not connected to any other step");

    if (orphaned.has(i)) {
      // Add/refresh the connectivity error, but never clobber a genuine
      // slug-format error already occupying this key.
      if (current === undefined || isConnectivityError) {
        next.set(key, disconnectedStepError(editDraft.steps[i]!.slug));
      }
    } else if (isConnectivityError) {
      // Step is connected now and the only error here was connectivity.
      next.delete(key);
    }
  }

  validationErrors = next;
}

/**
 * Extracts the branch label from a CF node's source handle ID.
 *
 * Handle ids are prefixed with the synthetic source node id (see
 * `ControlFlowNode.svelte`, which builds `<Handle id>` from the node id).
 * Returns undefined for non-CF edges (no branch).
 *
 * @param sourceId - The edge's synthetic source node id.
 * @param sourceHandle - The SvelteFlow source handle id, or null/undefined.
 */
function branchFromHandle(sourceId: string, sourceHandle: string | null | undefined): string | undefined {
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

/** Remove a step at the given index. Returns false if removal was prevented. */
function removeStep(id: string) {
  if (!editDraft) return;
  if (editDraft.steps.length <= 1) return; // Prevent removal of last step

  // Resolve the step by its stable synthetic id. The index is derived here
  // purely to re-key the index-based validation-error map below; identity and
  // edge cleanup are id-based so they survive slug edits and reordering.
  const index = editDraft.steps.findIndex((s) => s.id === id);
  if (index < 0) return;

  const removedSlug = editDraft.steps[index].slug;
  const removedId = id;
  editDraft = {
    ...editDraft,
    steps: editDraft.steps.filter((_, i) => i !== index),
    // Drop any edges touching the removed step (edges are id-based).
    edges: editDraft.edges.filter((e) => e.from !== removedId && e.to !== removedId),
  };

  // Clean up validation errors for the removed step and re-index subsequent steps
  const newErrors = new Map<string, string>();
  for (const [key, val] of validationErrors) {
    const stepMatch = key.match(/^steps\[(\d+)\]\.(.+)$/);
    if (stepMatch) {
      const stepIdx = Number.parseInt(stepMatch[1], 10);
      const field = stepMatch[2];
      if (stepIdx < index) {
        newErrors.set(key, val);
      } else if (stepIdx > index) {
        newErrors.set(`steps[${stepIdx - 1}].${field}`, val);
      }
      // Skip the removed index
    } else {
      newErrors.set(key, val);
    }
  }

  // Check if the removed step is referenced in other steps' templates
  if (removedSlug) {
    const referencingSteps = editDraft.steps.filter((s) => s.prompt?.includes(`steps.${removedSlug}.`));
    if (referencingSteps.length > 0) {
      const slugs = referencingSteps.map((s) => s.slug || "(unnamed)").join(", ");
      newErrors.set("steps.removeWarning", `Step "${removedSlug}" is referenced in: ${slugs}`);
    } else {
      newErrors.delete("steps.removeWarning");
    }
  }

  validationErrors = newErrors;
}

/**
 * Remove one or more steps identified by their synthetic node id.
 *
 * Backs SvelteFlow's native node deletion (Backspace/Delete key), which reports
 * the removed nodes by id. Ids are stable across the splices {@link removeStep}
 * performs, so they can be removed in a plain loop with no index bookkeeping.
 * The last-step guard in {@link removeStep} still applies, so the final step
 * cannot be deleted.
 *
 * @param ids - Synthetic node ids of the steps to remove.
 */
function removeStepsByIds(ids: string[]) {
  if (!editDraft || ids.length === 0) return;
  // If the currently selected step is being deleted, close the sidebar first so
  // it does not linger on a removed step.
  const selectedId = selectedStepIndex >= 0 ? editDraft.steps[selectedStepIndex]?.id : undefined;
  if (selectedId && ids.includes(selectedId)) {
    closeSidebar();
  }
  for (const id of ids) {
    removeStep(id);
  }
}

/** Validate a step slug with debounced inline feedback. */
let stepSlugTimeouts: Map<number, ReturnType<typeof setTimeout>> = new Map();

function onStepSlugInput(index: number, value: string) {
  if (!editDraft) return;
  // Edges are id-based and the step's id is stable, so a slug edit never touches
  // edges: connections survive renames, clears, and duplicate slugs untouched.
  editDraft = {
    ...editDraft,
    steps: editDraft.steps.map((s, i) => (i === index ? { ...s, slug: value } : s)),
  };

  const existing = stepSlugTimeouts.get(index);
  if (existing) clearTimeout(existing);

  stepSlugTimeouts.set(
    index,
    setTimeout(() => {
      const newErrors = new Map(validationErrors);
      const slugResult = validateSlug(value);
      if (!slugResult.valid && slugResult.error) {
        newErrors.set(`steps[${index}].slug`, slugResult.error);
      } else {
        newErrors.delete(`steps[${index}].slug`);
        // Check for duplicates
        const allSlugs = editDraft!.steps.map((s) => s.slug);
        const duplicateCheck = validateStepSlugsUnique(allSlugs);
        if (!duplicateCheck.valid && duplicateCheck.error) {
          // Find which indexes are duplicates of this slug
          const dupeIndexes = editDraft!.steps.map((s, i) => (s.slug === value ? i : -1)).filter((i) => i >= 0);
          if (dupeIndexes.length > 1) {
            for (const di of dupeIndexes) {
              newErrors.set(`steps[${di}].slug`, "Step slug must be unique");
            }
          }
        } else {
          // Clear duplicate errors for all steps with this slug if resolved
          for (let i = 0; i < editDraft!.steps.length; i++) {
            if (newErrors.get(`steps[${i}].slug`) === "Step slug must be unique") {
              // Re-validate: is this slug still duplicated?
              const otherSlugs = editDraft!.steps.map((s, j) => (j !== i ? s.slug : null)).filter(Boolean);
              if (!otherSlugs.includes(editDraft!.steps[i].slug)) {
                newErrors.delete(`steps[${i}].slug`);
              }
            }
          }
        }
      }
      validationErrors = newErrors;
    }, 300),
  );
}

/** Handle step type change from the sidebar (clears config and related validation). */
function handleStepTypeChange(index: number, newType: string) {
  if (!editDraft) return;
  editDraft = {
    ...editDraft,
    steps: editDraft.steps.map((s, i) => (i === index ? { ...s, type: newType, config: undefined } : s)),
  };
  const newErrors = new Map(validationErrors);
  if (newType === "agent") {
    newErrors.delete(`steps[${index}].prompt`);
  }
  validationErrors = newErrors;
}

/** Save the edited workflow. */
async function saveWorkflow() {
  if (!editDraft || !workflow) return;

  // Run full validation (edges are explicit in the draft — no reordering needed)
  const errors = validateWorkflowDraft(editDraft, customStepTypes);
  if (errors.size > 0) {
    validationErrors = errors;
    return;
  }

  saving = true;
  saveError = null;
  saveErrorDetails = [];

  try {
    const res = await authFetch(`/ext/workflows/${workflow.name}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(serializeWorkflowDraft(editDraft)),
    });

    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string; details?: string } | null;
      saveError = data?.error ?? `HTTP ${res.status}`;
      // The backend may attach a `details` string enumerating each specific
      // validation failure, separated by "; ". Surface them as a list so the
      // user can see exactly which edges/branches are invalid, not just the
      // generic top-level message.
      saveErrorDetails = data?.details
        ? data.details
            .split("; ")
            .map((d) => d.trim())
            .filter((d) => d.length > 0)
        : [];
      return;
    }

    // Re-fetch workflow to refresh the view
    await fetchWorkflow();
    editMode = false;
    editDraft = null;
    validationErrors = new Map();
    fitViewTrigger++;
    // Update sidebar step reference to fresh data
    if (sidebarOpen && selectedStepIndex >= 0 && workflow?.steps[selectedStepIndex]) {
      selectedStep = workflow.steps[selectedStepIndex] as StepDef;
    } else {
      sidebarOpen = false;
      selectedStep = null;
      selectedStepIndex = -1;
    }
  } catch (err) {
    saveError = err instanceof Error ? err.message : "Failed to save. Please try again.";
  } finally {
    saving = false;
  }
}

let saveDisabled = $derived(saving || validationErrors.size > 0);

/**
 * Whether the template-issues banner is expanded to show the individual
 * warnings. Collapsed by default so the banner stays compact; the count in the
 * header still communicates that issues exist.
 */
let warningsExpanded = $state(false);

/**
 * Slugs of steps that have a template/config warning, derived from the
 * workflow's `warnings`. Passed to the graph so the offending nodes render a
 * red error badge. Only meaningful in read-only view mode (warnings are not
 * produced for the in-progress edit draft).
 */
let errorSlugs = $derived(new Set((workflow?.warnings ?? []).map((w) => w.stepSlug)));

/**
 * Synthetic node ids of draft steps that should render an error badge in edit
 * mode. Combines two sources:
 *
 *  1. Live draft `validationErrors` (keys like `steps[2].slug` or
 *     `steps[2].config.url`); the `steps[<index>]` segment maps to that step's
 *     synthetic id. These update as the user types.
 *  2. The backend template `warnings` carried over from the loaded workflow,
 *     mapped from their `stepSlug` to the matching draft step's synthetic id so
 *     the same badges shown in view mode persist into edit mode (they don't
 *     vanish just because editing started). A warning whose slug no longer
 *     matches any draft step (e.g. the step was renamed) is simply dropped.
 *
 * Matching on the id (not the slug) keeps the badge on the right node even when
 * a slug is temporarily empty or duplicated mid-edit. Empty outside edit mode.
 */
let errorNodeIds = $derived.by(() => {
  if (!editMode || !editDraft) return new Set<string>();
  const ids = new Set<string>();

  // 1. Live draft validation errors, keyed by step index -> synthetic id.
  for (const key of validationErrors.keys()) {
    const match = key.match(/^steps\[(\d+)\]\./);
    if (!match) continue;
    const index = Number.parseInt(match[1]!, 10);
    const id = editDraft.steps[index]?.id;
    if (id) ids.add(id);
  }

  // 2. Backend template warnings, mapped slug -> synthetic id.
  const slugToId = new Map(editDraft.steps.map((s) => [s.slug, s.id]));
  for (const w of workflow?.warnings ?? []) {
    const id = slugToId.get(w.stepSlug);
    if (id) ids.add(id);
  }

  return ids;
});

const RUNS_PAGE_SIZE = 10;

let runsPage = $state(1);
let runsTotalPages = $derived(Math.max(1, Math.ceil((workflow?.runs.length ?? 0) / RUNS_PAGE_SIZE)));
let paginatedRuns = $derived((workflow?.runs ?? []).slice((runsPage - 1) * RUNS_PAGE_SIZE, runsPage * RUNS_PAGE_SIZE));

// Clamp page if runs disappear
$effect(() => {
  if (runsPage > runsTotalPages) {
    runsPage = runsTotalPages;
  }
});

const name = $derived((route.params as { name?: string }).name ?? "");

async function fetchWorkflow() {
  if (!name) return;
  loading = true;
  error = null;
  try {
    const res = await authFetch(`/ext/workflows/${name}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    workflow = normalizeWorkflow(await res.json());
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load workflow";
  } finally {
    loading = false;
  }
}

async function triggerRun() {
  if (!name) return;
  try {
    const res = await authFetch(`/ext/workflows/run/${name}`, {
      method: "POST",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = (await res.json()) as { workflowRunId: string };

    navigate("/workflows/:name/runs/:runId", {
      params: { name: `${name}`, runId: `${result.workflowRunId}` },
    });
  } catch (err) {
    console.error("Failed to trigger workflow:", err);
  }
}

let confirmingDelete = $state(false);

async function deleteWorkflow() {
  if (!name) return;
  try {
    const res = await authFetch(`/ext/workflows/${name}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    navigate("/workflows");
  } catch (err) {
    console.error("Failed to delete workflow:", err);
  }
}

async function retryRun(runId: string) {
  try {
    const res = await authFetch(`/ext/workflows/runs/${runId}/retry`, { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error("Failed to retry workflow run:", err);
  }
}

let cancellingRunId = $state<string | null>(null);

async function cancelRun(runId: string) {
  cancellingRunId = runId;
  try {
    const res = await authFetch(`/ext/workflows/runs/${runId}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await fetchWorkflow();
  } catch (err) {
    console.error("Failed to cancel workflow run:", err);
  } finally {
    cancellingRunId = null;
  }
}

function onStepClick(_step: { slug: string; type: string }, index: number) {
  const stepIndex = index;
  const def = editDraft ? editDraft.steps[stepIndex] : workflow?.steps[stepIndex];
  if (!def) return;

  if (selectedStepIndex === stepIndex && sidebarOpen && !triggerSelected) {
    closeSidebar();
    return;
  }

  triggerSelected = false;
  selectedStep = def as StepDef;
  selectedStepIndex = stepIndex;
  sidebarOpen = true;
  viewAsJson = false;
}

function onTriggerClick() {
  if (triggerSelected && sidebarOpen) {
    closeSidebar();
    return;
  }

  triggerSelected = true;
  selectedStep = null;
  selectedStepIndex = -1;
  sidebarOpen = true;
  viewAsJson = false;
}

function closeSidebar() {
  sidebarOpen = false;
  setTimeout(() => {
    if (!sidebarOpen) {
      selectedStep = null;
      triggerSelected = false;
    }
  }, 200);
}

$effect(() => {
  fetchWorkflow();
});

/** Handle real-time workflow events from the central store. */
function handleWorkflowEvent(msg: WorkflowEvent) {
  if (!workflow) return;

  if (msg.type === "workflow_started" && msg.workflowName === name) {
    const newRun = {
      runId: msg.workflowRunId,
      status: "queued" as string,
      startedAt: Date.now(),
      steps: msg.steps.map((s) => ({ slug: s.slug, status: "waiting", jobId: s.jobId ?? "" })),
    };
    workflow = { ...workflow, runs: [newRun, ...workflow.runs] };
  }

  if (msg.type === "workflow_step_started") {
    workflow = {
      ...workflow,
      runs: workflow.runs.map((r) =>
        r.runId === msg.workflowRunId
          ? {
              ...r,
              status: "running",
              steps: r.steps.map((s) => (s.slug === msg.stepSlug ? { ...s, status: "active", jobId: msg.jobId } : s)),
            }
          : r,
      ),
    };
  }

  if (msg.type === "workflow_step_completed") {
    workflow = {
      ...workflow,
      runs: workflow.runs.map((r) =>
        r.runId === msg.workflowRunId
          ? { ...r, steps: r.steps.map((s) => (s.slug === msg.stepSlug ? { ...s, status: "completed" } : s)) }
          : r,
      ),
    };
  }

  if (msg.type === "workflow_step_waiting") {
    workflow = {
      ...workflow,
      runs: workflow.runs.map((r) =>
        r.runId === msg.workflowRunId
          ? {
              ...r,
              status: "waiting-signal",
              steps: r.steps.map((s) => (s.slug === msg.stepSlug ? { ...s, status: "waiting-signal" } : s)),
            }
          : r,
      ),
    };
  }

  if (msg.type === "workflow_step_resumed") {
    workflow = {
      ...workflow,
      runs: workflow.runs.map((r) =>
        r.runId === msg.workflowRunId
          ? {
              ...r,
              status: "running",
              steps: r.steps.map((s) => (s.slug === msg.stepSlug ? { ...s, status: "completed" } : s)),
            }
          : r,
      ),
    };
  }

  if (msg.type === "workflow_step_failed") {
    workflow = {
      ...workflow,
      runs: workflow.runs.map((r) =>
        r.runId === msg.workflowRunId
          ? {
              ...r,
              status: "failed",
              steps: r.steps.map((s) => (s.slug === msg.stepSlug ? { ...s, status: "failed" } : s)),
            }
          : r,
      ),
    };
  }

  if (msg.type === "workflow_completed") {
    workflow = {
      ...workflow,
      runs: workflow.runs.map((r) => (r.runId === msg.workflowRunId ? { ...r, status: "completed" } : r)),
    };
  }

  if (msg.type === "workflow_failed") {
    workflow = {
      ...workflow,
      runs: workflow.runs.map((r) => (r.runId === msg.workflowRunId ? { ...r, status: "failed" } : r)),
    };
  }
}

const unsubWorkflow = workflowStore.subscribe(handleWorkflowEvent);

/** Keyboard shortcuts for edit mode. */
function handleKeydown(e: KeyboardEvent) {
  if (!editMode) return;

  if (e.key === "Escape") {
    e.preventDefault();
    cancelEdit();
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    if (!saveDisabled) saveWorkflow();
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    if (!saveDisabled) saveWorkflow();
    return;
  }
}

onMount(() => {
  window.addEventListener("keydown", handleKeydown);
});

onDestroy(() => {
  unsubWorkflow();
  window.removeEventListener("keydown", handleKeydown);
});
</script>

<!--
  Renders a trigger's icon tile (colored by category) followed by its type text.
  The icon is resolved by trigger subtype (manual/webhook/schedule/filewatcher)
  via visualForStepType, matching the graph trigger node.
-->
{#snippet triggerChip(triggerType: string)}
  {@const v = visualForStepType("trigger", { triggerType })}
  <span class="flex h-4 w-4 shrink-0 items-center justify-center rounded text-white {v.tileClass}">
    <v.icon size={11} weight="bold" aria-hidden="true" />
  </span>
  {triggerType}
{/snippet}

{#if loading}
  <LoadingIndicator />
{:else if error}
  <p class="text-sm text-destructive">{error}</p>
{:else if workflow}
  <div class="flex flex-col h-[calc(100vh-8rem)] overflow-hidden">
    <div class="flex flex-wrap items-center justify-between gap-2 mb-4 shrink-0">
      <div class="flex items-center gap-3 min-w-0">
        <Button
          size="sm"
          variant="outline"
          onclick={() => {
            navigate("/workflows");
          }}
        >
          &laquo;&nbsp;Back
        </Button>
        <h2 class="text-lg font-semibold truncate">{workflow.name}</h2>
        {#if !editMode && workflow.description}
          <span class="hidden md:inline text-sm text-muted-foreground truncate">{workflow.description}</span>
        {/if}
      </div>
      <div class="flex items-center gap-2 flex-wrap">
        {#if editMode}
          <Button size="sm" variant="default" onclick={saveWorkflow} disabled={saveDisabled}>
            {#if saving}
              Saving...
            {:else}
              Save
            {/if}
          </Button>
          <Button size="sm" variant="outline" onclick={cancelEdit}>Cancel</Button>
        {:else if confirmingDelete}
          <span class="text-sm font-bold text-destructive">Delete this workflow?</span>
          <Button size="sm" variant="destructive" onclick={() => deleteWorkflow()}>Confirm</Button>
          <Button size="sm" variant="outline" onclick={() => { confirmingDelete = false; }}>Cancel</Button>
        {:else}
          <Button size="sm" variant="outline" onclick={enterEditMode}>
            <PencilSimpleIcon size={14} class="mr-1.5" aria-hidden="true" />
            Edit
          </Button>
          <Button size="sm" variant="default" class="text-nowrap" onclick={triggerRun}>
            <PlayIcon size={14} class="mr-1.5" aria-hidden="true" />
            Run Workflow
          </Button>
          <Button size="sm" variant="destructive" onclick={() => { confirmingDelete = true; }}>
            <TrashIcon size={14} class="mr-1.5" aria-hidden="true" />
            Delete
          </Button>
        {/if}
      </div>
    </div>

    {#if saveError}
      <div
        class="mb-4 px-3 py-2 rounded-md border border-destructive bg-destructive/10 text-sm text-destructive shrink-0"
      >
        <div class="font-medium">{saveError}</div>
        {#if saveErrorDetails.length > 0}
          <ul class="list-disc list-inside mt-1 space-y-0.5 text-xs text-destructive/90">
            {#each saveErrorDetails as detail}
              <li>{detail}</li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}

    {#if !editMode && workflow.warnings && workflow.warnings.length > 0}
      <div class="mb-4 px-3 py-2 rounded-md border border-amber-500/50 bg-amber-500/10 text-sm shrink-0">
        <button
          type="button"
          class="flex w-full items-center gap-1.5 font-medium text-amber-500 text-left"
          aria-expanded={warningsExpanded}
          onclick={() => { warningsExpanded = !warningsExpanded; }}
        >
          <CaretRightIcon
            size={12}
            aria-hidden="true"
            class="transition-transform {warningsExpanded ? 'rotate-90' : ''}"
          />
          <WarningIcon size={14} aria-hidden="true" />
          Template {workflow.warnings.length === 1 ? "Issue" : "Issues"} ({workflow.warnings.length})
        </button>
        {#if warningsExpanded}
          <ul
            class="list-disc list-inside text-xs text-amber-500/80 space-y-0.5 mt-1"
            transition:slide={{ duration: 100 }}
          >
            {#each workflow.warnings as warning}
              <li><span class="font-mono">{warning.stepSlug}.{warning.field}</span>: {warning.message}</li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}

    {#if editMode && editDraft}
      <div class="mb-4 shrink-0 p-4 border border-border rounded-md bg-muted/30" transition:slide={{ duration: 100 }}>
        <div class="flex flex-col gap-1">
          <label for="edit-description" class="text-xs font-medium text-muted-foreground">Description</label>
          <input
            id="edit-description"
            type="text"
            class="px-2 py-1.5 text-sm border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
            value={editDraft.description}
            maxlength={256}
            oninput={(e) => { editDraft = { ...editDraft!, description: (e.target as HTMLInputElement).value }; }}
            placeholder="Optional description"
          >
          {#if validationErrors.get("description")}
            <span class="text-xs text-destructive">{validationErrors.get("description")}</span>
          {/if}
        </div>
      </div>
    {/if}

    <Tabs.Root bind:value={activeTab} class="flex flex-col flex-1 min-h-0">
      <Tabs.List class="flex gap-1 border-b border-border mb-3">
        <Tabs.Trigger
          value="definition"
          class="px-3 py-1.5 text-sm font-medium text-muted-foreground data-[state=active]:text-foreground data-[state=active]:border-b-2 data-[state=active]:border-primary -mb-px"
        >
          Definition
        </Tabs.Trigger>
        <Tabs.Trigger
          value="runs"
          class="px-3 py-1.5 text-sm font-medium text-muted-foreground data-[state=active]:text-foreground data-[state=active]:border-b-2 data-[state=active]:border-primary -mb-px"
        >
          Runs ({workflow.runs.length})
        </Tabs.Trigger>
      </Tabs.List>

      <Tabs.Content value="definition" class="flex flex-col flex-1 min-h-0">
        <!-- Graph area -->
        <div class="flex flex-1 min-w-0 min-h-0 transition-all duration-200">
          <div class="flex-1 min-w-0 min-h-0">
            <WorkflowGraph
              steps={(editDraft ?? workflow).steps.map((s) => ({
                ...s,
                status: "waiting" as const,
              }))}
              edges={editMode && editDraft ? editDraft.edges : workflow.edges}
              trigger={editMode && editDraft ? editDraft.trigger : workflow.trigger}
              {editMode}
              selectedStepId={sidebarOpen && !triggerSelected && selectedStepIndex >= 0
                ? ((editDraft ?? workflow).steps[selectedStepIndex]?.id ?? undefined)
                : undefined}
              triggerSelected={sidebarOpen && triggerSelected}
              {customStepTypes}
              errorSlugs={editMode ? undefined : errorSlugs}
              errorNodeIds={editMode ? errorNodeIds : undefined}
              onNodeClick={onStepClick}
              {onTriggerClick}
              onAddStep={addStep}
              onEdgesChange={editMode ? handleEdgesChange : undefined}
              onNodesDelete={editMode ? removeStepsByIds : undefined}
              {fitViewTrigger}
            />
          </div>

          <!-- Step detail sidebar -->
          <div
            class="shrink-0 overflow-hidden transition-all duration-200 ease-in-out bg-background"
            class:w-0={!sidebarOpen}
            class:border-l-0={!sidebarOpen}
            class:w-[380px]={sidebarOpen}
          >
            {#if selectedStep}
              <WorkflowStepSidebar
                {selectedStep}
                {selectedStepIndex}
                {editMode}
                {editDraftStep}
                {editDraft}
                {editAsJson}
                {viewAsJson}
                {validationErrors}
                {availableTools}
                {availableSkills}
                {metaLoading}
                {cachedSecretKeys}
                {customStepTypes}
                outputSchemas={workflow?.outputSchemas}
                onclose={closeSidebar}
                onSlugInput={onStepSlugInput}
                onRemoveStep={removeStep}
                onUpdateDraftStep={updateDraftStep}
                onValidationErrorsChange={(errors) => { validationErrors = errors; }}
                onStepTypeChange={handleStepTypeChange}
                onEditAsJsonChange={(v) => { editAsJson = v; }}
                onViewAsJsonChange={(v) => { viewAsJson = v; }}
              />
            {:else if triggerSelected}
              <div class="w-95 h-full flex flex-col">
                <div class="px-4 pb-2 pt-2 flex flex-col gap-2">
                  <div class="flex items-center gap-2">
                    <button
                      type="button"
                      class="shrink-0 p-0 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                      onclick={closeSidebar}
                      aria-label="Close trigger detail sidebar"
                    >
                      &#x2715;
                    </button>
                    <span class="text-sm font-medium truncate">Trigger</span>
                  </div>
                </div>

                <div class="flex-1 overflow-y-auto min-h-0 p-4 flex flex-col gap-4">
                  {#if editMode && editDraft}
                    <div class="flex flex-col gap-1">
                      <label for="sidebar-trigger-type" class="text-xs font-medium text-muted-foreground">Type</label>
                      <select
                        id="sidebar-trigger-type"
                        class="px-2 py-1.5 text-sm border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
                        value={editDraft.trigger.type}
                        onchange={(e) => {
                          const newType = (e.target as HTMLSelectElement).value;
                          const oldType = editDraft!.trigger.type;
                          editDraft = {
                            ...editDraft!,
                            trigger: {
                              ...editDraft!.trigger,
                              type: newType,
                              ref: newType === "manual" || newType !== oldType ? "" : editDraft!.trigger.ref,
                            },
                          };
                        }}
                      >
                        <option value="webhook">webhook</option>
                        <option value="schedule">schedule</option>
                        <option value="manual">manual</option>
                        <option value="filewatcher">filewatcher</option>
                      </select>
                      {#if validationErrors.get("trigger.type")}
                        <span class="text-xs text-destructive">{validationErrors.get("trigger.type")}</span>
                      {/if}
                    </div>

                    {#if editDraft.trigger.type !== "manual"}
                      {@const refOptions = availableTriggerRefs[editDraft.trigger.type] ?? []}
                      <div class="flex flex-col gap-1">
                        <label for="sidebar-trigger-ref" class="text-xs font-medium text-muted-foreground">Ref</label>
                        <select
                          id="sidebar-trigger-ref"
                          class="px-2 py-1.5 text-sm border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
                          value={editDraft.trigger.ref}
                          disabled={metaLoading}
                          onchange={(e) => {
                            editDraft = { ...editDraft!, trigger: { ...editDraft!.trigger, ref: (e.target as HTMLSelectElement).value } };
                            const newErrors = new Map(validationErrors);
                            if ((e.target as HTMLSelectElement).value) {
                              newErrors.delete("trigger.ref");
                            }
                            validationErrors = newErrors;
                          }}
                        >
                          <option value="">-- Select a ref --</option>
                          {#each refOptions as ref}
                            <option value={ref}>{ref}</option>
                          {/each}
                          {#if editDraft.trigger.ref && !refOptions.includes(editDraft.trigger.ref)}
                            <option value={editDraft.trigger.ref}>{editDraft.trigger.ref} (not found)</option>
                          {/if}
                        </select>
                        {#if metaLoading}
                          <span class="text-xs text-muted-foreground">Loading available refs...</span>
                        {:else if refOptions.length === 0}
                          <span class="text-xs text-muted-foreground">No refs available for this trigger type</span>
                        {/if}
                        {#if validationErrors.get("trigger.ref")}
                          <span class="text-xs text-destructive">{validationErrors.get("trigger.ref")}</span>
                        {/if}
                      </div>
                    {/if}
                  {:else}
                    <div class="flex items-center gap-2">
                      <span class="text-xs font-medium text-muted-foreground">Type:</span>
                      <Badge variant="outline" class="w-fit gap-1.5"
                        >{@render triggerChip(workflow.trigger.type)}</Badge
                      >
                    </div>
                    {#if workflow.trigger.ref}
                      <div class="flex items-center gap-2">
                        <span class="text-xs font-medium text-muted-foreground">Ref:</span>
                        <Badge variant="outline">{workflow.trigger.ref}</Badge>
                      </div>
                    {/if}
                  {/if}
                </div>
              </div>
            {/if}
          </div>
        </div>
      </Tabs.Content>

      <Tabs.Content value="runs" class="flex-1 min-h-0 overflow-y-auto">
        {#if workflow.runs.length === 0}
          <p class="text-sm text-muted-foreground text-center mt-3">No runs yet. Click "Run Workflow" to start one.</p>
        {:else}
          <!-- Mobile & Tablet: Card layout -->
          <div class="responsive-cards">
            {#each paginatedRuns as run (run.runId)}
              {@const aggregated = aggregateStepStatus(run.steps)}
              <div class="rounded-md border border-border p-4 space-y-3">
                <div class="flex items-center justify-between gap-2">
                  <a href="#/workflows/{name}/runs/{run.runId}" class="text-left">
                    <code class="text-xs font-mono font-medium">{run.runId.slice(0, 8)}</code>
                  </a>
                  <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
                </div>

                <StatusDot status={aggregated} title={aggregated} />

                <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>Started: {formatTimestamp(run.startedAt)}</span>
                  <span>Completed: {run.completedAt ? formatTimestamp(run.completedAt) : "\u2014"}</span>
                </div>

                {#if run.status === "failed" || isRunCancellable(run.status)}
                  <div class="flex flex-wrap items-center gap-2">
                    {#if run.status === "failed"}
                      <Button size="xs" variant="default" onclick={() => retryRun(run.runId)}>
                        <ArrowCounterClockwiseIcon size={12} class="mr-1" aria-hidden="true" />
                        Retry
                      </Button>
                    {/if}
                    {#if isRunCancellable(run.status)}
                      <Button
                        size="xs"
                        variant="destructive"
                        disabled={cancellingRunId === run.runId}
                        onclick={() => cancelRun(run.runId)}
                      >
                        <span class="text-xs font-bold mr-1" aria-hidden="true">&#x2715;</span>
                        {cancellingRunId === run.runId ? "..." : "Cancel"}
                      </Button>
                    {/if}
                  </div>
                {/if}
              </div>
            {/each}
          </div>

          <!-- Desktop: Table layout -->
          <div class="responsive-table rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead class="w-md">Run ID</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Completed</TableHead>
                  <TableHead class="min-w-[2em] text-center">Status</TableHead>
                  <TableHead class="min-w-[10em]"></TableHead>
                  <TableHead class="text-center min-w-[10em]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {#each paginatedRuns as run (run.runId)}
                  {@const aggregated = aggregateStepStatus(run.steps)}
                  <TableRow>
                    <TableCell>
                      <a href="#/workflows/{name}/runs/{run.runId}" class="text-left">
                        <code class="text-xs font-mono font-medium">{run.runId.slice(0, 8)}</code>
                      </a>
                    </TableCell>
                    <TableCell class="text-sm text-muted-foreground">
                      {formatTimestamp(run.startedAt)}
                    </TableCell>
                    <TableCell class="text-sm text-muted-foreground">
                      {run.completedAt ? formatTimestamp(run.completedAt) : "\u2014"}
                    </TableCell>
                    <TableCell class="text-center">
                      <StatusDot status={aggregated} title={aggregated} />
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
                    </TableCell>
                    <TableCell class="text-right">
                      <div class="inline-flex justify-end gap-2 flex-wrap xl:flex-nowrap">
                        {#if run.status === "failed"}
                          <Button size="sm" variant="default" onclick={() => retryRun(run.runId)}>
                            <ArrowCounterClockwiseIcon size={14} class="mr-1" aria-hidden="true" />
                            Retry
                          </Button>
                        {/if}
                        {#if isRunCancellable(run.status)}
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={cancellingRunId === run.runId}
                            onclick={() => cancelRun(run.runId)}
                          >
                            <span class="text-xs font-bold mr-1.5" aria-hidden="true">&#x2715;</span>
                            {cancellingRunId === run.runId ? "Cancelling" : "Cancel"}
                          </Button>
                        {/if}
                      </div>
                    </TableCell>
                  </TableRow>
                {/each}
              </TableBody>
            </Table>
          </div>

          {#if runsTotalPages > 1}
            <nav class="flex items-center justify-center gap-2 mt-6" aria-label="Pagination">
              <Button
                size="xs"
                variant="outline"
                disabled={runsPage <= 1}
                onclick={() => (runsPage = 1)}
                aria-label="First page"
              >
                <CaretLeftIcon size={14} aria-hidden="true" />
                <CaretLeftIcon size={14} class="-ml-1.5" aria-hidden="true" />
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={runsPage <= 1}
                onclick={() => (runsPage = Math.max(1, runsPage - 1))}
                aria-label="Previous page"
              >
                <CaretLeftIcon size={14} aria-hidden="true" />
              </Button>
              <span class="text-sm text-muted-foreground"> Page {runsPage} of {runsTotalPages} </span>
              <Button
                size="xs"
                variant="outline"
                disabled={runsPage >= runsTotalPages}
                onclick={() => (runsPage = Math.min(runsTotalPages, runsPage + 1))}
                aria-label="Next page"
              >
                <CaretRightIcon size={14} aria-hidden="true" />
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={runsPage >= runsTotalPages}
                onclick={() => (runsPage = runsTotalPages)}
                aria-label="Last page"
              >
                <CaretRightIcon size={14} aria-hidden="true" />
                <CaretRightIcon size={14} class="-ml-1.5" aria-hidden="true" />
              </Button>
            </nav>
          {/if}
        {/if}
      </Tabs.Content>
    </Tabs.Root>
  </div>
{/if}
