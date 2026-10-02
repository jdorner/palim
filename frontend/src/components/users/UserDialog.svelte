<script lang="ts">
import LockSimpleIcon from "phosphor-svelte/lib/LockSimpleIcon";
import TrashIcon from "phosphor-svelte/lib/TrashIcon";
import WarningIcon from "phosphor-svelte/lib/WarningIcon";
import { untrack } from "svelte";
import { Button } from "$lib/components/ui/button";
import { Dialog } from "$lib/components/ui/dialog";
import { createUser, deleteUser, updateUser } from "./api";
import PasswordFields from "./PasswordFields.svelte";
import {
  deleteLockReason,
  type RoleRow,
  roleIdsForNames,
  roleLockReason,
  type UserRow,
  validatePassword,
} from "./userAdmin";

interface Props {
  /** The user being edited, or null to create a new one. */
  user: UserRow | null;
  /** All users (for the last-admin guard). */
  users: UserRow[];
  /** Roles that may be assigned to human users. */
  roles: RoleRow[];
  /** The signed-in user's id. */
  currentUserId?: string;
  /** Called when the dialog is dismissed without saving. */
  onClose: () => void;
  /** Called after a successful save with a short confirmation message. */
  onSaved: (message: string) => void;
}

let { user, users, roles, currentUserId, onClose, onSaved }: Props = $props();

// The dialog is mounted per open, so it snapshots the user once.
const initial = untrack(() => user);
const isCreate = initial === null;
const initialRoleIds = untrack(() => (initial ? roleIdsForNames(roles, initial.roles) : []));

let username = $state("");
let displayName = $state(initial?.displayName ?? "");
let password = $state("");
let confirm = $state("");
let roleIds = $state<string[]>([...initialRoleIds]);
let error = $state<string | null>(null);
let saving = $state(false);
let confirmingDelete = $state(false);
let formEl = $state<HTMLFormElement | undefined>(undefined);
const deleteLock = untrack(() => (initial ? deleteLockReason(initial, users, currentUserId) : null));

async function remove() {
  if (!initial) return;
  error = null;
  saving = true;
  try {
    const sessions = await deleteUser(initial.id);
    onSaved(
      `Deleted ${initial.username}${sessions > 0 ? ` and ${sessions} chat session${sessions === 1 ? "" : "s"}` : ""}`,
    );
  } catch (err) {
    error = err instanceof Error ? err.message : "Delete failed";
    confirmingDelete = false;
  } finally {
    saving = false;
  }
}

function toggleRole(id: string) {
  roleIds = roleIds.includes(id) ? roleIds.filter((r) => r !== id) : [...roleIds, id];
}

function lockReason(role: RoleRow): string | null {
  return user ? roleLockReason(user, role, users, currentUserId) : null;
}

const rolesChanged = $derived(
  roleIds.length !== initialRoleIds.length || roleIds.some((id) => !initialRoleIds.includes(id)),
);
const displayNameChanged = $derived(displayName.trim() !== (user?.displayName ?? ""));
const dirty = $derived(isCreate || rolesChanged || displayNameChanged);

async function save(e: SubmitEvent) {
  e.preventDefault();
  error = null;
  if (isCreate) {
    if (!username.trim()) {
      error = "Username is required";
      return;
    }
    const pwError = validatePassword(password, confirm);
    if (pwError) {
      error = pwError;
      return;
    }
  }
  saving = true;
  try {
    if (user) {
      await updateUser(user.id, {
        ...(displayNameChanged ? { displayName: displayName.trim() } : {}),
        ...(rolesChanged ? { roleIds } : {}),
      });
      onSaved(`Updated ${user.username}`);
    } else {
      await createUser({
        username: username.trim(),
        password,
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        roleIds,
      });
      onSaved(`Created ${username.trim()}`);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : "Save failed";
  } finally {
    saving = false;
  }
}

function saveShortcut() {
  if (!saving && dirty && !confirmingDelete) formEl?.requestSubmit();
}

const inputClass = "w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm";
</script>

<Dialog open title={user ? `Edit ${user.username}` : "Add user"} class="max-w-lg" {onClose} onSave={saveShortcut}>
  <form id="user-dialog-form" class="space-y-4" onsubmit={save} bind:this={formEl}>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div class="space-y-1">
        <label for="user-username" class="text-xs font-medium text-muted-foreground">Username</label>
        {#if isCreate}
          <input id="user-username" type="text" autocomplete="off" bind:value={username} class={inputClass}>
        {:else}
          <input id="user-username" type="text" value={user?.username} disabled class="{inputClass} opacity-60">
        {/if}
      </div>
      <div class="space-y-1">
        <label for="user-display" class="text-xs font-medium text-muted-foreground">
          Display name <span class="font-normal">(optional)</span>
        </label>
        <input id="user-display" type="text" bind:value={displayName} class={inputClass}>
      </div>
    </div>

    {#if isCreate}
      <PasswordFields idPrefix="new-user" bind:password bind:confirm />
    {/if}

    <fieldset class="space-y-1">
      <legend class="text-xs font-medium text-muted-foreground mb-1">Roles</legend>
      <div class="rounded-md border border-border divide-y divide-border">
        {#each roles as role (role.id)}
          {@const lock = lockReason(role)}
          <label class="flex items-start gap-3 px-3 py-2 {lock ? "opacity-70" : "cursor-pointer hover:bg-muted/50"}">
            <input
              type="checkbox"
              class="mt-0.5"
              checked={roleIds.includes(role.id)}
              disabled={lock !== null}
              onchange={() => toggleRole(role.id)}
            >
            <span class="min-w-0 flex-1">
              <span class="block text-sm font-mono">{role.name}</span>
              {#if role.description}
                <span class="block text-xs text-muted-foreground">{role.description}</span>
              {/if}
              {#if lock}
                <span class="mt-0.5 inline-flex items-center gap-1 text-xs text-yellow-600 dark:text-yellow-400">
                  <LockSimpleIcon size={12} aria-hidden="true" />
                  {lock}
                </span>
              {/if}
            </span>
          </label>
        {/each}
      </div>
      {#if roleIds.length === 0}
        <p class="flex items-center gap-1 text-xs text-yellow-600 dark:text-yellow-400">
          <WarningIcon size={12} class="shrink-0" aria-hidden="true" />
          Without a role this user can sign in but do nothing.
        </p>
      {/if}
    </fieldset>

    {#if error}
      <p class="text-sm text-destructive" role="alert">{error}</p>
    {/if}
  </form>

  {#snippet footer()}
    {#if initial}
      <div class="mr-auto flex items-center gap-2">
        {#if confirmingDelete}
          <span class="text-xs text-muted-foreground">Delete account and all chat sessions?</span>
          <Button size="sm" variant="destructive" disabled={saving} onclick={remove}>Delete</Button>
          <Button size="sm" variant="ghost" onclick={() => (confirmingDelete = false)}>Keep</Button>
        {:else}
          <Button
            size="sm"
            variant="ghost"
            class="text-destructive hover:text-destructive"
            disabled={deleteLock !== null}
            title={deleteLock ?? undefined}
            onclick={() => (confirmingDelete = true)}
          >
            <TrashIcon size={14} class="mr-1.5" aria-hidden="true" />
            Delete
          </Button>
        {/if}
      </div>
    {/if}
    {#if !confirmingDelete}
      <Button size="sm" variant="outline" onclick={onClose}>Cancel</Button>
      <Button size="sm" type="submit" form="user-dialog-form" disabled={saving || !dirty}>
        {saving ? "Saving..." : isCreate ? "Create user" : "Save"}
      </Button>
    {/if}
  {/snippet}
</Dialog>
