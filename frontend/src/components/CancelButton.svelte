<script lang="ts">
import { authFetch } from "$lib/auth";
import { Button } from "$lib/components/ui/button";
import { t } from "$lib/i18n.svelte";
import { responseError } from "$lib/utils";

/**
 * Cancel action for a job or workflow run that has not finished: POSTs to its
 * cancel endpoint. Cancelling is not destructive (the job or run ends failed
 * and stays listed until it is deleted), so it asks for no confirmation. A
 * refusal is shown next to the button, with the server's reason as tooltip.
 */
interface Props {
  /** Cancel endpoint (`/api/jobs/:id/cancel` or `/ext/workflows/runs/:id/cancel`). */
  url: string;
  /** Button size. */
  size?: "xs" | "sm";
  /** Called after the cancellation was accepted. */
  onCancelled?: () => void | Promise<void>;
}

let { url, size = "sm", onCancelled }: Props = $props();

let cancelling = $state(false);
let failure = $state<string | null>(null);

async function cancel() {
  cancelling = true;
  failure = null;
  try {
    const res = await authFetch(url, { method: "POST" });
    if (!res.ok) throw new Error(await responseError(res));
    await onCancelled?.();
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  } finally {
    cancelling = false;
  }
}
</script>

{#if failure}
  <span class="text-xs text-destructive" title={failure}>{t("common.cancelFailed")}</span>
{/if}
<Button
  {size}
  variant="destructive"
  disabled={cancelling}
  onclick={(e: Event) => {
    e.stopPropagation();
    cancel();
  }}
>
  <span class="text-xs font-bold {size === "xs" ? "mr-1" : "mr-1.5"}" aria-hidden="true">&#x2715;</span>
  {cancelling ? t("common.cancelling") : t("common.cancel")}
</Button>
