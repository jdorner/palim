<script lang="ts">
import CheckCircleIcon from "phosphor-svelte/lib/CheckCircleIcon";
import FloppyDiskIcon from "phosphor-svelte/lib/FloppyDiskIcon";
import PencilSimpleIcon from "phosphor-svelte/lib/PencilSimpleIcon";
import PlusIcon from "phosphor-svelte/lib/PlusIcon";
import TrashIcon from "phosphor-svelte/lib/TrashIcon";
import { authFetch } from "$lib/auth";
import LoadingIndicator from "$lib/components/LoadingIndicator.svelte";
import AlertDialog from "$lib/components/ui/alert-dialog/AlertDialog.svelte";
import { Button } from "$lib/components/ui/button";
import { Card, CardContent, CardHeader } from "$lib/components/ui/card";
import { ensureOk } from "$lib/http";
import { i18n, t } from "$lib/i18n.svelte";
import type { GlobalVariableEntry } from "../../../shared/types";

/** Maximum length of a variable value in characters (mirrors the API limit). */
const MAX_VALUE_LEN = 65536;

/** Maximum length of a variable description in characters (mirrors the API limit). */
const MAX_DESCRIPTION_LEN = 1024;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Loading state for initial fetch. */
let loading = $state(true);

/** Error from initial fetch. */
let fetchError = $state<string | null>(null);

/** List of stored global variables (full plaintext values). */
let variables = $state<GlobalVariableEntry[]>([]);

/** Whether form is currently submitting. */
let submitting = $state(false);

/** Success toast message. */
let successMsg = $state<string | null>(null);
let successTimer: ReturnType<typeof setTimeout> | null = null;

/** Delete confirmation dialog state. */
let deleteDialogOpen = $state(false);
let deleteTargetKey = $state<string | null>(null);
let deleting = $state(false);

/**
 * Workflows that reference the delete target. Empty until an unconfirmed
 * delete returns a 409, at which point the dialog escalates to require an
 * explicit confirmation listing these workflows.
 */
let deleteReferencingWorkflows = $state<string[]>([]);

// --- Unified form state (create + edit) ---
let formMode = $state<"create" | "edit" | null>(null);

/** Key being edited (immutable in edit mode); null while creating. */
let editingKey = $state<string | null>(null);

let formKey = $state("");
let formValue = $state("");
let formDescription = $state("");
let formError = $state<string | null>(null);

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

/**
 * Loads all global variables from the API into local state.
 * Populates {@link fetchError} on failure.
 */
async function fetchVariables() {
  loading = true;
  fetchError = null;
  try {
    const res = await authFetch("/api/variables");
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(data.error ?? `HTTP ${res.status}`);
    }
    const data: { variables: GlobalVariableEntry[] } = await res.json();
    variables = data.variables;
  } catch (err) {
    fetchError = err instanceof Error ? err.message : t("variables.loadFailed");
  } finally {
    loading = false;
  }
}

// Fetch on mount
$effect(() => {
  fetchVariables();
});

// ---------------------------------------------------------------------------
// Form management
// ---------------------------------------------------------------------------

/** Opens the create form with empty fields. */
function openCreateForm() {
  resetForm();
  formMode = "create";
}

/**
 * Opens the edit form for an existing variable. The key is immutable in edit
 * mode; the value is pre-filled since variable values are non-sensitive.
 *
 * @param entry - The variable to edit.
 */
function openEditForm(entry: GlobalVariableEntry) {
  formMode = "edit";
  editingKey = entry.key;
  formKey = entry.key;
  formValue = entry.value;
  formDescription = entry.description ?? "";
  formError = null;
}

/** Resets all form fields and closes the form. */
function resetForm() {
  formMode = null;
  editingKey = null;
  formKey = "";
  formValue = "";
  formDescription = "";
  formError = null;
}

/**
 * Validates and submits the create/edit form via the upsert endpoint.
 * On failure, preserves entered values and shows the API error message.
 */
async function submitForm() {
  formError = null;

  // In edit mode the key is immutable; use the editing key. In create mode
  // validate the entered key.
  const key = formMode === "edit" ? (editingKey ?? "") : formKey.trim();

  if (formMode === "create") {
    if (!key) {
      formError = t("globalSecrets.keyRequired");
      return;
    }
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key)) {
      formError = t("variables.keyFormat");
      return;
    }
    if (variables.some((v) => v.key === key)) {
      formError = t("variables.exists", { key });
      return;
    }
  }

  // Value is required for both create and edit (variables cannot be empty).
  if (formValue.trim().length === 0) {
    formError = t("secrets.valueEmpty");
    return;
  }
  if (formValue.length > MAX_VALUE_LEN) {
    formError = t("variables.valueTooLong", { max: MAX_VALUE_LEN });
    return;
  }
  if (formDescription.length > MAX_DESCRIPTION_LEN) {
    formError = t("variables.descriptionTooLong", { max: MAX_DESCRIPTION_LEN });
    return;
  }

  submitting = true;
  try {
    await saveVariable(key, formValue, formDescription.trim(), formMode === "create");

    const message = t(formMode === "create" ? "variables.added" : "variables.updated", { key });
    resetForm();
    await fetchVariables();
    showSuccess(message);
  } catch (err) {
    // Preserve entered values (do not reset form) and surface the API error.
    formError = err instanceof Error ? err.message : t("common.saveFailedShort");
    // A create can collide with a variable added elsewhere; refresh the list.
    if (formMode === "create") fetchVariables();
  } finally {
    submitting = false;
  }
}

