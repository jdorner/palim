<script lang="ts">
import CheckCircleIcon from "phosphor-svelte/lib/CheckCircleIcon";
import TrashIcon from "phosphor-svelte/lib/TrashIcon";
import { cleaning, cleanQueue, jobs } from "$lib/appStore";
import { authFetch } from "$lib/auth";
import { AlertDialog } from "$lib/components/ui/alert-dialog";
import { Button } from "$lib/components/ui/button";
import { t } from "$lib/i18n.svelte";
import { type WorkflowEvent, workflowStore } from "$lib/workflowRunStore.svelte";
import JobFilters from "../components/JobFilters.svelte";
import JobList from "../components/JobList.svelte";

let selectedStatuses = $state(new Set<string>());
let selectedQueues = $state(new Set<string>());

let filterKey = $derived(`${[...selectedStatuses].sort().join(",")}|${[...selectedQueues].sort().join(",")}`);

/** Bulk delete awaiting confirmation. */
let pendingClean = $state<"completed" | "failed" | null>(null);

let runStatuses = $state<Record<string, string>>({});
let runStatusesLoaded = $state(false);

// Subscribe to workflow events for real-time run status updates
function handleWorkflowEvent(msg: WorkflowEvent) {
  if (msg.type === "workflow_step_waiting" && msg.workflowRunId) {
    runStatuses = { ...runStatuses, [msg.workflowRunId]: "waiting-signal" };
  } else if ((msg.type === "workflow_step_resumed" || msg.type === "workflow_step_started") && msg.workflowRunId) {
    runStatuses = { ...runStatuses, [msg.workflowRunId]: "running" };
  } else if (msg.type === "workflow_completed" && msg.workflowRunId) {
    runStatuses = { ...runStatuses, [msg.workflowRunId]: "completed" };
  } else if (msg.type === "workflow_failed" && msg.workflowRunId) {
    runStatuses = { ...runStatuses, [msg.workflowRunId]: "failed" };
  }
}

const unsubWorkflow = workflowStore.subscribe(handleWorkflowEvent);

// Fetch workflow run statuses to enrich aggregate status for workflow groups.
// A single bulk request (GET /ext/workflows/runs) returns { runId, status }
// for every run across all workflows. This replaces the previous N+1 pattern
// (one /ext/workflows/:name request per workflow definition), which tripped
// the API rate limiter after a few page loads. Live updates thereafter arrive
// via workflowStore WebSocket events (handleWorkflowEvent above).
(async () => {
  try {
    const res = await authFetch("/ext/workflows/runs");
    if (res.ok) {
      const runs: Array<{ runId: string; status: string }> = await res.json();
      const statuses: Record<string, string> = {};
      for (const run of runs) {
        statuses[run.runId] = run.status;
      }
      runStatuses = statuses;
    }
  } catch {
    // Silently ignore - aggregate status will still work from job statuses
  } finally {
    runStatusesLoaded = true;
  }
})();

let filteredJobs = $derived(
  (() => {
    let filtered = $jobs;
    if (selectedStatuses.size > 0) {
      filtered = filtered.filter((j) => selectedStatuses.has(j.status));
    }
    if (selectedQueues.size > 0) {
      filtered = filtered.filter((j) => selectedQueues.has(j.queue));
    }
    return filtered.toSorted((a, b) => b.createdAt - a.createdAt);
  })(),
);
</script>

<div class="flex items-center gap-3 mb-6">
  <Button
    size="sm"
    variant="outline"
    disabled={$cleaning || !$jobs.some((j) => j.status === "completed")}
    onclick={() => (pendingClean = "completed")}
  >
    <CheckCircleIcon size={14} class="mr-1.5" aria-hidden="true" />
    {$cleaning ? t("common.deleting") : t("jobs.cleanCompleted")}
  </Button>
  <Button
    size="sm"
    variant="destructive"
    disabled={$cleaning || !$jobs.some((j) => j.status === "failed")}
    onclick={() => (pendingClean = "failed")}
  >
    <TrashIcon size={14} class="mr-1.5" aria-hidden="true" />
    {$cleaning ? t("common.deleting") : t("jobs.cleanFailed")}
  </Button>
</div>

<JobFilters bind:selectedStatuses bind:selectedQueues jobs={$jobs} />
{#if runStatusesLoaded}
  <JobList jobs={filteredJobs} {filterKey} {runStatuses} />
{/if}

<AlertDialog
  open={pendingClean !== null}
  title={pendingClean === "failed" ? t("jobs.cleanFailedTitle") : t("jobs.cleanCompletedTitle")}
  description={pendingClean === "failed" ? t("jobs.cleanFailedConfirm") : t("jobs.cleanCompletedConfirm")}
  confirmLabel={t("common.delete")}
  cancelLabel={t("common.cancel")}
  confirmVariant="destructive"
  onConfirm={() => {
    const type = pendingClean;
    pendingClean = null;
    if (type) cleanQueue(type);
  }}
  onCancel={() => {
    pendingClean = null;
  }}
/>
