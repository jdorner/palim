<script lang="ts">
import PlayIcon from "phosphor-svelte/lib/PlayIcon";
import TrashIcon from "phosphor-svelte/lib/TrashIcon";
import { onDestroy } from "svelte";
import { schedules } from "$lib/appStore";
import { authFetch } from "$lib/auth";
import LoadingIndicator from "$lib/components/LoadingIndicator.svelte";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "$lib/components/ui/table";
import { t } from "$lib/i18n.svelte";
import { formatTimestamp } from "$lib/utils";
import type { ScheduleEntry } from "../../../shared/types";

let items = $state<ScheduleEntry[]>([]);
let sortedItems = $derived([...items].sort((a, b) => a.id.localeCompare(b.id)));
let loading = $state(true);
let error = $state<string | null>(null);
let errorDetail = $state<string | null>(null);

async function fetchSchedules() {
  loading = true;
  error = null;
  errorDetail = null;
  try {
    const res = await authFetch("/ext/scheduler/schedules");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    items = await res.json();
    schedules.set(items);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    errorDetail = msg || t("common.unknownError");
    if (msg.includes("Failed to fetch") || msg.includes("502") || msg.includes("503") || msg.includes("NetworkError")) {
      error = t("common.serverUnreachable");
    } else {
      error = t("schedules.loadFailed");
    }
  } finally {
    loading = false;
  }
}

/** Keep local state in sync when the global store is updated (e.g. via WebSocket). */
const unsubscribe = schedules.subscribe((value) => {
  if (value.length > 0 || !loading) {
    items = value;
  }
});

onDestroy(() => {
  unsubscribe();
});

async function deleteSchedule(id: string) {
  try {
    const res = await authFetch(`/ext/scheduler/schedules/${id}`, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    items = items.filter((s) => s.id !== id);
    schedules.set(items);
  } catch (err) {
    console.error("Failed to delete schedule:", err);
  }
}

let triggeringId = $state<string | null>(null);
let confirmingDelete = $state<string | null>(null);

async function triggerSchedule(id: string) {
  triggeringId = id;
  try {
    const res = await authFetch(`/ext/scheduler/schedules/${id}/trigger`, {
      method: "POST",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error("Failed to trigger schedule:", err);
  } finally {
    triggeringId = null;
  }
}

function formatRepeat(schedule: ScheduleEntry): string {
  if (schedule.pattern) return t("schedules.cron", { pattern: schedule.pattern });
  if (schedule.every) {
    const seconds = schedule.every / 1000;
    if (seconds < 60) return t("schedules.everySeconds", { n: seconds });
    const minutes = seconds / 60;
    if (minutes < 60) return t("schedules.everyMinutes", { n: minutes });
    const hours = minutes / 60;
    return t("schedules.everyHours", { n: hours });
  }
  return t("schedules.unknown");
}

$effect(() => {
  fetchSchedules();
});
</script>

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
  {:else if items.length === 0}
    <p class="text-sm text-muted-foreground">{t("schedules.empty")}</p>
  {:else}
    <!-- Mobile & Tablet: Card layout -->
    <div class="responsive-cards">
      {#each sortedItems as schedule (schedule.id)}
        <div class="rounded-md border border-border p-4 space-y-3">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0 flex-1">
              <span class="font-medium block truncate">{schedule.name}</span>
              {#if schedule.description}
                <p class="text-xs text-muted-foreground mt-0.5 line-clamp-2">{schedule.description}</p>
              {/if}
            </div>
            <Badge variant="outline" class="shrink-0">{formatRepeat(schedule)}</Badge>
          </div>

          <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span>{t("schedules.next", { time: formatTimestamp(schedule.next, "-") })}</span>
            <code class="text-xs font-mono">{schedule.id}</code>
          </div>

          <hr>

          {#if confirmingDelete === schedule.id}
            <div class="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="destructive" onclick={() => deleteSchedule(schedule.id)}
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
              <Button
                size="sm"
                variant="default"
                disabled={triggeringId === schedule.id}
                onclick={() => triggerSchedule(schedule.id)}
              >
                <PlayIcon size={14} class="mr-1.5" aria-hidden="true" />
                {triggeringId === schedule.id ? t("schedules.triggering") : t("schedules.trigger")}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onclick={() => {
                  confirmingDelete = schedule.id;
                }}
              >
                <TrashIcon size={14} class="mr-1.5" aria-hidden="true" />
                {t("common.delete")}
              </Button>
            </div>
          {/if}
        </div>
      {/each}
    </div>

    <!-- Desktop: Table layout -->
    <div class="responsive-table rounded-md border border-border">
      <Table>
        <TableHeader class="bg-muted/30">
          <TableRow>
            <TableHead>{t("common.name")}</TableHead>
            <TableHead>{t("schedules.colId")}</TableHead>
            <TableHead>{t("schedules.colRepeat")}</TableHead>
            <TableHead>{t("schedules.colRuns")}</TableHead>
            <TableHead>{t("schedules.colNextRun")}</TableHead>
            <TableHead class="text-center">{t("common.actions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each sortedItems as schedule (schedule.id)}
            <TableRow>
              <TableCell>
                <span class="font-medium">{schedule.name}</span>
                {#if schedule.description}
                  <p class="text-xs text-muted-foreground mt-0.5">{schedule.description}</p>
                {/if}
              </TableCell>
              <TableCell class="wrap-break-word">
                <code class="text-xs text-muted-foreground">{schedule.id}</code>
              </TableCell>
              <TableCell class="whitespace-nowrap">
                <Badge variant="outline">{formatRepeat(schedule)}</Badge>
              </TableCell>
              <TableCell class="text-sm text-muted-foreground whitespace-nowrap">
                {schedule.limit != null ? `${schedule.executions}/${schedule.limit}` : `${schedule.executions}/\u221E`}
              </TableCell>
              <TableCell class="text-sm text-muted-foreground">
                {formatTimestamp(schedule.next, "-")}
              </TableCell>
              <TableCell class="text-right">
                {#if confirmingDelete === schedule.id}
                  <div class="inline-flex justify-end gap-2 flex-wrap xl:flex-nowrap">
                    <Button size="sm" variant="destructive" onclick={() => deleteSchedule(schedule.id)}>
                      {t("common.confirm")}
                    </Button>
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
                    <Button
                      size="sm"
                      variant="default"
                      disabled={triggeringId === schedule.id}
                      onclick={() => triggerSchedule(schedule.id)}
                    >
                      <PlayIcon size={14} class="mr-1.5" aria-hidden="true" />
                      {triggeringId === schedule.id ? t("schedules.triggering") : t("schedules.trigger")}
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onclick={() => {
                        confirmingDelete = schedule.id;
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
        </TableBody>
      </Table>
    </div>
  {/if}
</div>
