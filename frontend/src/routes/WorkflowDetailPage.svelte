<script lang="ts">
import type { Edge } from "@xyflow/svelte";
import { Tabs } from "bits-ui";
import { blockNavigation } from "sv-router";
import { onDestroy, onMount } from "svelte";
import { onReconnect } from "$lib/appStore";
import { authFetch } from "$lib/auth";
import LoadingIndicator from "$lib/components/LoadingIndicator.svelte";
import { AlertDialog } from "$lib/components/ui/alert-dialog";
import { detailPanelMode } from "$lib/detailPanelMode.svelte";
import { extensions } from "$lib/extensionStore";
import { t } from "$lib/i18n.svelte";
import { localizeStepType } from "$lib/stepTypes";
import { UndoHistory } from "$lib/undoHistory";
import { applyWorkflowEvent, normalizeWorkflow, type StepDef, type WorkflowDetail } from "$lib/workflowDetail";
import {
  draftErrorNodeIds,
  draftFromWorkflow,
  errorsAfterStepRemoval,
  graphEdgesToDraftEdges,
  nextStepId,
  parseSaveErrorDetails,
  reconcileConnectivityErrors,
  slugErrorsAfterEdit,
  stepTemplate,
  uniqueStepSlug,
  withConfigDefaults,
} from "$lib/workflowDraft";
import {
  emptyTriggerRefs,
  fetchSecretKeys,
  fetchVariableKeys,
  fetchWorkflowAnalysis,
  fetchWorkflowEditorMeta,
  fetchWorkflowGroups,
  type TriggerRefs,
  type WorkflowAnalysis,
} from "$lib/workflowEditorMeta";
import { type WorkflowEvent, workflowStore } from "$lib/workflowRunStore.svelte";
import {
  type EdgeDraft,
  type StepDraft,
  serializeWorkflowDraft,
  validateWorkflowDraft,
  type WorkflowDraft,
} from "$lib/workflowValidation";
import { BUILTIN_STEP_TYPES, type StepTypeDescriptor, WorkflowBuilder } from "$shared/workflowBuilder";
import DetailPanelModeToggle from "../components/DetailPanelModeToggle.svelte";
import StepTypePickerPopover from "../components/StepTypePickerPopover.svelte";
import WorkflowDetailToolbar from "../components/WorkflowDetailToolbar.svelte";
import WorkflowGraph from "../components/WorkflowGraph.svelte";
import WorkflowMetaFields from "../components/WorkflowMetaFields.svelte";
import WorkflowRunsTab from "../components/WorkflowRunsTab.svelte";
import WorkflowSaveError from "../components/WorkflowSaveError.svelte";
import WorkflowStepSidebar from "../components/WorkflowStepSidebar.svelte";
import WorkflowTriggerPanel from "../components/WorkflowTriggerPanel.svelte";
import WorkflowWarningsBanner from "../components/WorkflowWarningsBanner.svelte";
import { navigate, route } from "../router";

let workflow = $state<WorkflowDetail | null>(null);
let loading = $state(true);
let error = $state<string | null>(null);
let selectedStep = $state<StepDef | null>(null);
let sidebarOpen = $state(false);
let activeTab = $state("definition");

// Edit mode state
let editMode = $state(false);
let editDraft = $state<WorkflowDraft | null>(null);
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

// Meta endpoint state for tools/skills/trigger refs
let availableTools = $state<string[]>([]);
let availableSkills = $state<string[]>([]);
let availableTriggerRefs = $state<TriggerRefs>(emptyTriggerRefs());
let metaLoading = $state(false);

// Cached secret/variable keys for template autocomplete
let cachedSecretKeys = $state<string[]>([]);
let cachedVariableKeys = $state<string[]>([]);
let knownGroups = $state<string[]>([]);

/** Custom step types registered by extensions, derived from the extension store. */
let customStepTypes = $derived(
  $extensions
    .filter((ext) => ext.enabled && ext.ui?.stepTypes?.length)
    .flatMap((ext) => ext.ui!.stepTypes!.map(localizeStepType)),
);

/** WorkflowBuilder instance, recreated when extension step types change. */
let workflowBuilder = $derived(
  new WorkflowBuilder({
    stepTypes: [
      ...BUILTIN_STEP_TYPES,
      ...customStepTypes
        .filter((st): st is typeof st & { type: string } => !!st.type)
        .map(
          (st): StepTypeDescriptor => ({
            type: st.type,
            branches: [],
            terminal: st.terminal ?? false,
          }),
        ),
    ],
    idFactory: nextStepId,
    slugFactory: nextStepSlug,
  }),
);

