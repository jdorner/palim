<script lang="ts">
import ArrowCounterClockwiseIcon from "phosphor-svelte/lib/ArrowCounterClockwiseIcon";
import CaretDownIcon from "phosphor-svelte/lib/CaretDownIcon";
import CaretLeftIcon from "phosphor-svelte/lib/CaretLeftIcon";
import CaretRightIcon from "phosphor-svelte/lib/CaretRightIcon";
import CheckIcon from "phosphor-svelte/lib/CheckIcon";
import CopyIcon from "phosphor-svelte/lib/CopyIcon";
import FileTextIcon from "phosphor-svelte/lib/FileTextIcon";
import { tick } from "svelte";
import type { SlideParams, TransitionConfig } from "svelte/transition";
import { slide } from "svelte/transition";
import { authFetch } from "$lib/auth";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "$lib/components/ui/table";
import { automationStyle, formatTimestamp, isJobCancellable } from "$lib/utils";
import type { JobEntry } from "../../../shared/types";
import JobLogs from "./JobLogs.svelte";
import StatusDot from "./StatusDot.svelte";

/**
 * Wraps Svelte's `slide` transition to guard against NaN height values.
 * When the element is inside a table cell that hasn't been laid out yet,
 * `offsetHeight` can be 0, causing `slide` to produce invalid keyframes.
 * In that case, fall back to a no-op transition.
 */
function safeSlide(node: Element, params?: SlideParams): TransitionConfig {
  const height = (node as HTMLElement).offsetHeight;
  if (!height || !Number.isFinite(height)) {
    return { duration: 0 };
  }
  return slide(node, params);
}

let { jobs, onCancelJob }: { jobs: JobEntry[]; onCancelJob?: (jobId: string) => void } = $props();

let selectedJobId = $state<string | null>(null);
let cancellingJobId = $state<string | null>(null);
let copiedJobId = $state<string | null>(null);
let expandedWorkflows = $state<Set<string>>(new Set());

/** Represents either a standalone job or a workflow group. */
type DisplayItem =
  | { type: "job"; job: JobEntry }
  | { type: "workflow"; workflowRunId: string; workflowName: string; jobs: JobEntry[]; aggregateStatus: string };

/**
 * Computes an aggregate status for a workflow group.
 * Priority: active > failed > waiting/delayed > completed
 */
function computeAggregateStatus(workflowJobs: JobEntry[]): string {
  if (workflowJobs.some((j) => j.status === "active")) return "active";
  if (workflowJobs.some((j) => j.status === "failed")) return "failed";
  if (workflowJobs.some((j) => j.status === "waiting" || j.status === "delayed")) return "waiting";
  if (workflowJobs.every((j) => j.status === "completed")) return "completed";
  return "unknown";
}

/**
 * Groups jobs by workflowRunId. Jobs without a workflowRunId remain standalone.
 * Workflow groups are sorted by the earliest createdAt among their jobs.
 */
let displayItems = $derived.by<DisplayItem[]>(() => {
  const workflowMap = new Map<string, JobEntry[]>();
  const standalone: JobEntry[] = [];

  for (const job of jobs) {
    if (job.workflowRunId) {
      const group = workflowMap.get(job.workflowRunId);
      if (group) group.push(job);
      else workflowMap.set(job.workflowRunId, [job]);
    } else {
      standalone.push(job);
    }
  }

  const items: DisplayItem[] = [];

  for (const job of standalone) {
    items.push({ type: "job", job });
  }

  for (const [workflowRunId, workflowJobs] of workflowMap) {
    // Sort steps by stepIndex
    workflowJobs.sort((a, b) => (a.stepIndex ?? 0) - (b.stepIndex ?? 0));
    const workflowName = workflowJobs[0].workflowName ?? "Workflow";
    items.push({
      type: "workflow",
      workflowRunId,
      workflowName,
      jobs: workflowJobs,
      aggregateStatus: computeAggregateStatus(workflowJobs),
    });
  }

  // Sort all items by createdAt descending (most recent first)
  items.sort((a, b) => {
    const tsA = a.type === "job" ? a.job.createdAt : Math.min(...a.jobs.map((j) => j.createdAt));
    const tsB = b.type === "job" ? b.job.createdAt : Math.min(...b.jobs.map((j) => j.createdAt));
    return tsB - tsA;
  });

  return items;
});

