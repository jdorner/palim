<script lang="ts">
import TrashIcon from "phosphor-svelte/lib/TrashIcon";
import { authFetch } from "$lib/auth";
import { AlertDialog } from "$lib/components/ui/alert-dialog";
import { Button } from "$lib/components/ui/button";
import { t } from "$lib/i18n.svelte";

/**
 * Delete action for a finished (failed) workflow run: asks for confirmation,
 * then removes the run with its step jobs and logs.
 */
interface Props {
  /** ID of the run to delete. */
  runId: string;
  /** Button size. */
  size?: "xs" | "sm";
  /** Called after the run was deleted. */
  onDeleted?: () => void | Promise<void>;
}

let { runId, size = "sm", onDeleted }: Props = $props();

let confirming = $state(false);
let deleting = $state(false);

async function deleteRun() {
  confirming = false;
  deleting = true;
  try {
    const res = await authFetch(`/ext/workflows/runs/${runId}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await onDeleted?.();
  } catch (err) {
    console.error("Failed to delete workflow run:", err);
  } finally {
    deleting = false;
  }
}
</script>

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

<AlertDialog
  open={confirming}
  title={t("runs.deleteTitle")}
  description={t("runs.deleteConfirm", { id: runId.slice(0, 8) })}
  confirmLabel={t("common.delete")}
  cancelLabel={t("common.cancel")}
  confirmVariant="destructive"
  onConfirm={deleteRun}
  onCancel={() => {
    confirming = false;
  }}
/>