/** Load editor reference data (tools, skills, trigger refs, autocomplete keys). */
async function loadEditorMeta() {
  metaLoading = true;
  fetchSecretKeys().then((keys) => {
    cachedSecretKeys = keys;
  });
  fetchVariableKeys().then((keys) => {
    cachedVariableKeys = keys;
  });
  fetchWorkflowGroups().then((groups) => {
    knownGroups = groups;
  });
  const meta = await fetchWorkflowEditorMeta();
  availableTools = meta.tools;
  availableSkills = meta.skills;
  availableTriggerRefs = meta.triggerRefs;
  metaLoading = false;
}

/** The draft as it was when edit mode was entered (JSON), to detect unsaved changes. */
let editBaseline = $state<string | null>(null);

/** Whether the edit draft differs from the version edit mode started from. */
let hasUnsavedChanges = $derived(
  editMode && editDraft !== null && editBaseline !== null && JSON.stringify(editDraft) !== editBaseline,
);

/** Resolves the pending discard confirmation; `null` while no dialog is open. */
let discardConfirm = $state<((ok: boolean) => void) | null>(null);

/** Asks the user whether to discard unsaved changes. Resolves `true` to discard. */
function confirmDiscard(): Promise<boolean> {
  // A newer request supersedes (cancels) a pending one.
  discardConfirm?.(false);
  return new Promise((resolve) => {
    discardConfirm = resolve;
  });
}

function settleDiscard(ok: boolean) {
  const resolve = discardConfirm;
  discardConfirm = null;
  resolve?.(ok);
}

// Route changes ask before discarding unsaved edits; closing or reloading the
// tab gets the browser's own prompt (it cannot wait for an async dialog).
$effect(() => {
  if (!hasUnsavedChanges) return;
  return blockNavigation({ beforeUnload: () => false, onNavigate: confirmDiscard });
});

/** Enter edit mode with a deep copy of the current workflow data. */
function enterEditMode() {
  if (!workflow) return;
  editDraft = draftFromWorkflow(workflow);
  editBaseline = JSON.stringify(editDraft);
  saveError = null;
  saveErrorDetails = [];
  validationErrors = new Map();
  clearHistory();
  editMode = true;
  loadEditorMeta();
}

/**
 * After leaving edit mode, re-point the sidebar at the (saved or original)
 * workflow step at the same index, or close it if there is none.
 */
function resyncSelectionWithWorkflow() {
  if (sidebarOpen && selectedStepIndex >= 0 && workflow?.steps[selectedStepIndex]) {
    selectedStep = workflow.steps[selectedStepIndex] as StepDef;
  } else {
    sidebarOpen = false;
    selectedStep = null;
    selectedStepIndex = -1;
  }
}

/** Cancel edit mode, asking first when there are unsaved changes. */
async function requestCancelEdit() {
  if (hasUnsavedChanges && !(await confirmDiscard())) return;
  cancelEdit();
}

/** Cancel edit mode, discard changes. */
function cancelEdit() {
  editMode = false;
  editDraft = null;
  editBaseline = null;
  saveError = null;
  saveErrorDetails = [];
  validationErrors = new Map();
  editAsJson = false;
  viewAsJson = false;
  clearHistory();
  resyncSelectionWithWorkflow();
}

/** Index of the selected step in the (draft or saved) step list. */
let selectedStepIndex = $state(-1);
/** Whether the trigger node is currently selected (sidebar shows trigger config). */
let triggerSelected = $state(false);

/** The draft step corresponding to the currently selected step. */
let editDraftStep = $derived.by(() => {
  if (!editMode || !editDraft || !selectedStep) return null;
  return editDraft.steps[selectedStepIndex] ?? null;
});

/**
 * One undo/redo step: the draft plus the editor state that is keyed to it.
 * Validation errors are index-keyed and only partially recomputed, so they are
 * restored with the draft rather than re-derived; selection is kept by step id.
 */
interface EditSnapshot {
  draft: WorkflowDraft;
  validationErrors: Map<string, string>;
  selectedStepId: string | null;
}

/** Undo/redo history of the current edit session. */
const history = new UndoHistory<EditSnapshot>();
let canUndo = $state(false);
let canRedo = $state(false);

