<script lang="ts">
import CameraIcon from "phosphor-svelte/lib/CameraIcon";
import CaretRightIcon from "phosphor-svelte/lib/CaretRightIcon";
import CursorClickIcon from "phosphor-svelte/lib/CursorClickIcon";
import EyeIcon from "phosphor-svelte/lib/EyeIcon";
import LinkSimpleIcon from "phosphor-svelte/lib/LinkSimpleIcon";
import PlayIcon from "phosphor-svelte/lib/PlayIcon";
import TimerIcon from "phosphor-svelte/lib/TimerIcon";
import TrashIcon from "phosphor-svelte/lib/TrashIcon";
import WarningIcon from "phosphor-svelte/lib/WarningIcon";
import { onDestroy } from "svelte";
import { authFetch } from "$lib/auth";
import LoadingIndicator from "$lib/components/LoadingIndicator.svelte";
import { Button } from "$lib/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "$lib/components/ui/table";
import { t } from "$lib/i18n.svelte";
import { type CoreKey, translateCore } from "$lib/i18nCore";
import { automationStyle } from "$lib/utils";
import { warningLocation } from "$lib/workflowDetail";
import {
  groupWorkflows,
  readCollapsedGroups,
  sectionKey,
  sumRunCounts,
  type WorkflowRunCounts,
  writeCollapsedGroups,
} from "$lib/workflowGroups";
import { type WorkflowEvent, workflowStore } from "$lib/workflowRunStore.svelte";
import { navigate } from "../router";

interface WorkflowSummary {
  name: string;
  description?: string;
  group?: string;
  trigger: { type: string; ref?: string };
  stepCount: number;
  enabled: boolean;
  steps: Array<{ slug: string; type: string }>;
  activeRuns: number;
  completedRuns: number;
  failedRuns: number;
  warnings: Array<{ stepSlug: string; field: string; message: string }>;
}

let workflows = $state<WorkflowSummary[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);
let errorDetail = $state<string | null>(null);
let confirmingDelete = $state<string | null>(null);
let collapsedGroups = $state(readCollapsedGroups());

const sections = $derived(groupWorkflows(workflows));
/** Without any named group the list renders flat, as before grouping existed. */
const showGroupHeaders = $derived(sections.some((s) => s.group !== null));

function isCollapsed(group: string | null): boolean {
  return showGroupHeaders && collapsedGroups.has(sectionKey(group));
}

function toggleGroup(group: string | null) {
  const key = sectionKey(group);
  const next = new Set(collapsedGroups);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  collapsedGroups = next;
  writeCollapsedGroups(next);
}

async function fetchWorkflows(showLoading = true) {
  if (showLoading) loading = true;
  error = null;
  errorDetail = null;
  try {
    const res = await authFetch("/ext/workflows");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    workflows = (await res.json()).sort((a: WorkflowSummary, b: WorkflowSummary) => a.name.localeCompare(b.name));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    errorDetail = msg || t("common.unknownError");
    if (msg.includes("Failed to fetch") || msg.includes("502") || msg.includes("503") || msg.includes("NetworkError")) {
      error = t("common.serverUnreachable");
    } else {
      error = t("workflows.loadFailed");
    }
  } finally {
    loading = false;
  }
}

