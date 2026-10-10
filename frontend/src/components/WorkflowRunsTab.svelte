<script lang="ts">
import ArrowCounterClockwiseIcon from "phosphor-svelte/lib/ArrowCounterClockwiseIcon";
import CaretLeftIcon from "phosphor-svelte/lib/CaretLeftIcon";
import CaretRightIcon from "phosphor-svelte/lib/CaretRightIcon";
import { authFetch } from "$lib/auth";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "$lib/components/ui/table";
import { t } from "$lib/i18n.svelte";
/**
 * Paginated run history for a workflow: cards on small screens, a table on
 * desktop, with Retry (failed runs) and Cancel (in-flight runs) actions.
 */
import { statusLabel } from "$lib/i18nCore";
import { aggregateStepStatus, formatTimestamp, isRunCancellable, statusVariant } from "$lib/utils";
import type { WorkflowRunSummary } from "$lib/workflowDetail";
import StatusDot from "./StatusDot.svelte";

interface Props {
  /** Workflow name, used to build run detail links. */
  workflowName: string;
  /** Runs, newest first. */
  runs: WorkflowRunSummary[];
  /** Called after a run was cancelled, so the parent can refresh. */
  onRunCancelled: () => void | Promise<void>;
}

let { workflowName, runs, onRunCancelled }: Props = $props();

const RUNS_PAGE_SIZE = 10;

let runsPage = $state(1);
let runsTotalPages = $derived(Math.max(1, Math.ceil(runs.length / RUNS_PAGE_SIZE)));
let paginatedRuns = $derived(runs.slice((runsPage - 1) * RUNS_PAGE_SIZE, runsPage * RUNS_PAGE_SIZE));

// Clamp page if runs disappear
$effect(() => {
  if (runsPage > runsTotalPages) {
    runsPage = runsTotalPages;
  }
});

let cancellingRunId = $state<string | null>(null);

async function retryRun(runId: string) {
  try {
    const res = await authFetch(`/ext/workflows/runs/${runId}/retry`, { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error("Failed to retry workflow run:", err);
  }
}

async function cancelRun(runId: string) {
  cancellingRunId = runId;
  try {
    const res = await authFetch(`/ext/workflows/runs/${runId}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await onRunCancelled();
  } catch (err) {
    console.error("Failed to cancel workflow run:", err);
  } finally {
    cancellingRunId = null;
  }
}
</script>

{#snippet runLink(
  runId: string,
)}
  <a href="#/workflows/{workflowName}/runs/{runId}" class="text-left">
    <code class="text-xs font-mono font-medium">{runId.slice(0, 8)}</code>
  </a>
{/snippet}

{#if runs.length === 0}
  <p class="text-sm text-muted-foreground text-center mt-3">{t("runs.empty")}</p>
{:else}
  <!-- Mobile & Tablet: Card layout -->
  <div class="responsive-cards">
    {#each paginatedRuns as run (run.runId)}
      {@const aggregated = aggregateStepStatus(run.steps)}
      <div class="rounded-md border border-border p-4 space-y-3">
        <div class="flex items-center justify-between gap-2">
          {@render runLink(run.runId)}
          <Badge variant={statusVariant(run.status)}>{statusLabel(run.status)}</Badge>
        </div>

        <StatusDot status={aggregated} title={statusLabel(aggregated)} />

        <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{t("runs.started", { time: formatTimestamp(run.startedAt) })}</span>
          <span>{t("runs.completed", { time: formatTimestamp(run.completedAt, "—") })}</span>
        </div>

        {#if run.status === "failed" || isRunCancellable(run.status)}
          <div class="flex flex-wrap items-center gap-2">
            {#if run.status === "failed"}
              <Button size="xs" variant="default" onclick={() => retryRun(run.runId)}>
                <ArrowCounterClockwiseIcon size={12} class="mr-1" aria-hidden="true" />
                {t("common.retry")}
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
                {cancellingRunId === run.runId ? "..." : t("common.cancel")}
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
          <TableHead class="w-md">{t("runs.colRunId")}</TableHead>
          <TableHead>{t("runs.colStarted")}</TableHead>
          <TableHead>{t("jobs.colCompleted")}</TableHead>
          <TableHead class="min-w-[2em] text-center">{t("jobs.colStatus")}</TableHead>
          <TableHead class="min-w-[10em]"></TableHead>
          <TableHead class="text-center min-w-[10em]">{t("common.actions")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each paginatedRuns as run (run.runId)}
          {@const aggregated = aggregateStepStatus(run.steps)}
          <TableRow>
            <TableCell> {@render runLink(run.runId)} </TableCell>
            <TableCell class="text-sm text-muted-foreground">
              {formatTimestamp(run.startedAt)}
            </TableCell>
            <TableCell class="text-sm text-muted-foreground">
              {formatTimestamp(run.completedAt, "—")}
            </TableCell>
            <TableCell class="text-center">
              <StatusDot status={aggregated} title={statusLabel(aggregated)} />
            </TableCell>
            <TableCell>
              <Badge variant={statusVariant(run.status)}>{statusLabel(run.status)}</Badge>
            </TableCell>
            <TableCell class="text-right">
              <div class="inline-flex justify-end gap-2 flex-wrap xl:flex-nowrap">
                {#if run.status === "failed"}
                  <Button size="sm" variant="default" onclick={() => retryRun(run.runId)}>
                    <ArrowCounterClockwiseIcon size={14} class="mr-1" aria-hidden="true" />
                    {t("common.retry")}
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
    <nav class="flex items-center justify-center gap-2 mt-6" aria-label={t("common.pagination")}>
      <Button
        size="xs"
        variant="outline"
        disabled={runsPage <= 1}
        onclick={() => (runsPage = 1)}
        aria-label={t("common.firstPage")}
      >
        <CaretLeftIcon size={14} aria-hidden="true" />
        <CaretLeftIcon size={14} class="-ml-1.5" aria-hidden="true" />
      </Button>
      <Button
        size="xs"
        variant="outline"
        disabled={runsPage <= 1}
        onclick={() => (runsPage = Math.max(1, runsPage - 1))}
        aria-label={t("common.previousPage")}
      >
        <CaretLeftIcon size={14} aria-hidden="true" />
      </Button>
      <span class="text-sm text-muted-foreground">{t("common.pageOf", { page: runsPage, total: runsTotalPages })}</span>
      <Button
        size="xs"
        variant="outline"
        disabled={runsPage >= runsTotalPages}
        onclick={() => (runsPage = Math.min(runsTotalPages, runsPage + 1))}
        aria-label={t("common.nextPage")}
      >
        <CaretRightIcon size={14} aria-hidden="true" />
      </Button>
      <Button
        size="xs"
        variant="outline"
        disabled={runsPage >= runsTotalPages}
        onclick={() => (runsPage = runsTotalPages)}
        aria-label={t("common.lastPage")}
      >
        <CaretRightIcon size={14} aria-hidden="true" />
        <CaretRightIcon size={14} class="-ml-1.5" aria-hidden="true" />
      </Button>
    </nav>
  {/if}
{/if}