const PAGE_SIZE = 10;
let currentPage = $state(1);
let totalPages = $derived(Math.max(1, Math.ceil(displayItems.length / PAGE_SIZE)));
let paginatedItems = $derived(displayItems.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE));

// Clamp page if items disappear (e.g. after clean)
$effect(() => {
  if (currentPage > totalPages) {
    currentPage = totalPages;
  }
});

// Reset to page 1 when the input jobs change significantly (new filter)
$effect(() => {
  jobs;
  currentPage = 1;
});

function toggleWorkflow(workflowRunId: string) {
  const next = new Set(expandedWorkflows);
  if (next.has(workflowRunId)) next.delete(workflowRunId);
  else next.add(workflowRunId);
  expandedWorkflows = next;
}

/** Chain cancel confirmation state */
let chainDialog = $state<{
  open: boolean;
  jobId: string;
  workflowRunId: string;
  siblings: JobEntry[];
  loading: boolean;
}>({ open: false, jobId: "", workflowRunId: "", siblings: [], loading: false });

let chainCancelBtnEl = $state<HTMLButtonElement | undefined>(undefined);

$effect(() => {
  if (chainDialog.open) {
    tick().then(() => chainCancelBtnEl?.focus());
  }
});

async function copyWorkflowId(jobId: string, workflowId: string) {
  await navigator.clipboard.writeText(workflowId);
  copiedJobId = jobId;
  setTimeout(() => {
    copiedJobId = null;
  }, 1500);
}

function isCancellable(status: string): boolean {
  return isJobCancellable(status);
}

/** Extracts the extension name from a queue identifier (e.g. "scheduler:jobs" -> "scheduler"). */
function queueLabel(queue: string): string {
  return queue.split(":")[0];
}

/**
 * Checks if this job is part of a workflow chain. If so, shows the chain
 * cancel dialog. Otherwise falls through to a normal single cancel.
 */
async function handleCancel(jobId: string) {
  const job = jobs.find((j) => j.id === jobId);
  if (job?.queue !== "workflows:steps") {
    cancellingJobId = jobId;
    onCancelJob?.(jobId);
    setTimeout(() => {
      cancellingJobId = null;
    }, 3000);
    return;
  }

  chainDialog = { open: false, jobId, workflowRunId: "", siblings: [], loading: true };
  try {
    const res = await authFetch(`/api/jobs/${jobId}/chain`);
    if (!res.ok) {
      cancellingJobId = jobId;
      onCancelJob?.(jobId);
      setTimeout(() => {
        cancellingJobId = null;
      }, 3000);
      return;
    }
    const data = await res.json();
    chainDialog = {
      open: true,
      jobId,
      workflowRunId: data.workflowRunId,
      siblings: data.siblings,
      loading: false,
    };
  } catch {
    cancellingJobId = jobId;
    onCancelJob?.(jobId);
    setTimeout(() => {
      cancellingJobId = null;
    }, 3000);
  }
}

async function confirmCancelChain() {
  const { jobId } = chainDialog;
  chainDialog = { ...chainDialog, open: false };
  cancellingJobId = jobId;

  try {
    const res = await authFetch(`/api/jobs/${jobId}/cancel`, { method: "POST" });
    if (!res.ok) {
      console.error("Cancel chain failed:", await res.text());
    }
  } catch (err) {
    console.error("Failed to cancel chain:", err);
  } finally {
    setTimeout(() => {
      cancellingJobId = null;
    }, 3000);
  }
}

function dismissChainDialog() {
  chainDialog = { open: false, jobId: "", workflowRunId: "", siblings: [], loading: false };
}

let retryingJobId = $state<string | null>(null);

