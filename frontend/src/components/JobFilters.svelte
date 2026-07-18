<script lang="ts">
import type { JobEntry } from "../../../shared/types";

let {
  selectedStatuses = $bindable(new Set<string>()),
  selectedQueues = $bindable(new Set<string>()),
  jobs = [],
}: {
  selectedStatuses: Set<string>;
  selectedQueues: Set<string>;
  jobs?: JobEntry[];
} = $props();

const statuses = ["waiting", "active", "completed", "failed", "delayed", "unknown"];

/** Initial state: display all statuses */
selectedStatuses = new Set(statuses);

let allQueues = $derived([...new Set(jobs.map((j) => j.queue))].sort());

/** Extracts the extension name from a queue identifier (e.g. "scheduler:jobs" -> "scheduler"). */
function queueLabel(queue: string): string {
  return queue.split(":")[0];
}

/** Track whether the user has explicitly picked a specific queue */
let userHasFiltered = $state(false);

/** Keep selectedQueues in sync when new queues appear (only if showing all) */
$effect(() => {
  if (userHasFiltered) return;
  let changed = false;
  for (const q of allQueues) {
    if (!selectedQueues.has(q)) {
      selectedQueues.add(q);
      changed = true;
    }
  }
  if (changed) selectedQueues = new Set(selectedQueues);
});

let statusValue = $derived(
  selectedStatuses.size === statuses.length ? "__all__" : (statuses.find((s) => selectedStatuses.has(s)) ?? "__all__"),
);

let queueValue = $derived(
  allQueues.length > 0 && selectedQueues.size === allQueues.length
    ? "__all__"
    : (allQueues.find((q) => selectedQueues.has(q)) ?? "__all__"),
);

function onStatusSelect(e: Event) {
  const value = (e.target as HTMLSelectElement).value;
  if (value === "__all__") {
    selectedStatuses = new Set(statuses);
  } else {
    selectedStatuses = new Set([value]);
  }
}

function onQueueSelect(e: Event) {
  const value = (e.target as HTMLSelectElement).value;
  if (value === "__all__") {
    userHasFiltered = false;
    selectedQueues = new Set(allQueues);
  } else {
    userHasFiltered = true;
    selectedQueues = new Set([value]);
  }
}
</script>

<div class="filters-section">
  <div class="filter-row">
    <label class="filter-label" for="queue-filter">Queue:</label>
    <select
      id="queue-filter"
      class="filter-select"
      value={queueValue}
      disabled={allQueues.length === 0}
      onchange={onQueueSelect}
    >
      <option value="__all__">All Queues</option>
      {#each allQueues as queue}
        <option value={queue}>{queueLabel(queue)}</option>
      {/each}
    </select>
  </div>

  <div class="filter-row">
    <label class="filter-label" for="status-filter">Status:</label>
    <select id="status-filter" class="filter-select" value={statusValue} onchange={onStatusSelect}>
      <option value="__all__">All Statuses</option>
      {#each statuses as status}
        <option value={status}>{status}</option>
      {/each}
    </select>
  </div>
</div>

<style>
.filters-section {
  display: flex;
  flex-direction: row;
  gap: 0.5rem;
  padding: 1rem;
  border-radius: 0.5rem;
  margin-bottom: 1rem;
  background-color: hsl(var(--muted));
}

.filter-row {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding-left: 1rem;
}

.filter-label {
  font-weight: 500;
  font-size: 0.9rem;
  min-width: 3.5rem;
}

.filter-select {
  padding: 0.375rem 0.75rem;
  border-radius: 0.375rem;
  border: 1px solid hsl(var(--border));
  background-color: hsl(var(--background));
  color: hsl(var(--foreground));
  font-size: 0.875rem;
  cursor: pointer;
  outline: none;
}

.filter-select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.filter-select:focus {
  border-color: hsl(var(--ring));
  box-shadow: 0 0 0 2px hsl(var(--ring) / 0.2);
}
</style>
