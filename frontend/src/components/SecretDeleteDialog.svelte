<script lang="ts">
import AlertDialog from "$lib/components/ui/alert-dialog/AlertDialog.svelte";
import { t } from "$lib/i18n.svelte";

/** Confirmation dialog for deleting a secret; open while `secretKey` is set. */
interface Props {
  /** Key pending deletion, or null when the dialog is closed. */
  secretKey: string | null;
  /** Whether the delete request is in flight. */
  deleting: boolean;
  /** Called when the user confirms. */
  onConfirm: () => void;
  /** Called when the user cancels. */
  onCancel: () => void;
}

let { secretKey, deleting, onConfirm, onCancel }: Props = $props();
</script>

<AlertDialog
  open={secretKey !== null}
  title={t("secrets.deleteTitle")}
  description={t("secrets.deleteConfirm", { key: secretKey })}
  confirmLabel={deleting ? t("common.deleting") : t("common.delete")}
  cancelLabel={t("common.cancel")}
  confirmVariant="destructive"
  {onConfirm}
  {onCancel}
/>