/** Mirrors the history's availability flags into reactive state for the toolbar. */
function syncHistoryFlags() {
  canUndo = history.canUndo;
  canRedo = history.canRedo;
}

/** Drops all history (edit session start/end). */
function clearHistory() {
  history.clear();
  syncHistoryFlags();
}

/** Captures the current editor state for the history. Requires an edit draft. */
function snapshot(): EditSnapshot {
  const selected =
    sidebarOpen && !triggerSelected && selectedStepIndex >= 0 ? editDraft!.steps[selectedStepIndex] : null;
  return { draft: editDraft!, validationErrors, selectedStepId: selected?.id ?? null };
}

/**
 * Records the current state as an undo step. Call before mutating the draft.
 *
 * @param key - Coalescing key for continuous edits (typing); omit for discrete operations.
 */
function recordHistory(key?: string) {
  if (!editDraft) return;
  history.record(snapshot(), key);
  syncHistoryFlags();
}

/**
 * Replaces the draft, recording the previous state as an undo step.
 *
 * @param next - The new draft.
 * @param key - Coalescing key for continuous edits (typing); omit for discrete operations.
 */
function commitDraft(next: WorkflowDraft, key?: string) {
  // Forms may echo unchanged values back (e.g. a config form on mount); those
  // must not become undo steps.
  if (editDraft && JSON.stringify(next) === JSON.stringify(editDraft)) return;
  recordHistory(key);
  editDraft = next;
}

/** Restores a history snapshot, re-pointing the selection by step id. */
function restoreSnapshot(snap: EditSnapshot) {
  // Pending slug validations were computed against the replaced draft and
  // would write stale index-keyed errors.
  for (const timeout of stepSlugTimeouts.values()) clearTimeout(timeout);
  stepSlugTimeouts.clear();
  pendingSlugs.clear();

  const currentId =
    sidebarOpen && !triggerSelected && selectedStepIndex >= 0 ? editDraft?.steps[selectedStepIndex]?.id : null;
  editDraft = snap.draft;
  validationErrors = snap.validationErrors;
  syncHistoryFlags();

  if (triggerSelected && !snap.selectedStepId) return;
  const targetId = snap.selectedStepId ?? currentId;
  const index = targetId ? snap.draft.steps.findIndex((s) => s.id === targetId) : -1;
  if (index >= 0) {
    triggerSelected = false;
    selectedStep = snap.draft.steps[index] as StepDef;
    selectedStepIndex = index;
    sidebarOpen = true;
  } else if (currentId) {
    closeSidebar();
    selectedStepIndex = -1;
  }
}

/** Undoes the last draft change. */
function undo() {
  if (!editDraft) return;
  const snap = history.undo(snapshot());
  if (snap) restoreSnapshot(snap);
}

/** Redoes the last undone draft change. */
function redo() {
  if (!editDraft) return;
  const snap = history.redo(snapshot());
  if (snap) restoreSnapshot(snap);
}

/** Update a field on the currently selected draft step. */
function updateDraftStep(index: number, updater: (step: StepDraft) => void) {
  if (!editDraft || index < 0 || index >= editDraft.steps.length) return;
  commitDraft(
    {
      ...editDraft,
      steps: editDraft.steps.map((s, i) => {
        if (i !== index) return s;
        const copy = { ...s };
        updater(copy);
        return copy;
      }),
    },
    `step:${editDraft.steps[index]!.id}`,
  );
}

/**
 * Slugs handed out by {@link nextStepSlug} since the last draft commit. Cleared
 * whenever a builder operation starts. Prevents duplicate slugs when one
 * operation mints several steps synchronously.
 */
let pendingSlugs = new Set<string>();

/**
 * Generates a unique placeholder slug for a newly added step
 * (e.g. "step-1", "step-2", ...) that doesn't collide with existing slugs.
 */
function nextStepSlug(): string {
  const existing = new Set(editDraft ? editDraft.steps.map((s) => s.slug) : []);
  // Also exclude slugs handed out earlier in the same synchronous burst. When a
  // single builder operation creates multiple steps (e.g. an iterator + its
  // paired aggregator), slugFactory() is called several times before editDraft
  // is reassigned, so the draft snapshot alone would return the same slug twice.
  for (const s of pendingSlugs) existing.add(s);
  const candidate = uniqueStepSlug(existing);
  pendingSlugs.add(candidate);
  return candidate;
}

