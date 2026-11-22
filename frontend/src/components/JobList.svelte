<script lang="ts">
import ArrowCounterClockwiseIcon from "phosphor-svelte/lib/ArrowCounterClockwiseIcon";
import CaretDownIcon from "phosphor-svelte/lib/CaretDownIcon";
import CaretLeftIcon from "phosphor-svelte/lib/CaretLeftIcon";
import CaretRightIcon from "phosphor-svelte/lib/CaretRightIcon";
import CheckIcon from "phosphor-svelte/lib/CheckIcon";
import CopyIcon from "phosphor-svelte/lib/CopyIcon";
import FileTextIcon from "phosphor-svelte/lib/FileTextIcon";
import type { SlideParams, TransitionConfig } from "svelte/transition";
import { slide } from "svelte/transition";
import { authFetch } from "$lib/auth";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "$lib/components/ui/table";
import { t } from "$lib/i18n.svelte";
import { statusLabel } from "$lib/i18nCore";
import {
  aggregateStepStatus,
  automationStyle,
  formatTimestamp,
  isFinished,
  isJobCancellable,
  isRunCancellable,
  responseError,
} from "$lib/utils";
import type { JobEntry } from "../../../shared/jobs";
import CancelButton from "./CancelButton.svelte";
import DeleteButton from "./DeleteButton.svelte";
import JobLogs from "./JobLogs.svelte";
import RerunButton from "./RerunButton.svelte";
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

/**
 * Job list with the same actions everywhere: Cancel for a job or run that has
 * not finished (it ends failed and stays listed), Retry (jobs) or Run again
 * (workflow runs) plus Delete for failed ones, Delete for completed ones. A
 * workflow run is the unit for Retry and Delete: its step rows only offer
 * Cancel (which fails the run) and Logs.
 */
let {
  jobs,
  filterKey = "",
  runStatuses = {},
}: {
  jobs: JobEntry[];
  filterKey?: string;
  runStatuses?: Record<string, string>;
} = $props();

let selectedJobId = $state<string | null>(null);
let copiedJobId = $state<string | null>(null);
let expandedWorkflows = $state<Set<string>>(new Set());

/** Represents either a standalone job or a workflow group. */
type DisplayItem =
  | { type: "job"; job: JobEntry }
  | { type: "workflow"; workflowRunId: string; workflowName: string; jobs: JobEntry[]; aggregateStatus: string };

type WorkflowItem = Extract<DisplayItem, { type: "workflow" }>;

/** Earliest creation timestamp among a workflow group's step jobs. */
function workflowCreatedAt(workflowJobs: JobEntry[]): number {
  return Math.min(...workflowJobs.map((j) => j.createdAt));
}

/** Latest completion timestamp of a workflow group, or undefined while any step is still incomplete. */
function workflowCompletedAt(workflowJobs: JobEntry[]): number | undefined {
  if (!workflowJobs.every((j) => j.completedAt)) return undefined;
  return Math.max(...workflowJobs.map((j) => j.completedAt!));
}

/**
 * Computes an aggregate status for a workflow group. The run's own status
 * wins: its step jobs do not show a run that waits on a signal, has finished,
 * or is between two steps. Without a run status (run record gone), the steps'
 * aggregate (failed > waiting-signal > active > waiting/delayed > completed).
 */
function computeAggregateStatus(workflowJobs: JobEntry[], runId: string): string {
  const runStatus = runStatuses[runId];
  if (runStatus === "failed" || runStatus === "completed" || runStatus === "waiting-signal") return runStatus;
  const steps = aggregateStepStatus(workflowJobs);
  // A running run whose jobs so far have all ended is between two steps.
  if (runStatus === "running" && !isRunCancellable(steps)) return "active";
  return steps;
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
    const workflowName = workflowJobs[0].workflowName ?? t("jobs.workflow");
    items.push({
      type: "workflow",
      workflowRunId,
      workflowName,
      jobs: workflowJobs,
      aggregateStatus: computeAggregateStatus(workflowJobs, workflowRunId),
    });
  }

  // Sort all items by createdAt descending (most recent first)
  items.sort((a, b) => {
    const tsA = a.type === "job" ? a.job.createdAt : workflowCreatedAt(a.jobs);
    const tsB = b.type === "job" ? b.job.createdAt : workflowCreatedAt(b.jobs);
    return tsB - tsA;
  });

  return items;
});

