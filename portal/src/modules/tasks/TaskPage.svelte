<!-- A single task: details, the answer form, and its history. -->
<script lang="ts">
import { Markdown } from "@comark/svelte";
import { Badge, Button } from "@palim/ui";
import ArrowLeftIcon from "phosphor-svelte/lib/ArrowLeftIcon";
import { ApiError } from "$app/api";
import { collectData, formFields, initialValues } from "$app/form";
import { i18n, t } from "$app/i18n.svelte";
import type { HumanTaskDetail, HumanTaskOutcome } from "$shared/portal";
import { dueText, isUrgent, outcomeLabel, userName } from "./labels";
import { tasks } from "./store.svelte";
import TaskForm from "./TaskForm.svelte";

let { params }: { params: Record<string, string> } = $props();

let task = $state<HumanTaskDetail | null>(null);
let loadError = $state<string | null>(null);
let values = $state<Record<string, unknown>>({});
let fieldErrors = $state<Record<string, string>>({});
let comment = $state("");
let submitting = $state(false);
let message = $state<{ kind: "error" | "info"; text: string } | null>(null);

const fields = $derived(formFields(task?.formSchema ?? null));

/** Loads the task; keeps entered values unless the form changed shape. */
async function load(id: string, keepInput = false) {
  try {
    const next = await tasks.fetchTask(id);
    const formChanged = JSON.stringify(next.formSchema) !== JSON.stringify(task?.formSchema);
    task = next;
    loadError = null;
    if (!keepInput || formChanged) values = initialValues(formFields(next.formSchema));
  } catch (err) {
    task = null;
    loadError =
      err instanceof ApiError && err.status === 404
        ? t("tasks.notAvailable")
        : t("tasks.loadFailed", { message: err instanceof Error ? err.message : String(err) });
  }
}

$effect(() => {
  const id = params.id ?? "";
  message = null;
  comment = "";
  fieldErrors = {};
  void load(id);
});

// Live updates of this task (answered elsewhere, cancelled, reassigned).
$effect(() => {
  const change = tasks.changed;
  if (change && change.id === params.id && !submitting) void load(change.id, true);
});