async function handleRetry(jobId: string) {
  retryingJobId = jobId;
  try {
    const res = await authFetch(`/api/jobs/${jobId}/retry`, { method: "POST" });
    if (!res.ok) {
      console.error("Retry failed:", await res.text());
    }
  } catch (err) {
    console.error("Failed to retry job:", err);
  } finally {
    setTimeout(() => {
      retryingJobId = null;
    }, 2000);
  }
}
/**
 * Svelte action that tracks the parent table's column widths and exposes them as CSS custom properties.
 * Inner nested tables can use these to stay aligned.
 */
function trackColumnWidths(container: HTMLElement) {
  function sync() {
    const firstRow = container.querySelector("table > thead > tr");
    if (!firstRow) return;
    const cells = firstRow.querySelectorAll("th");
    cells.forEach((cell, i) => {
      container.style.setProperty(`--col-${i}`, `${(cell as HTMLElement).offsetWidth}px`);
    });
  }
  sync();
  const ro = new ResizeObserver(sync);
  ro.observe(container);
  return {
    destroy() {
      ro.disconnect();
    },
  };
}
</script>

<svelte:window
  onkeydown={(e) => { if (e.key === "Escape") { if (chainDialog.open) dismissChainDialog(); else if (selectedJobId) selectedJobId = null; } }}
/>