const PAGE_SIZE = 10;
let currentPage = $state(1);
let totalPages = $derived(Math.max(1, Math.ceil(displayItems.length / PAGE_SIZE)));
let paginatedItems = $derived(displayItems.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE));

// Reset to page 1 when the parent signals a filter change via filterKey.
// We skip the initial run by comparing against a captured baseline.
let initialFilterKey: string | undefined;
$effect(() => {
  const key = filterKey;
  if (initialFilterKey === undefined) {
    initialFilterKey = key;
  } else if (key !== initialFilterKey) {
    currentPage = 1;
    initialFilterKey = key;
  }
});

// Clamp page if items disappear (e.g. after clean)
$effect(() => {
  if (currentPage > totalPages) {
    currentPage = totalPages;
  }
});

function toggleWorkflow(workflowRunId: string) {
  const next = new Set(expandedWorkflows);
  if (next.has(workflowRunId)) next.delete(workflowRunId);
  else next.add(workflowRunId);
  expandedWorkflows = next;
}

async function copyWorkflowId(jobId: string, workflowId: string) {
  await navigator.clipboard.writeText(workflowId);
  copiedJobId = jobId;
  setTimeout(() => {
    copiedJobId = null;
  }, 1500);
}

/** Extracts the extension name from a queue identifier (e.g. "scheduler:jobs" -> "scheduler"). */
function queueLabel(queue: string): string {
  return queue.split(":")[0];
}

let retryingJobId = $state<string | null>(null);
/** Refused retry, shown next to that job's button. */
let retryFailure = $state<{ jobId: string; message: string } | null>(null);