async function answer(outcome: HumanTaskOutcome) {
  if (!task) return;
  message = null;
  fieldErrors = {};
  const { data, missing } = collectData(fields, values);
  if (missing.length > 0) {
    const labels = fields.filter((f) => missing.includes(f.key)).map((f) => f.label);
    for (const key of missing) fieldErrors[key] = t("tasks.required");
    message = { kind: "error", text: t("tasks.missingFields", { fields: labels.join(", ") }) };
    return;
  }
  if (task.requireComment && comment.trim() === "") {
    message = { kind: "error", text: t("tasks.commentMissing") };
    return;
  }

  submitting = true;
  try {
    await tasks.complete(task, {
      outcome: outcome.id,
      ...(task.formSchema ? { data } : {}),
      comment: comment.trim() || null,
    });
    message = { kind: "info", text: t("tasks.answered") };
    await load(task.id, true);
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      await load(task.id, true);
      message = { kind: "error", text: task?.status === "open" ? t("tasks.changed") : t("tasks.alreadyHandled") };
    } else if (err instanceof ApiError && err.status === 404) {
      message = { kind: "error", text: t("tasks.notAvailable") };
    } else if (err instanceof ApiError && err.status === 422 && err.details?.length) {
      for (const detail of err.details)
        fieldErrors[detail.path.replace(/^\//, "").split("/")[0] ?? ""] = detail.message;
      message = { kind: "error", text: err.message };
    } else {
      message = {
        kind: "error",
        text: t("tasks.submitFailed", { message: err instanceof Error ? err.message : String(err) }),
      };
    }
  } finally {
    submitting = false;
  }
}

/** Renders a context value. */
function contextValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

const outcomeVariant = (o: HumanTaskOutcome) =>
  o.style === "primary" ? "default" : o.style === "danger" ? "destructive" : "outline";
</script>

<div class="space-y-5">
  <a
    href="#/tasks"
    class="inline-flex items-center gap-1 text-sm text-muted-foreground no-underline hover:text-foreground"
  >
    <ArrowLeftIcon size={14} aria-hidden="true" />
    {t("tasks.back")}
  </a>

  {#if loadError}
    <p class="rounded-lg border p-4 text-sm">{loadError}</p>
  {:else if !task}
    <p class="py-8 text-center text-sm text-muted-foreground">{t("app.loading")}</p>
  {:else}
    {@const due = dueText(task)}
    <header class="space-y-2">
      <h2 class="text-xl font-semibold leading-tight">{task.title}</h2>
      <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant={task.status === "open" ? "default" : "outline"} class="text-[10px] px-1.5 py-0">
          {t(`tasks.status.${task.status}`)}
        </Badge>
        {#if task.priority !== "normal"}
          <Badge variant={task.priority === "high" ? "warning-outline" : "outline"} class="text-[10px] px-1.5 py-0">
            {t(task.priority === "high" ? "tasks.priorityHigh" : "tasks.priorityLow")}
          </Badge>
        {/if}
        <span>{i18n.current.format.date(task.createdAt)}</span>
        {#if due}
          <span class={isUrgent(task) ? "font-medium text-red-600 dark:text-red-400" : ""}>· {due}</span>
        {/if}
      </div>
    </header>

    {#if task.body}
      <div class="task-markdown"><Markdown value={task.body} /></div>
    {/if}

    {#if task.context && Object.keys(task.context).length > 0}
      <section class="space-y-2">
        <h3 class="text-sm font-semibold">{t("tasks.details")}</h3>
        <dl class="grid grid-cols-[minmax(0,auto)_1fr] gap-x-4 gap-y-1 rounded-lg border p-3 text-sm">
          {#each Object.entries(task.context) as [key, value] (key)}
            <dt class="text-muted-foreground">{key}</dt>
            <dd class="min-w-0 break-words">{contextValue(value)}</dd>
          {/each}
        </dl>
      </section>
    {/if}

    {#if task.canRespond}
      <section class="space-y-4 rounded-lg border p-4">
        {#if fields.length > 0}
          <h3 class="text-sm font-semibold">{t("tasks.form")}</h3>
          <TaskForm {fields} bind:values errors={fieldErrors} disabled={submitting} />
        {/if}
        <div class="space-y-1">
          <label class="text-sm font-medium" for="task-comment">
            {task.requireComment ? t("tasks.commentRequired") : t("tasks.comment")}
          </label>
          <textarea
            id="task-comment"
            rows="3"
            class="w-full rounded-md border border-input bg-background px-3 py-2 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            placeholder={task.requireComment ? "" : t("tasks.commentPlaceholder")}
            bind:value={comment}
            disabled={submitting}
          ></textarea>
        </div>
        {#if message}
          <p class="text-sm {message.kind === "error" ? "text-destructive" : "text-muted-foreground"}" role="alert">
            {message.text}
          </p>
        {/if}
        <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {#each task.outcomes as outcome (outcome.id)}
            <Button variant={outcomeVariant(outcome)} disabled={submitting} onclick={() => answer(outcome)}>
              {submitting ? t("tasks.submitting") : outcome.label}
            </Button>
          {/each}
        </div>
      </section>
    {:else}
      <section class="space-y-2 rounded-lg border p-4 text-sm">
        {#if message}
          <p class={message.kind === "error" ? "text-destructive" : "text-muted-foreground"} role="alert">
            {message.text}
          </p>
        {/if}
        {#if task.completion}
          <p>
            <span class="font-medium">{t("tasks.answer")}:</span>
            {t("tasks.answeredBy", {
              outcome: outcomeLabel(task, task.completion.outcome),
              user: userName(task.completion.by),
              time: i18n.current.format.date(task.completion.at),
            })}
          </p>
          {#if task.completion.comment}
            <p class="whitespace-pre-wrap text-muted-foreground">{task.completion.comment}</p>
          {/if}
          {#if task.completion.data && typeof task.completion.data === "object"}
            <dl class="grid grid-cols-[minmax(0,auto)_1fr] gap-x-4 gap-y-1">
              {#each Object.entries(task.completion.data as Record<string, unknown>) as [key, value] (key)}
                <dt class="text-muted-foreground">{fields.find((f) => f.key === key)?.label ?? key}</dt>
                <dd class="min-w-0 break-words">{contextValue(value)}</dd>
              {/each}
            </dl>
          {/if}
        {:else}
          <p class="text-muted-foreground">{t("tasks.noLongerOpen", { status: t(`tasks.status.${task.status}`) })}</p>
        {/if}
      </section>
    {/if}

    <section class="space-y-2">
      <h3 class="text-sm font-semibold">{t("tasks.assignedTo")}</h3>
      <div class="flex flex-wrap gap-1.5">
        {#each task.assignees.users as user (user.id)}
          <Badge variant="outline" class="text-xs">{userName(user)}</Badge>
        {/each}
        {#each task.assignees.roles as role (role)}
          <Badge variant="outline" class="text-xs">{t("tasks.role", { role })}</Badge>
        {/each}
      </div>
    </section>

    <section class="space-y-2">
      <h3 class="text-sm font-semibold">{t("tasks.history")}</h3>
      <ol class="space-y-1 text-xs text-muted-foreground">
        {#each task.history as entry, i (i)}
          <li class="flex gap-2">
            <span class="shrink-0 tabular-nums">{i18n.current.format.date(entry.at)}</span>
            <span>{t(`tasks.event.${entry.kind}`, { user: userName(entry.actor) })}</span>
          </li>
        {/each}
      </ol>
    </section>
  {/if}
</div>
