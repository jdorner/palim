<script lang="ts">
import HourglassIcon from "phosphor-svelte/lib/HourglassIcon";
import InfoIcon from "phosphor-svelte/lib/InfoIcon";
import PauseCircleIcon from "phosphor-svelte/lib/PauseCircleIcon";
import { onDestroy, onMount, untrack } from "svelte";
import { authFetch } from "$lib/auth";
import LoadingIndicator from "$lib/components/LoadingIndicator.svelte";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { detailPanelMode } from "$lib/detailPanelMode.svelte";
import { extensions } from "$lib/extensionStore";
import { t } from "$lib/i18n.svelte";
import { statusLabel } from "$lib/i18nCore";
import { localizeStepType } from "$lib/stepTypes";
import { formatTimestamp, isRunCancellable, statusVariant } from "$lib/utils";
import { buildStatusMap, type GraphStepStatus } from "$lib/workflowRunStatus";
import { type RunStep, workflowStore } from "$lib/workflowRunStore.svelte";
import ChatMarkdown from "../components/ChatMarkdown.svelte";
import DetailPanelModeToggle from "../components/DetailPanelModeToggle.svelte";
import HumanTaskCard from "../components/HumanTaskCard.svelte";
import SignalDeliveryForm from "../components/SignalDeliveryForm.svelte";
import StatusDot from "../components/StatusDot.svelte";
import StepPanelHeader from "../components/StepPanelHeader.svelte";
import WorkflowGraph from "../components/WorkflowGraph.svelte";
import { navigate, route } from "../router";

type StepStatus = GraphStepStatus;

let loading = $state(true);
let error = $state<string | null>(null);
let cancelling = $state(false);
/**
 * The step shown in the panel: its slug and graph type, plus a placeholder for
 * steps the run has not recorded (skipped branches).
 */
let inspected = $state<{ slug: string; type: string; placeholder?: RunStep } | null>(null);
let stepLogs = $state<Array<{ message: string; timestamp: number }>>([]);
let loadingLogs = $state(false);

/** Full workflow definition steps (DAG nodes as an array with slug). */
let definitionSteps = $state<Array<Record<string, unknown>>>([]);

/** Full workflow definition edges (DAG connections). */
let definitionEdges = $state<Array<{ from: string; to: string; branch?: string }>>([]);

const params = $derived(route.params as { name?: string; runId?: string });
const runId = $derived(params.runId ?? "");
const workflowName = $derived(params.name ?? "");

/** Reactive reference to the store's run state. */
const run = $derived(workflowStore.run);

/**
 * The inspected step, read live from the run so status changes arriving over
 * the WebSocket update the open panel. Steps first seen via WebSocket events
 * have no type; the graph node's type fills in.
 */
const inspectedStep = $derived.by((): RunStep | null => {
  if (!inspected) return null;
  const live = run?.steps.find((s) => s.slug === inspected!.slug);
  if (live) return { ...live, type: live.type || inspected.type };
  return inspected.placeholder ?? null;
});

/** Job whose logs the panel shows, re-read whenever the step's status changes. */
const logSource = $derived(inspectedStep?.jobId ? `${inspectedStep.jobId}:${inspectedStep.status}` : "");

let logRequest = 0;
$effect(() => {
  const source = logSource;
  const jobId = source.slice(0, source.lastIndexOf(":"));
  const request = ++logRequest;
  if (!jobId) {
    loadingLogs = false;
    return;
  }
  // Keep the logs already shown while refreshing; only the first load shows the spinner.
  if (untrack(() => stepLogs.length) === 0) loadingLogs = true;
  authFetch(`/api/jobs/${jobId}/logs`)
    .then(async (res) => {
      if (request !== logRequest) return;
      if (res.ok) stepLogs = ((await res.json()).logs ?? []) as typeof stepLogs;
    })
    .catch(() => {
      /* ignore */
    })
    .finally(() => {
      if (request === logRequest) loadingLogs = false;
    });
});

/**
 * Custom step types registered by enabled extensions, derived from the
 * extension store. Passed to the graph so custom step nodes render their
 * extension-declared icon (and terminal/category styling) instead of the
 * generic gear fallback.
 */
const customStepTypes = $derived(
  $extensions
    .filter((ext) => ext.enabled && ext.ui?.stepTypes?.length)
    .flatMap((ext) => ext.ui!.stepTypes!.map(localizeStepType)),
);

/**
 * Builds a slug-to-status map from the run steps, including skipped branch detection.
 * Steps in the run get their actual status. All other steps in the definition
 * that were not executed get "skipped" (if the run is past their branch point)
 * or "waiting" (if the run hasn't reached them yet).
 */
const statusMap = $derived.by((): Record<string, StepStatus> => {
  if (!run) return {};
  return buildStatusMap(
    run.steps.map((s) => ({ slug: s.slug, status: s.status as string })),
    run.status,
    definitionSteps.map((s) => s.slug as string),
    definitionEdges,
    workflowStore.chosenBranches,
  );
});

