<script lang="ts">
import { Button } from "$lib/components/ui/button";
import { Dialog } from "$lib/components/ui/dialog";
import { updateUser } from "./api";
import PasswordFields from "./PasswordFields.svelte";
import { type UserRow, validatePassword } from "./userAdmin";

interface Props {
  /** The user whose password is being reset. */
  user: UserRow;
  /** Called when the dialog is dismissed without saving. */
  onClose: () => void;
  /** Called after a successful reset with a short confirmation message. */
  onSaved: (message: string) => void;
}

let { user, onClose, onSaved }: Props = $props();

let password = $state("");
let confirm = $state("");
let error = $state<string | null>(null);
let saving = $state(false);

async function save(e: SubmitEvent) {
  e.preventDefault();
  error = validatePassword(password, confirm);
  if (error) return;
  saving = true;
  try {
    await updateUser(user.id, { password });
    onSaved(`Password reset for ${user.username}`);
  } catch (err) {
    error = err instanceof Error ? err.message : "Reset failed";
  } finally {
    saving = false;
  }
}
</script>

<Dialog
  open
  title="Reset password"
  description="Set a new password for {user.username}. Their existing sign-ins stay active."
  {onClose}
>
  <form id="password-dialog-form" class="space-y-4" onsubmit={save}>
    <PasswordFields idPrefix="reset" bind:password bind:confirm />
    {#if error}
      <p class="text-sm text-destructive" role="alert">{error}</p>
    {/if}
  </form>

  {#snippet footer()}
    <Button size="sm" variant="outline" onclick={onClose}>Cancel</Button>
    <Button size="sm" type="submit" form="password-dialog-form" disabled={saving || !password}>
      {saving ? "Saving..." : "Reset password"}
    </Button>
  {/snippet}
</Dialog>
