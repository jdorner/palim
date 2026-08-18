<script lang="ts">
import CheckCircleIcon from "phosphor-svelte/lib/CheckCircleIcon";
import TrashIcon from "phosphor-svelte/lib/TrashIcon";
import { cancelJob, cleaning, cleanQueue, jobs } from "$lib/appStore";
import { authFetch } from "$lib/auth";
import { Button } from "$lib/components/ui/button";
import { type WorkflowEvent, workflowStore } from "$lib/workflowRunStore.svelte";
import JobFilters from "../components/JobFilters.svelte";
import JobList from "../components/JobList.svelte";

let selectedStatuses = $state(new Set<string>());
let selectedQueues = $state(new Set<string>());

let filterKey = $derived(`${[...selectedStatuses].sort().join(",")}|${[...selectedQueues].sort().join(",")}`);

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

// Fetch workflow run statuses to enrich aggregate status for workflow groups
(async () => {
  try {
    const res = await authFetch("/ext/workflows");
    if (res.ok) {
      const workflows = await res.json();
      const statuses: Record<string, string> = {};
      for (const wf of workflows) {
        const runRes = await authFetch(`/ext/workflows/${wf.name}`);
        if (runRes.ok) {
          const wfDetail = await runRes.json();
          for (const run of wfDetail.runs ?? []) {
            statuses[run.runId] = run.status;
          }
        }
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
    onclick={() => cleanQueue("completed")}
  >
    <CheckCircleIcon size={14} class="mr-1.5" aria-hidden="true" />
    {$cleaning ? "Cleaning..." : "Clean Completed"}
  </Button>
  <Button
    size="sm"
    variant="destructive"
    disabled={$cleaning || !$jobs.some((j) => j.status === "failed")}
    onclick={() => cleanQueue("failed")}
  >
    <TrashIcon size={14} class="mr-1.5" aria-hidden="true" />
    {$cleaning ? "Cleaning..." : "Clean Failed"}
  </Button>
</div>

<JobFilters bind:selectedStatuses bind:selectedQueues jobs={$jobs} />
{#if runStatusesLoaded}
  <JobList jobs={filteredJobs} onCancelJob={cancelJob} {filterKey} {runStatuses} />
{/if}
