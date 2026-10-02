<script lang="ts">
import { Tabs } from "bits-ui";
import ArrowClockwiseIcon from "phosphor-svelte/lib/ArrowClockwiseIcon";
import CheckCircleIcon from "phosphor-svelte/lib/CheckCircleIcon";
import CheckIcon from "phosphor-svelte/lib/CheckIcon";
import KeyIcon from "phosphor-svelte/lib/KeyIcon";
import LockSimpleIcon from "phosphor-svelte/lib/LockSimpleIcon";
import MagnifyingGlassIcon from "phosphor-svelte/lib/MagnifyingGlassIcon";
import PlusIcon from "phosphor-svelte/lib/PlusIcon";
import ProhibitIcon from "phosphor-svelte/lib/ProhibitIcon";
import WarningIcon from "phosphor-svelte/lib/WarningIcon";
import XIcon from "phosphor-svelte/lib/XIcon";
import LoadingIndicator from "$lib/components/LoadingIndicator.svelte";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "$lib/components/ui/table";
import { identity } from "$lib/identity.svelte";
import { ROLE_ADMIN, ROLE_SYSTEM } from "$shared/auth";
import { loadUsersAndRoles, updateUser } from "../components/users/api";
import PasswordDialog from "../components/users/PasswordDialog.svelte";
import RoleDialog from "../components/users/RoleDialog.svelte";
import UserDialog from "../components/users/UserDialog.svelte";
import {
  disableLockReason,
  groupPermissions,
  isLastAdmin,
  isSystemUser,
  type RoleRow,
  type UserRow,
} from "../components/users/userAdmin";

/** Show the user search box once the list gets long enough to need it. */
const SEARCH_THRESHOLD = 8;

/** Tab trigger styling, matching the Settings page. */
const TAB_TRIGGER_CLASS =
  "px-3 py-1.5 text-sm font-medium text-muted-foreground data-[state=active]:text-foreground data-[state=active]:border-b-2 data-[state=active]:border-primary -mb-px";

// --- Tabs (remembered per browser session, like Settings) ---
const TAB_KEY = "users-active-tab";
let activeTab = $state(readTab());

function readTab(): string {
  try {
    return sessionStorage.getItem(TAB_KEY) ?? "users";
  } catch {
    return "users";
  }
}

function onTabChange(tab: string) {
  activeTab = tab;
  try {
    sessionStorage.setItem(TAB_KEY, tab);
  } catch {
    // Storage unavailable; the tab just won't be remembered.
  }
}

// --- Data ---
let loading = $state(true);
let loadError = $state<string | null>(null);
let users = $state<UserRow[]>([]);
let roles = $state<RoleRow[]>([]);
let permissions = $state<string[]>([]);

// --- Feedback ---
let notice = $state<{ kind: "success" | "error"; text: string } | null>(null);
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

// --- Dialogs and inline confirmations ---
let userDialog = $state<{ user: UserRow | null } | null>(null);
let passwordUser = $state<UserRow | null>(null);
let roleDialog = $state<{ role: RoleRow | null } | null>(null);
let confirmDisableId = $state<string | null>(null);
let busyUserId = $state<string | null>(null);
let search = $state("");

const currentUserId = $derived(identity.user?.id);
const assignableRoles = $derived(roles.filter((r) => r.name !== ROLE_SYSTEM));
const visibleUsers = $derived.by(() => {
  const q = search.trim().toLowerCase();
  if (!q) return users;
  return users.filter((u) => u.username.toLowerCase().includes(q) || u.displayName?.toLowerCase().includes(q));
});