/**
 * Creates a step using stepTemplate + nextStepSlug. Used for the "unconnected add"
 * path where the builder's operations don't apply (no source node exists).
 */
function builderCreateStep(type: string): StepDraft {
  const step = stepTemplate(type, customStepTypes);
  step.slug = nextStepSlug();
  return step;
}

/**
 * Commits the result of a step-creating builder operation to the draft, seeds
 * custom step config defaults, flags a fresh agent step's missing prompt, and
 * selects the new step in the sidebar. No-op if the builder changed nothing.
 */
function commitNewStep(type: string, result: { steps: StepDraft[]; edges: EdgeDraft[] }) {
  if (!editDraft) return;
  if (result.steps === editDraft.steps && result.edges === editDraft.edges) return;

  commitDraft({ ...editDraft, steps: withConfigDefaults(result.steps, customStepTypes), edges: result.edges });

  const newIndex = editDraft.steps.length - 1;
  const newErrors = new Map(validationErrors);
  if (type === "agent") {
    newErrors.set(`steps[${newIndex}].prompt`, t("validation.promptRequired"));
  }
  validationErrors = newErrors;

  // Auto-select the new step in the sidebar
  selectedStep = editDraft.steps[newIndex] as StepDef;
  selectedStepIndex = newIndex;
  triggerSelected = false;
  sidebarOpen = true;
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
  pendingSlugs.clear();

  let result: { steps: StepDraft[]; edges: EdgeDraft[] };

  if (branchContext) {
    if (branchContext.lastNodeId) {
      // Main-chain tail or populated branch: append after the last node.
      result = workflowBuilder.appendAfter(editDraft, branchContext.lastNodeId, type);
    } else if (branchContext.branch) {
      // Empty branch: add to the CF node's branch.
      result = workflowBuilder.addToBranch(editDraft, branchContext.parentNodeId, branchContext.branch, type);
    } else {
      // Fallback: append after parent with no branch
      result = workflowBuilder.appendAfter(editDraft, branchContext.parentNodeId, type);
    }
  } else {
    // No context (first step of an empty workflow): create unconnected.
    // The builder doesn't have an "add unconnected" operation, so we manually
    // add the step. Use the builder's descriptor for paired creation.
    const descriptor = workflowBuilder.getDescriptor(type);
    const newStep = builderCreateStep(type);
    let newSteps = [...editDraft.steps, newStep];
    const newEdges = [...editDraft.edges];

    if (descriptor.paired) {
      const pairedStep = builderCreateStep(descriptor.paired.type);
      (pairedStep as Record<string, unknown>)[descriptor.paired.ref] = newStep.slug;
      newEdges.push({ from: newStep.id!, to: pairedStep.id!, branch: descriptor.paired.branch });
      newSteps = [...editDraft.steps, newStep, pairedStep];
    }

    result = { steps: newSteps, edges: newEdges };
  }

  commitNewStep(type, result);
}

/**
 * Pending edge insertion context — shown as a type picker popup.
 */
let edgeInsertContext = $state<{
  sourceId: string;
  targetId: string;
  branch?: string;
  position: { x: number; y: number };
} | null>(null);

/**
 * Called when the user clicks the "+" button on an edge. Opens the type picker.
 */
function insertStepOnEdge(
  sourceId: string,
  targetId: string,
  branch: string | undefined,
  position: { x: number; y: number },
) {
  edgeInsertContext = { sourceId, targetId, branch, position };
}

/**
 * Called when a type is selected from the edge insert popup.
 * Performs the actual edge split and step creation.
 */
function confirmEdgeInsert(type: string) {
  if (!editDraft || !edgeInsertContext) return;
  pendingSlugs.clear();

  const { sourceId, targetId, branch } = edgeInsertContext;
  edgeInsertContext = null;

  // The trigger is implicit (not a real node), so inserting on the trigger edge
  // prepends a step before the first root instead of splitting an edge.
  const result =
    sourceId === "__trigger__"
      ? workflowBuilder.insertAtStart(editDraft, type)
      : workflowBuilder.insertBetween(editDraft, sourceId, targetId, type, branch);

  commitNewStep(type, result);
}