async function handleRetry(jobId: string) {
  retryingJobId = jobId;
  retryFailure = null;
  try {
    const res = await authFetch(`/api/jobs/${jobId}/retry`, { method: "POST" });
    if (!res.ok) throw new Error(await responseError(res));
  } catch (err) {
    retryFailure = { jobId, message: err instanceof Error ? err.message : String(err) };
  } finally {
    retryingJobId = null;
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
  onkeydown={(e) => {
    if (e.key === "Escape" && selectedJobId) selectedJobId = null;
  }}
/>

{#snippet queueBadge(label: string)}
  <Badge variant="outline" class={automationStyle(label).border}>{label}</Badge>
{/snippet}

{#snippet expandCaret(isExpanded: boolean, className: string)}
  {#if isExpanded}
    <CaretDownIcon size={14} class={className} aria-hidden="true" />
  {:else}
    <CaretRightIcon size={14} class={className} aria-hidden="true" />
  {/if}
{/snippet}

{#snippet cardTimestamps(createdAt: number, completedAt: number | undefined, className = "")}
  <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground {className}">
    <span>{t("jobs.colCreated")}: {formatTimestamp(createdAt)}</span>
    <span>{t("jobs.colCompleted")}: {formatTimestamp(completedAt, "\u2013")}</span>
  </div>
{/snippet}

{#snippet jobError(job: JobEntry, className = "mt-0.5")}
  {#if job.error}
    <p class="text-xs text-destructive truncate {className}">{job.error}</p>
  {/if}
{/snippet}

<!--
  Actions for one job: Cancel while it has not finished; Retry and Delete once
  it failed, Delete once it completed (not for a workflow step: its run is the
  unit); always Logs.
-->
{#snippet jobActions(job: JobEntry, compact: boolean)}
  {@const iconMargin = compact ? "mr-1" : "mr-1.5"}
  {@const isStep = job.workflowRunId != null}
  {#if isJobCancellable(job.status)}
    <CancelButton url="/api/jobs/{job.id}/cancel" />
  {/if}
  {#if !isStep && job.status === "failed"}
    {#if retryFailure?.jobId === job.id}
      <span class="text-xs text-destructive" title={retryFailure.message}>{t("common.retryFailed")}</span>
    {/if}
    <Button size="sm" variant="default" disabled={retryingJobId === job.id} onclick={() => handleRetry(job.id)}>
      <ArrowCounterClockwiseIcon size={14} class={iconMargin} aria-hidden="true" />
      {retryingJobId === job.id ? t("common.retrying") : t("common.retry")}
    </Button>
  {/if}
  {#if !isStep && isFinished(job.status)}
    <DeleteButton
      url="/api/jobs/{job.id}"
      confirmTitle={t("jobs.deleteTitle")}
      confirmMessage={t("jobs.deleteConfirm", { id: job.id.slice(0, 8) })}
    />
  {/if}
  <Button size="sm" variant="outline" onclick={() => (selectedJobId = job.id)}>
    <FileTextIcon size={14} class={iconMargin} aria-hidden="true" />
    {t("jobs.logs")}
  </Button>
{/snippet}

<!-- Actions for a workflow run: Cancel while in flight; Run again and Delete once failed; Delete once completed -->
{#snippet workflowRunAction(item: WorkflowItem)}
  {#if isRunCancellable(item.aggregateStatus)}
    <CancelButton url="/ext/workflows/runs/{item.workflowRunId}/cancel" />
  {/if}
  {#if item.aggregateStatus === "failed"}
    <RerunButton runId={item.workflowRunId} />
  {/if}
  {#if isFinished(item.aggregateStatus)}
    <DeleteButton
      url="/ext/workflows/runs/{item.workflowRunId}"
      confirmTitle={t("runs.deleteTitle")}
      confirmMessage={t("runs.deleteConfirm", { id: item.workflowRunId.slice(0, 8) })}
    />
  {/if}
{/snippet}

{#snippet copyWorkflowIdButton(workflowRunId: string)}
  <button
    type="button"
    class="inline-flex shrink-0 items-center p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted border-none bg-transparent cursor-pointer"
    title={t("jobs.copyWorkflowId", { id: workflowRunId })}
    onclick={(e) => {
      e.stopPropagation();
      copyWorkflowId(workflowRunId, workflowRunId);
    }}
    aria-label={t("jobs.copyWorkflowIdLabel", { id: workflowRunId })}
  >
    {#if copiedJobId === workflowRunId}
      <CheckIcon size={12} aria-hidden="true" />
    {:else}
      <CopyIcon size={12} aria-hidden="true" />
    {/if}
  </button>
{/snippet}

<!-- Mobile & Tablet: Card layout -->
<div class="responsive-cards">
  {#each paginatedItems as item}
    {#if item.type === "job"}
      {@const job = item.job}
      <div class="rounded-md border border-border p-4 space-y-3 {job.error ? "bg-destructive/5" : ""}">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              {@render queueBadge(queueLabel(job.queue))}
              <StatusDot status={job.status} title={statusLabel(job.status)} size="md" />
            </div>
            <p class="text-sm mt-1.5 truncate" title={job.description}>{job.description}</p>
            {@render jobError(job)}
          </div>
        </div>
        {@render cardTimestamps(job.createdAt, job.completedAt)}
        <hr>
        <div class="flex flex-wrap items-center gap-2">
          {@render jobActions(job, true)}
        </div>
      </div>
    {:else}
      {@const isExpanded = expandedWorkflows.has(item.workflowRunId)}
      <!-- biome-ignore lint/a11y/useSemanticElements: role="button" is intentional on a div acting as a clickable workflow group toggle -->
      <div
        class="rounded-md border border-border overflow-hidden cursor-pointer hover:bg-muted/50 transition-colors"
        onclick={() => toggleWorkflow(item.workflowRunId)}
        onkeydown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleWorkflow(item.workflowRunId);
          }
        }}
        role="button"
        tabindex="0"
        aria-expanded={isExpanded}
      >
        <div class="w-full p-4 flex flex-col gap-2 text-left">
          <div class="flex items-center gap-2">
            {@render queueBadge("workflow")}
            <div class="flex items-center gap-1.5">
              <StatusDot status={item.aggregateStatus} title={item.aggregateStatus} />
            </div>
          </div>
          <div class="flex items-center gap-2">
            {@render expandCaret(isExpanded, "shrink-0 text-muted-foreground")}
            <p class="text-sm font-medium truncate min-w-0 flex-1">{item.workflowName}</p>
            {@render copyWorkflowIdButton(item.workflowRunId)}
          </div>
        </div>
        {@render cardTimestamps(workflowCreatedAt(item.jobs), workflowCompletedAt(item.jobs), "px-4 pb-3 -mt-1")}

        {#if isRunCancellable(item.aggregateStatus) || isFinished(item.aggregateStatus)}
          <div class="flex flex-wrap items-center gap-2 px-4 pb-3">
            {@render workflowRunAction(item)}
          </div>
        {/if}

        {#if isExpanded}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="border-t border-border divide-y divide-border"
            transition:safeSlide={{ duration: 200 }}
            onclick={(e) => e.stopPropagation()}
            onkeydown={(e) => e.stopPropagation()}
          >
            {#each item.jobs as job (job.id)}
              <div class="px-4 py-3 space-y-2 {job.error ? "bg-destructive/5" : "bg-muted/30"}">
                <div class="flex items-center gap-3">
                  <div class="shrink-0 w-6 flex justify-center">
                    {#if job.stepIndex != null}
                      <Badge variant="outline">{job.stepIndex + 1}</Badge>
                    {/if}
                  </div>
                  <div class="min-w-0 flex-1 space-y-2">
                    <div class="flex items-center gap-2 flex-wrap">
                      <StatusDot status={job.status} title={statusLabel(job.status)} />
                      <span class="text-sm truncate" title={job.description}>{job.description}</span>
                    </div>
                    {@render jobError(job, "")}
                    {@render cardTimestamps(job.createdAt, job.completedAt)}
                    <hr>
                    <div class="flex flex-wrap items-center gap-2">
                      {@render jobActions(job, true)}
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
    <TableHeader class="bg-muted/30">
      <TableRow>
        <TableHead class="w-8"></TableHead>
        <TableHead class="min-w-20">{t("jobs.colQueue")}</TableHead>
        <TableHead class="w-8">{t("jobs.colStatus")}</TableHead>
        <TableHead>{t("jobs.colDescription")}</TableHead>
        <TableHead class="hidden xl:table-cell">{t("jobs.colCreated")}</TableHead>
        <TableHead class="hidden xl:table-cell">{t("jobs.colCompleted")}</TableHead>
        <TableHead class="text-center min-w-48">{t("common.actions")}</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each paginatedItems as item}
        {#if item.type === "job"}
          {@const job = item.job}
          <TableRow class={job.error ? "bg-destructive/5" : ""}>
            <TableCell></TableCell>
            <TableCell> {@render queueBadge(queueLabel(job.queue))} </TableCell>
            <TableCell>
              <StatusDot status={job.status} title={statusLabel(job.status)} />
            </TableCell>
            <TableCell class="max-w-48">
              <span class="truncate block" title={job.description}>{job.description}</span>
              {@render jobError(job)}
            </TableCell>
            <TableCell class="hidden xl:table-cell text-sm text-muted-foreground">
              {formatTimestamp(job.createdAt)}
            </TableCell>
            <TableCell class="hidden xl:table-cell text-sm text-muted-foreground">
              {formatTimestamp(job.completedAt, "\u2013")}
            </TableCell>
            <TableCell class="text-right w-1">
              <div class="inline-flex justify-end gap-2 flex-wrap xl:flex-nowrap">
                {@render jobActions(job, false)}
              </div>
            </TableCell>
          </TableRow>
        {:else}
          {@const isExpanded = expandedWorkflows.has(item.workflowRunId)}
          <TableRow
            class="cursor-pointer hover:bg-muted/50 h-15"
            onclick={() => toggleWorkflow(item.workflowRunId)}
            onkeydown={(e: KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggleWorkflow(item.workflowRunId);
              }
            }}
          >
            <TableCell class="w-8 pr-0"> {@render expandCaret(isExpanded, "text-muted-foreground")} </TableCell>
            <TableCell> {@render queueBadge("workflow")} </TableCell>
            <TableCell>
              <div class="flex items-center gap-1">
                <StatusDot status={item.aggregateStatus} title={item.aggregateStatus} />
              </div>
            </TableCell>
            <TableCell class="max-w-48">
              <div class="flex items-center gap-1">
                <span class="truncate font-medium" title={item.workflowName}>{item.workflowName}</span>
                {@render copyWorkflowIdButton(item.workflowRunId)}
              </div>
            </TableCell>
            <TableCell class="hidden xl:table-cell text-sm text-muted-foreground">
              {formatTimestamp(workflowCreatedAt(item.jobs))}
            </TableCell>
            <TableCell class="hidden xl:table-cell text-sm text-muted-foreground">
              {formatTimestamp(workflowCompletedAt(item.jobs), "\u2013")}
            </TableCell>
            <TableCell class="text-right w-1">
              <div class="inline-flex justify-end gap-2 flex-wrap xl:flex-nowrap">
                {@render workflowRunAction(item)}
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
                      class="flex items-center border-b border-border last:border-b-0 {job.error
                        ? "bg-destructive/5"
                        : "bg-muted/30"}"
                    >
                      <div class="p-3 shrink-0" style="width: var(--col-0)"></div>
                      <div class="p-3 shrink-0" style="width: var(--col-1)">
                        {#if job.stepIndex != null}
                          <Badge variant="outline">{job.stepIndex + 1}</Badge>
                        {/if}
                      </div>
                      <div class="p-3 shrink-0" style="width: var(--col-2)">
                        <StatusDot status={job.status} title={statusLabel(job.status)} />
                      </div>
                      <div class="p-3 min-w-0 flex-1">
                        <span class="truncate block text-sm" title={job.description}>{job.description}</span>
                        {@render jobError(job)}
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
                        {formatTimestamp(job.completedAt, "\u2013")}
                      </div>
                      <div class="p-3 shrink-0 text-right" style="width: var(--col-6)">
                        <div class="inline-flex justify-end gap-2 flex-wrap">
                          {@render jobActions(job, false)}
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
  <nav class="flex items-center justify-center gap-2 mt-6" aria-label={t("common.pagination")}>
    <Button
      size="xs"
      variant="outline"
      disabled={currentPage <= 1}
      onclick={() => (currentPage = 1)}
      aria-label={t("common.firstPage")}
    >
      <CaretLeftIcon size={14} aria-hidden="true" /><CaretLeftIcon size={14} class="-ml-1.5" aria-hidden="true" />
    </Button>
    <Button
      size="xs"
      variant="outline"
      disabled={currentPage <= 1}
      onclick={() => (currentPage = Math.max(1, currentPage - 1))}
      aria-label={t("common.previousPage")}
    >
      <CaretLeftIcon size={14} aria-hidden="true" />
    </Button>
    <span class="text-sm text-muted-foreground">{t("common.pageOf", { page: currentPage, total: totalPages })}</span>
    <Button
      size="xs"
      variant="outline"
      disabled={currentPage >= totalPages}
      onclick={() => (currentPage = Math.min(totalPages, currentPage + 1))}
      aria-label={t("common.nextPage")}
    >
      <CaretRightIcon size={14} aria-hidden="true" />
    </Button>
    <Button
      size="xs"
      variant="outline"
      disabled={currentPage >= totalPages}
      onclick={() => (currentPage = totalPages)}
      aria-label={t("common.lastPage")}
    >
      <CaretRightIcon size={14} aria-hidden="true" /><CaretRightIcon size={14} class="-ml-1.5" aria-hidden="true" />
    </Button>
  </nav>
{/if}

{#if selectedJobId && jobs.find((j) => j.id === selectedJobId)}
  <JobLogs job={jobs.find((j) => j.id === selectedJobId)} onClose={() => (selectedJobId = null)} />
{/if}
