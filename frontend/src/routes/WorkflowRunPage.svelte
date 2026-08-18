<script lang="ts">
import ArrowCounterClockwiseIcon from "phosphor-svelte/lib/ArrowCounterClockwiseIcon";
import PauseCircleIcon from "phosphor-svelte/lib/PauseCircleIcon";
import { onDestroy, onMount } from "svelte";
import { authFetch } from "$lib/auth";
import LoadingIndicator from "$lib/components/LoadingIndicator.svelte";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { formatTimestamp, isRunCancellable, renderMarkdown, statusVariant } from "$lib/utils";
import { type RunStep, workflowStore } from "$lib/workflowRunStore.svelte";
import SignalDeliveryForm from "../components/SignalDeliveryForm.svelte";
import WorkflowGraph from "../components/WorkflowGraph.svelte";
import { navigate, route } from "../router";

type StepStatus = "waiting" | "active" | "completed" | "failed" | "waiting-signal" | "skipped";

let loading = $state(true);
let error = $state<string | null>(null);
let retrying = $state(false);
let cancelling = $state(false);
let inspectedStep = $state<RunStep | null>(null);
let stepLogs = $state<Array<{ message: string; timestamp: number }>>([]);
let loadingLogs = $state(false);

/** Full workflow definition steps (recursive tree with branches). */
let definitionSteps = $state<Array<Record<string, unknown>>>([]);

const params = $derived(route.params as { name?: string; runId?: string });
const runId = $derived(params.runId ?? "");
const workflowName = $derived(params.name ?? "");

/** Reactive reference to the store's run state. */
const run = $derived(workflowStore.run);

/**
 * Builds a slug-to-status map from the run steps, including skipped branch detection.
 * Steps in the run get their actual status. All other steps in the definition
 * that were not executed get "skipped" (if the run is past their branch point)
 * or "waiting" (if the run hasn't reached them yet).
 */
const statusMap = $derived.by((): Record<string, StepStatus> => {
  if (!run) return {};
  const map: Record<string, StepStatus> = {};

  // Map executed steps by slug
  for (const step of run.steps) {
    map[step.slug] = step.status as StepStatus;
  }

  // Mark definition steps not in the run based on branch analysis
  const chosenBranches = workflowStore.chosenBranches;
  markSkippedSteps(definitionSteps, map, chosenBranches, run.status);

  return map;
});

/**
 * Recursively walks the definition step tree and marks steps that were not
 * executed. If the parent CF node has completed and a branch was chosen,
 * steps in other branches are "skipped". Steps not yet reached are "waiting".
 */
function markSkippedSteps(
  steps: Array<Record<string, unknown>>,
  map: Record<string, StepStatus>,
  chosenBranches: Record<string, string>,
  runStatus: string,
): void {
  for (const step of steps) {
    const slug = step.slug as string;
    const type = step.type as string;

    // If the step already has a status from the run, skip it
    if (map[slug] !== undefined) {
      // But still recurse into CF branches to mark branch children
      if (type === "if" || type === "case") {
        markCfBranches(step, slug, map, chosenBranches, runStatus);
      }
      continue;
    }

    // Step not in run - determine if skipped or just not reached
    // If the run is completed or failed, any step not executed was skipped
    if (runStatus === "completed" || runStatus === "failed") {
      map[slug] = "skipped";
    }
    // Otherwise it hasn't been reached yet
  }
}

/**
 * Marks children of a control flow node based on which branch was chosen.
 */
function markCfBranches(
  step: Record<string, unknown>,
  slug: string,
  map: Record<string, StepStatus>,
  chosenBranches: Record<string, string>,
  runStatus: string,
): void {
  const chosen = chosenBranches[slug];
  const cfStatus = map[slug];
  const cfCompleted = cfStatus === "completed";

  if (step.type === "if") {
    const thenSteps = (step.then as Array<Record<string, unknown>>) ?? [];
    const elseSteps = (step.else as Array<Record<string, unknown>>) ?? [];

    if (cfCompleted && chosen) {
      // Mark the not-chosen branch as skipped
      const skippedBranch = chosen === "then" ? elseSteps : thenSteps;
      const takenBranch = chosen === "then" ? thenSteps : elseSteps;
      markBranchSkipped(skippedBranch, map);
      markSkippedSteps(takenBranch, map, chosenBranches, runStatus);
    } else {
      // CF not yet completed - recurse normally
      markSkippedSteps(thenSteps, map, chosenBranches, runStatus);
      markSkippedSteps(elseSteps, map, chosenBranches, runStatus);
    }
  } else if (step.type === "case") {
    const paths = (step.paths as Record<string, Array<Record<string, unknown>>>) ?? {};
    const defaultSteps = (step.default as Array<Record<string, unknown>>) ?? [];

    if (cfCompleted && chosen) {
      // Map __default to default for case step matching
      const normalizedChosen = chosen === "__default" ? "default" : chosen;
      // Mark all non-chosen paths as skipped
      for (const [pathKey, pathSteps] of Object.entries(paths)) {
        if (pathKey === normalizedChosen) {
          markSkippedSteps(pathSteps, map, chosenBranches, runStatus);
        } else {
          markBranchSkipped(pathSteps, map);
        }
      }
      if (normalizedChosen === "default") {
        markSkippedSteps(defaultSteps, map, chosenBranches, runStatus);
      } else {
        markBranchSkipped(defaultSteps, map);
      }
    } else {
      for (const pathSteps of Object.values(paths)) {
        markSkippedSteps(pathSteps, map, chosenBranches, runStatus);
      }
      markSkippedSteps(defaultSteps, map, chosenBranches, runStatus);
    }
  }
}

