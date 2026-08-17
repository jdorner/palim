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
import type { OutputSchemas } from "$lib/templateScope";
import { formatTimestamp, isRunCancellable, statusVariant } from "$lib/utils";
import { type WorkflowEvent, workflowStore } from "$lib/workflowRunStore.svelte";
import {
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
  steps: StepDef[];
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

/** Enter edit mode with a deep copy of the current workflow data. */
function enterEditMode() {
  if (!workflow) return;
  editDraft = {
    name: workflow.name,
    description: workflow.description ?? "",
    trigger: { type: workflow.trigger.type, ref: workflow.trigger.ref ?? "" },
    enabled: workflow.enabled ?? true,
    steps: workflow.steps.map((s) => {
      const { slug, type } = s;

      // Agent steps: extract known fields
      if (type === "agent") {
        const { prompt, tools, skills } = s;
        return {
          slug,
          type,
          prompt,
          tools: tools ? [...tools] : undefined,
          skills: skills ? [...skills] : undefined,
        };
      }

      // Control flow: if - preserve condition + branches
      if (type === "if") {
        return JSON.parse(JSON.stringify(s));
      }

      // Control flow: case - preserve match + paths + default
      if (type === "case") {
        return JSON.parse(JSON.stringify(s));
      }

      // Control flow: waitFor
      if (type === "waitFor") {
        return JSON.parse(JSON.stringify(s));
      }

      // Control flow: emit
      if (type === "emit") {
        return JSON.parse(JSON.stringify(s));
      }

      // Custom extension step types: rebuild config from non-standard fields
      const { slug: _s, type: _t, input: _i, output: _o, ...config } = s;
      return {
        slug,
        type,
        config: Object.keys(config).length > 0 ? config : undefined,
      };
    }),
  };
  saveError = null;
  validationErrors = new Map();
  currentGraphEdges = [];
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

/** Add a new step to the draft with the given type (defaults to "agent"). */
function addStep(type: string = "agent", branchContext?: { parentNodeId: string; branch: string }) {
  if (!editDraft) return;

  const template = stepTemplate(type);

  if (branchContext) {
    // Insert into a branch of a CF step
    const stepIndex = parseStepIndex(branchContext.parentNodeId);
    if (stepIndex === null || stepIndex >= editDraft.steps.length) return;

    editDraft = {
      ...editDraft,
      steps: editDraft.steps.map((s, i) => {
        if (i !== stepIndex) return s;
        return insertIntoBranch(s, branchContext.branch, template);
      }),
    };
  } else {
    // Append to top-level steps
    editDraft = {
      ...editDraft,
      steps: [...editDraft.steps, template],
    };
  }

  // Mark validation errors for the new step
  const newErrors = new Map(validationErrors);
  if (!branchContext) {
    const newIndex = editDraft.steps.length - 1;
    newErrors.set(`steps[${newIndex}].slug`, "Slug is required");
    if (type === "agent") {
      newErrors.set(`steps[${newIndex}].prompt`, "Prompt is required for agent steps");
    }
    // Auto-select the new step in the sidebar
    selectedStep = editDraft.steps[newIndex] as StepDef;
    selectedStepIndex = newIndex;
    sidebarOpen = true;
  }
  validationErrors = newErrors;
}

/**
 * Extracts the step array index from a graph node ID.
 * "step-2" -> 2, "step-0.then-0" -> 0
 */
function parseStepIndex(nodeId: string): number | null {
  const match = nodeId.match(/^step-(\d+)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * Inserts a new step into the specified branch of a CF step.
 * Handles "then", "else" for if steps, and path keys / "default" for case steps.
 */
function insertIntoBranch(step: StepDraft, branch: string, template: StepDraft): StepDraft {
  const copy = { ...step };

  if (step.type === "if") {
    if (branch === "then") {
      const current = (copy.then as StepDraft[] | undefined) ?? [];
      // biome-ignore lint/suspicious/noThenProperty: "then" is the workflow branch keyword, not a thenable
      copy.then = [...current, template];
    } else if (branch === "else") {
      const current = (copy.else as StepDraft[] | undefined) ?? [];
      copy.else = [...current, template];
    }
  } else if (step.type === "case") {
    if (branch === "default") {
      const current = (copy.default as StepDraft[] | undefined) ?? [];
      copy.default = [...current, template];
    } else {
      const paths = { ...((copy.paths as Record<string, StepDraft[]>) ?? {}) };
      const current = paths[branch] ?? [];
      paths[branch] = [...current, template];
      copy.paths = paths;
    }
  }

  return copy;
}

/** Returns a default step template for a given type. */
function stepTemplate(type: string): StepDraft {
  switch (type) {
    case "agent":
      return { slug: "", type: "agent", prompt: "" };
    case "if":
      return {
        slug: "",
        type: "if",
        condition: { ref: "" },
        // biome-ignore lint/suspicious/noThenProperty: "then" is the workflow branch keyword, not a thenable
        then: [],
      };
    case "case":
      return {
        slug: "",
        type: "case",
        match: "",
        paths: {},
      };
    case "waitFor":
      return { slug: "", type: "waitFor", event: "" };
    case "emit":
      return { slug: "", type: "emit", event: "" };
    default:
      // Custom extension step type
      return { slug: "", type };
  }
}

/**
 * Store the latest edge state from the graph without reordering steps.
 * Step order is resolved from edges only at save time to avoid visual disruption.
 */
let currentGraphEdges = $state<Edge[]>([]);

function handleEdgesChange(edges: Edge[]) {
  currentGraphEdges = edges;
}

/**
 * Resolves step order from edge topology. Used at save time to ensure
 * the serialized step array follows the user's edge connections.
 * Returns steps in topological order based on the current graph edges.
 */
function resolveStepOrderFromEdges(draft: WorkflowDraft): StepDraft[] {
  if (currentGraphEdges.length === 0) return draft.steps;

  // Filter to only step-to-step edges (exclude trigger and addStep edges)
  const stepEdges = currentGraphEdges.filter((e) => e.source.startsWith("step-") && e.target.startsWith("step-"));

  if (stepEdges.length === 0) return draft.steps;

  // Build adjacency using node IDs (index-based)
  const outgoing = new Map<string, string>();
  const incoming = new Set<string>();
  for (const edge of stepEdges) {
    outgoing.set(edge.source, edge.target);
    incoming.add(edge.target);
  }

  // All step node IDs
  const allStepIds = draft.steps.map((_, i) => `step-${i}`);

  // Find chain starts: step nodes with outgoing edges but no incoming edge from other steps
  const connectedSteps = new Set([...outgoing.keys(), ...incoming]);
  const chainStarts = [...connectedSteps].filter((id) => !incoming.has(id));

  // Walk the chain from each start to produce ordered node IDs
  const ordered: string[] = [];
  const visited = new Set<string>();

  for (const start of chainStarts) {
    let current: string | undefined = start;
    while (current && !visited.has(current)) {
      visited.add(current);
      ordered.push(current);
      current = outgoing.get(current);
    }
  }

  // Append any steps not part of the chain (disconnected nodes) in original order
  for (const id of allStepIds) {
    if (!visited.has(id)) {
      ordered.push(id);
    }
  }

  // Convert node IDs back to indices and reorder steps
  return ordered
    .map((id) => {
      const idx = Number.parseInt(id.replace("step-", ""), 10);
      return draft.steps[idx];
    })
    .filter(Boolean) as StepDraft[];
}

/** Remove a step at the given index. Returns false if removal was prevented. */
function removeStep(index: number) {
  if (!editDraft) return;
  if (editDraft.steps.length <= 1) return; // Prevent removal of last step

  const removedSlug = editDraft.steps[index].slug;
  editDraft = {
    ...editDraft,
    steps: editDraft.steps.filter((_, i) => i !== index),
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

/** Validate a step slug with debounced inline feedback. */
let stepSlugTimeouts: Map<number, ReturnType<typeof setTimeout>> = new Map();

function onStepSlugInput(index: number, value: string) {
  if (!editDraft) return;
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

  // Resolve step order from edge topology before validation and save
  const orderedDraft: WorkflowDraft = {
    ...editDraft,
    steps: resolveStepOrderFromEdges(editDraft),
  };

  // Run full validation
  const errors = validateWorkflowDraft(orderedDraft, customStepTypes);
  if (errors.size > 0) {
    validationErrors = errors;
    return;
  }

  saving = true;
  saveError = null;

  try {
    const res = await authFetch(`/ext/workflows/${workflow.name}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(serializeWorkflowDraft(orderedDraft)),
    });

    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      saveError = data?.error ?? `HTTP ${res.status}`;
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
    workflow = await res.json();
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

function onStepClick(step: { slug: string; type: string }, index: number) {
  const stepIndex = index;
  const def = editDraft ? editDraft.steps[stepIndex] : workflow?.steps[stepIndex];
  if (!def) return;

  if (selectedStepIndex === stepIndex && sidebarOpen) {
    closeSidebar();
    return;
  }

  selectedStep = def as StepDef;
  selectedStepIndex = stepIndex;
  sidebarOpen = true;
  viewAsJson = false;
}

function closeSidebar() {
  sidebarOpen = false;
  setTimeout(() => {
    if (!sidebarOpen) {
      selectedStep = null;
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
        {saveError}
      </div>
    {/if}

    {#if !editMode && workflow.warnings && workflow.warnings.length > 0}
      <div class="mb-4 px-3 py-2 rounded-md border border-amber-500/50 bg-amber-500/10 text-sm shrink-0">
        <div class="flex items-center gap-1.5 font-medium text-amber-500 mb-1">
          <WarningIcon size={14} aria-hidden="true" />
          Template {workflow.warnings.length === 1 ? "Issue" : "Issues"} ({workflow.warnings.length})
        </div>
        <ul class="list-disc list-inside text-xs text-amber-500/80 space-y-0.5">
          {#each workflow.warnings as warning}
            <li><span class="font-mono">{warning.stepSlug}.{warning.field}</span>: {warning.message}</li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if editMode && editDraft}
      <div
        class="mb-4 shrink-0 grid grid-cols-1 md:grid-cols-2 gap-4 p-4 border border-border rounded-md bg-muted/30"
        transition:slide={{ duration: 100 }}
      >
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

        <div class="flex flex-col gap-1"></div>

        <div class="flex flex-col gap-1">
          <label for="edit-trigger-type" class="text-xs font-medium text-muted-foreground">Trigger Type</label>
          <select
            id="edit-trigger-type"
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
            <label for="edit-trigger-ref" class="text-xs font-medium text-muted-foreground">Trigger Ref</label>
            <select
              id="edit-trigger-ref"
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
              trigger={editMode && editDraft ? editDraft.trigger : workflow.trigger}
              {editMode}
              selectedStepIndex={sidebarOpen ? selectedStepIndex : -1}
              {customStepTypes}
              onNodeClick={onStepClick}
              onAddStep={addStep}
              onEdgesChange={editMode ? handleEdgesChange : undefined}
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
              <div class="rounded-md border border-border p-4 space-y-3">
                <div class="flex items-center justify-between gap-2">
                  <a href="#/workflows/{name}/runs/{run.runId}" class="text-left">
                    <code class="text-xs font-mono font-medium">{run.runId.slice(0, 8)}</code>
                  </a>
                  <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
                </div>

                <div class="flex items-center gap-1">
                  {#each run.steps as step}
                    <StatusDot status={step.status} title="{step.slug}: {step.status}" />
                  {/each}
                </div>

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
                  <TableHead class="min-w-[10em]">Steps</TableHead>
                  <TableHead class="text-left">Status</TableHead>
                  <TableHead class="text-center min-w-[10em]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {#each paginatedRuns as run (run.runId)}
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
                    <TableCell>
                      <div class="flex items-center gap-1">
                        {#each run.steps as step}
                          <StatusDot status={step.status} title="{step.slug}: {step.status}" />
                        {/each}
                      </div>
                    </TableCell>
                    <TableCell class="text-left">
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
