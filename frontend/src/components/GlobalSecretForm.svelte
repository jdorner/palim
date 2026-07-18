<script lang="ts">
import CheckCircleIcon from "phosphor-svelte/lib/CheckCircleIcon";
import FloppyDiskIcon from "phosphor-svelte/lib/FloppyDiskIcon";
import PencilSimpleIcon from "phosphor-svelte/lib/PencilSimpleIcon";
import PlusIcon from "phosphor-svelte/lib/PlusIcon";
import TrashIcon from "phosphor-svelte/lib/TrashIcon";
import { authFetch } from "$lib/auth";
import LoadingIndicator from "$lib/components/LoadingIndicator.svelte";
import AlertDialog from "$lib/components/ui/alert-dialog/AlertDialog.svelte";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { Card, CardContent, CardHeader } from "$lib/components/ui/card";

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
let successMsg = $state<string | null>(null);
let successTimer: ReturnType<typeof setTimeout> | null = null;

/** Delete confirmation dialog state. */
let deleteDialogOpen = $state(false);
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
    const res = await authFetch("/api/secrets");
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(data.error ?? `HTTP ${res.status}`);
    }
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
      await saveSecret(trimmedKey, formValue, consumers, formDescription.trim());
    } else {
      // Edit mode: key may have changed
      const keyChanged = editingKey !== null && editingKey !== trimmedKey;

      if (keyChanged) {
        // Must provide a value when creating under a new key
        if (formValue.trim().length === 0) {
          formError = "Value is required when changing the key";
          return;
        }
        // Create new key first, then delete old
        await saveSecret(trimmedKey, formValue, consumers, formDescription.trim());
        await authFetch(`/api/secrets/${encodeURIComponent(editingKey!)}`, { method: "DELETE" });
      } else if (formValue.trim().length > 0) {
        // Key unchanged, value provided -> upsert value + meta
        await saveSecret(trimmedKey, formValue, consumers, formDescription.trim());
      } else {
        // Key unchanged, no new value -> update metadata only (consumers + description)
        await updateMeta(trimmedKey, consumers, formDescription.trim());
      }
    }

    const action = formMode === "create" ? "added" : "updated";
    resetForm();
    await fetchSecrets();
    showSuccess(`Secret "${trimmedKey}" ${action}`);
  } catch (err) {
    formError = err instanceof Error ? err.message : "Failed to save";
  } finally {
    submitting = false;
  }
}

/**
 * Upserts a secret via the PUT endpoint.
 */
async function saveSecret(key: string, value: string, consumers: string[], description: string) {
  const body: Record<string, unknown> = {
    secrets: { [key]: value },
    consumers,
  };
  if (description) {
    body.descriptions = { [key]: description };
  }

  const res = await authFetch("/api/secrets", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
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

  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

function confirmDelete(key: string) {
  deleteTargetKey = key;
  deleteDialogOpen = true;
}

async function executeDelete() {
  if (!deleteTargetKey) return;
  const key = deleteTargetKey;
  deleting = true;

  try {
    const res = await authFetch(`/api/secrets/${key}`, {
      method: "DELETE",
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(data.error ?? `HTTP ${res.status}`);
    }

    if (editingKey === key) resetForm();
    await fetchSecrets();
    showSuccess(`Secret "${key}" deleted`);
  } catch (err) {
    formError = err instanceof Error ? err.message : "Failed to delete";
  } finally {
    deleting = false;
    deleteDialogOpen = false;
    deleteTargetKey = null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function showSuccess(msg: string) {
  successMsg = msg;
  if (successTimer) clearTimeout(successTimer);
  successTimer = setTimeout(() => (successMsg = null), 3000);
}

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

      <div class="h-px w-full bg-current opacity-15">&nbsp;</div>

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
          <div
            class="rounded-md border border-border px-3 py-2 space-y-1.5 {editingKey === entry.key ? 'bg-accent' : ''}"
          >
            <!-- Header row -->
            <div class="flex items-center gap-2">
              <CheckCircleIcon class="w-4 h-4 text-green-600 dark:text-green-400 shrink-0" aria-label="Secret is set" />
              <span class="text-sm font-medium font-mono">{entry.key}</span>

              <!-- Consumer badges -->
              <div class="inline-flex items-center gap-1">
                {#each entry.consumers as consumer}
                  <Badge variant="secondary" class="text-xs font-normal">{consumer}</Badge>
                {/each}
              </div>

              <!-- Action buttons -->
              <div class="ml-auto flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  class="h-7 w-7"
                  aria-label="Edit {entry.key}"
                  title="Edit"
                  onclick={() => openEditForm(entry)}
                >
                  <PencilSimpleIcon class="w-4 h-4" aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  class="h-7 w-7 text-destructive hover:text-destructive"
                  aria-label="Delete {entry.key}"
                  title="Delete"
                  onclick={() => confirmDelete(entry.key)}
                >
                  <TrashIcon class="w-4 h-4" aria-hidden="true" />
                </Button>
              </div>
            </div>

            <!-- Description and last updated -->
            <div class="flex items-center gap-3">
              {#if entry.description}
                <p class="text-xs text-muted-foreground">{entry.description}</p>
              {/if}
              <span class="text-xs text-muted-foreground/60 ml-auto shrink-0">
                Updated {formatDate(entry.updatedAt)}
              </span>
            </div>
          </div>
        {/each}
      </div>
    {/if}

    <!-- Success toast -->
    {#if successMsg}
      <div class="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
        <CheckCircleIcon class="w-4 h-4 shrink-0" aria-hidden="true" />
        <span>{successMsg}</span>
      </div>
    {/if}
  </div>
{/if}

<!-- Delete confirmation dialog -->
<AlertDialog
  open={deleteDialogOpen}
  title="Delete Secret"
  description={`Are you sure you want to delete "${deleteTargetKey}"? This action is irreversible.`}
  confirmLabel={deleting ? "Deleting..." : "Delete"}
  cancelLabel="Cancel"
  confirmVariant="destructive"
  onConfirm={executeDelete}
  onCancel={() => { deleteDialogOpen = false; deleteTargetKey = null; }}
/>