/** Marks all steps in a branch as skipped (recursively). */
function markBranchSkipped(steps: Array<Record<string, unknown>>, map: Record<string, StepStatus>): void {
  for (const step of steps) {
    const slug = step.slug as string;
    if (!map[slug]) {
      map[slug] = "skipped";
    }
    // Recurse into nested CF branches
    if (step.type === "if") {
      const thenSteps = (step.then as Array<Record<string, unknown>>) ?? [];
      const elseSteps = (step.else as Array<Record<string, unknown>>) ?? [];
      markBranchSkipped(thenSteps, map);
      markBranchSkipped(elseSteps, map);
    } else if (step.type === "case") {
      const paths = (step.paths as Record<string, Array<Record<string, unknown>>>) ?? {};
      const defaultSteps = (step.default as Array<Record<string, unknown>>) ?? [];
      for (const pathSteps of Object.values(paths)) {
        markBranchSkipped(pathSteps, map);
      }
      markBranchSkipped(defaultSteps, map);
    }
  }
}

async function fetchRun() {
  if (!runId) return;
  loading = true;
  error = null;
  try {
    // Fetch both run data and workflow definition in parallel
    const [runRes, defRes] = await Promise.all([
      authFetch(`/ext/workflows/runs/${runId}`),
      authFetch(`/ext/workflows/${workflowName}`),
    ]);
    if (!runRes.ok) throw new Error(`HTTP ${runRes.status}`);
    const detail = await runRes.json();
    workflowStore.track(runId, detail);

    // Load definition steps (best-effort; fall back to run steps if unavailable)
    if (defRes.ok) {
      const def = await defRes.json();
      definitionSteps = def.steps ?? [];
    }
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load run";
  } finally {
    loading = false;
  }
}

let sidebarOpen = $state(false);