<!-- Mobile & Tablet: Card layout -->
<div class="responsive-cards">
  {#each paginatedItems as item}
    {#if item.type === "job"}
      {@const job = item.job}
      <div class="rounded-md border border-border p-4 space-y-3 {job.error ? 'bg-destructive/5' : ''}">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <Badge variant="outline" class={automationStyle(queueLabel(job.queue)).border}
                >{queueLabel(job.queue)}</Badge
              >
              <StatusDot status={job.status} title={job.status} size="md" />
            </div>
            <p class="text-sm mt-1.5 truncate" title={job.description}>{job.description}</p>
            {#if job.error}
              <p class="text-xs text-destructive mt-0.5 truncate">{job.error}</p>
            {/if}
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>Created: {formatTimestamp(job.createdAt)}</span>
          <span>Completed: {job.completedAt ? formatTimestamp(job.completedAt) : "\u2013"}</span>
        </div>
        <hr>
        <div class="flex flex-wrap items-center gap-2">
          {#if job.status === "failed"}
            <Button size="sm" variant="default" disabled={retryingJobId === job.id} onclick={() => handleRetry(job.id)}>
              <ArrowCounterClockwiseIcon size={14} class="mr-1" aria-hidden="true" />
              {retryingJobId === job.id ? "..." : "Retry"}
            </Button>
          {/if}
          {#if isCancellable(job.status)}
            <Button
              size="sm"
              variant="destructive"
              disabled={cancellingJobId === job.id}
              onclick={() => handleCancel(job.id)}
            >
              <span class="text-xs font-bold mr-1.5" aria-hidden="true">&#x2715;</span>
              {cancellingJobId === job.id ? "..." : "Cancel"}
            </Button>
          {/if}
          <Button size="sm" variant="outline" onclick={() => (selectedJobId = job.id)}>
            <FileTextIcon size={14} class="mr-1" aria-hidden="true" />
            Logs
          </Button>
        </div>
      </div>
    {:else}
      {@const isExpanded = expandedWorkflows.has(item.workflowRunId)}
      <!-- biome-ignore lint/a11y/useSemanticElements: role="button" is intentional on a div acting as a clickable workflow group toggle -->
      <div
        class="rounded-md border border-border overflow-hidden cursor-pointer hover:bg-muted/50 transition-colors"
        onclick={() => toggleWorkflow(item.workflowRunId)}
        onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleWorkflow(item.workflowRunId); } }}
        role="button"
        tabindex="0"
        aria-expanded={isExpanded}
      >
        <div class="w-full p-4 flex flex-col gap-2 text-left">
          <div class="flex items-center gap-2">
            <Badge variant="outline" class={automationStyle("workflow").border}>workflow</Badge>
            <div class="flex items-center gap-1.5">
              {#each item.jobs as step}
                <StatusDot status={step.status} title="{step.description}: {step.status}" />
              {/each}
            </div>
          </div>
          <div class="flex items-center gap-2">
            {#if isExpanded}
              <CaretDownIcon size={14} class="shrink-0 text-muted-foreground" aria-hidden="true" />
            {:else}
              <CaretRightIcon size={14} class="shrink-0 text-muted-foreground" aria-hidden="true" />
            {/if}
            <p class="text-sm font-medium truncate min-w-0 flex-1">{item.workflowName}</p>
            <button
              type="button"
              class="inline-flex shrink-0 items-center p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted border-none bg-transparent cursor-pointer"
              title="Copy workflow ID: {item.workflowRunId}"
              onclick={(e) => { e.stopPropagation(); copyWorkflowId(item.workflowRunId, item.workflowRunId); }}
              aria-label="Copy workflow ID {item.workflowRunId}"
            >
              {#if copiedJobId === item.workflowRunId}
                <CheckIcon size={12} aria-hidden="true" />
              {:else}
                <CopyIcon size={12} aria-hidden="true" />
              {/if}
            </button>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground px-4 pb-3 -mt-1">
          <span>Created: {formatTimestamp(Math.min(...item.jobs.map((j) => j.createdAt)))}</span>
          <span
            >Completed:
            {item.jobs.every((j) => j.completedAt) ? formatTimestamp(Math.max(...item.jobs.map((j) => j.completedAt!))) : "\u2013"}</span
          >
        </div>

        {#if isExpanded}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="border-t border-border divide-y divide-border"
            transition:safeSlide={{ duration: 200 }}
            onclick={(e) => e.stopPropagation()}
            onkeydown={(e) => e.stopPropagation()}
          >
            {#each item.jobs as job (job.id)}
              <div class="px-4 py-3 space-y-2 {job.error ? 'bg-destructive/5' : 'bg-muted/30'}">
                <div class="flex items-center gap-3">
                  <div class="shrink-0 w-6 flex justify-center">
                    {#if job.stepIndex != null}
                      <Badge variant="outline">{job.stepIndex + 1}</Badge>
                    {/if}
                  </div>
                  <div class="min-w-0 flex-1 space-y-2">
                    <div class="flex items-center gap-2 flex-wrap">
                      <StatusDot status={job.status} title={job.status} />
                      <span class="text-sm truncate" title={job.description}>{job.description}</span>
                    </div>
                    {#if job.error}
                      <p class="text-xs text-destructive truncate">{job.error}</p>
                    {/if}
                    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>Created: {formatTimestamp(job.createdAt)}</span>
                      <span>Completed: {job.completedAt ? formatTimestamp(job.completedAt) : "\u2013"}</span>
                    </div>
                    <hr>
                    <div class="flex flex-wrap items-center gap-2">
                      {#if job.status === "failed"}
                        <Button
                          size="sm"
                          variant="default"
                          disabled={retryingJobId === job.id}
                          onclick={() => handleRetry(job.id)}
                        >
                          <ArrowCounterClockwiseIcon size={14} class="mr-1" aria-hidden="true" />
                          {retryingJobId === job.id ? "..." : "Retry"}
                        </Button>
                      {/if}
                      {#if isCancellable(job.status)}
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={cancellingJobId === job.id}
                          onclick={() => handleCancel(job.id)}
                        >
                          <span class="text-xs font-bold mr-1.5" aria-hidden="true">&#x2715;</span>
                          {cancellingJobId === job.id ? "..." : "Cancel"}
                        </Button>
                      {/if}
                      <Button size="sm" variant="outline" onclick={() => (selectedJobId = job.id)}>
                        <FileTextIcon size={14} class="mr-1" aria-hidden="true" />
                        Logs
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  {/each}
</div>

<!-- Desktop: Table layout -->
<div class="responsive-table rounded-md border border-border" use:trackColumnWidths>
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead class="w-8"></TableHead>
        <TableHead class="min-w-20">Queue</TableHead>
        <TableHead class="w-8">Status</TableHead>
        <TableHead>Description</TableHead>
        <TableHead class="hidden xl:table-cell">Created</TableHead>
        <TableHead class="hidden xl:table-cell">Completed</TableHead>
        <TableHead class="text-center min-w-48">Actions</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each paginatedItems as item}
        {#if item.type === "job"}
          {@const job = item.job}
          <TableRow class={job.error ? "bg-destructive/5" : ""}>
            <TableCell></TableCell>
            <TableCell>
              <Badge variant="outline" class={automationStyle(queueLabel(job.queue)).border}
                >{queueLabel(job.queue)}</Badge
              >
            </TableCell>
            <TableCell>
              <StatusDot status={job.status} title={job.status} />
            </TableCell>
            <TableCell class="max-w-48">
              <span class="truncate block" title={job.description}>{job.description}</span>
              {#if job.error}
                <p class="text-xs text-destructive mt-0.5 truncate">{job.error}</p>
              {/if}
            </TableCell>
            <TableCell class="hidden xl:table-cell text-sm text-muted-foreground">
              {formatTimestamp(job.createdAt)}
            </TableCell>
            <TableCell class="hidden xl:table-cell text-sm text-muted-foreground">
              {job.completedAt ? formatTimestamp(job.completedAt) : "\u2013"}
            </TableCell>
            <TableCell class="text-right w-1">
              <div class="inline-flex justify-end gap-2 flex-wrap xl:flex-nowrap">
                {#if job.status === "failed"}
                  <Button
                    size="sm"
                    variant="default"
                    disabled={retryingJobId === job.id}
                    onclick={() => handleRetry(job.id)}
                  >
                    <ArrowCounterClockwiseIcon size={14} class="mr-1.5" aria-hidden="true" />
                    {retryingJobId === job.id ? "Retrying" : "Retry"}
                  </Button>
                {/if}
                {#if isCancellable(job.status)}
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={cancellingJobId === job.id}
                    onclick={() => handleCancel(job.id)}
                  >
                    <span class="text-xs font-bold mr-1.5" aria-hidden="true">&#x2715;</span>
                    {cancellingJobId === job.id ? "Cancelling" : "Cancel"}
                  </Button>
                {/if}
                <Button size="sm" variant="outline" onclick={() => (selectedJobId = job.id)}>
                  <FileTextIcon size={14} class="mr-1.5" aria-hidden="true" />
                  Logs
                </Button>
              </div>
            </TableCell>
          </TableRow>
        {:else}
          {@const isExpanded = expandedWorkflows.has(item.workflowRunId)}
          <TableRow
            class="cursor-pointer hover:bg-muted/50 h-15"
            onclick={() => toggleWorkflow(item.workflowRunId)}
            onkeydown={(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleWorkflow(item.workflowRunId); } }}
          >
            <TableCell class="w-8 pr-0">
              {#if isExpanded}
                <CaretDownIcon size={14} class="text-muted-foreground" aria-hidden="true" />
              {:else}
                <CaretRightIcon size={14} class="text-muted-foreground" aria-hidden="true" />
              {/if}
            </TableCell>
            <TableCell>
              <Badge variant="outline" class={automationStyle("workflow").border}>workflow</Badge>
            </TableCell>
            <TableCell>
              <div class="flex items-center gap-1">
                {#each item.jobs as step}
                  <StatusDot status={step.status} title="{step.description}: {step.status}" />
                {/each}
              </div>
            </TableCell>
            <TableCell class="max-w-48">
              <div class="flex items-center gap-1">
                <span class="truncate font-medium" title={item.workflowName}>{item.workflowName}</span>
                <button
                  type="button"
                  class="inline-flex shrink-0 items-center p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted border-none bg-transparent cursor-pointer"
                  title="Copy workflow ID: {item.workflowRunId}"
                  onclick={(e) => { e.stopPropagation(); copyWorkflowId(item.workflowRunId, item.workflowRunId); }}
                  aria-label="Copy workflow ID {item.workflowRunId}"
                >
                  {#if copiedJobId === item.workflowRunId}
                    <CheckIcon size={12} aria-hidden="true" />
                  {:else}
                    <CopyIcon size={12} aria-hidden="true" />
                  {/if}
                </button>
              </div>
            </TableCell>
            <TableCell class="hidden xl:table-cell text-sm text-muted-foreground">
              {formatTimestamp(Math.min(...item.jobs.map((j) => j.createdAt)))}
            </TableCell>
            <TableCell class="hidden xl:table-cell text-sm text-muted-foreground">
              {item.jobs.every((j) => j.completedAt) ? formatTimestamp(Math.max(...item.jobs.map((j) => j.completedAt!))) : "\u2013"}
            </TableCell>
            <TableCell class="text-right w-1">
              <div class="inline-flex justify-end gap-2 flex-wrap xl:flex-nowrap">
                {#if isCancellable(item.aggregateStatus)}
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={cancellingJobId === item.jobs[0]?.id}
                    onclick={(e: Event) => { e.stopPropagation(); handleCancel(item.jobs.find((j) => isCancellable(j.status))?.id ?? item.jobs[0].id); }}
                  >
                    <span class="text-xs font-bold mr-1.5" aria-hidden="true">&#x2715;</span>
                    Cancel
                  </Button>
                {/if}
              </div>
            </TableCell>
          </TableRow>
          <!-- Expanded step rows -->
          {#if isExpanded}
            <TableRow class="p-0! border-b-0! !hover:bg-transparent">
              <TableCell colspan={7} class="p-0!">
                <div transition:safeSlide={{ duration: 200 }}>
                  {#each item.jobs as job (job.id)}
                    <div
                      class="flex items-center border-b border-border last:border-b-0 {job.error ? 'bg-destructive/5' : 'bg-muted/30'}"
                    >
                      <div class="p-3 shrink-0" style="width: var(--col-0)"></div>
                      <div class="p-3 shrink-0" style="width: var(--col-1)">
                        {#if job.stepIndex != null}
                          <Badge variant="outline">{job.stepIndex + 1}</Badge>
                        {/if}
                      </div>
                      <div class="p-3 shrink-0" style="width: var(--col-2)">
                        <StatusDot status={job.status} title={job.status} />
                      </div>
                      <div class="p-3 min-w-0 flex-1">
                        <span class="truncate block text-sm" title={job.description}>{job.description}</span>
                        {#if job.error}
                          <p class="text-xs text-destructive mt-0.5 truncate">{job.error}</p>
                        {/if}
                      </div>
                      <div
                        class="p-3 shrink-0 hidden xl:block text-sm text-muted-foreground"
                        style="width: var(--col-4)"
                      >
                        {formatTimestamp(job.createdAt)}
                      </div>
                      <div
                        class="p-3 shrink-0 hidden xl:block text-sm text-muted-foreground"
                        style="width: var(--col-5)"
                      >
                        {job.completedAt ? formatTimestamp(job.completedAt) : "\u2013"}
                      </div>
                      <div class="p-3 shrink-0 text-right" style="width: var(--col-6)">
                        <div class="inline-flex justify-end gap-2 flex-wrap">
                          {#if job.status === "failed"}
                            <Button
                              size="sm"
                              variant="default"
                              disabled={retryingJobId === job.id}
                              onclick={() => handleRetry(job.id)}
                            >
                              <ArrowCounterClockwiseIcon size={14} class="mr-1.5" aria-hidden="true" />
                              {retryingJobId === job.id ? "Retrying" : "Retry"}
                            </Button>
                          {/if}
                          {#if isCancellable(job.status)}
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={cancellingJobId === job.id}
                              onclick={() => handleCancel(job.id)}
                            >
                              <span class="text-xs font-bold mr-1.5" aria-hidden="true">&#x2715;</span>
                              {cancellingJobId === job.id ? "Cancelling" : "Cancel"}
                            </Button>
                          {/if}
                          <Button size="sm" variant="outline" onclick={() => (selectedJobId = job.id)}>
                            <FileTextIcon size={14} class="mr-1.5" aria-hidden="true" />
                            Logs
                          </Button>
                        </div>
                      </div>
                    </div>
                  {/each}
                </div>
              </TableCell>
            </TableRow>
          {/if}
        {/if}
      {/each}
    </TableBody>
  </Table>
</div>

{#if totalPages > 1}
  <nav class="flex items-center justify-center gap-2 mt-6" aria-label="Pagination">
    <Button
      size="xs"
      variant="outline"
      disabled={currentPage <= 1}
      onclick={() => (currentPage = 1)}
      aria-label="First page"
    >
      <CaretLeftIcon size={14} aria-hidden="true" /><CaretLeftIcon size={14} class="-ml-1.5" aria-hidden="true" />
    </Button>
    <Button
      size="xs"
      variant="outline"
      disabled={currentPage <= 1}
      onclick={() => (currentPage = Math.max(1, currentPage - 1))}
      aria-label="Previous page"
    >
      <CaretLeftIcon size={14} aria-hidden="true" />
    </Button>
    <span class="text-sm text-muted-foreground">Page {currentPage} of {totalPages}</span>
    <Button
      size="xs"
      variant="outline"
      disabled={currentPage >= totalPages}
      onclick={() => (currentPage = Math.min(totalPages, currentPage + 1))}
      aria-label="Next page"
    >
      <CaretRightIcon size={14} aria-hidden="true" />
    </Button>
    <Button
      size="xs"
      variant="outline"
      disabled={currentPage >= totalPages}
      onclick={() => (currentPage = totalPages)}
      aria-label="Last page"
    >
      <CaretRightIcon size={14} aria-hidden="true" /><CaretRightIcon size={14} class="-ml-1.5" aria-hidden="true" />
    </Button>
  </nav>
{/if}

{#if selectedJobId && jobs.find((j) => j.id === selectedJobId)}
  <JobLogs job={jobs.find((j) => j.id === selectedJobId)} onClose={() => (selectedJobId = null)} />
{/if}

{#if chainDialog.open}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <!-- svelte-ignore a11y_interactive_supports_focus -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    role="dialog"
    aria-modal="true"
    aria-labelledby="chain-dialog-title"
    onclick={(e) => { if (e.target === e.currentTarget) dismissChainDialog(); }}
    onkeydown={(e) => { if (e.key === "Escape") dismissChainDialog(); }}
  >
    <div class="bg-background border border-border rounded-lg shadow-lg p-6 max-w-md w-full mx-4 space-y-4">
      <h2 id="chain-dialog-title" class="text-lg font-semibold">Cancel Workflow Chain</h2>
      <p class="text-sm text-muted-foreground">
        This job is part of a workflow chain. All {chainDialog.siblings.length} jobs in the chain will be cancelled:
      </p>
      <ul class="list-none p-0 m-0 max-h-48 overflow-y-auto border border-border rounded-md">
        {#each chainDialog.siblings as sibling (sibling.id)}
          <li class="flex items-center gap-2 px-2 py-1.5 text-sm border-b border-border last:border-b-0">
            <StatusDot status={sibling.status} />
            <span class="truncate" title={sibling.description}>{sibling.description}</span>
          </li>
        {/each}
      </ul>
      <div class="flex justify-end gap-2 pt-2">
        <button
          bind:this={chainCancelBtnEl}
          type="button"
          class="inline-flex items-center justify-center rounded-md text-sm font-medium ring-offset-background transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-9 px-3"
          onclick={dismissChainDialog}
        >
          Cancel
        </button>
        <Button size="sm" variant="destructive" onclick={confirmCancelChain}>
          Remove all {chainDialog.siblings.length} jobs
        </Button>
      </div>
    </div>
  </div>
{/if}
