<script lang="ts">
import AlertDialog from "$lib/components/ui/alert-dialog/AlertDialog.svelte";

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
  title="Delete Secret"
  description={`Are you sure you want to delete "${secretKey}"? This action is irreversible.`}
  confirmLabel={deleting ? "Deleting..." : "Delete"}
  cancelLabel="Cancel"
  confirmVariant="destructive"
  {onConfirm}
  {onCancel}
/>
