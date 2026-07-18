<script lang="ts">
import { onMount } from "svelte";
import { authFetch } from "$lib/auth";
import LoadingIndicator from "$lib/components/LoadingIndicator.svelte";
import { Button } from "$lib/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "$lib/components/ui/card";
import { formatTimestamp, renderMarkdown } from "$lib/utils";
import type { JobEntry, LogEntry } from "../../../shared/types";

let { job, onClose }: { job?: JobEntry; onClose: () => void } = $props();

let mergedLogs = $state<LogEntry[]>([]);
let loading = $state(false);

/**
 * Merge cached real-time logs with persisted logs from the API.
 * Persisted logs have accurate timestamps; cached logs fill gaps for in-flight jobs.
 */
async function loadLogs() {
  if (!job) return;

  loading = true;
  try {
    const res = await authFetch(`/api/jobs/${job.id}/logs`);
    if (res.ok) {
      const data = await res.json();
      const persisted: LogEntry[] = (data.logs ?? []).map((l: { message: string; timestamp: number }) => ({
        message: l.message,
        timestamp: l.timestamp,
      }));
      if (persisted.length > 0) {
        mergedLogs = persisted;
        return;
      }
    }
  } catch {
    /* fall through to cached logs */
  } finally {
    loading = false;
  }

  // Fallback to in-memory cached logs from WebSocket
  mergedLogs = job.logs ?? [];
}

onMount(() => {
  loadLogs();
});
</script>

{#if job}
  <div
    role="dialog"
    aria-modal="true"
    aria-label="Job logs"
    class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
    onclick={onClose}
    onkeydown={(e) => { if (e.key === 'Escape') onClose(); }}
    tabindex="-1"
  >
    <div
      class="w-full max-w-3xl mx-4"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
      role="presentation"
    >
      <Card>
        <CardHeader>
          <div class="flex items-center justify-between">
            <CardTitle>Logs for Job {job.id}</CardTitle>
            <Button variant="ghost" size="icon" onclick={onClose}>✕</Button>
          </div>
        </CardHeader>

        <CardContent>
          <div class="max-h-[60vh] overflow-y-auto text-sm">
            {#if loading}
              <div class="flex justify-center py-8"><LoadingIndicator message="Loading logs..." /></div>
            {:else if mergedLogs.length > 0}
              {#each mergedLogs as log}
                <div class="flex gap-4 py-1 border-b last:border-b-0">
                  {#if log.timestamp}
                    <span class="text-muted-foreground whitespace-nowrap shrink-0">
                      {formatTimestamp(log.timestamp)}
                    </span>
                  {/if}
                  {#if log.message.startsWith("***Thinking:***")}
                    <span
                      class="thinking-log flex-1 pt-0.5 wrap-break-words text-xs font-sans whitespace-pre-line text-muted-foreground"
                      >{@html renderMarkdown(log.message)}</span
                    >
                  {:else}
                    <span class="flex-1 pt-0.5 wrap-break-words text-xs font-sans whitespace-pre-line"
                      >{@html renderMarkdown(log.message)}</span
                    >
                  {/if}
                </div>
              {/each}
            {:else}
              <p class="text-center text-muted-foreground py-8">No logs available for this job.</p>
            {/if}
          </div>
        </CardContent>
      </Card>
    </div>
  </div>
{/if}

<style>
:global(.thinking-log),
:global(.thinking-log *) {
  font-style: italic;
}
</style>