async function fetchRun() {
  if (!runId) return;
  loading = true;
  error = null;
  try {
    // Fetch both run data and workflow definition in parallel
    const [runRes, defRes] = await Promise.all([
      authFetch(`/ext/workflows/runs/${runId}`),
      authFetch(`/ext/workflows/${workflowName}`),
    ]);
    if (!runRes.ok) throw new Error(`HTTP ${runRes.status}`);
    const detail = await runRes.json();
    workflowStore.track(runId, detail);

    // Load definition steps (best-effort; fall back to run steps if unavailable).
    // DAG format: steps is a map keyed by slug, edges is an array.
    if (defRes.ok) {
      const def = await defRes.json();
      const stepsMap = (def.steps ?? {}) as Record<string, Record<string, unknown>>;
      definitionSteps = Object.entries(stepsMap).map(([slug, s]) => ({ slug, ...s }));
      definitionEdges = def.edges ?? [];
    }
  } catch (err) {
    error = err instanceof Error ? err.message : t("runs.loadFailed");
  } finally {
    loading = false;
  }
}

let sidebarOpen = $state(false);

async function cancelRun() {
  if (!runId) return;
  cancelling = true;
  try {
    const res = await authFetch(`/ext/workflows/runs/${runId}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    navigate("/workflows/:name", { params: { name: `${workflowName}` } });
  } catch (err) {
    console.error("Failed to cancel workflow run:", err);
  } finally {
    cancelling = false;
  }
}

function openSidebar(step: { slug: string; type: string; status?: string; jobId?: string }) {
  const found = run?.steps.find((s) => s.slug === step.slug);
  if (!found) {
    // Step exists in definition but was not executed (skipped) - just show status
    if (step.status === "skipped") {
      inspected = {
        slug: step.slug,
        type: step.type,
        placeholder: { slug: step.slug, type: step.type, status: "waiting", jobId: "" },
      };
      stepLogs = [];
      sidebarOpen = true;
    }
    return;
  }

  // Double-clicking the same step toggles the sidebar closed
  if (inspected?.slug === found.slug && sidebarOpen) {
    closeSidebar();
    return;
  }

  inspected = { slug: step.slug, type: step.type };
  stepLogs = [];
  sidebarOpen = true;
}

function closeSidebar() {
  sidebarOpen = false;
  // Delay clearing data so the slide-out animation can play
  setTimeout(() => {
    if (!sidebarOpen) {
      inspected = null;
      stepLogs = [];
    }
  }, 200);
}

/** Escape dismisses the floating log panel (the docked sidebar has its own close button). */
function handleKeydown(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  if (detailPanelMode.current === "floating" && sidebarOpen) {
    e.preventDefault();
    closeSidebar();
  }
}

onMount(() => {
  fetchRun();
});
onDestroy(() => {
  workflowStore.untrack();
});
</script>

<svelte:window onkeydown={handleKeydown} />

{#if loading}
  <LoadingIndicator />
{:else if error}
  <p class="text-sm text-destructive">{error}</p>
{:else if run}
  <div class="flex flex-col h-[calc(100vh-8rem)] overflow-hidden">
    <div class="flex items-center justify-between mb-4 shrink-0">
      <div class="flex items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          onclick={() => {
            navigate("/workflows/:name", {
              params: { name: `${workflowName}` },
            });
          }}
        >
          &laquo;&nbsp;{t("common.back")}
        </Button>
        <span class="text-xs text-muted-foreground font-mono">{t("runs.runId", { id: run.runId.slice(0, 8) })}</span>
      </div>
      <div class="flex items-center gap-2">
        <DetailPanelModeToggle />
        {#if isRunCancellable(run.status)}
          <Button size="sm" variant="destructive" onclick={cancelRun} disabled={cancelling}>
            <span class="text-xs font-bold mr-1.5" aria-hidden="true">&#x2715;</span>
            {cancelling ? t("runs.cancelling") : t("common.cancel")}
          </Button>
        {/if}
        <Badge variant={statusVariant(run.status)}>{statusLabel(run.status)}</Badge>
      </div>
    </div>

    <div class="flex flex-1 min-h-0 gap-0">
      <!-- Graph area -->
      <div class="flex-1 min-w-0 overflow-auto transition-all duration-200">
        <WorkflowGraph
          steps={(definitionSteps.length > 0
            ? definitionSteps
            : run.steps.map((s) => ({
                slug: s.slug,
                type: s.type,
                status: s.status,
                jobId: s.jobId,
              }))) as Array<{ slug: string; type: string; [key: string]: unknown }>}
          edges={definitionEdges}
          trigger={run.trigger ?? undefined}
          statusMap={definitionSteps.length > 0 ? statusMap : undefined}
          {customStepTypes}
          selectedStepId={sidebarOpen ? inspectedStep?.slug : undefined}
          nodePanel={detailPanelMode.current === "floating" ? floatingLogPanel : undefined}
          onNodeClick={openSidebar}
          onPaneClick={() => {
            // The floating panel overlays the canvas, so clicking empty
            // canvas dismisses it. The docked sidebar stays open.
            if (detailPanelMode.current === "floating" && sidebarOpen) closeSidebar();
          }}
        />
      </div>

      <!-- Log sidebar (docked mode) -->
      {#if detailPanelMode.current === "sidebar"}
        <div
          class="shrink-0 overflow-hidden transition-all duration-200 ease-in-out bg-background"
          class:w-0={!sidebarOpen}
          class:border-l-0={!sidebarOpen}
          class:w-[380px]={sidebarOpen}
        >
          {@render logPanel()}
        </div>
      {/if}
    </div>
  </div>
{/if}

<!-- Step status/log content, rendered either in the docked sidebar or in a
     floating panel anchored beneath the selected node. -->
{#snippet logPanel()}
  {#if inspectedStep && run}
    <div class="w-95 h-full flex flex-col">
      <StepPanelHeader type={inspectedStep.type} subtitle={inspectedStep.slug} onclose={closeSidebar}>
        {#snippet badge()}
          <span
            class="flex items-center gap-1.5 rounded-full bg-black/35 px-2 py-0.5 text-[11px] font-semibold text-white ring-1 ring-white/25"
          >
            <StatusDot status={inspectedStep!.status} />
            {statusLabel(inspectedStep!.status)}
          </span>
        {/snippet}
      </StepPanelHeader>

      <!-- Sidebar content -->
      <div class="flex-1 overflow-y-auto min-h-0 p-4">
        {#if inspectedStep.status === "waiting" || inspectedStep.status === "pending"}
          {@render emptyState(HourglassIcon, t("runs.waitingPrevious"))}
        {:else if inspectedStep.status === "waiting-signal"}
          <div class="flex items-center gap-2 mb-3">
            <PauseCircleIcon size={16} class="text-amber-500" aria-hidden="true" />
            <p class="text-sm text-muted-foreground">{t("runs.waitingSignal")}</p>
          </div>
          {#if inspectedStep.type === "humanTask"}
            <HumanTaskCard runId={run.runId} stepSlug={inspectedStep.slug} />
          {:else if inspectedStep.waitEvent}
            <SignalDeliveryForm
              runId={run.runId}
              stepSlug={inspectedStep.slug}
              event={inspectedStep.waitEvent}
              inputSchema={inspectedStep.waitInputSchema}
            />
          {/if}
        {:else if inspectedStep.error}
          <p class="text-xs font-medium text-muted-foreground mb-1">{t("runs.stepError")}</p>
          <div
            class="text-xs font-mono whitespace-pre-wrap wrap-break-word rounded bg-destructive/10 text-destructive p-2"
          >
            {inspectedStep.error}
          </div>
        {:else if inspectedStep.evaluation}
          {@const evaluation = inspectedStep.evaluation}
          <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs">
            <dt class="text-muted-foreground">{t("runs.evaluation.expression")}</dt>
            <dd class="font-mono break-all">{evaluation.expression}</dd>
            {#if evaluation.value !== undefined}
              <dt class="text-muted-foreground">{t("runs.evaluation.value")}</dt>
              <dd class="font-mono break-all">
                {#if evaluation.value === null}
                  <span class="italic text-muted-foreground">{t("runs.evaluation.unresolved")}</span>
                {:else}
                  {JSON.stringify(evaluation.value)}
                {/if}
              </dd>
            {/if}
            {#if evaluation.operator}
              <dt class="text-muted-foreground">{t("runs.evaluation.comparison")}</dt>
              <dd class="font-mono break-all">{evaluation.operator} {JSON.stringify(evaluation.operand)}</dd>
            {/if}
            <dt class="text-muted-foreground">{t("runs.evaluation.branch")}</dt>
            <dd class="font-mono font-medium">
              {evaluation.fallback ? t("runs.evaluation.fallback", { branch: evaluation.branch }) : evaluation.branch}
            </dd>
          </dl>
        {:else if loadingLogs}
          <p class="text-sm text-muted-foreground">{t("jobs.loadingLogs")}</p>
        {:else if stepLogs.length === 0}
          {@render emptyState(InfoIcon, t("runs.noLogs"))}
        {:else}
          <div class="space-y-1">
            {#each stepLogs as log}
              <div class="flex flex-col gap-0.5 text-xs font-mono bg-muted p-2 rounded">
                {#if log.timestamp}
                  <span class="text-muted-foreground text-[10px]">{formatTimestamp(log.timestamp)}</span>
                {/if}
                <div class="whitespace-pre-wrap wrap-break-word"><ChatMarkdown content={log.message} /></div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  {/if}
{/snippet}

<!-- Centered placeholder for a step panel without content. -->
{#snippet emptyState(
  Icon: typeof InfoIcon,
  message: string,
)}
  <div class="flex h-full min-h-32 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
    <Icon size={28} weight="duotone" class="opacity-70" aria-hidden="true" />
    <p class="text-sm">{message}</p>
  </div>
{/snippet}

{#snippet floatingLogPanel()}
  <div class="h-112 max-h-[60vh] overflow-hidden rounded-lg border border-border bg-background shadow-xl">
    {@render logPanel()}
  </div>
{/snippet}