/** Sync draft edges from the graph after the user connects/disconnects nodes. */
function handleEdgesChange(edges: Edge[]) {
  if (!editDraft) return;

  const stepIds = new Set(editDraft.steps.map((s) => s.id!));
  commitDraft({ ...editDraft, edges: graphEdgesToDraftEdges(edges, stepIds) });

  // Connectivity errors are otherwise only recomputed on save, so drawing an
  // edge that reconnects an orphaned step would leave its stale "not connected"
  // error (and a disabled Save button) hanging. Reconcile that error class here
  // against the updated edge set.
  validationErrors = reconcileConnectivityErrors(editDraft, validationErrors);
}

/** Remove the step with the given synthetic id (the builder reconnects/cascades as needed). */
function removeStep(id: string) {
  if (!editDraft?.steps.some((s) => s.id === id)) return;
  recordHistory();
  removeStepWithoutHistory(id);
}

/** {@link removeStep} without recording an undo step, for batched removals. */
function removeStepWithoutHistory(id: string) {
  if (!editDraft) return;

  const index = editDraft.steps.findIndex((s) => s.id === id);
  if (index < 0) return;

  const removedSlug = editDraft.steps[index]!.slug;

  // Use the builder for intelligent removal (reconnection, cascade, etc.)
  const result = workflowBuilder.remove(editDraft, id);
  editDraft = { ...editDraft, steps: result.steps, edges: result.edges };

  validationErrors = errorsAfterStepRemoval(validationErrors, editDraft.steps, removedSlug);
}

/**
 * Remove one or more steps identified by their synthetic node id.
 *
 * Backs SvelteFlow's native node deletion (Backspace/Delete key), which reports
 * the removed nodes by id. Ids are stable across the splices {@link removeStep}
 * performs, so they can be removed in a plain loop with no index bookkeeping.
 *
 * @param ids - Synthetic node ids of the steps to remove.
 */
function removeStepsByIds(ids: string[]) {
  if (!editDraft || ids.length === 0) return;
  // One undo step for the whole batch, recorded before the selection changes.
  recordHistory();
  // If the currently selected step is being deleted, close the sidebar first so
  // it does not linger on a removed step.
  const selectedId = selectedStepIndex >= 0 ? editDraft.steps[selectedStepIndex]?.id : undefined;
  if (selectedId && ids.includes(selectedId)) {
    closeSidebar();
  }
  for (const id of ids) {
    removeStepWithoutHistory(id);
  }
}

/** Pending debounced slug validations, keyed by step index. */
const stepSlugTimeouts: Map<number, ReturnType<typeof setTimeout>> = new Map();

/** Update a step slug and validate it with debounced inline feedback. */
function onStepSlugInput(index: number, value: string) {
  if (!editDraft) return;
  // Edges are id-based and the step's id is stable, so a slug edit never touches
  // edges: connections survive renames, clears, and duplicate slugs untouched.
  const oldSlug = editDraft.steps[index]?.slug;
  const stepType = editDraft.steps[index]?.type;

  let updatedSteps = editDraft.steps.map((s, i) => (i === index ? { ...s, slug: value } : s));

  // Renaming an iterator updates any aggregator that references it by slug.
  if (stepType === "iterator" && oldSlug) {
    updatedSteps = updatedSteps.map((s) =>
      s.type === "aggregator" && (s as Record<string, unknown>).iterator === oldSlug ? { ...s, iterator: value } : s,
    );
  }

  commitDraft({ ...editDraft, steps: updatedSteps }, `step:${editDraft.steps[index]?.id}`);

  const existing = stepSlugTimeouts.get(index);
  if (existing) clearTimeout(existing);

  stepSlugTimeouts.set(
    index,
    setTimeout(() => {
      if (editDraft) validationErrors = slugErrorsAfterEdit(validationErrors, editDraft.steps, index, value);
    }, 300),
  );
}

/** The pending "save with template issues" confirmation; `null` while no dialog is open. */
let saveIssuesConfirm = $state<{ count: number; resolve: (ok: boolean) => void } | null>(null);

/** Asks the user whether to save despite `count` template issues. Resolves `true` to save. */
function confirmSaveWithIssues(count: number): Promise<boolean> {
  return new Promise((resolve) => {
    saveIssuesConfirm = { count, resolve };
  });
}

function settleSaveIssues(ok: boolean) {
  const pending = saveIssuesConfirm;
  saveIssuesConfirm = null;
  pending?.resolve(ok);
}

