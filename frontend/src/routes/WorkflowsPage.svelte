<script lang="ts">
import { attachDraggable, attachDroppable, type DragDropState, dndState } from "@thisux/sveltednd";
import CameraIcon from "phosphor-svelte/lib/CameraIcon";
import CaretRightIcon from "phosphor-svelte/lib/CaretRightIcon";
import CursorClickIcon from "phosphor-svelte/lib/CursorClickIcon";
import DotsSixVerticalIcon from "phosphor-svelte/lib/DotsSixVerticalIcon";
import EyeIcon from "phosphor-svelte/lib/EyeIcon";
import FolderPlusIcon from "phosphor-svelte/lib/FolderPlusIcon";
import LinkSimpleIcon from "phosphor-svelte/lib/LinkSimpleIcon";
import PlayIcon from "phosphor-svelte/lib/PlayIcon";
import TimerIcon from "phosphor-svelte/lib/TimerIcon";
import WarningIcon from "phosphor-svelte/lib/WarningIcon";
import { onDestroy } from "svelte";
import { onReconnect } from "$lib/appStore";
import { authFetch } from "$lib/auth";
import LoadingIndicator from "$lib/components/LoadingIndicator.svelte";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "$lib/components/ui/table";
import { t } from "$lib/i18n.svelte";
import { type CoreKey, translateCore } from "$lib/i18nCore";
import { automationStyle } from "$lib/utils";
import { warningLocation } from "$lib/workflowDetail";
import {
  containerGroup,
  GROUP_NAME_MAX_LENGTH,
  groupContainer,
  NEW_GROUP_CONTAINER,
  normalizeGroupName,
} from "$lib/workflowGroupDnd";
import {
  groupWorkflows,
  readCollapsedGroups,
  sectionKey,
  sumRunCounts,
  type WorkflowRunCounts,
  writeCollapsedGroups,
} from "$lib/workflowGroups";
import { listNeedsRefetch } from "$lib/workflowList";
import { type WorkflowEvent, workflowStore } from "$lib/workflowRunStore.svelte";
import type { WorkflowLoadError } from "../../../shared/workflows";
import DeleteButton from "../components/DeleteButton.svelte";
import IconAction from "../components/IconAction.svelte";
import StatusDot from "../components/StatusDot.svelte";
import { navigate } from "../router";

interface WorkflowSummary {
  name: string;
  description?: string;
  group?: string;
  trigger: { type: string; ref?: string };
  stepCount: number;
  enabled: boolean;
  /** A draft runs only by hand until it is activated. */
  draft?: boolean;
  steps: Array<{ slug: string; type: string }>;
  activeRuns: number;
  /** Runs paused on a signal, human task or wait step. */
  waitingRuns: number;
  completedRuns: number;
  failedRuns: number;
  warnings: Array<{ stepSlug: string; field: string; message: string }>;
}

let workflows = $state<WorkflowSummary[]>([]);
/** Workflow files the server skipped as invalid, so they are not in `workflows`. */
let loadErrors = $state<WorkflowLoadError[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);
let errorDetail = $state<string | null>(null);
let collapsedGroups = $state(readCollapsedGroups());
let moveError = $state<string | null>(null);
/** Workflow dropped on the "new group" zone, waiting for the group name. */
let newGroupFor = $state<string | null>(null);
let newGroupName = $state("");
/** Touch/pen position during a pointer drag, for the floating label. */
let dragPointer = $state<{ x: number; y: number } | null>(null);

/** Name of the workflow being dragged, or `null`. */
const draggedName = $derived(
  dndState.isDragging && typeof dndState.draggedItem === "string" ? dndState.draggedItem : null,
);

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

function groupLabel(group: string | null): string {
  return group ?? t("workflows.ungrouped");
}

/** Label of a drop zone, for screen-reader announcements. */
function containerLabel(container: string | null): string {
  if (container === NEW_GROUP_CONTAINER) return t("workflows.dropNewGroup");
  const group = container === null ? undefined : containerGroup(container);
  return group === undefined ? "" : groupLabel(group);
}

