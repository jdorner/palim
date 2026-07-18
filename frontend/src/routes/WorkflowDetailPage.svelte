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
import { onDestroy } from "svelte";
import { authFetch } from "$lib/auth";
import LoadingIndicator from "$lib/components/LoadingIndicator.svelte";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "$lib/components/ui/table";
import { formatTimestamp, isRunCancellable, renderMarkdown, statusVariant } from "$lib/utils";
import { type WorkflowEvent, workflowStore } from "$lib/workflowRunStore.svelte";
import {
  type StepDraft,
  serializeWorkflowDraft,
  validateSlug,
  validateStepSlugsUnique,
  validateWorkflowDraft,
  type WorkflowDraft,
} from "$lib/workflowValidation";
import MultiSelect from "../components/MultiSelect.svelte";
import StatusDot from "../components/StatusDot.svelte";
import WorkflowGraph from "../components/WorkflowGraph.svelte";
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

interface WorkflowDetail {
  name: string;
  description?: string;
  trigger: { type: string; ref?: string };
  enabled?: boolean;
  steps: StepDef[];
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
let activeTab = $state("runs");

// Edit mode state
let editMode = $state(false);
let editDraft = $state<WorkflowDraft | null>(null);
let saving = $state(false);
let saveError = $state<string | null>(null);
let validationErrors = $state<Map<string, string>>(new Map());

// Meta endpoint state for tools/skills
let availableTools = $state<string[]>([]);
let availableSkills = $state<string[]>([]);
let availableTriggerRefs = $state<Record<string, string[]>>({
  webhook: [],
  schedule: [],
  filewatcher: [],
});
let metaLoading = $state(false);

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

/** Enter edit mode with a deep copy of the current workflow data. */
function enterEditMode() {
  if (!workflow) return;
  editDraft = {
    name: workflow.name,
    description: workflow.description ?? "",
    trigger: { type: workflow.trigger.type, ref: workflow.trigger.ref ?? "" },
    enabled: workflow.enabled ?? true,
    steps: workflow.steps.map((s) => ({
      slug: s.slug,
      type: s.type as "agent" | "webhook",
      prompt: s.prompt,
      tools: s.tools ? [...s.tools] : undefined,
      skills: s.skills ? [...s.skills] : undefined,
      url: s.url,
      method: s.method,
      body: s.body,
    })),
  };
  saveError = null;
  validationErrors = new Map();
  currentGraphEdges = [];
  editMode = true;
  fetchMeta();
}

/** Cancel edit mode, discard changes. */
function cancelEdit() {
  editMode = false;
  editDraft = null;
  saveError = null;
  validationErrors = new Map();
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

/** Add a new empty step to the draft. */
function addStep() {
  if (!editDraft) return;
  editDraft = {
    ...editDraft,
    steps: [...editDraft.steps, { slug: "", type: "agent", prompt: "" }],
  };
  // Mark the new step's slug and prompt as needing validation (empty = required)
  const newErrors = new Map(validationErrors);
  const newIndex = editDraft.steps.length - 1;
  newErrors.set(`steps[${newIndex}].slug`, "Slug is required");
  newErrors.set(`steps[${newIndex}].prompt`, "Prompt is required for agent steps");
  validationErrors = newErrors;

  // Auto-select the new step in the sidebar
  selectedStep = editDraft.steps[newIndex] as StepDef;
  selectedStepIndex = newIndex;
  sidebarOpen = true;
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

/** Update the type of a step at the given index. */
function onStepTypeChange(index: number, value: string) {
  if (!editDraft) return;
  editDraft = {
    ...editDraft,
    steps: editDraft.steps.map((s, i) => (i === index ? { ...s, type: value as "agent" | "webhook" } : s)),
  };
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
  const errors = validateWorkflowDraft(orderedDraft);
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

onDestroy(() => {
  unsubWorkflow();
});
</script>

{#if loading}
  <LoadingIndicator />
{:else if error}
  <p class="text-sm text-destructive">{error}</p>
{:else if workflow}
  <div class="flex flex-col h-[calc(100vh-8rem)] overflow-hidden">
    <div class="flex items-center justify-between mb-4 shrink-0">
      <div class="flex items-center gap-4 align-top">
        <button
          type="button"
          class="px-3 py-1.5 text-sm rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          onclick={() => {
            navigate("/workflows");
          }}
        >
          Back
        </button>
        <h2 class="text-lg font-semibold text-nowrap">{workflow.name}</h2>
        {#if !editMode && workflow.description}
          <span class="text-sm text-muted-foreground">{workflow.description}</span>
        {/if}
      </div>
      <div class="flex items-center gap-2">
        {#if editMode}
          <Button size="sm" variant="default" onclick={saveWorkflow} disabled={saveDisabled}>
            {#if saving}
              Saving...
            {:else}
              Save
            {/if}
          </Button>
          <Button size="sm" variant="outline" onclick={cancelEdit}> Cancel </Button>
        {:else if confirmingDelete}
          <span class="text-sm font-bold text-destructive">Delete this workflow?</span>
          <Button size="sm" variant="destructive" onclick={() => deleteWorkflow()}> Confirm </Button>
          <Button size="sm" variant="outline" onclick={() => { confirmingDelete = false; }}> Cancel </Button>
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

    {#if editMode && editDraft}
      <div class="mb-4 shrink-0 grid grid-cols-1 md:grid-cols-2 gap-4 p-4 border border-border rounded-md bg-muted/30">
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
          value="runs"
          class="px-3 py-1.5 text-sm font-medium text-muted-foreground data-[state=active]:text-foreground data-[state=active]:border-b-2 data-[state=active]:border-primary -mb-px"
        >
          Runs ({workflow.runs.length})
        </Tabs.Trigger>
        <Tabs.Trigger
          value="diagram"
          class="px-3 py-1.5 text-sm font-medium text-muted-foreground data-[state=active]:text-foreground data-[state=active]:border-b-2 data-[state=active]:border-primary -mb-px"
        >
          Diagram
        </Tabs.Trigger>
      </Tabs.List>

      <Tabs.Content value="diagram" class="flex flex-col flex-1 min-h-0">
        <!-- Graph area -->
        <div class="flex flex-1 min-w-0 min-h-0 overflow-auto transition-all duration-200">
          <div class="flex-1 min-w-0 overflow-auto">
            <WorkflowGraph
              steps={(editDraft ?? workflow).steps.map((s) => ({
                slug: s.slug,
                type: s.type,
                status: "waiting" as const,
              }))}
              trigger={editMode && editDraft ? editDraft.trigger : workflow.trigger}
              {editMode}
              onNodeClick={onStepClick}
              onAddStep={addStep}
              onEdgesChange={editMode ? handleEdgesChange : undefined}
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
              <div class="w-[380px] h-full flex flex-col">
                <!-- Sidebar header -->
                <div class="px-4 pb-2 pt-2 flex flex-col gap-2">
                  <div class="flex items-center gap-2">
                    <button
                      type="button"
                      class="shrink-0 p-0 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                      onclick={closeSidebar}
                      aria-label="Close step detail sidebar"
                    >
                      ✕
                    </button>
                    {#if editMode}
                      <div class="flex-1 flex flex-col gap-0.5">
                        <input
                          type="text"
                          class="w-full px-2 py-1 text-sm border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
                          value={editDraftStep?.slug ?? selectedStep.slug}
                          maxlength={64}
                          oninput={(e) => onStepSlugInput(selectedStepIndex, (e.target as HTMLInputElement).value)}
                          placeholder="step-slug"
                        >
                        {#if validationErrors.get(`steps[${selectedStepIndex}].slug`)}
                          <span class="text-xs text-destructive"
                            >{validationErrors.get(`steps[${selectedStepIndex}].slug`)}</span
                          >
                        {/if}
                      </div>
                      <button
                        type="button"
                        class="shrink-0 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        disabled={!editDraft || editDraft.steps.length <= 1}
                        onclick={() => { removeStep(selectedStepIndex); closeSidebar(); }}
                        aria-label="Remove step"
                        title={!editDraft || editDraft.steps.length <= 1 ? "At least one step is required" : `Remove step ${editDraftStep?.slug || "(unnamed)"}`}
                      >
                        <TrashIcon size={14} aria-hidden="true" />
                      </button>
                    {:else}
                      <span class="text-sm font-medium truncate">{selectedStep.slug}</span>
                    {/if}
                  </div>
                  {#if editMode}
                    {#if validationErrors.get("steps.removeWarning")}
                      <div
                        class="flex items-center gap-1.5 px-2 py-1 rounded-md bg-yellow-500/10 text-yellow-600 dark:text-yellow-400"
                      >
                        <WarningIcon size={12} class="shrink-0" aria-hidden="true" />
                        <span class="text-xs">{validationErrors.get("steps.removeWarning")}</span>
                      </div>
                    {/if}
                    <label for="step-type" class="text-xs font-medium text-muted-foreground">Type</label>
                    <select
                      id="step-type"
                      class="px-2 py-1 text-sm border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
                      value={editDraftStep?.type ?? selectedStep.type}
                      onchange={(e) => {
                        const newType = (e.target as HTMLSelectElement).value as "agent" | "webhook";
                        editDraft = editDraft ? { ...editDraft, steps: editDraft.steps.map((s, i) => (i === selectedStepIndex ? { ...s, type: newType } : s)) } : null;
                        const newErrors = new Map(validationErrors);
                        if (newType === "agent") {
                          newErrors.delete(`steps[${selectedStepIndex}].prompt`);
                        }
                        validationErrors = newErrors;
                      }}
                    >
                      <option value="agent">agent</option>
                      <option value="webhook">webhook</option>
                    </select>
                  {:else}
                    <label for="step-type" class="text-xs font-medium text-muted-foreground">Type:</label>
                    <Badge variant="outline" class="w-fit">{selectedStep.type}</Badge>
                  {/if}
                </div>

                <!-- Sidebar content -->
                <div class="flex-1 overflow-y-auto min-h-0 p-4">
                  {#if editMode && editDraftStep && (editDraftStep.type ?? selectedStep?.type) === "agent"}
                    <!-- Edit mode: agent step -->
                    <div class="space-y-4">
                      <div class="flex flex-col gap-1.5">
                        <span class="text-xs font-medium text-muted-foreground">Tools</span>
                        <MultiSelect
                          items={availableTools}
                          selected={editDraftStep.tools ?? []}
                          placeholder="Search tools..."
                          disabled={metaLoading || availableTools.length === 0}
                          onchange={(newSelected) => updateDraftStep(selectedStepIndex, (s) => { s.tools = newSelected; })}
                        />
                      </div>

                      <div class="flex flex-col gap-1.5">
                        <span class="text-xs font-medium text-muted-foreground">Skills</span>
                        <MultiSelect
                          items={availableSkills}
                          selected={editDraftStep.skills ?? []}
                          placeholder="Search skills..."
                          disabled={metaLoading || availableSkills.length === 0}
                          onchange={(newSelected) => updateDraftStep(selectedStepIndex, (s) => { s.skills = newSelected; })}
                        />
                      </div>

                      <div class="flex flex-col gap-1.5">
                        <label for="step-prompt" class="text-xs font-medium text-muted-foreground">Prompt</label>
                        <textarea
                          id="step-prompt"
                          class="w-full min-h-[160px] px-2 py-1.5 text-sm font-mono border border-border rounded-md bg-background resize-y focus:outline-none focus:ring-2 focus:ring-ring"
                          maxlength={10000}
                          value={editDraftStep.prompt ?? ""}
                          oninput={(e) => {
                            updateDraftStep(selectedStepIndex, (s) => { s.prompt = (e.target as HTMLTextAreaElement).value; });
                            const newErrors = new Map(validationErrors);
                            newErrors.delete(`steps[${selectedStepIndex}].prompt`);
                            validationErrors = newErrors;
                          }}
                          placeholder="Enter step prompt..."
                        ></textarea>
                        <div class="flex items-center justify-between">
                          {#if validationErrors.get(`steps[${selectedStepIndex}].prompt`)}
                            <span class="text-xs text-destructive"
                              >{validationErrors.get(`steps[${selectedStepIndex}].prompt`)}</span
                            >
                          {:else}
                            <span></span>
                          {/if}
                          <span class="text-xs text-muted-foreground"
                            >{(editDraftStep.prompt ?? "").length}
                            / 10000</span
                          >
                        </div>
                      </div>
                    </div>
                  {:else if editMode && editDraftStep && (editDraftStep.type ?? selectedStep?.type) === "webhook"}
                    <!-- Edit mode: webhook step -->
                    <div class="space-y-4">
                      <div class="flex flex-col gap-1.5">
                        <label for="step-url" class="text-xs font-medium text-muted-foreground">URL</label>
                        <input
                          id="step-url"
                          type="text"
                          class="w-full px-2 py-1.5 text-sm border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
                          value={editDraftStep.url ?? ""}
                          oninput={(e) => {
                            updateDraftStep(selectedStepIndex, (s) => { s.url = (e.target as HTMLInputElement).value; });
                            const newErrors = new Map(validationErrors);
                            newErrors.delete(`steps[${selectedStepIndex}].url`);
                            validationErrors = newErrors;
                          }}
                          placeholder="https://..."
                        >
                        {#if validationErrors.get(`steps[${selectedStepIndex}].url`)}
                          <span class="text-xs text-destructive"
                            >{validationErrors.get(`steps[${selectedStepIndex}].url`)}</span
                          >
                        {/if}
                      </div>
                      <div class="flex flex-col gap-1.5">
                        <label for="step-method" class="text-xs font-medium text-muted-foreground">Method</label>
                        <select
                          id="step-method"
                          class="px-2 py-1.5 text-sm border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
                          value={editDraftStep.method ?? "POST"}
                          onchange={(e) => updateDraftStep(selectedStepIndex, (s) => { s.method = (e.target as HTMLSelectElement).value; })}
                        >
                          <option value="GET">GET</option>
                          <option value="POST">POST</option>
                          <option value="PUT">PUT</option>
                          <option value="DELETE">DELETE</option>
                        </select>
                      </div>
                      <div class="flex flex-col gap-1.5">
                        <label for="step-body" class="text-xs font-medium text-muted-foreground">Body</label>
                        <textarea
                          id="step-body"
                          class="w-full min-h-[100px] px-2 py-1.5 text-sm font-mono border border-border rounded-md bg-background resize-y focus:outline-none focus:ring-2 focus:ring-ring"
                          value={editDraftStep.body ?? ""}
                          oninput={(e) => updateDraftStep(selectedStepIndex, (s) => { s.body = (e.target as HTMLTextAreaElement).value; })}
                          placeholder="Optional request body..."
                        ></textarea>
                      </div>
                    </div>
                  {:else if !editMode && selectedStep?.type === "agent" && selectedStep.prompt}
                    <div class="space-y-3">
                      <div class="flex items-center gap-1.5 flex-wrap">
                        <span class="text-xs font-medium text-muted-foreground">Tools:</span>
                        {#if selectedStep.tools?.length}
                          {#each selectedStep.tools as tool}
                            <Badge variant="outline" class="text-xs">{tool}</Badge>
                          {/each}
                        {:else}
                          <Badge variant="outline" class="text-xs">none</Badge>
                        {/if}
                      </div>

                      <div class="flex items-center gap-1.5 flex-wrap">
                        <span class="text-xs font-medium text-muted-foreground">Skills:</span>
                        {#if selectedStep.skills?.length}
                          {#each selectedStep.skills as skill}
                            <Badge variant="outline" class="text-xs">{skill}</Badge>
                          {/each}
                        {:else}
                          <Badge variant="outline" class="text-xs">none</Badge>
                        {/if}
                      </div>

                      <div>
                        <span class="text-xs font-medium text-muted-foreground">Prompt:</span>
                        <pre
                          class="text-xs font-mono whitespace-pre-wrap wrap-break-word bg-muted p-3 rounded mt-1"
                        >{@html renderMarkdown(selectedStep.prompt)}</pre>
                      </div>
                    </div>
                  {:else if !editMode && selectedStep.type === "webhook"}
                    <div class="space-y-3">
                      <div>
                        <span class="text-xs font-medium text-muted-foreground">URL</span>
                        <code class="block text-xs font-mono bg-muted px-2 py-1 rounded mt-0.5"
                          >{selectedStep.method ?? "POST"} {selectedStep.url}</code
                        >
                      </div>
                      {#if selectedStep.body}
                        <div>
                          <span class="text-xs font-medium text-muted-foreground">Body</span>
                          <pre
                            class="text-xs font-mono whitespace-pre-wrap wrap-break-word bg-muted p-3 rounded max-h-32 overflow-y-auto mt-0.5"
                          >{selectedStep.body}</pre>
                        </div>
                      {/if}
                    </div>
                  {:else}
                    <p class="text-sm text-muted-foreground">No details available for this step type.</p>
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
