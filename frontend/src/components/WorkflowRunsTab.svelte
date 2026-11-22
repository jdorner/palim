<script lang="ts">
import CaretLeftIcon from "phosphor-svelte/lib/CaretLeftIcon";
import CaretRightIcon from "phosphor-svelte/lib/CaretRightIcon";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "$lib/components/ui/table";
import { t } from "$lib/i18n.svelte";
/**
 * Paginated run history for a workflow: cards on small screens, a table on
 * desktop. Actions: Cancel while a run is in flight (it ends failed and stays
 * listed), Run again and Delete once it failed, Delete once it completed.
 */
import { statusLabel } from "$lib/i18nCore";
import { aggregateStepStatus, formatTimestamp, isFinished, isRunCancellable, statusVariant } from "$lib/utils";
import type { WorkflowRunSummary } from "$lib/workflowDetail";
import CancelButton from "./CancelButton.svelte";
import DeleteButton from "./DeleteButton.svelte";
import RerunButton from "./RerunButton.svelte";
import StatusDot from "./StatusDot.svelte";

interface Props {
  /** Workflow name, used to build run detail links. */
  workflowName: string;
  /** Runs, newest first. */
  runs: WorkflowRunSummary[];
  /** Called after a run was cancelled or deleted, so the parent can refresh. */
  onRunChanged: () => void | Promise<void>;
}

let { workflowName, runs, onRunChanged }: Props = $props();

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
</script>

{#snippet runLink(runId: string)}
  <a href="#/workflows/{workflowName}/runs/{runId}" class="text-left">
    <code class="text-xs font-mono font-medium">{runId.slice(0, 8)}</code>
  </a>
{/snippet}

<!-- Cancel while in flight; Run again and Delete once failed; Delete once completed -->
{#snippet runActions(runId: string, status: string, size: "xs" | "sm")}
  {#if isRunCancellable(status)}
    <CancelButton url="/ext/workflows/runs/{runId}/cancel" {size} onCancelled={onRunChanged} />
  {/if}
  {#if status === "failed"}
    <RerunButton {runId} {size} />
  {/if}
  {#if isFinished(status)}
    <DeleteButton
      url="/ext/workflows/runs/{runId}"
      confirmTitle={t("runs.deleteTitle")}
      confirmMessage={t("runs.deleteConfirm", { id: runId.slice(0, 8) })}
      {size}
      onDeleted={onRunChanged}
    />
  {/if}
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

        {#if isRunCancellable(run.status) || isFinished(run.status)}
          <div class="flex flex-wrap items-center gap-2">
            {@render runActions(run.runId, run.status, "xs")}
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
              <div class="inline-flex items-center justify-end gap-2 flex-wrap xl:flex-nowrap">
                {@render runActions(run.runId, run.status, "sm")}
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