/** Optimistically moves a workflow to a group; reverts and reports on failure. */
async function moveToGroup(name: string, group: string | null) {
  const wf = workflows.find((w) => w.name === name);
  if (!wf || (wf.group ?? null) === group) return;
  const previous = wf.group;
  const setGroup = (value: string | undefined) => {
    workflows = workflows.map((w) => (w.name === name ? { ...w, group: value } : w));
  };
  moveError = null;
  setGroup(group ?? undefined);
  try {
    const res = await authFetch(`/ext/workflows/${encodeURIComponent(name)}/group`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
      throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${res.status}`);
    }
  } catch (err) {
    setGroup(previous);
    moveError = t("workflows.moveFailed", { name, error: err instanceof Error ? err.message : String(err) });
  }
}

function handleDrop(state: DragDropState<string>) {
  const target = state.targetContainer;
  if (!target || target === state.sourceContainer) return;
  if (target === NEW_GROUP_CONTAINER) {
    newGroupFor = state.draggedItem;
    newGroupName = "";
    return;
  }
  const group = containerGroup(target);
  if (group !== undefined) void moveToGroup(state.draggedItem, group);
}

function submitNewGroup(event: SubmitEvent) {
  event.preventDefault();
  const group = normalizeGroupName(newGroupName);
  if (!newGroupFor || !group) return;
  const name = newGroupFor;
  newGroupFor = null;
  void moveToGroup(name, group);
}

/** Focuses the new-group input right after the drop that opened it. */
function focusOnMount(el: HTMLElement) {
  el.focus();
}

/** Drop zone of a group section (or of the "new group" target). */
function dropZone(container: string) {
  return attachDroppable<string>({
    container,
    callbacks: { onDrop: handleDrop },
    attributes: { dragOverClass: "wf-drop-over" },
  });
}

/**
 * Drag handle of a workflow. Only the grip is draggable: the library disables
 * touch scrolling on its draggable element, which must not be the whole card.
 */
function dragHandle(name: string, group: string | null) {
  return attachDraggable<string>({
    container: groupContainer(group),
    dragData: name,
    keyboard: {
      announcements: {
        grabbed: () => t("workflows.dndGrabbed", { name }),
        moved: (c) => t("workflows.dndOver", { group: containerLabel(c.targetContainer) }),
        dropped: (c) => t("workflows.dndDropped", { name, group: containerLabel(c.targetContainer) }),
        cancelled: () => t("workflows.dndCancelled"),
        invalid: () => t("workflows.dndCancelled"),
      },
    },
  });
}

/**
 * Replaces the browser's drag image (a translucent copy of the grip, or of the
 * whole row) with the same name chip that follows touch drags.
 */
function dragImageChip(name: string) {
  return (handle: HTMLElement) => {
    const onDragStart = (event: DragEvent) => {
      if (!event.dataTransfer) return;
      const chip = document.createElement("div");
      chip.className = "wf-drag-label";
      chip.textContent = name;
      // Rendered off-screen: the browser snapshots it during dragstart.
      chip.style.left = "-1000px";
      chip.style.top = "-1000px";
      document.body.append(chip);
      event.dataTransfer.setDragImage(chip, -12, -12);
      requestAnimationFrame(() => chip.remove());
    };
    handle.addEventListener("dragstart", onDragStart);
    return () => handle.removeEventListener("dragstart", onDragStart);
  };
}

// Pointer drags (touch, pen) get no browser drag image: track the finger for a floating label.
$effect(() => {
  if (!draggedName || dndState.dragInput !== "pointer") {
    dragPointer = null;
    return;
  }
  const onMove = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") dragPointer = { x: e.clientX, y: e.clientY };
  };
  document.addEventListener("pointermove", onMove);
  return () => document.removeEventListener("pointermove", onMove);
});

/** Sequence number of the latest list fetch; an older response that arrives later is dropped. */
let fetchSeq = 0;

async function fetchWorkflows(showLoading = true) {
  const seq = ++fetchSeq;
  if (showLoading) loading = true;
  error = null;
  errorDetail = null;
  try {
    const [res, errorsRes] = await Promise.all([
      authFetch("/ext/workflows"),
      authFetch("/ext/workflows/meta/load-errors"),
    ]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const fresh = (await res.json()).sort((a: WorkflowSummary, b: WorkflowSummary) => a.name.localeCompare(b.name));
    // The list stays usable when only the load errors cannot be fetched.
    const freshErrors = errorsRes.ok ? await errorsRes.json() : [];
    if (seq !== fetchSeq) return;
    workflows = fresh;
    loadErrors = freshErrors;
  } catch (err) {
    if (seq !== fetchSeq) return;
    const msg = err instanceof Error ? err.message : "";
    errorDetail = msg || t("common.unknownError");
    if (msg.includes("Failed to fetch") || msg.includes("502") || msg.includes("503") || msg.includes("NetworkError")) {
      error = t("common.serverUnreachable");
    } else {
      error = t("workflows.loadFailed");
    }
  } finally {
    if (seq === fetchSeq) loading = false;
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

/** The text after a broken file's name: which workflow it unloaded, if any, and why it is invalid. */
function loadErrorReason(loadError: WorkflowLoadError): string {
  const unloaded = loadError.unloaded ? ` (${t("workflows.loadErrorUnloaded", { name: loadError.unloaded })})` : "";
  return `${unloaded}: ${loadError.error}`;
}

/** Handle real-time workflow events: run counts, and workflow files changed on disk (by an agent or an editor). */
function handleWorkflowEvent(msg: WorkflowEvent) {
  if (msg.type === "workflow_started") {
    workflows = workflows.map((wf) => (wf.name === msg.workflowName ? { ...wf, activeRuns: wf.activeRuns + 1 } : wf));
  }
  if (listNeedsRefetch(msg.type)) {
    fetchWorkflows(false);
  }
}

const unsubWorkflow = workflowStore.subscribe(handleWorkflowEvent);
// Events sent while the socket was down are lost, so catch up on reconnect.
const unsubReconnect = onReconnect(() => fetchWorkflows(false));

onDestroy(() => {
  unsubWorkflow();
  unsubReconnect();
});

$effect(() => {
  fetchWorkflows();
});

/** One run counter of a workflow or group: status for StatusDot, color, count, and tooltip text. */
interface RunCountItem {
  status: "active" | "waiting-signal" | "failed" | "completed";
  color: string;
  count: number;
  label: string;
}

/**
 * The four run counters in display order: active, waiting, failed, completed.
 *
 * @param counts - Counters of a workflow or a group subtotal
 * @returns One entry per status
 */
function runCountItems(counts: WorkflowRunCounts): RunCountItem[] {
  return [
    {
      status: "active",
      color: "text-blue-500",
      count: counts.activeRuns,
      label: t("workflows.runsActive", { count: counts.activeRuns }),
    },
    {
      status: "waiting-signal",
      color: "text-amber-500",
      count: counts.waitingRuns,
      label: t("workflows.runsWaiting", { count: counts.waitingRuns }),
    },
    {
      status: "failed",
      color: "text-red-500",
      count: counts.failedRuns,
      label: t("workflows.runsFailed", { count: counts.failedRuns }),
    },
    {
      status: "completed",
      color: "text-green-600 dark:text-green-500",
      count: counts.completedRuns,
      label: t("workflows.runsCompleted", { count: counts.completedRuns }),
    },
  ];
}
</script>

<!-- Row actions: Run, Delete rightmost as a muted trash icon -->
{#snippet actions(wf: WorkflowSummary)}
  <IconAction label={t("workflows.run")} icon={PlayIcon} onclick={() => triggerRun(wf.name)} />
  <DeleteButton
    url="/ext/workflows/{wf.name}"
    confirmTitle={t("workflows.deleteTitle")}
    confirmMessage={t("workflows.deleteConfirm", { name: wf.name })}
    iconOnly
    onDeleted={() => fetchWorkflows(false)}
  />
{/snippet}

{#snippet groupHeader(group: string | null, count: number, hasWarnings: boolean)}
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
    {#if hasWarnings}
      <span class="inline-flex shrink-0 text-amber-500" title={t("workflows.groupHasWarnings")}>
        <WarningIcon size={14} aria-hidden="true" />
        <span class="sr-only">{t("workflows.groupHasWarnings")}</span>
      </span>
    {/if}
  </button>
{/snippet}

<!--
  Run counters of the table in fixed slots, so they line up across rows and under the
  header dots: active, waiting, failed, completed. A number above zero has its status
  color, a zero is grey; the tooltip names the status.
-->
{#snippet runCounts(counts: WorkflowRunCounts)}
  <div class="grid w-44 grid-cols-4 justify-items-center text-sm tabular-nums">
    {#each runCountItems(counts) as item (item.status)}
      <span class={item.count > 0 ? item.color : "text-muted-foreground"} title={item.label}>
        <span aria-hidden="true">{item.count}</span>
        <span class="sr-only">{item.label}</span>
      </span>
    {/each}
  </div>
{/snippet}

<!--
  Run counters of a card (no column header there to explain them): status dot plus
  number. The dot always has its status color; a zero count is grey. The tooltip and screen-reader text name the status.
-->
{#snippet cardRunCounts(counts: WorkflowRunCounts, textClass: string)}
  <div class="flex flex-wrap items-center gap-x-4 gap-y-1 tabular-nums {textClass}">
    {#each runCountItems(counts) as item (item.status)}
      <span
        class="inline-flex items-center gap-1.5 {item.count > 0 ? item.color : "text-muted-foreground"}"
        title={item.label}
      >
        <StatusDot status={item.status} still={item.count === 0} />
        <span aria-hidden="true">{item.count}</span>
        <span class="sr-only">{item.label}</span>
      </span>
    {/each}
  </div>
{/snippet}

<!-- Column header for runCounts: the four status dots, named by their tooltips. -->
{#snippet runLegend()}
  <div class="grid w-44 grid-cols-4 justify-items-center" aria-hidden="true">
    {#each [
      ["active", t("workflows.colActive")],
      ["waiting-signal", t("workflows.colWaiting")],
      ["failed", t("workflows.colFailed")],
      ["completed", t("workflows.colCompleted")],
    ] as [status, label] (status)}
      <span class="inline-flex items-center py-2" title={label}><StatusDot {status} size="md" still /></span>
    {/each}
  </div>
{/snippet}

{#snippet grip(wf: WorkflowSummary)}
  <span
    class="wf-grip"
    title={t("workflows.dragHandle", { name: wf.name })}
    {@attach dragHandle(wf.name, wf.group ?? null)}
    {@attach dragImageChip(wf.name)}
  >
    <DotsSixVerticalIcon size={16} aria-hidden="true" />
    <span class="sr-only">{t("workflows.dragHandle", { name: wf.name })}</span>
  </span>
{/snippet}

{#snippet draftBadge()}
  <Badge
    variant="outline"
    class="shrink-0 font-normal border-amber-500/50 text-amber-600 dark:text-amber-400"
    title={t("workflows.draftHint")}
    >{t("workflows.draft")}</Badge
  >
{/snippet}

{#snippet cardSubtotals(totals: WorkflowRunCounts)}
  {@render cardRunCounts(totals, "pl-5 text-xs")}
{/snippet}

<div class="space-y-4">
  {#if !loading && !error && loadErrors.length > 0}
    <div class="error-card" role="alert">
      <p class="error-card-message flex items-center gap-1.5 font-medium">
        <WarningIcon size={16} aria-hidden="true" />
        {t("workflows.loadErrorsTitle", { count: loadErrors.length })}
      </p>
      <ul class="mt-1 space-y-1">
        {#each loadErrors as loadError (loadError.file)}
          <li class="error-card-detail break-words">
            <span class="font-semibold">{loadError.file}</span>{loadErrorReason(loadError)}
          </li>
        {/each}
      </ul>
      <p class="error-card-message mt-2 text-xs">{t("workflows.loadErrorsHint")}</p>
    </div>
  {/if}
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
    {#if moveError}
      <div class="error-card flex items-start justify-between gap-2" role="alert">
        <p class="error-card-message">{moveError}</p>
        <Button size="sm" variant="outline" onclick={() => (moveError = null)}>{t("common.close")}</Button>
      </div>
    {/if}
    {#if newGroupFor}
      <form class="flex flex-wrap items-end gap-2 rounded-md border border-border p-3" onsubmit={submitNewGroup}>
        <label class="flex min-w-48 flex-1 flex-col gap-1 text-sm">
          <span class="font-medium">{t("workflows.newGroupFor", { name: newGroupFor })}</span>
          <input
            class="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
            bind:value={newGroupName}
            maxlength={GROUP_NAME_MAX_LENGTH}
            placeholder={t("workflows.newGroupPlaceholder")}
            {@attach focusOnMount}
            onkeydown={(e) => {
              if (e.key === "Escape") newGroupFor = null;
            }}
          >
        </label>
        <div class="flex gap-2">
          <Button size="sm" type="submit" disabled={!normalizeGroupName(newGroupName)}>{t("workflows.move")}</Button>
          <Button size="sm" variant="outline" onclick={() => (newGroupFor = null)}>{t("common.cancel")}</Button>
        </div>
      </form>
    {/if}
    <!-- Mobile & Tablet: Card layout -->
    <div class="responsive-cards">
      {#each sections as section (sectionKey(section.group))}
        <div class="wf-drop-zone flex flex-col gap-3 rounded-md" {@attach dropZone(groupContainer(section.group))}>
          {#if showGroupHeaders}
            <div class="space-y-1 pt-2">
              {@render groupHeader(
                section.group,
                section.items.length,
                section.items.some((wf) => wf.warnings.length > 0),
              )}
              {@render cardSubtotals(sumRunCounts(section.items))}
            </div>
          {/if}
          {#if !isCollapsed(section.group)}
            {#each section.items as wf (wf.name)}
              {@const style = automationStyle(wf.trigger.type)}
              <div
                class="rounded-md border border-border bg-background p-4 space-y-3 {draggedName === wf.name
                  ? "opacity-50"
                  : ""}"
              >
                <!-- Header: Grip + Name + Trigger -->
                <div class="flex items-start justify-between gap-2">
                  {@render grip(wf)}
                  <div class="min-w-0 flex-1">
                    <!-- The badge sits beside the link, not in it, so it takes no link underline. -->
                    <div class="flex items-center gap-2">
                      <a href="#/workflows/{wf.name}" class="min-w-0 font-medium truncate">{wf.name}</a>
                      {#if wf.draft}
                        {@render draftBadge()}
                      {/if}
                    </div>
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
                        >{translateCore(`triggerTypes.${wf.trigger.type}` as CoreKey, {
                          default: wf.trigger.type,
                        })}</span
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

                <!-- Stats row, indented to the name: grip (16px icon + 6px padding net of its negative margin) + gap-2 -->
                {@render cardRunCounts(wf, "pl-7.5 text-sm")}

                <hr>

                <!-- Actions -->
                <div class="flex flex-wrap items-center gap-2">
                  {@render actions(wf)}
                </div>
              </div>
            {/each}
          {/if}
        </div>
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
            <TableHead class="w-44">
              <span class="sr-only">{t("workflows.colRuns")}</span>
              {@render runLegend()}
            </TableHead>
            <TableHead class="w-24 text-center">{t("common.actions")}</TableHead>
          </TableRow>
        </TableHeader>
        {#each sections as section, sectionIndex (sectionKey(section.group))}
          <TableBody
            class="wf-drop-zone {sectionIndex < sections.length - 1 ? "[&_tr:last-child]:border-b" : ""}"
            {@attach dropZone(groupContainer(section.group))}
          >
            {#if showGroupHeaders}
              {@const totals = sumRunCounts(section.items)}
              <TableRow class="bg-muted/20 hover:bg-muted/30">
                <TableCell colspan={2}
                  >{@render groupHeader(
                    section.group,
                    section.items.length,
                    section.items.some((wf) => wf.warnings.length > 0),
                  )}</TableCell
                >
                <TableCell>{@render runCounts(totals)}</TableCell>
                <TableCell></TableCell>
              </TableRow>
            {/if}
            {#if !isCollapsed(section.group)}
              {#each section.items as wf (wf.name)}
                <TableRow class={draggedName === wf.name ? "opacity-50" : ""}>
                  <!-- max-w-0 + w-full: the name column takes the remaining width and truncates instead of growing -->
                  <TableCell class="w-full max-w-0">
                    <div class="flex items-start gap-1.5">
                      {@render grip(wf)}
                      <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-2">
                          <a href="#/workflows/{wf.name}" class="font-medium text-left">{wf.name}</a>
                          {#if wf.draft}
                            {@render draftBadge()}
                          {/if}
                        </div>
                        {#if wf.description}
                          <p class="text-xs text-muted-foreground mt-0.5 truncate" title={wf.description}>
                            {wf.description}
                          </p>
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
                      </div>
                    </div>
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
                        <span
                          class="block max-w-44 truncate text-muted-foreground text-xs font-mono mt-0.5"
                          title={wf.trigger.ref}
                          >{wf.trigger.ref}</span
                        >
                      </a>
                    {:else if wf.trigger.ref}
                      <span
                        class="block max-w-44 truncate text-muted-foreground text-xs font-mono mt-0.5"
                        title={wf.trigger.ref}
                        >{wf.trigger.ref}</span
                      >
                    {/if}
                  </TableCell>
                  <TableCell>{@render runCounts(wf)}</TableCell>
                  <TableCell class="text-center">
                    <div class="inline-flex items-center justify-center gap-1 flex-nowrap">
                      {@render actions(wf)}
                    </div>
                  </TableCell>
                </TableRow>
              {/each}
            {/if}
          </TableBody>
        {/each}
      </Table>
    </div>
  {/if}
</div>

{#if draggedName}
  <!-- Fixed to the viewport so it stays reachable while dragging through a long list on a phone. -->
  <div class="wf-new-group-zone" {@attach dropZone(NEW_GROUP_CONTAINER)}>
    <FolderPlusIcon size={18} aria-hidden="true" />
    {t("workflows.dropNewGroup")}
  </div>
{/if}

{#if draggedName && dragPointer}
  <div class="wf-drag-label" style="left: {dragPointer.x + 12}px; top: {dragPointer.y + 12}px">{draggedName}</div>
{/if}

<style>
.wf-grip {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  /* Comfortable touch target around the 16px icon. */
  margin: -0.375rem 0 -0.375rem -0.375rem;
  padding: 0.375rem;
  border-radius: 0.25rem;
  color: hsl(var(--muted-foreground));
  cursor: grab;
}
.wf-grip:hover,
.wf-grip:focus-visible {
  background: hsl(var(--muted));
  color: hsl(var(--foreground));
}
/* Drop highlight in Palim's signature amber, the logo color (the theme's
   primary is near-black and would only grey the target out). */
:global(.wf-drop-zone) {
  --wf-drop-accent: var(--color-amber-500);
  /* Opaque: a translucent tint shows seams where table cells overlap. */
  --wf-drop-tint: color-mix(in oklab, var(--wf-drop-accent) 8%, hsl(var(--background)));
}
/* Card sections: a tinted area with a ring, padded out so it does not hug the cards. */
:global(div.wf-drop-zone.wf-drop-over) {
  border-radius: 0.375rem;
  background: var(--wf-drop-tint);
  box-shadow:
    0 0 0 0.5rem var(--wf-drop-tint),
    0 0 0 calc(0.5rem + 2px) color-mix(in oklab, var(--wf-drop-accent) 50%, transparent);
}
/* Table sections: outlines on <tbody> render as stray lines, so tint the rows
   and mark the section with an accent bar along its left edge. */
:global(tbody.wf-drop-zone.wf-drop-over > tr > td) {
  background: var(--wf-drop-tint);
}
:global(tbody.wf-drop-zone.wf-drop-over > tr > td:first-child) {
  /* Only a 3px image strip: a full-width gradient leaves a sub-pixel seam on fractional cell widths. */
  background-image: linear-gradient(var(--wf-drop-accent), var(--wf-drop-accent));
  background-size: 3px 100%;
  background-repeat: no-repeat;
}
/* Groups are sorted by name, so the library's insert-position lines would mislead. */
:global(.wf-drop-zone.drop-before::before),
:global(.wf-drop-zone.drop-after::after) {
  display: none;
}
.wf-new-group-zone {
  position: fixed;
  inset-inline: 1rem;
  bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  margin-inline: auto;
  max-width: 32rem;
  padding: 1rem;
  border: 2px dashed hsl(var(--border));
  border-radius: 0.5rem;
  background: hsl(var(--background));
  color: hsl(var(--muted-foreground));
  font-size: 0.875rem;
  box-shadow: 0 4px 16px rgb(0 0 0 / 0.12);
}
:global(.wf-new-group-zone.wf-drop-over) {
  border-color: var(--color-amber-500);
  background: color-mix(in oklab, var(--color-amber-500) 8%, hsl(var(--background)));
  color: hsl(var(--foreground));
}
:global(.wf-drag-label) {
  position: fixed;
  z-index: 50;
  pointer-events: none;
  max-width: 16rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0.25rem 0.625rem;
  border: 1px solid hsl(var(--border));
  border-radius: 0.375rem;
  background: hsl(var(--background));
  font-size: 0.875rem;
  font-weight: 500;
  box-shadow: 0 4px 12px rgb(0 0 0 / 0.15);
}
</style>
