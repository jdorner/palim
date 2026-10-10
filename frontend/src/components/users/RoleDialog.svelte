<script lang="ts">
import TrashIcon from "phosphor-svelte/lib/TrashIcon";
import { untrack } from "svelte";
import { Button } from "$lib/components/ui/button";
import { Dialog } from "$lib/components/ui/dialog";
import { t } from "$lib/i18n.svelte";
import { ROLE_ADMIN } from "$shared/auth";
import { createRole, deleteRole, updateRole } from "./api";
import PermissionMatrix from "./PermissionMatrix.svelte";
import { type RoleRow, roleDeleteLockReason } from "./userAdmin";

interface Props {
  /** The role being viewed/edited, or null to create a new one. */
  role: RoleRow | null;
  /** The full permission catalog. */
  permissions: string[];
  /** Called when the dialog is dismissed without saving. */
  onClose: () => void;
  /** Called after a successful save or delete with a short confirmation message. */
  onSaved: (message: string) => void;
}

let { role, permissions, onClose, onSaved }: Props = $props();

// The dialog is mounted per open, so it snapshots the role once.
const initial = untrack(() => role);
const isCreate = initial === null;
const readonly = initial?.builtIn ?? false;
const deleteLock = $derived(initial ? roleDeleteLockReason(initial, t) : null);

let name = $state("");
let description = $state(initial?.description ?? "");
let selected = $state<string[]>([...(initial?.permissions ?? [])]);
let error = $state<string | null>(null);
let saving = $state(false);
let formEl = $state<HTMLFormElement | undefined>(undefined);

function saveShortcut() {
  if (!readonly && !saving && !confirmingDelete) formEl?.requestSubmit();
}
let confirmingDelete = $state(false);

async function save(e: SubmitEvent) {
  e.preventDefault();
  error = null;
  if (isCreate && !/^[a-z][a-z0-9_-]*$/.test(name.trim())) {
    error = t("users.roleNameInvalid");
    return;
  }
  saving = true;
  try {
    if (role) {
      await updateRole(role.id, description.trim(), selected);
      onSaved(t("users.updatedRole", { name: role.name }));
    } else {
      await createRole({
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        permissions: selected,
      });
      onSaved(t("users.createdRole", { name: name.trim() }));
    }
  } catch (err) {
    error = err instanceof Error ? err.message : t("common.saveFailed");
  } finally {
    saving = false;
  }
}

async function remove() {
  if (!role) return;
  error = null;
  saving = true;
  try {
    await deleteRole(role.id);
    onSaved(t("users.deletedRole", { name: role.name }));
  } catch (err) {
    error = err instanceof Error ? err.message : t("common.deleteFailed");
    confirmingDelete = false;
  } finally {
    saving = false;
  }
}

const title = $derived(
  isCreate
    ? t("users.addRole")
    : readonly
      ? t("users.roleTitle", { name: role?.name })
      : t("users.editRole", { name: role?.name }),
);
const inputClass = "w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm";
</script>

<Dialog
  open
  {title}
  description={readonly ? t("users.builtInRoleDescription") : undefined}
  class="max-w-2xl"
  {onClose}
  onSave={saveShortcut}
>
  <form id="role-dialog-form" class="space-y-4" onsubmit={save} bind:this={formEl}>
    {#if !readonly}
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div class="space-y-1">
          <label for="role-name" class="text-xs font-medium text-muted-foreground">{t("common.name")}</label>
          {#if isCreate}
            <input
              id="role-name"
              type="text"
              autocomplete="off"
              bind:value={name}
              placeholder={t("users.roleNamePlaceholder")}
              class="{inputClass} font-mono"
            >
          {:else}
            <input id="role-name" type="text" value={role?.name} disabled class="{inputClass} font-mono opacity-60">
          {/if}
        </div>
        <div class="space-y-1">
          <label for="role-desc" class="text-xs font-medium text-muted-foreground">
            {t("common.description")} <span class="font-normal">{t("common.optional")}</span>
          </label>
          <input id="role-desc" type="text" bind:value={description} class={inputClass}>
        </div>
      </div>
    {:else if role?.description}
      <p class="text-sm">{role.description}</p>
    {/if}

    {#if role?.name === ROLE_ADMIN}
      <p class="text-sm text-muted-foreground">{t("users.adminAllPermissions")}</p>
    {:else}
      <div class="space-y-1">
        <div class="flex items-baseline justify-between">
          <span class="text-xs font-medium text-muted-foreground">{t("users.permissions")}</span>
          <span class="text-xs text-muted-foreground"
            >{t("common.countOf", { count: selected.length, total: permissions.length })}</span
          >
        </div>
        <PermissionMatrix available={permissions} bind:selected {readonly} />
        {#if !readonly}
          <p class="text-xs text-muted-foreground">{t("users.toggleRowHint")}</p>
        {/if}
      </div>
    {/if}

    {#if error}
      <p class="text-sm text-destructive" role="alert">{error}</p>
    {/if}
  </form>

  {#snippet footer()}
    {#if readonly}
      <Button size="sm" variant="outline" onclick={onClose}>{t("common.close")}</Button>
    {:else}
      {#if role}
        <div class="mr-auto flex items-center gap-2">
          {#if confirmingDelete}
            <span class="text-xs text-muted-foreground">{t("common.deleteNamed", { name: role.name })}</span>
            <Button size="sm" variant="destructive" disabled={saving} onclick={remove}>{t("common.delete")}</Button>
            <Button size="sm" variant="ghost" onclick={() => (confirmingDelete = false)}>{t("common.keep")}</Button>
          {:else}
            <Button
              size="sm"
              variant="ghost"
              class="text-destructive"
              disabled={deleteLock !== null}
              onclick={() => (confirmingDelete = true)}
            >
              <TrashIcon size={14} class="mr-1.5" aria-hidden="true" />
              {t("common.delete")}
            </Button>
            {#if deleteLock}
              <span class="text-xs text-muted-foreground">{deleteLock}</span>
            {/if}
          {/if}
        </div>
      {/if}
      <Button size="sm" variant="outline" onclick={onClose}>{t("common.cancel")}</Button>
      <Button size="sm" type="submit" form="role-dialog-form" disabled={saving}>
        {saving ? t("common.saving") : isCreate ? t("users.createRole") : t("common.save")}
      </Button>
    {/if}
  {/snippet}
</Dialog>