/** Case-insensitive, locale-aware name comparison for list ordering. */
function byName(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

/**
 * Loads users and roles. The full-page spinner is shown only for the first
 * load; later refreshes keep the current list on screen.
 */
async function refresh() {
  try {
    const data = await loadUsersAndRoles();
    users = data.users.toSorted((x, y) => byName(x.username, y.username));
    roles = data.roles.toSorted((x, y) => byName(x.name, y.name));
    permissions = data.permissions;
    loadError = null;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load";
    if (loading) loadError = message;
    else showNotice("error", message);
  } finally {
    loading = false;
  }
}

$effect(() => {
  refresh();
});

/** Retries a failed initial load, showing the spinner again. */
function retryLoad() {
  loading = true;
  refresh();
}

function showNotice(kind: "success" | "error", text: string) {
  notice = { kind, text };
  if (noticeTimer) clearTimeout(noticeTimer);
  // Errors stay until dismissed; confirmations fade out.
  noticeTimer = kind === "success" ? setTimeout(() => (notice = null), 3000) : null;
}

/** Closes all dialogs, shows the confirmation, and reloads the lists. */
async function handleSaved(message: string) {
  userDialog = null;
  passwordUser = null;
  roleDialog = null;
  showNotice("success", message);
  await refresh();
}

async function setDisabled(user: UserRow, disabled: boolean) {
  confirmDisableId = null;
  busyUserId = user.id;
  try {
    await updateUser(user.id, { disabled });
    await handleSaved(`${disabled ? "Disabled" : "Enabled"} ${user.username}`);
  } catch (err) {
    showNotice("error", err instanceof Error ? err.message : "Update failed");
  } finally {
    busyUserId = null;
  }
}

/** Short inline label for why a user cannot be disabled. */
function shortDisableLock(user: UserRow): string | null {
  if (!disableLockReason(user, users, currentUserId)) return null;
  if (user.id === currentUserId) return "Your account";
  return isLastAdmin(user, users) ? "Last admin" : "Locked";
}

/** Compact per-resource summary of a role's permissions. */
function permissionSummary(role: RoleRow): { resource: string; actions: string }[] {
  const groups = groupPermissions(role.permissions);
  return groups.resources.map(({ resource, perms }) => ({
    resource,
    actions: groups.actions.filter((a) => perms.has(a)).join(", "),
  }));
}
</script>

{#if notice}
  <div
    class="fixed bottom-4 right-4 z-40 flex max-w-sm items-start gap-2 rounded-md border px-3 py-2 text-sm shadow-md bg-background
      {notice.kind === 'success' ? 'border-green-600/40 text-green-700 dark:text-green-400' : 'border-destructive/50 text-destructive'}"
    role={notice.kind === "error" ? "alert" : "status"}
  >
    {#if notice.kind === "success"}
      <CheckCircleIcon size={16} class="mt-0.5 shrink-0" aria-hidden="true" />
    {:else}
      <WarningIcon size={16} class="mt-0.5 shrink-0" aria-hidden="true" />
    {/if}
    <span class="flex-1">{notice.text}</span>
    <button type="button" aria-label="Dismiss" class="opacity-60 hover:opacity-100" onclick={() => (notice = null)}>
      <XIcon size={14} aria-hidden="true" />
    </button>
  </div>
{/if}

{#if loading}
  <LoadingIndicator message="Loading users and roles..." />
{:else if loadError}
  <div class="flex items-center gap-3">
    <p class="text-sm text-destructive">{loadError}</p>
    <Button size="sm" variant="outline" onclick={retryLoad}>
      <ArrowClockwiseIcon size={14} class="mr-1.5" aria-hidden="true" />
      Retry
    </Button>
  </div>
{:else}
  <Tabs.Root value={activeTab} onValueChange={onTabChange} class="space-y-4">
    <div class="flex items-end gap-3 border-b border-border">
      <Tabs.List class="flex gap-1">
        <Tabs.Trigger value="users" class={TAB_TRIGGER_CLASS}>
          Users <span class="ml-1 text-xs text-muted-foreground">{users.length}</span>
        </Tabs.Trigger>
        <Tabs.Trigger value="roles" class={TAB_TRIGGER_CLASS}>
          Roles <span class="ml-1 text-xs text-muted-foreground">{roles.length}</span>
        </Tabs.Trigger>
      </Tabs.List>
      {#if activeTab === "roles"}
        <Button size="sm" class="mb-1 ml-auto" onclick={() => (roleDialog = { role: null })}>
          <PlusIcon size={14} class="mr-1.5" aria-hidden="true" />
          Add role
        </Button>
      {:else}
        <Button size="sm" class="mb-1 ml-auto" onclick={() => (userDialog = { user: null })}>
          <PlusIcon size={14} class="mr-1.5" aria-hidden="true" />
          Add user
        </Button>
      {/if}
    </div>

    <!-- ================= Users ================= -->
    <Tabs.Content value="users" class="space-y-3">
      {#if users.length > SEARCH_THRESHOLD}
        <div class="relative">
          <MagnifyingGlassIcon
            size={14}
            class="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            type="search"
            placeholder="Filter users"
            aria-label="Filter users"
            bind:value={search}
            class="w-48 rounded-md border border-input bg-background py-1.5 pl-8 pr-3 text-sm"
          >
        </div>
      {/if}

      <div class="rounded-md border border-border">
        <Table>
          <TableHeader class="bg-muted/30">
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Roles</TableHead>
              <TableHead class="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each visibleUsers as user (user.id)}
              {@const system = isSystemUser(user)}
              <TableRow class={system ? "bg-muted/30" : ""}>
                <TableCell class={user.disabled ? "opacity-60" : ""}>
                  <div class="flex flex-wrap items-center gap-2">
                    {#if system}
                      <span class="font-medium">{user.username}</span>
                    {:else}
                      <a
                        href="#user-{user.id}"
                        class="font-medium"
                        onclick={(e) => {
                          e.preventDefault();
                          userDialog = { user };
                        }}
                      >
                        {user.username}
                      </a>
                    {/if}
                    {#if user.id === currentUserId}
                      <Badge variant="outline" class="text-[10px] px-1.5 py-0">you</Badge>
                    {/if}
                    {#if user.disabled}
                      <Badge variant="warning-outline" class="text-[10px] px-1.5 py-0">disabled</Badge>
                    {/if}
                  </div>
                  {#if user.displayName}
                    <span class="text-xs text-muted-foreground">{user.displayName}</span>
                  {:else if system}
                    <span class="text-xs text-muted-foreground"
                      >Built-in account for background jobs. Cannot sign in.</span
                    >
                  {/if}
                </TableCell>
                <TableCell class={user.disabled ? "opacity-60" : ""}>
                  <div class="flex flex-wrap gap-1">
                    {#each user.roles as role}
                      <Badge
                        variant={role === ROLE_ADMIN ? "default" : "secondary"}
                        class="text-xs font-mono font-normal"
                      >
                        {role}
                      </Badge>
                    {:else}
                      <span class="text-xs text-yellow-600 dark:text-yellow-400">no roles</span>
                    {/each}
                  </div>
                </TableCell>
                <TableCell class="w-1">
                  <div class="flex items-center justify-end gap-1 whitespace-nowrap">
                    {#if system}
                      <span class="pr-2 text-xs text-muted-foreground">read-only</span>
                    {:else if confirmDisableId === user.id}
                      <span class="text-xs text-muted-foreground mr-1">Disable and sign out?</span>
                      <Button size="sm" variant="destructive" onclick={() => setDisabled(user, true)}>Disable</Button>
                      <Button size="sm" variant="ghost" onclick={() => (confirmDisableId = null)}>Cancel</Button>
                    {:else}
                      {@const lock = shortDisableLock(user)}
                      <Button size="sm" variant="ghost" onclick={() => (passwordUser = user)}>
                        <KeyIcon size={14} class="mr-1.5" aria-hidden="true" />
                        Password
                      </Button>
                      {#if user.disabled}
                        <Button
                          size="sm"
                          variant="ghost"
                          class="w-28 justify-end"
                          disabled={busyUserId === user.id}
                          onclick={() => setDisabled(user, false)}
                        >
                          <CheckIcon size={14} class="mr-1.5" aria-hidden="true" />
                          Enable
                        </Button>
                      {:else if lock}
                        <span
                          class="inline-flex w-28 items-center justify-end gap-1 pr-2 text-xs text-muted-foreground"
                          title={disableLockReason(user, users, currentUserId)}
                        >
                          <LockSimpleIcon size={12} aria-hidden="true" />
                          {lock}
                        </span>
                      {:else}
                        <Button
                          size="sm"
                          variant="ghost"
                          class="w-28 justify-end text-destructive hover:text-destructive"
                          disabled={busyUserId === user.id}
                          onclick={() => (confirmDisableId = user.id)}
                        >
                          <ProhibitIcon size={14} class="mr-1.5" aria-hidden="true" />
                          Disable
                        </Button>
                      {/if}
                    {/if}
                  </div>
                </TableCell>
              </TableRow>
            {:else}
              <TableRow>
                <TableCell colspan={3} class="text-muted-foreground">No users match "{search}".</TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      </div>
    </Tabs.Content>

    <!-- ================= Roles ================= -->
    <Tabs.Content value="roles" class="space-y-3">
      <div class="rounded-md border border-border">
        <Table>
          <TableHeader class="bg-muted/30">
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead class="hidden lg:table-cell">Description</TableHead>
              <TableHead>Permissions</TableHead>
              <TableHead class="text-right">Users</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each roles as role (role.id)}
              <!-- h-15 matches the user rows (36px buttons + cell padding); acts as a min height on table rows -->
              <TableRow class="h-15">
                <TableCell class="whitespace-nowrap">
                  <span class="inline-flex items-center gap-2">
                    <a
                      href="#role-{role.id}"
                      class="font-medium"
                      onclick={(e) => {
                        e.preventDefault();
                        roleDialog = { role };
                      }}
                    >
                      {role.name}
                    </a>
                    {#if role.builtIn}
                      <Badge variant="outline" class="text-[10px] px-1.5 py-0">built-in</Badge>
                    {/if}
                  </span>
                </TableCell>
                <TableCell class="hidden lg:table-cell text-xs text-muted-foreground">
                  {role.description || "-"}
                </TableCell>
                <TableCell>
                  <div class="flex flex-wrap gap-1">
                    {#if role.name === ROLE_ADMIN}
                      <span class="text-xs text-muted-foreground">All permissions</span>
                    {:else}
                      {#each permissionSummary(role) as { resource, actions } (resource)}
                        <span class="inline-flex items-center gap-1 rounded bg-secondary px-1.5 py-0.5 text-xs">
                          <span class="font-mono">{resource}</span>
                          <span class="text-muted-foreground">{actions}</span>
                        </span>
                      {:else}
                        <span class="text-xs text-yellow-600 dark:text-yellow-400">No permissions</span>
                      {/each}
                    {/if}
                  </div>
                </TableCell>
                <TableCell class="w-1 text-right text-muted-foreground">{role.userCount}</TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      </div>
    </Tabs.Content>
  </Tabs.Root>
{/if}

{#if userDialog}
  <UserDialog
    user={userDialog.user}
    {users}
    roles={assignableRoles}
    {currentUserId}
    onClose={() => (userDialog = null)}
    onSaved={handleSaved}
  />
{/if}

{#if passwordUser}
  <PasswordDialog user={passwordUser} onClose={() => (passwordUser = null)} onSaved={handleSaved} />
{/if}

{#if roleDialog}
  <RoleDialog role={roleDialog.role} {permissions} onClose={() => (roleDialog = null)} onSaved={handleSaved} />
{/if}
