<script lang="ts">
import FloppyDiskIcon from "phosphor-svelte/lib/FloppyDiskIcon";
import PlusIcon from "phosphor-svelte/lib/PlusIcon";
import { authFetch } from "$lib/auth";
import LoadingIndicator from "$lib/components/LoadingIndicator.svelte";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { Card, CardContent, CardHeader } from "$lib/components/ui/card";
import { Flash } from "$lib/flash.svelte";
import { ensureOk } from "$lib/http";
import FlashMessage from "./FlashMessage.svelte";
import SecretDeleteDialog from "./SecretDeleteDialog.svelte";
import SecretRow from "./SecretRow.svelte";

/**
 * Global secret entry returned by the API.
 */
interface GlobalSecretEntry {
  key: string;
  description?: string;
  consumers: string[];
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Loading state for initial fetch. */
let loading = $state(true);

/** Error from initial fetch. */
let fetchError = $state<string | null>(null);

/** List of stored global secrets (metadata only). */
let secrets = $state<GlobalSecretEntry[]>([]);

/** Whether form is currently submitting. */
let submitting = $state(false);

/** Success toast message. */
const flash = new Flash();

/** Key pending delete confirmation. */
let deleteTargetKey = $state<string | null>(null);
let deleting = $state(false);

// --- Unified form state (create + edit) ---
let formMode = $state<"create" | "edit" | null>(null);
let editingKey = $state<string | null>(null);

let formKey = $state("");
let formValue = $state("");
let formDescription = $state("");
let formConsumers = $state("workflow:*");
let formError = $state<string | null>(null);

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function fetchSecrets() {
  loading = true;
  fetchError = null;
  try {
    const res = await ensureOk(await authFetch("/api/secrets"));
    const data: { secrets: GlobalSecretEntry[] } = await res.json();
    secrets = data.secrets;
  } catch (err) {
    fetchError = err instanceof Error ? err.message : "Failed to load secrets";
  } finally {
    loading = false;
  }
}

// Fetch on mount
$effect(() => {
  fetchSecrets();
});

// ---------------------------------------------------------------------------
// Form management
// ---------------------------------------------------------------------------

function openCreateForm() {
  resetForm();
  formMode = "create";
}

function openEditForm(entry: GlobalSecretEntry) {
  formMode = "edit";
  editingKey = entry.key;
  formKey = entry.key;
  formValue = "";
  formDescription = entry.description ?? "";
  formConsumers = entry.consumers.join(", ");
  formError = null;
}

function resetForm() {
  formMode = null;
  editingKey = null;
  formKey = "";
  formValue = "";
  formDescription = "";
  formConsumers = "workflow:*";
  formError = null;
}

async function submitForm() {
  formError = null;

  // Validate key
  const trimmedKey = formKey.trim();
  if (!trimmedKey) {
    formError = "Key is required";
    return;
  }
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(trimmedKey)) {
    formError = "Key must be UPPER_SNAKE_CASE (e.g. MY_API_TOKEN)";
    return;
  }
  if (trimmedKey !== editingKey && secrets.some((s) => s.key === trimmedKey)) {
    formError = `Secret "${trimmedKey}" already exists`;
    return;
  }

  // Validate value (required for create, optional for edit = only update if provided)
  if (formMode === "create" && formValue.trim().length === 0) {
    formError = "Value cannot be empty";
    return;
  }

  // Parse consumers
  const consumers = formConsumers
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (consumers.length === 0) {
    formError = "At least one consumer pattern is required";
    return;
  }