async function retryRun() {
  if (!runId) return;
  retrying = true;
  try {
    const res = await authFetch(`/ext/workflows/runs/${runId}/retry`, { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error("Failed to retry workflow run:", err);
  } finally {
    retrying = false;
  }
}

async function cancelRun() {
  if (!runId) return;
  cancelling = true;
  try {
    const res = await authFetch(`/ext/workflows/runs/${runId}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    navigate("/workflows/:name", { params: { name: `${workflowName}` } });
  } catch (err) {
    console.error("Failed to cancel workflow run:", err);
  } finally {
    cancelling = false;
  }
}

async function openSidebar(step: { slug: string; type: string; status?: string; jobId?: string }) {
  const found = run?.steps.find((s) => s.slug === step.slug);
  if (!found) {
    // Step exists in definition but was not executed (skipped) - just show status
    if (step.status === "skipped") {
      inspectedStep = { slug: step.slug, type: step.type, status: "waiting", jobId: "" };
      stepLogs = [];
      sidebarOpen = true;
    }
    return;
  }

  // Double-clicking the same step toggles the sidebar closed
  if (inspectedStep?.slug === found.slug && sidebarOpen) {
    closeSidebar();
    return;
  }

  inspectedStep = found;
  stepLogs = [];
  sidebarOpen = true;

  if (found.jobId) {
    loadingLogs = true;
    try {
      const res = await authFetch(`/api/jobs/${found.jobId}/logs`);
      if (res.ok) {
        const data = await res.json();
        stepLogs = data.logs ?? [];
      }
    } catch {
      /* ignore */
    }
    loadingLogs = false;
  }
}

function closeSidebar() {
  sidebarOpen = false;
  // Delay clearing data so the slide-out animation can play
  setTimeout(() => {
    if (!sidebarOpen) {
      inspectedStep = null;
      stepLogs = [];
    }
  }, 200);
}

onMount(() => {
  fetchRun();
});
onDestroy(() => {
  workflowStore.untrack();
});
</script>

{#if loading}
  <LoadingIndicator />
{:else if error}
  <p class="text-sm text-destructive">{error}</p>
{:else if run}
  <div class="flex flex-col h-[calc(100vh-8rem)] overflow-hidden">
    <div class="flex items-center justify-between mb-4 shrink-0">
      <div class="flex items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          onclick={() => {
            navigate("/workflows/:name", {
              params: { name: `${workflowName}` },
            });
          }}
        >
          &laquo;&nbsp;Back
        </Button>
        <span class="text-xs text-muted-foreground font-mono">Run: {run.runId.slice(0, 8)}</span>
      </div>
      <div class="flex items-center gap-2">
        {#if run.status === "failed"}
          <Button size="sm" variant="default" onclick={retryRun} disabled={retrying}>
            <ArrowCounterClockwiseIcon size={14} class="mr-1.5" aria-hidden="true" />
            {retrying ? "Retrying..." : "Retry"}
          </Button>
        {/if}
        {#if isRunCancellable(run.status)}
          <Button size="sm" variant="destructive" onclick={cancelRun} disabled={cancelling}>
            <span class="text-xs font-bold mr-1.5" aria-hidden="true">&#x2715;</span>
            {cancelling ? "Cancelling..." : "Cancel"}
          </Button>
        {/if}
        <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
      </div>
    </div>

    <div class="flex flex-1 min-h-0 gap-0">
      <!-- Graph area -->
      <div class="flex-1 min-w-0 overflow-auto transition-all duration-200">
        <WorkflowGraph
          steps={(definitionSteps.length > 0 ? definitionSteps : run.steps.map((s) => ({
            slug: s.slug,
            type: s.type,
            status: s.status,
            jobId: s.jobId,
          }))) as Array<{ slug: string; type: string; [key: string]: unknown }>}
          trigger={run.trigger ?? undefined}
          statusMap={definitionSteps.length > 0 ? statusMap : undefined}
          onNodeClick={openSidebar}
        />
      </div>

      <!-- Log sidebar -->
      <div
        class="shrink-0 overflow-hidden transition-all duration-200 ease-in-out bg-background"
        class:w-0={!sidebarOpen}
        class:border-l-0={!sidebarOpen}
        class:w-[380px]={sidebarOpen}
      >
        {#if inspectedStep}
          <div class="w-95 h-full flex flex-col">
            <!-- Sidebar header -->
            <div class="flex items-center gap-2 px-4 pb-2 pt-0">
              <button
                type="button"
                class="shrink-0 p-0 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                onclick={closeSidebar}
                aria-label="Close log sidebar"
              >
                ✕
              </button>
              <span class="text-sm font-medium truncate">{inspectedStep.slug}</span>
              <Badge variant={statusVariant(inspectedStep.status)}>{inspectedStep.status}</Badge>
            </div>

            <!-- Sidebar content -->
            <div class="flex-1 overflow-y-auto min-h-0 p-4">
              {#if inspectedStep.status === "waiting"}
                <p class="text-sm text-muted-foreground">Waiting for previous step to complete</p>
              {:else if inspectedStep.status === "waiting-signal"}
                <div class="flex items-center gap-2 mb-3">
                  <PauseCircleIcon size={16} class="text-amber-500" aria-hidden="true" />
                  <p class="text-sm text-muted-foreground">Waiting for external signal</p>
                </div>
                {#if inspectedStep.waitEvent}
                  <SignalDeliveryForm
                    runId={run.runId}
                    event={inspectedStep.waitEvent}
                    inputSchema={inspectedStep.waitInputSchema}
                  />
                {/if}
              {:else if loadingLogs}
                <p class="text-sm text-muted-foreground">Loading logs...</p>
              {:else if stepLogs.length === 0}
                <p class="text-sm text-muted-foreground">No logs available</p>
              {:else}
                <div class="space-y-1">
                  {#each stepLogs as log}
                    <div class="flex flex-col gap-0.5 text-xs font-mono bg-muted p-2 rounded">
                      {#if log.timestamp}
                        <span class="text-muted-foreground text-[10px]">{formatTimestamp(log.timestamp)}</span>
                      {/if}
                      <pre class="whitespace-pre-wrap wrap-break-word">{@html renderMarkdown(log.message)}</pre>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}
