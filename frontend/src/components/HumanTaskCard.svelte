<!--
  The open human task of a waiting `humanTask` step on the run page: title,
  assignees, due date, a link to the portal, and (with hitl:manage) cancel.
  Loads the task from the run detail, so it also works when the step started
  waiting through a live update.
-->
<script lang="ts">
import ArrowSquareOutIcon from "phosphor-svelte/lib/ArrowSquareOutIcon";
import UserCheckIcon from "phosphor-svelte/lib/UserCheckIcon";
import { onMount } from "svelte";
import { authFetch } from "$lib/auth";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { buttonVariants } from "$lib/components/ui/button/button.svelte";
import { i18n, t } from "$lib/i18n.svelte";
import { identity } from "$lib/identity.svelte";

interface Props {
  /** The workflow run ID. */
  runId: string;
  /** Slug of the waiting humanTask step. */
  stepSlug: string;
}

/** The waiting task as returned in the run detail. */
interface WaitingTask {
  id: string;
  title: string;
  priority: string;
  dueAt: number | null;
  createdAt: number;
  assignees: { users: string[]; roles: string[] };
}

let { runId, stepSlug }: Props = $props();

let task = $state<WaitingTask | null>(null);
let loaded = $state(false);
let confirmingCancel = $state(false);
let busy = $state(false);
let error = $state<string | null>(null);
let cancelled = $state(false);

const canManage = $derived(identity.can("manage", "HumanTask"));
const portalLink = $derived(task && identity.portalUrl ? `${identity.portalUrl}/tasks/${task.id}` : null);

onMount(async () => {
  try {
    const res = await authFetch(`/ext/workflows/runs/${encodeURIComponent(runId)}`);
    if (res.ok) {
      const data = (await res.json()) as { steps: { slug: string; humanTask?: WaitingTask }[] };
      task = data.steps.find((s) => s.slug === stepSlug)?.humanTask ?? null;
    }
  } finally {
    loaded = true;
  }
});

async function cancelTask() {
  if (!task) return;
  busy = true;
  error = null;
  try {
    const res = await authFetch(`/api/portal/tasks/${encodeURIComponent(task.id)}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (res.ok) {
      cancelled = true;
    } else {
      const data = await res.json().catch(() => null);
      error = data?.error ?? t("humanTask.cancelFailed");
    }
  } catch (err) {
    error = err instanceof Error ? err.message : t("humanTask.cancelFailed");
  } finally {
    busy = false;
    confirmingCancel = false;
  }
}
</script>

<div class="border-t border-border pt-3 mt-3 space-y-3">
  <h4 class="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
    <UserCheckIcon size={14} aria-hidden="true" />
    {t("humanTask.heading")}
  </h4>

  {#if !loaded}
    <p class="text-xs text-muted-foreground">{t("common.loading")}</p>
  {:else if !task}
    <p class="text-xs text-muted-foreground">{t("humanTask.notFound")}</p>
  {:else}
    <div class="space-y-2">
      <p class="text-sm font-medium">{task.title}</p>
      <div class="flex flex-wrap items-center gap-1.5">
        {#if task.priority !== "normal"}
          <Badge variant={task.priority === "high" ? "warning-outline" : "outline"} class="text-[10px] px-1.5 py-0">
            {t(task.priority === "high" ? "humanTask.priorityHigh" : "humanTask.priorityLow")}
          </Badge>
        {/if}
        {#each task.assignees.users as user (user)}
          <Badge variant="outline" class="text-[10px] px-1.5 py-0 font-mono">{user}</Badge>
        {/each}
        {#each task.assignees.roles as role (role)}
          <Badge variant="outline" class="text-[10px] px-1.5 py-0 font-mono">{t("humanTask.role", { role })}</Badge>
        {/each}
      </div>
      <p class="text-xs text-muted-foreground">
        {t("humanTask.created", { time: i18n.format.relative(task.createdAt) })}
        {#if task.dueAt}
          · {t("humanTask.due", { time: i18n.format.date(task.dueAt) })}
        {/if}
      </p>
    </div>

    {#if cancelled}
      <p class="text-xs text-muted-foreground">{t("humanTask.cancelled")}</p>
    {:else}
      <div class="flex flex-wrap items-center gap-2">
        {#if portalLink}
          <a
            href={portalLink}
            target="_blank"
            rel="noopener"
            class={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <ArrowSquareOutIcon size={14} class="mr-1.5" aria-hidden="true" />
            {t("humanTask.openInPortal")}
          </a>
        {/if}
        {#if canManage}
          {#if confirmingCancel}
            <span class="text-xs text-muted-foreground">{t("humanTask.confirmCancel")}</span>
            <Button size="sm" variant="destructive" disabled={busy} onclick={cancelTask}
              >{t("humanTask.cancel")}</Button
            >
            <Button size="sm" variant="ghost" onclick={() => (confirmingCancel = false)}>{t("common.keep")}</Button>
          {:else}
            <Button
              size="sm"
              variant="ghost"
              class="text-destructive hover:text-destructive"
              onclick={() => (confirmingCancel = true)}
            >
              {t("humanTask.cancel")}
            </Button>
          {/if}
        {/if}
      </div>
    {/if}
    {#if error}
      <p class="text-xs text-destructive" role="alert">{error}</p>
    {/if}
  {/if}
</div>