  submitting = true;
  try {
    if (formMode === "create") {
      await saveSecret(trimmedKey, formValue, consumers, formDescription.trim(), true);
    } else {
      // Edit mode: key may have changed
      const keyChanged = editingKey !== null && editingKey !== trimmedKey;

      if (keyChanged) {
        // Must provide a value when creating under a new key
        if (formValue.trim().length === 0) {
          formError = "Value is required when changing the key";
          return;
        }
        // Create new key first (refused if it exists), then delete old
        await saveSecret(trimmedKey, formValue, consumers, formDescription.trim(), true);
        await ensureOk(await authFetch(`/api/secrets/${encodeURIComponent(editingKey!)}`, { method: "DELETE" }));
      } else if (formValue.trim().length > 0) {
        // Key unchanged, value provided -> upsert value + meta
        await saveSecret(trimmedKey, formValue, consumers, formDescription.trim(), false);
      } else {
        // Key unchanged, no new value -> update metadata only (consumers + description)
        await updateMeta(trimmedKey, consumers, formDescription.trim());
      }
    }

    const action = formMode === "create" ? "added" : "updated";
    resetForm();
    await fetchSecrets();
    flash.show(`Secret "${trimmedKey}" ${action}`);
  } catch (err) {
    formError = err instanceof Error ? err.message : "Failed to save";
    // The key may collide with a secret added elsewhere; refresh the list.
    fetchSecrets();
  } finally {
    submitting = false;
  }
}

/**
 * Saves a secret. Creating uses POST, which the API rejects with 409 when the
 * key already exists; updating uses PUT, which overwrites.
 */
