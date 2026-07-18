<script lang="ts">
import CheckCircleIcon from "phosphor-svelte/lib/CheckCircleIcon";
import TrashIcon from "phosphor-svelte/lib/TrashIcon";
import { cancelJob, cleaning, cleanQueue, jobs } from "$lib/appStore";
import { Button } from "$lib/components/ui/button";
import JobFilters from "../components/JobFilters.svelte";
import JobList from "../components/JobList.svelte";

let selectedStatuses = $state(new Set<string>());
let selectedQueues = $state(new Set<string>());

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
<JobList jobs={filteredJobs} onCancelJob={cancelJob} />