async function deleteWorkflow(name: string) {
  try {
    const res = await authFetch(`/ext/workflows/${name}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    confirmingDelete = null;
    await fetchWorkflows();
  } catch (err) {
    console.error("Failed to delete workflow:", err);
  }
}

async function triggerRun(name: string) {
  try {
    const res = await authFetch(`/ext/workflows/run/${name}`, { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = (await res.json()) as { workflowRunId: string };
    navigate("/workflows/:name/runs/:runId", {
      params: { name, runId: result.workflowRunId },
    });
  } catch (err) {
    console.error("Failed to trigger workflow:", err);
  }
}

function triggerRoute(type: string): string {
  switch (type) {
    case "schedule":
      return "schedules";
    case "webhook":
      return "webhooks";
    case "filewatcher":
      return "filewatchers";
    default:
      return "";
  }
}

/** Handle real-time workflow events to update run counts. */
function handleWorkflowEvent(msg: WorkflowEvent) {
  if (msg.type === "workflow_started") {
    workflows = workflows.map((wf) => (wf.name === msg.workflowName ? { ...wf, activeRuns: wf.activeRuns + 1 } : wf));
  }
  if (msg.type === "workflow_completed" || msg.type === "workflow_failed" || msg.type === "workflow_run_removed") {
    fetchWorkflows(false);
  }
}

const unsubWorkflow = workflowStore.subscribe(handleWorkflowEvent);

onDestroy(() => {
  unsubWorkflow();
});

$effect(() => {
  fetchWorkflows();
});
</script>

{#snippet groupHeader(
  group: string | null,
  count: number,
)}
  <button
    type="button"
    class="flex w-full items-center gap-2 text-left text-sm font-semibold"
    aria-expanded={!isCollapsed(group)}
    onclick={() => toggleGroup(group)}
  >
    <CaretRightIcon
      size={14}
      class="shrink-0 text-muted-foreground transition-transform {isCollapsed(group) ? "" : "rotate-90"}"
      aria-hidden="true"
    />
    <span class="truncate {group === null ? "text-muted-foreground" : ""}">{group ?? t("workflows.ungrouped")}</span>
    <span class="text-xs font-normal text-muted-foreground">{count}</span>
  </button>
{/snippet}

{#snippet runCount(
  value: number,
  color: string,
)}
  {#if value > 0 && color}
    <span class="font-medium {color}">{value}</span>
  {:else}
    <span class="text-muted-foreground">{value}</span>
  {/if}
{/snippet}

{#snippet cardSubtotals(
  totals: WorkflowRunCounts,
)}
  <div class="flex flex-wrap items-center gap-x-4 gap-y-1 pl-5 text-xs text-muted-foreground">
    <span>{t("workflows.activeLabel")} {@render runCount(totals.activeRuns, "text-blue-500")}</span>
    <span>{t("workflows.failedLabel")} {@render runCount(totals.failedRuns, "text-red-500")}</span>
    <span>{t("workflows.completedLabel", { count: totals.completedRuns })}</span>
  </div>
{/snippet}

<div class="space-y-4">
  {#if loading}
    <LoadingIndicator />
  {:else if error}
    <div class="error-card">
      <p class="error-card-message">{error}</p>
      {#if errorDetail}
        <p class="error-card-detail">{errorDetail}</p>
      {/if}
    </div>
  {:else if workflows.length === 0}
    <p class="text-sm text-muted-foreground">
      {t("workflows.emptyBefore")} <code>&lt;AGENT_WORK_DIR&gt;/workflows/</code>
      {t("workflows.emptyAfter")}
    </p>
  {:else}
    <!-- Mobile & Tablet: Card layout -->
    <div class="responsive-cards">
      {#each sections as section (sectionKey(section.group))}
        {#if showGroupHeaders}
          <div class="space-y-1 pt-2">
            {@render groupHeader(section.group, section.items.length)}
            {@render cardSubtotals(sumRunCounts(section.items))}
          </div>
        {/if}
        {#if !isCollapsed(section.group)}
          {#each section.items as wf (wf.name)}
            {@const style = automationStyle(wf.trigger.type)}
            <div class="rounded-md border border-border p-4 space-y-3">
              <!-- Header: Name + Trigger -->
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0 flex-1">
                  <a href="#/workflows/{wf.name}" class="block overflow-hidden">
                    <span class="font-medium block truncate">{wf.name}</span>
                  </a>
                  {#if wf.description}
                    <p class="text-xs text-muted-foreground mt-0.5 line-clamp-2">{wf.description}</p>
                  {/if}
                  {#if wf.warnings.length > 0}
                    <span
                      class="inline-flex items-center gap-1 text-xs text-amber-500 mt-1"
                      title={wf.warnings.map((w) => `[${warningLocation(w)}] ${w.message}`).join("\n")}
                    >
                      <WarningIcon size={12} aria-hidden="true" />
                      {t("workflows.templateIssues", { count: wf.warnings.length })}
                    </span>
                  {/if}
                </div>
                <div class="shrink-0 text-right">
                  <span class="inline-flex items-center gap-1.5">
                    {#if style.icon === "timer"}
                      <TimerIcon size={14} class={style.color} aria-hidden="true" />
                    {:else if style.icon === "eye"}
                      <EyeIcon size={14} class={style.color} aria-hidden="true" />
                    {:else if style.icon === "link"}
                      <LinkSimpleIcon size={14} class={style.color} aria-hidden="true" />
                    {:else if style.icon === "cursor"}
                      <CursorClickIcon size={14} class={style.color} aria-hidden="true" />
                    {:else if style.icon === "camera"}
                      <CameraIcon size={14} class={style.color} aria-hidden="true" />
                    {/if}
                    <span class="text-sm {style.color} font-medium"
                      >{translateCore(`triggerTypes.${wf.trigger.type}` as CoreKey, { default: wf.trigger.type })}</span
                    >
                  </span>
                  {#if wf.trigger.ref && triggerRoute(wf.trigger.type)}
                    <a href="#/{triggerRoute(wf.trigger.type)}" class="block">
                      <span class="text-muted-foreground text-xs font-mono mt-0.5 truncate max-w-48 block"
                        >{wf.trigger.ref}</span
                      >
                    </a>
                  {:else if wf.trigger.ref}
                    <span class="block text-muted-foreground text-xs font-mono mt-0.5 truncate max-w-32"
                      >{wf.trigger.ref}</span
                    >
                  {/if}
                </div>
              </div>

              <!-- Stats row -->
              <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <span class="text-muted-foreground"
                  >{t("workflows.activeLabel")}
                  {#if wf.activeRuns > 0}
                    <span class="font-medium text-blue-500">{wf.activeRuns}</span>
                  {:else}
                    <span>0</span>
                  {/if}
                </span>
                <span class="text-muted-foreground"
                  >{t("workflows.failedLabel")}
                  {#if wf.failedRuns > 0}
                    <span class="font-medium text-red-500">{wf.failedRuns}</span>
                  {:else}
                    <span>0</span>
                  {/if}
                </span>
                <span class="text-muted-foreground">{t("workflows.completedLabel", { count: wf.completedRuns })}</span>
              </div>

              <hr>

              <!-- Actions -->
              {#if confirmingDelete === wf.name}
                <div class="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="destructive" onclick={() => deleteWorkflow(wf.name)}
                    >{t("common.confirm")}</Button
                  >
                  <Button
                    size="sm"
                    variant="outline"
                    onclick={() => {
                      confirmingDelete = null;
                    }}
                    >{t("common.cancel")}</Button
                  >
                </div>
              {:else}
                <div class="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="default" onclick={() => triggerRun(wf.name)}>
                    <PlayIcon size={14} class="mr-1.5" aria-hidden="true" />
                    {t("workflows.run")}
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onclick={() => {
                      confirmingDelete = wf.name;
                    }}
                  >
                    <TrashIcon size={14} class="mr-1.5" aria-hidden="true" />
                    {t("common.delete")}
                  </Button>
                </div>
              {/if}
            </div>
          {/each}
        {/if}
      {/each}
    </div>

    <!-- Desktop: Table layout -->
    <div class="responsive-table rounded-md border border-border">
      <!-- Explicit widths on all columns but Name (which takes the remaining space) keep the
           layout stable when group sections are collapsed and their rows' content disappears. -->
      <Table>
        <TableHeader class="bg-muted/30">
          <TableRow>
            <TableHead>{t("common.name")}</TableHead>
            <TableHead class="w-44">{t("workflows.colTrigger")}</TableHead>
            <TableHead class="w-24 text-center">{t("workflows.colActive")}</TableHead>
            <TableHead class="w-24 text-center">{t("workflows.colFailed")}</TableHead>
            <TableHead class="w-24 text-center">{t("workflows.colCompleted")}</TableHead>
            <TableHead class="w-36 text-center xl:w-64">{t("common.actions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each sections as section (sectionKey(section.group))}
            {#if showGroupHeaders}
              {@const totals = sumRunCounts(section.items)}
              <TableRow class="bg-muted/20 hover:bg-muted/30">
                <TableCell colspan={2}>{@render groupHeader(section.group, section.items.length)}</TableCell>
                <TableCell class="text-center text-sm"
                  >{@render runCount(totals.activeRuns, "text-blue-500")}</TableCell
                >
                <TableCell class="text-center text-sm">{@render runCount(totals.failedRuns, "text-red-500")}</TableCell>
                <TableCell class="text-center text-sm">{@render runCount(totals.completedRuns, "")}</TableCell>
                <TableCell></TableCell>
              </TableRow>
            {/if}
            {#if !isCollapsed(section.group)}
              {#each section.items as wf (wf.name)}
                <TableRow>
                  <TableCell>
                    <a href="#/workflows/{wf.name}" class="text-left w-full">
                      <span class="font-medium">{wf.name}</span></a
                    >
                    {#if wf.description}
                      <p class="text-xs text-muted-foreground mt-0.5">{wf.description}</p>
                    {/if}
                    {#if wf.warnings.length > 0}
                      <span
                        class="flex items-center gap-1 text-xs text-amber-500 mt-0.5"
                        title={wf.warnings.map((w) => `[${warningLocation(w)}] ${w.message}`).join("\n")}
                      >
                        <WarningIcon size={12} aria-hidden="true" />
                        {t("workflows.templateIssues", { count: wf.warnings.length })}
                      </span>
                    {/if}
                  </TableCell>
                  <TableCell>
                    {@const style = automationStyle(wf.trigger.type)}

                    <span class="inline-flex items-center gap-1.5">
                      {#if style.icon === "timer"}
                        <TimerIcon size={14} class={style.color} aria-hidden="true" />
                      {:else if style.icon === "eye"}
                        <EyeIcon size={14} class={style.color} aria-hidden="true" />
                      {:else if style.icon === "link"}
                        <LinkSimpleIcon size={14} class={style.color} aria-hidden="true" />
                      {:else if style.icon === "cursor"}
                        <CursorClickIcon size={14} class={style.color} aria-hidden="true" />
                      {:else if style.icon === "camera"}
                        <CameraIcon size={14} class={style.color} aria-hidden="true" />
                      {/if}
                      <span class="text-sm {style.color} font-medium"
                        >{translateCore(`triggerTypes.${wf.trigger.type}` as CoreKey, {
                          default: wf.trigger.type,
                        })}</span
                      >
                    </span>
                    {#if wf.trigger.ref && triggerRoute(wf.trigger.type)}
                      <a href="#/{triggerRoute(wf.trigger.type)}" class="text-left">
                        <span class="block text-muted-foreground text-xs font-mono mt-0.5 break-all"
                          >{wf.trigger.ref}</span
                        >
                      </a>
                    {:else if wf.trigger.ref}
                      <span class="block text-muted-foreground text-xs font-mono mt-0.5 break-all"
                        >{wf.trigger.ref}</span
                      >
                    {/if}
                  </TableCell>
                  <TableCell class="text-center">
                    {#if wf.activeRuns > 0}
                      <span class="text-sm font-medium text-blue-500">{wf.activeRuns}</span>
                    {:else}
                      <span class="text-sm text-muted-foreground">0</span>
                    {/if}
                  </TableCell>
                  <TableCell class="text-center">
                    {#if wf.failedRuns > 0}
                      <span class="text-sm font-medium text-red-500">{wf.failedRuns}</span>
                    {:else}
                      <span class="text-sm text-muted-foreground">0</span>
                    {/if}
                  </TableCell>
                  <TableCell class="text-center">
                    <span class="text-sm text-muted-foreground">{wf.completedRuns}</span>
                  </TableCell>
                  <TableCell class="text-right">
                    {#if confirmingDelete === wf.name}
                      <div class="inline-flex justify-end gap-2 flex-wrap xl:flex-nowrap">
                        <Button size="sm" variant="destructive" onclick={() => deleteWorkflow(wf.name)}
                          >{t("common.confirm")}</Button
                        >
                        <Button
                          size="sm"
                          variant="outline"
                          onclick={() => {
                            confirmingDelete = null;
                          }}
                        >
                          {t("common.cancel")}
                        </Button>
                      </div>
                    {:else}
                      <div class="inline-flex justify-end gap-2 flex-wrap xl:flex-nowrap">
                        <Button size="sm" variant="default" onclick={() => triggerRun(wf.name)}>
                          <PlayIcon size={14} class="mr-1.5" aria-hidden="true" />
                          {t("workflows.run")}
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onclick={() => {
                            confirmingDelete = wf.name;
                          }}
                        >
                          <TrashIcon size={14} class="mr-1.5" aria-hidden="true" />
                          {t("common.delete")}
                        </Button>
                      </div>
                    {/if}
                  </TableCell>
                </TableRow>
              {/each}
            {/if}
          {/each}
        </TableBody>
      </Table>
    </div>
  {/if}
</div>