async function saveSecret(key: string, value: string, consumers: string[], description: string, create: boolean) {
  const body: Record<string, unknown> = {
    secrets: { [key]: value },
    consumers,
  };
  if (description) {
    body.descriptions = { [key]: description };
  }

  const res = await authFetch("/api/secrets", {
    method: create ? "POST" : "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  await ensureOk(res);
}

/**
 * Updates only metadata (consumers, description) for an existing secret via PATCH.
 */
async function updateMeta(key: string, consumers: string[], description: string) {
  const res = await authFetch(`/api/secrets/${encodeURIComponent(key)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      consumers,
      description: description || null,
    }),
  });
  await ensureOk(res);
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

async function executeDelete() {
  if (!deleteTargetKey) return;
  const key = deleteTargetKey;
  deleting = true;

  try {
    await ensureOk(await authFetch(`/api/secrets/${encodeURIComponent(key)}`, { method: "DELETE" }));

    if (editingKey === key) resetForm();
    await fetchSecrets();
    flash.show(`Secret "${key}" deleted`);
  } catch (err) {
    formError = err instanceof Error ? err.message : "Failed to delete";
  } finally {
    deleting = false;
    deleteTargetKey = null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(epoch: number): string {
  return new Date(epoch).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && formMode) resetForm();
  if ((event.key === "s" || event.key === "Enter") && (event.ctrlKey || event.metaKey) && formMode) {
    event.preventDefault();
    submitForm();
  }
}
</script>

{#snippet secretForm()}
  <Card class="bg-accent">
    <CardHeader class="pb-2">
      <span class="text-sm font-medium">
        {formMode === "create" ? "Add Global Secret" : `Edit: ${editingKey}`}
      </span>
    </CardHeader>
    <CardContent class="space-y-3">
      <div class="space-y-1">
        <label for="secret-key" class="text-xs font-medium text-muted-foreground">Key (UPPER_SNAKE_CASE)</label>
        <input
          id="secret-key"
          type="text"
          class="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm font-mono"
          placeholder="e.g. GITEA_API_TOKEN"
          bind:value={formKey}
        >
      </div>

      <div class="space-y-1">
        <label for="secret-value" class="text-xs font-medium text-muted-foreground">
          Value
          {#if formMode === "edit"}
            <span class="font-normal">(leave blank to keep unchanged)</span>
          {/if}
        </label>
        <input
          id="secret-value"
          type="password"
          maxlength={4096}
          class="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          placeholder={formMode === "edit" ? "Enter new value or leave blank" : "Secret value"}
          bind:value={formValue}
        >
      </div>

      <div class="space-y-1">
        <label for="secret-desc" class="text-xs font-medium text-muted-foreground">Description (optional)</label>
        <input
          id="secret-desc"
          type="text"
          maxlength={200}
          class="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          placeholder="e.g. Gitea API token for commit-check workflow"
          bind:value={formDescription}
        >
      </div>

      <div class="space-y-1">
        <label for="secret-consumers" class="text-xs font-medium text-muted-foreground">
          Consumer patterns (comma-separated)
        </label>
        <input
          id="secret-consumers"
          type="text"
          class="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm font-mono"
          placeholder="workflow:*"
          bind:value={formConsumers}
        >
        <p class="text-xs text-muted-foreground">
          Examples: <code class="bg-muted px-1 rounded">workflow:*</code> (all workflows),
          <code class="bg-muted px-1 rounded">workflow:my-wf</code>
          (specific workflow),
          <code class="bg-muted px-1 rounded">ext:telegram</code>
          (specific extension)
        </p>
      </div>

      {#if formError}
        <p class="text-sm font-bold text-destructive">{formError}</p>
      {/if}

      <hr>

      <div class="flex gap-2">
        <Button size="sm" disabled={submitting} onclick={submitForm}>
          <FloppyDiskIcon class="w-4 h-4 mr-1.5" aria-hidden="true" />
          {submitting ? "Saving..." : formMode === "create" ? "Create" : "Save"}
        </Button>
        <Button size="sm" variant="outline" onclick={resetForm}>Cancel</Button>
      </div>
    </CardContent>
  </Card>
{/snippet}

<svelte:window onkeydown={handleKeydown} />

{#if loading}
  <LoadingIndicator message="Loading global secrets..." />
{:else if fetchError}
  <p class="text-sm text-destructive">{fetchError}</p>
{:else}
  <div class="space-y-4">
    <!-- Top action bar -->
    <div class="flex items-center justify-between">
      <Button size="sm" onclick={() => (formMode ? resetForm() : openCreateForm())}>
        {#if !formMode}
          <PlusIcon size={14} class="mr-1.5" aria-hidden="true" />
        {/if}
        {formMode ? "Cancel" : "Add Secret"}
      </Button>
    </div>

    <!-- Create form -->
    {#if formMode === "create"}
      {@render secretForm()}
    {/if}

    <!-- Empty state -->
    {#if secrets.length === 0 && !formMode}
      <p class="text-sm text-muted-foreground">No global secrets configured, yet.</p>
    {/if}

    <!-- Edit form (shown above the list when editing) -->
    {#if formMode === "edit"}
      {@render secretForm()}
    {/if}

    <!-- Secrets list -->
    {#if secrets.length > 0}
      <div class="space-y-2">
        {#each secrets as entry (entry.key)}
          <SecretRow
            secretKey={entry.key}
            isSet
            highlighted={editingKey === entry.key}
            onEdit={() => openEditForm(entry)}
            onDelete={() => (deleteTargetKey = entry.key)}
          >
            {#snippet badges()}
              <div class="inline-flex items-center gap-1">
                {#each entry.consumers as consumer}
                  <Badge variant="secondary" class="text-xs font-normal">{consumer}</Badge>
                {/each}
              </div>
            {/snippet}

            <!-- Description and last updated -->
            <div class="flex items-center gap-3">
              {#if entry.description}
                <p class="text-xs text-muted-foreground">{entry.description}</p>
              {/if}
              <span class="text-xs text-muted-foreground/60 ml-auto shrink-0">
                Updated {formatDate(entry.updatedAt)}
              </span>
            </div>
          </SecretRow>
        {/each}
      </div>
    {/if}

    <FlashMessage message={flash.message} />
  </div>
{/if}

<SecretDeleteDialog
  secretKey={deleteTargetKey}
  {deleting}
  onConfirm={executeDelete}
  onCancel={() => (deleteTargetKey = null)}
/>
