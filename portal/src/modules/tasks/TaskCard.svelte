<!-- A task in the inbox list. -->
<script lang="ts">
import { Badge } from "@palim/ui";
import CaretRightIcon from "phosphor-svelte/lib/CaretRightIcon";
import { i18n, t } from "$app/i18n.svelte";
import type { HumanTask } from "$shared/portal";
import { dueText, isUrgent, outcomeLabel, userName } from "./labels";

let { task }: { task: HumanTask } = $props();

const due = $derived(dueText(task));
</script>

<a
  href="#/tasks/{encodeURIComponent(task.id)}"
  class="flex items-center gap-3 rounded-lg border bg-card px-4 py-3 no-underline text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
>
  <div class="min-w-0 flex-1 space-y-1">
    <div class="flex items-center gap-2">
      {#if task.priority === "high"}
        <span class="size-2 shrink-0 rounded-full bg-red-500" title={t("tasks.priorityHigh")}></span>
      {/if}
      <span class="truncate font-medium">{task.title}</span>
    </div>
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      {#if task.completion}
        <span>
          {t("tasks.answeredBy", {
            outcome: outcomeLabel(task, task.completion.outcome),
            user: userName(task.completion.by),
            time: i18n.current.format.relative(task.completion.at),
          })}
        </span>
      {:else if task.status !== "open"}
        <Badge variant="outline" class="text-[10px] px-1.5 py-0">{t(`tasks.status.${task.status}`)}</Badge>
      {:else}
        <span>{i18n.current.format.relative(task.createdAt)}</span>
        {#if due}
          <span class={isUrgent(task) ? "font-medium text-red-600 dark:text-red-400" : ""}>· {due}</span>
        {/if}
      {/if}
    </div>
  </div>
  <CaretRightIcon size={16} class="shrink-0 text-muted-foreground" aria-hidden="true" />
</a>