/**
 * Saves a variable. Creating uses POST, which the API rejects with 409 when
 * the key already exists; editing uses PUT, which overwrites.
 *
 * @param key - The variable key.
 * @param value - The plaintext value.
 * @param description - Optional description (empty string is omitted).
 * @param create - Whether this creates a new variable.
 * @throws If the API returns a non-OK response.
 */
async function saveVariable(key: string, value: string, description: string, create: boolean) {
  const body: Record<string, unknown> = {
    variables: { [key]: value },
  };
  if (description) {
    body.descriptions = { [key]: description };
  }

  await ensureOk(
    await authFetch("/api/variables", {
      method: create ? "POST" : "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

// ---------------------------------------------------------------------------
// Delete (two-stage: standard confirm, then escalated confirm if referenced)
// ---------------------------------------------------------------------------

/**
 * Opens the standard delete confirmation dialog for a variable. The escalated
 * (referenced) prompt is shown later only if the initial delete returns a 409.
 *
 * @param key - The variable key to delete.
 */
function confirmDelete(key: string) {
  deleteTargetKey = key;
  deleteReferencingWorkflows = [];
  deleteDialogOpen = true;
}

/**
 * Issues the delete request for the current target.
 *
 * First attempt is made without confirmation. If the variable is referenced by
 * workflows the API responds 409 with the referencing list; this captures the
 * list and re-opens the dialog escalated so the admin must explicitly confirm.
 * A confirmed deletion re-issues the request with `?confirm=true`.
 */
async function executeDelete() {
  if (!deleteTargetKey) return;
  const key = deleteTargetKey;
  const escalated = deleteReferencingWorkflows.length > 0;
  deleting = true;

  try {
    const url = `/api/variables/${encodeURIComponent(key)}${escalated ? "?confirm=true" : ""}`;
    const res = await authFetch(url, { method: "DELETE" });

    // Referenced without confirmation: escalate the dialog to list workflows.
    if (res.status === 409) {
      const data: { referencingWorkflows?: string[] } = await res.json().catch(() => ({ referencingWorkflows: [] }));
      deleteReferencingWorkflows = data.referencingWorkflows ?? [];
      deleting = false;
      // Keep the dialog open; it now renders the escalated confirmation.
      return;
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(data.error ?? `HTTP ${res.status}`);
    }

    if (editingKey === key) resetForm();
    await fetchVariables();
    showSuccess(t("variables.deleted", { key }));
    closeDeleteDialog();
  } catch (err) {
    formError = err instanceof Error ? err.message : t("common.deleteFailedShort");
    closeDeleteDialog();
  } finally {
    deleting = false;
  }
}

/** Closes and resets the delete confirmation dialog state. */
function closeDeleteDialog() {
  deleteDialogOpen = false;
  deleteTargetKey = null;
  deleteReferencingWorkflows = [];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Shows a transient success toast for 3 seconds.
 *
 * @param msg - The message to display.
 */
function showSuccess(msg: string) {
  successMsg = msg;
  if (successTimer) clearTimeout(successTimer);
  successTimer = setTimeout(() => (successMsg = null), 3000);
}

/**
 * Formats an epoch timestamp (ms) as a localized date/time string.
 *
 * @param epoch - Epoch milliseconds.
 * @returns Human-readable date/time.
 */
function formatDate(epoch: number): string {
  return i18n.format.date(epoch, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Global keyboard handling: Escape cancels the form, Ctrl/Cmd+S or
 * Ctrl/Cmd+Enter submits it.
 *
 * @param event - The keyboard event.
 */
function handleKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && formMode) resetForm();
  if ((event.key === "s" || event.key === "Enter") && (event.ctrlKey || event.metaKey) && formMode) {
    event.preventDefault();
    submitForm();
  }
}
</script>

{#snippet variableForm()}
  <Card class="bg-accent">
    <CardHeader class="pb-2">
      <span class="text-sm font-medium">
        {formMode === "create" ? t("variables.addTitle") : t("globalSecrets.editTitle", { key: editingKey })}
      </span>
    </CardHeader>
    <CardContent class="space-y-3">
      <div class="space-y-1">
        <label for="variable-key" class="text-xs font-medium text-muted-foreground"
          >{t("globalSecrets.keyLabel")}</label
        >
        <input
          id="variable-key"
          type="text"
          class="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm font-mono disabled:opacity-60"
          placeholder={t("variables.keyPlaceholder")}
          bind:value={formKey}
          disabled={formMode === "edit"}
        >
        {#if formMode === "edit"}
          <p class="text-xs text-muted-foreground">{t("variables.keyLocked")}</p>
        {/if}
      </div>

      <div class="space-y-1">
        <label for="variable-value" class="text-xs font-medium text-muted-foreground">{t("globalSecrets.value")}</label>
        <input
          id="variable-value"
          type="text"
          maxlength={MAX_VALUE_LEN}
          class="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          placeholder={t("variables.valuePlaceholder")}
          bind:value={formValue}
        >
      </div>

      <div class="space-y-1">
        <label for="variable-desc" class="text-xs font-medium text-muted-foreground"
          >{t("globalSecrets.descriptionLabel")}</label
        >
        <input
          id="variable-desc"
          type="text"
          maxlength={MAX_DESCRIPTION_LEN}
          class="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          placeholder={t("variables.descriptionPlaceholder")}
          bind:value={formDescription}
        >
      </div>

      {#if formError}
        <p class="text-sm font-bold text-destructive">{formError}</p>
      {/if}

      <hr>

      <div class="flex gap-2">
        <Button size="sm" disabled={submitting} onclick={submitForm}>
          <FloppyDiskIcon class="w-4 h-4 mr-1.5" aria-hidden="true" />
          {submitting ? t("common.saving") : formMode === "create" ? t("common.create") : t("common.save")}
        </Button>
        <Button size="sm" variant="outline" onclick={resetForm}>{t("common.cancel")}</Button>
      </div>
    </CardContent>
  </Card>
{/snippet}

<svelte:window onkeydown={handleKeydown} />

{#if loading}
  <LoadingIndicator message={t("variables.loading")} />
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
        {formMode ? t("common.cancel") : t("variables.add")}
      </Button>
    </div>

    <!-- Create form -->
    {#if formMode === "create"}
      {@render variableForm()}
    {/if}

    <!-- Empty state -->
    {#if variables.length === 0 && !formMode}
      <p class="text-sm text-muted-foreground">{t("variables.empty")}</p>
    {/if}

    <!-- Edit form (shown above the list when editing) -->
    {#if formMode === "edit"}
      {@render variableForm()}
    {/if}

    <!-- Variables list -->
    {#if variables.length > 0}
      <div class="space-y-2">
        {#each variables as entry (entry.key)}
          <div
            class="rounded-md border border-border px-3 py-2 space-y-1.5 {editingKey === entry.key ? "bg-accent" : ""}"
          >
            <!-- Header row -->
            <div class="flex items-center gap-2">
              <CheckCircleIcon
                class="w-4 h-4 text-green-600 dark:text-green-400 shrink-0"
                aria-label={t("variables.isSet")}
              />
              <span class="text-sm font-medium font-mono">{entry.key}</span>

              <!-- Action buttons -->
              <div class="ml-auto flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  class="h-7 w-7"
                  aria-label={t("secrets.editKey", { key: entry.key })}
                  title={t("common.edit")}
                  onclick={() => openEditForm(entry)}
                >
                  <PencilSimpleIcon class="w-4 h-4" aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  class="h-7 w-7 text-destructive hover:text-destructive"
                  aria-label={t("secrets.deleteKey", { key: entry.key })}
                  title={t("common.delete")}
                  onclick={() => confirmDelete(entry.key)}
                >
                  <TrashIcon class="w-4 h-4" aria-hidden="true" />
                </Button>
              </div>
            </div>

            <!-- Plaintext value (variables are non-sensitive, shown unmasked) -->
            <p class="text-sm font-mono break-all">{entry.value}</p>

            <!-- Description and last updated -->
            <div class="flex items-center gap-3">
              {#if entry.description}
                <p class="text-xs text-muted-foreground">{entry.description}</p>
              {/if}
              <span class="text-xs text-muted-foreground/60 ml-auto shrink-0">
                {t("common.updatedAt", { date: formatDate(entry.updatedAt) })}
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

<!-- Delete confirmation dialog. The description escalates to list referencing
     workflows once an unconfirmed delete returns a 409. -->
<AlertDialog
  open={deleteDialogOpen}
  title={t("variables.deleteTitle")}
  description={deleteReferencingWorkflows.length > 0
    ? t("variables.deleteReferenced", {
        key: deleteTargetKey,
        count: deleteReferencingWorkflows.length,
        workflows: deleteReferencingWorkflows.join(", "),
      })
    : t("variables.deleteConfirm", { key: deleteTargetKey })}
  confirmLabel={deleting
    ? t("common.deleting")
    : deleteReferencingWorkflows.length > 0
      ? t("variables.deleteAnyway")
      : t("common.delete")}
  cancelLabel={t("common.cancel")}
  confirmVariant="destructive"
  onConfirm={executeDelete}
  onCancel={closeDeleteDialog}
/>