/** Save the edited workflow, asking first when the draft has template issues. */
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
    const definition = serializeWorkflowDraft(editDraft);
    // Analyze exactly what is saved: the live draft analysis is debounced and
    // may lag behind the latest edit.
    const analysis = await fetchWorkflowAnalysis(definition);
    const issueCount = analysis?.valid ? analysis.warnings.length : 0;
    if (issueCount > 0 && !(await confirmSaveWithIssues(issueCount))) return;

    const res = await authFetch(`/ext/workflows/${workflow.name}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(definition),
    });

    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string; details?: string } | null;
      saveError = data?.error ?? `HTTP ${res.status}`;
      // Surface each specific validation failure the backend reports, not just
      // the generic top-level message.
      saveErrorDetails = parseSaveErrorDetails(data?.details);
      return;
    }

    // Re-fetch workflow to refresh the view
    await fetchWorkflow();
    editMode = false;
    editDraft = null;
    editBaseline = null;
    validationErrors = new Map();
    clearHistory();
    resyncSelectionWithWorkflow();
  } catch (err) {
    saveError = err instanceof Error ? err.message : t("workflows.saveFailed");
  } finally {
    saving = false;
  }
}

let saveDisabled = $derived(saving || validationErrors.size > 0);

/**
 * Server analysis of the edit draft: output schemas for template autocomplete
 * and template/config warnings, refreshed (debounced) as the draft changes, so
 * neither depends on the last saved version. `null` outside edit mode and until
 * the first response arrives.
 */
let draftAnalysis = $state<WorkflowAnalysis | null>(null);

$effect(() => {
  if (!editMode || !editDraft) {
    draftAnalysis = null;
    return;
  }
  const definition = serializeWorkflowDraft(editDraft);
  const controller = new AbortController();
  const timer = setTimeout(async () => {
    const analysis = await fetchWorkflowAnalysis(definition, controller.signal);
    if (analysis && !controller.signal.aborted) draftAnalysis = analysis;
  }, 400);
  return () => {
    clearTimeout(timer);
    controller.abort();
  };
});

/** Warnings for the current mode: the draft's in edit mode (once analyzed), else the saved workflow's. */
let activeWarnings = $derived(editMode && draftAnalysis?.valid ? draftAnalysis.warnings : (workflow?.warnings ?? []));

/** Output schemas for template autocomplete: the draft's in edit mode (once analyzed), else the saved workflow's. */
let activeOutputSchemas = $derived(editMode && draftAnalysis ? draftAnalysis.outputSchemas : workflow?.outputSchemas);

/**
 * Slugs of steps that have a template/config warning, derived from the
 * workflow's `warnings`. Passed to the graph so the offending nodes render a
 * red error badge. Only meaningful in read-only view mode (warnings are not
 * produced for the in-progress edit draft).
 */
let errorSlugs = $derived(new Set((workflow?.warnings ?? []).map((w) => w.stepSlug)));

/**
 * Synthetic node ids of draft steps that render an error badge in edit mode
 * (live validation errors plus {@link activeWarnings}). Empty outside edit mode.
 */
let errorNodeIds = $derived(
  editMode && editDraft ? draftErrorNodeIds(editDraft, validationErrors, activeWarnings) : new Set<string>(),
);

/**
 * Whether the trigger node should render an error badge. In edit mode this
 * reflects live draft `validationErrors` for the trigger (keys `trigger.*`). In read-only view mode it reflects backend template
 * `warnings` targeting the trigger (identified by the reserved `__trigger__`
 * stepSlug). Keeps the trigger node visually consistent with step nodes, which
 * already show a badge for their own config errors.
 */
let triggerHasError = $derived.by(() => {
  if (editMode) {
    return [...validationErrors.keys()].some((key) => key.startsWith("trigger."));
  }
  return (workflow?.warnings ?? []).some((w) => w.stepSlug === "__trigger__");
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
    error = err instanceof Error ? err.message : t("workflows.loadWorkflowFailed");
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

const unsubWorkflow = workflowStore.subscribe((msg: WorkflowEvent) => {
  if (workflow) workflow = applyWorkflowEvent(workflow, msg, name);
});

/**
 * Refreshes only the run list after a WebSocket reconnect: run events sent
 * while the socket was down are lost. The definition (and any edit in
 * progress) is left alone.
 */
async function refreshRuns() {
  if (!workflow || !name) return;
  try {
    const res = await authFetch(`/ext/workflows/${name}`);
    if (!res.ok) return;
    const fresh = normalizeWorkflow(await res.json());
    if (workflow) workflow = { ...workflow, runs: fresh.runs };
  } catch {
    /* best effort: the next event or page load catches up */
  }
}
const unsubReconnect = onReconnect(refreshRuns);

/** Keyboard shortcuts: Escape dismisses the floating detail panel, then edit-mode shortcuts. */
function handleKeydown(e: KeyboardEvent) {
  // Escape already handled by a nested control (open dropdown, autocomplete).
  if (e.key === "Escape" && e.defaultPrevented) return;
  // The discard dialog handles its own keys.
  if (discardConfirm) return;

  // Escape closes an open floating panel first; a second press leaves edit mode.
  if (e.key === "Escape" && detailPanelMode.current === "floating" && sidebarOpen) {
    e.preventDefault();
    closeSidebar();
    return;
  }

  if (!editMode) return;

  if (e.key === "Escape") {
    e.preventDefault();
    requestCancelEdit();
    return;
  }

  if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "Enter")) {
    e.preventDefault();
    if (!saveDisabled) saveWorkflow();
    return;
  }

  // Draft undo/redo. Text fields keep their native undo, so skip while one is focused.
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !isEditableTarget(e.target)) {
    const key = e.key.toLowerCase();
    if (key === "z" || key === "y") {
      e.preventDefault();
      if (key === "y" || e.shiftKey) redo();
      else undo();
    }
  }
}

/** Whether a keyboard event target handles its own text undo (inputs, textareas, rich editors). */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.closest("input, textarea, select, [contenteditable]") !== null;
}

/** Leaving a field ends its typing run, so the next edit starts a new undo step. */
function handleFocusOut() {
  history.breakCoalescing();
}

onMount(() => {
  window.addEventListener("keydown", handleKeydown);
  window.addEventListener("focusout", handleFocusOut);
});

onDestroy(() => {
  unsubWorkflow();
  unsubReconnect();
  window.removeEventListener("keydown", handleKeydown);
  window.removeEventListener("focusout", handleFocusOut);
});
</script>

{#if loading}
  <LoadingIndicator />
{:else if error}
  <p class="text-sm text-destructive">{error}</p>
{:else if workflow}
  <div class="flex flex-col h-[calc(100vh-8rem)] overflow-hidden">
    <WorkflowDetailToolbar
      name={workflow.name}
      description={workflow.description}
      group={workflow.group}
      {editMode}
      {saving}
      {saveDisabled}
      {canUndo}
      {canRedo}
      onUndo={undo}
      onRedo={redo}
      onSave={saveWorkflow}
      onCancelEdit={requestCancelEdit}
      onEdit={enterEditMode}
      onRun={triggerRun}
      onDelete={deleteWorkflow}
    />

    {#if saveError}
      <WorkflowSaveError error={saveError} details={saveErrorDetails} />
    {/if}

    <WorkflowWarningsBanner warnings={activeWarnings} />

    {#if editMode && editDraft}
      <WorkflowMetaFields
        description={editDraft.description}
        descriptionError={validationErrors.get("description")}
        ondescription={(description) => commitDraft({ ...editDraft!, description }, "description")}
        group={editDraft.group}
        groupError={validationErrors.get("group")}
        {knownGroups}
        ongroup={(group) => commitDraft({ ...editDraft!, group }, "group")}
      />
    {/if}

    <Tabs.Root bind:value={activeTab} class="flex flex-col flex-1 min-h-0">
      <Tabs.List class="flex gap-1 border-b border-border mb-3">
        <Tabs.Trigger
          value="definition"
          class="px-3 py-1.5 text-sm font-medium text-muted-foreground data-[state=active]:text-foreground data-[state=active]:border-b-2 data-[state=active]:border-primary -mb-px"
        >
          {t("workflows.tabDefinition")}
        </Tabs.Trigger>
        <Tabs.Trigger
          value="runs"
          class="px-3 py-1.5 text-sm font-medium text-muted-foreground data-[state=active]:text-foreground data-[state=active]:border-b-2 data-[state=active]:border-primary -mb-px"
        >
          {t("workflows.tabRuns", { count: workflow.runs.length })}
        </Tabs.Trigger>
        {#if activeTab === "definition"}
          <DetailPanelModeToggle class="ml-auto self-center" />
        {/if}
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
                ? ((editDraft ?? workflow).steps[selectedStepIndex]?.id ??
                  (editDraft ?? workflow).steps[selectedStepIndex]?.slug)
                : undefined}
              triggerSelected={sidebarOpen && triggerSelected}
              nodePanel={detailPanelMode.current === "floating" ? floatingDetailPanel : undefined}
              {customStepTypes}
              errorSlugs={editMode ? undefined : errorSlugs}
              errorNodeIds={editMode ? errorNodeIds : undefined}
              {triggerHasError}
              onNodeClick={onStepClick}
              {onTriggerClick}
              onPaneClick={() => {
                // The floating panel overlays the canvas, so clicking empty
                // canvas dismisses it. The docked sidebar stays open.
                if (detailPanelMode.current === "floating" && sidebarOpen) closeSidebar();
              }}
              onAddStep={addStep}
              onInsertStepOnEdge={editMode ? insertStepOnEdge : undefined}
              onEdgesChange={editMode ? handleEdgesChange : undefined}
              onNodesDelete={editMode ? removeStepsByIds : undefined}
            />
          </div>

          <!-- Step detail sidebar (docked mode) -->
          {#if detailPanelMode.current === "sidebar"}
            <div
              class="shrink-0 overflow-hidden transition-all duration-200 ease-in-out bg-background"
              class:w-0={!sidebarOpen}
              class:border-l-0={!sidebarOpen}
              class:w-[380px]={sidebarOpen}
            >
              {@render detailPanel()}
            </div>
          {/if}
        </div>
      </Tabs.Content>

      <Tabs.Content value="runs" class="flex-1 min-h-0 overflow-y-auto">
        <WorkflowRunsTab workflowName={name} runs={workflow.runs} onRunCancelled={fetchWorkflow} />
      </Tabs.Content>
    </Tabs.Root>
  </div>
{/if}

<!-- Edge insert type picker popup -->
{#if edgeInsertContext}
  <StepTypePickerPopover
    position={edgeInsertContext.position}
    {customStepTypes}
    onselect={confirmEdgeInsert}
    onclose={() => {
      edgeInsertContext = null;
    }}
  />
{/if}

<AlertDialog
  open={discardConfirm !== null}
  title={t("workflows.discardChangesTitle")}
  description={t("workflows.discardChangesMessage")}
  confirmLabel={t("workflows.discardChanges")}
  onConfirm={() => settleDiscard(true)}
  onCancel={() => settleDiscard(false)}
/>

<AlertDialog
  open={saveIssuesConfirm !== null}
  title={t("workflows.saveWithIssuesTitle")}
  description={t("workflows.saveWithIssuesMessage", { count: saveIssuesConfirm?.count ?? 0 })}
  confirmLabel={t("workflows.saveAnyway")}
  confirmVariant="default"
  onConfirm={() => settleSaveIssues(true)}
  onCancel={() => settleSaveIssues(false)}
/>

<!-- Step/trigger detail content, rendered either in the docked sidebar or
     in a floating panel anchored beneath the selected node. -->
{#snippet detailPanel()}
  {#if workflow}
    {#if selectedStep}
      <WorkflowStepSidebar
        workflowName={workflow.name}
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
        {cachedVariableKeys}
        {customStepTypes}
        outputSchemas={activeOutputSchemas}
        onclose={closeSidebar}
        onSlugInput={onStepSlugInput}
        onRemoveStep={removeStep}
        onUpdateDraftStep={updateDraftStep}
        onValidationErrorsChange={(errors) => {
          validationErrors = errors;
        }}
        onEditAsJsonChange={(v) => {
          editAsJson = v;
        }}
        onViewAsJsonChange={(v) => {
          viewAsJson = v;
        }}
      />
    {:else if triggerSelected}
      <WorkflowTriggerPanel
        trigger={workflow.trigger}
        workflowName={workflow.name}
        draftTrigger={editMode && editDraft ? editDraft.trigger : null}
        {validationErrors}
        portalRunAs={workflow.portalRunAs ?? null}
        {availableTriggerRefs}
        {metaLoading}
        onclose={closeSidebar}
        onTriggerChange={(trigger) => {
          commitDraft({ ...editDraft!, trigger }, "trigger");
        }}
        onValidationErrorsChange={(errors) => {
          validationErrors = errors;
        }}
      />
    {/if}
  {/if}
{/snippet}

{#snippet floatingDetailPanel()}
  <div class="h-[32rem] max-h-[60vh] overflow-hidden rounded-lg border border-border bg-background shadow-xl">
    {@render detailPanel()}
  </div>
{/snippet}
