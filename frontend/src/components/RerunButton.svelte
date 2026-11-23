<script lang="ts">
import ArrowCounterClockwiseIcon from "phosphor-svelte/lib/ArrowCounterClockwiseIcon";
import { authFetch } from "$lib/auth";
import { Button } from "$lib/components/ui/button";
import { t } from "$lib/i18n.svelte";
import { responseError } from "$lib/utils";

/**
 * "Run again" action for a failed workflow run: starts a new run with the same
 * trigger payload. The failed run stays unchanged; the new run shows up via
 * the `workflow_started` WebSocket event. A refusal is shown next to the
 * button, with the server's reason as tooltip.
 */
interface Props {
  /** ID of the failed run. */
  runId: string;
  /** Button size. */
  size?: "xs" | "sm";
}

let { runId, size = "sm" }: Props = $props();

let rerunning = $state(false);
let failure = $state<string | null>(null);

async function rerun() {
  rerunning = true;
  failure = null;
  try {
    const res = await authFetch(`/ext/workflows/runs/${runId}/rerun`, { method: "POST" });
    if (!res.ok) throw new Error(await responseError(res));
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  } finally {
    rerunning = false;
  }
}
</script>

{#if failure}
  <span class="text-xs text-destructive" title={failure}>{t("runs.rerunFailed")}</span>
{/if}
<Button
  {size}
  variant="outline"
  class="whitespace-nowrap"
  disabled={rerunning}
  title={t("runs.rerunHint")}
  onclick={(e: Event) => {
    e.stopPropagation();
    rerun();
  }}
>
  <ArrowCounterClockwiseIcon size={size === "xs" ? 12 : 14} class="mr-1" aria-hidden="true" />
  {rerunning ? t("runs.rerunning") : t("runs.rerun")}
</Button>
