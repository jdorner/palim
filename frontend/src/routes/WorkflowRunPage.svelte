<script lang="ts">
import ArrowCounterClockwiseIcon from "phosphor-svelte/lib/ArrowCounterClockwiseIcon";
import { onDestroy, onMount } from "svelte";
import { authFetch } from "$lib/auth";
import LoadingIndicator from "$lib/components/LoadingIndicator.svelte";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { formatTimestamp, isRunCancellable, renderMarkdown, statusVariant } from "$lib/utils";
import { type RunStep, workflowStore } from "$lib/workflowRunStore.svelte";
import WorkflowGraph from "../components/WorkflowGraph.svelte";
import { navigate, route } from "../router";

let loading = $state(true);
let error = $state<string | null>(null);
let retrying = $state(false);
let cancelling = $state(false);
let inspectedStep = $state<RunStep | null>(null);
let stepLogs = $state<Array<{ message: string; timestamp: number }>>([]);
let loadingLogs = $state(false);

const params = $derived(route.params as { name?: string; runId?: string });
const runId = $derived(params.runId ?? "");
const workflowName = $derived(params.name ?? "");

/** Reactive reference to the store's run state. */
const run = $derived(workflowStore.run);

async function fetchRun() {
  if (!runId) return;
  loading = true;
  error = null;
  try {
    const res = await authFetch(`/ext/workflows/runs/${runId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const detail = await res.json();
    workflowStore.track(runId, detail);
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
  if (!found) return;

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
        <button
          type="button"
          class="px-3 py-1.5 text-sm rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          onclick={() => {
            navigate("/workflows/:name", {
              params: { name: `${workflowName}` },
            });
          }}
        >
          Back
        </button>
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
          steps={run.steps.map((s) => ({
            slug: s.slug,
            type: s.type,
            status: s.status,
            jobId: s.jobId,
          }))}
          trigger={run.trigger ?? undefined}
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
          <div class="w-[380px] h-full flex flex-col">
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
