<script lang="ts">
import TrashIcon from "phosphor-svelte/lib/TrashIcon";
import { authFetch } from "$lib/auth";
import { AlertDialog } from "$lib/components/ui/alert-dialog";
import { Button } from "$lib/components/ui/button";
import { t } from "$lib/i18n.svelte";
import { responseError } from "$lib/utils";
import IconAction from "./IconAction.svelte";

/**
 * Delete action for a list row (job, run, workflow, schedule, ...): asks for
 * confirmation, then sends DELETE to its endpoint. A refusal is shown next to the button,
 * with the server's reason as tooltip.
 */
interface Props {
  /** Delete endpoint, e.g. `/api/jobs/:id` or `/ext/workflows/runs/:id`. */
  url: string;
  /** Confirmation dialog title. */
  confirmTitle: string;
  /** Confirmation dialog text. */
  confirmMessage: string;
  /** Button size. */
  size?: "xs" | "sm";
  /**
   * Show only a muted red trash icon (full red on hover) with the label as tooltip,
   * for dense lists where a red button per row would dominate.
   */
  iconOnly?: boolean;
  /** Called after the deletion succeeded. */
  onDeleted?: () => void | Promise<void>;
}

let { url, confirmTitle, confirmMessage, size = "sm", iconOnly = false, onDeleted }: Props = $props();

let confirming = $state(false);
let deleting = $state(false);
let failure = $state<string | null>(null);

async function remove() {
  confirming = false;
  deleting = true;
  failure = null;
  try {
    const res = await authFetch(url, { method: "DELETE" });
    if (!res.ok) throw new Error(await responseError(res));
    await onDeleted?.();
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  } finally {
    deleting = false;
  }
}
</script>

{#if failure}
  <span class="text-xs text-destructive" title={failure}>{t("common.deleteFailed")}</span>
{/if}
{#if iconOnly}
  <IconAction
    label={deleting ? t("common.deleting") : t("common.delete")}
    icon={TrashIcon}
    tone="destructive"
    {size}
    disabled={deleting}
    onclick={() => {
      confirming = true;
    }}
  />
{:else}
  <Button
    {size}
    variant="destructive"
    disabled={deleting}
    onclick={(e: Event) => {
      e.stopPropagation();
      confirming = true;
    }}
  >
    <TrashIcon size={size === "xs" ? 12 : 14} class="mr-1" aria-hidden="true" />
    {deleting ? t("common.deleting") : t("common.delete")}
  </Button>
{/if}

<AlertDialog
  open={confirming}
  title={confirmTitle}
  description={confirmMessage}
  confirmLabel={t("common.delete")}
  cancelLabel={t("common.cancel")}
  confirmVariant="destructive"
  onConfirm={remove}
  onCancel={() => {
    confirming = false;
  }}
/>
