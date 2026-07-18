<script lang="ts">
import CheckCircleIcon from "phosphor-svelte/lib/CheckCircleIcon";
import CircleIcon from "phosphor-svelte/lib/CircleIcon";
import FloppyDiskIcon from "phosphor-svelte/lib/FloppyDiskIcon";
import PencilSimpleIcon from "phosphor-svelte/lib/PencilSimpleIcon";
import TrashIcon from "phosphor-svelte/lib/TrashIcon";
import WarningIcon from "phosphor-svelte/lib/WarningIcon";
import { authFetch } from "$lib/auth";
import LoadingIndicator from "$lib/components/LoadingIndicator.svelte";
import AlertDialog from "$lib/components/ui/alert-dialog/AlertDialog.svelte";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import type { SecretSchemaEntry } from "../../../shared/types";

interface Props {
  /** Extension name for API calls. */
  extensionName: string;
  /** Secrets schema declared by the extension. */
  schema: SecretSchemaEntry[];
}

let { extensionName, schema }: Props = $props();

/** Secret status from the backend (set/unset per key). */
interface SecretStatus {
  key: string;
  description: string;
  required: boolean;
  status: "set" | "unset";
}

/** Loading state for initial fetch. */
let loading = $state(true);

/** Error from initial fetch. */
let fetchError = $state<string | null>(null);

/** Status map: key -> "set" | "unset". */
let statusMap = $state<Record<string, "set" | "unset">>({});

/** Keys currently in edit mode. */
let editing = $state<Set<string>>(new Set());

/** Current edited values per key. */
let editedValues = $state<Record<string, string>>({});

/** Per-row error messages. */
let rowErrors = $state<Record<string, string>>({});

/** Whether form is currently submitting. */
let submitting = $state(false);

/** Success toast message. */
let successMsg = $state<string | null>(null);
let successTimer: ReturnType<typeof setTimeout> | null = null;

/** Delete confirmation dialog state. */
let deleteDialogOpen = $state(false);
let deleteTargetKey = $state<string | null>(null);
let deleting = $state(false);

// ---------------------------------------------------------------------------
// Grouping logic
// ---------------------------------------------------------------------------

interface SecretGroup {
  label: string | null;
  entries: SecretSchemaEntry[];
}

/** Grouped secrets: ungrouped first, then named groups in order of first occurrence. */
let groups = $derived.by((): SecretGroup[] => {
  const ungrouped: SecretSchemaEntry[] = [];
  const groupMap = new Map<string, SecretSchemaEntry[]>();
  const groupOrder: string[] = [];

  for (const entry of schema) {
    if (!entry.group) {
      ungrouped.push(entry);
    } else {
      if (!groupMap.has(entry.group)) {
        groupMap.set(entry.group, []);
        groupOrder.push(entry.group);
      }
      groupMap.get(entry.group)!.push(entry);
    }
  }

  const result: SecretGroup[] = [];
  if (ungrouped.length > 0) {
    result.push({ label: null, entries: ungrouped });
  }
  for (const label of groupOrder) {
    result.push({ label, entries: groupMap.get(label)! });
  }
  return result;
});

/** Whether any values have been edited (dirty check). */
let hasChanges = $derived(Object.keys(editedValues).length > 0);

// ---------------------------------------------------------------------------
// Group warnings
// ---------------------------------------------------------------------------

/**
 * Returns true when a group has some required secrets set but others missing.
 * This indicates an "incomplete group" state.
 */
function isGroupIncomplete(entries: SecretSchemaEntry[]): boolean {
  const requiredEntries = entries.filter((e) => e.required);
  if (requiredEntries.length <= 1) return false;

  const setCount = requiredEntries.filter((e) => statusMap[e.key] === "set").length;
  return setCount > 0 && setCount < requiredEntries.length;
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function fetchStatus() {
  loading = true;
  fetchError = null;
  try {
    const res = await authFetch(`/api/extensions/${extensionName}/secrets`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(data.error ?? `HTTP ${res.status}`);
    }
    const data: { schema: SecretSchemaEntry[]; secrets: SecretStatus[] } = await res.json();
    const map: Record<string, "set" | "unset"> = {};
    for (const s of data.secrets) {
      map[s.key] = s.status;
    }
    statusMap = map;
  } catch (err) {
    fetchError = err instanceof Error ? err.message : "Failed to load secrets";
  } finally {
    loading = false;
  }
}

// Fetch on mount
$effect(() => {
  fetchStatus();
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function startEdit(key: string) {
  editing = new Set([...editing, key]);
  // Start with empty value for new input
  editedValues = { ...editedValues, [key]: "" };
}

function cancelEdit(key: string) {
  const next = new Set(editing);
  next.delete(key);
  editing = next;
  const { [key]: _, ...rest } = editedValues;
  editedValues = rest;
  // Clear any row error
  if (rowErrors[key]) {
    const { [key]: __, ...restErrors } = rowErrors;
    rowErrors = restErrors;
  }
}

function updateValue(key: string, value: string) {
  editedValues = { ...editedValues, [key]: value };
  // Clear row error on typing
  if (rowErrors[key]) {
    const { [key]: _, ...rest } = rowErrors;
    rowErrors = rest;
  }
}

async function handleSubmit() {
  if (!hasChanges || submitting) return;

  // Client-side validation: no empty values
  const newErrors: Record<string, string> = {};
  for (const [key, value] of Object.entries(editedValues)) {
    if (value.trim().length === 0) {
      newErrors[key] = "Value cannot be empty";
    }
  }
  if (Object.keys(newErrors).length > 0) {
    rowErrors = newErrors;
    return;
  }

  submitting = true;
  rowErrors = {};
  successMsg = null;

  try {
    const res = await authFetch(`/api/extensions/${extensionName}/secrets`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secrets: editedValues }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      const errorMsg = data.error ?? `HTTP ${res.status}`;
      // Try to match error to a specific key
      const keyMatch = errorMsg.match(/key:\s*(\S+)/i);
      if (keyMatch?.[1] && editedValues[keyMatch[1]] !== undefined) {
        rowErrors = { [keyMatch[1]]: errorMsg };
      } else {
        // Show error on first edited key
        const firstKey = Object.keys(editedValues)[0];
        if (firstKey) rowErrors = { [firstKey]: errorMsg };
      }
      return;
    }

    // Success: update status, clear edit state
    for (const key of Object.keys(editedValues)) {
      statusMap[key] = "set";
    }
    statusMap = { ...statusMap };
    editing = new Set();
    editedValues = {};

    showSuccess("Secrets saved");
  } catch (err) {
    const firstKey = Object.keys(editedValues)[0];
    if (firstKey) {
      rowErrors = { [firstKey]: err instanceof Error ? err.message : "Failed to save" };
    }
  } finally {
    submitting = false;
  }
}

function confirmDelete(key: string) {
  deleteTargetKey = key;
  deleteDialogOpen = true;
}

async function executeDelete() {
  if (!deleteTargetKey) return;
  const key = deleteTargetKey;
  deleting = true;

  try {
    const res = await authFetch(`/api/extensions/${extensionName}/secrets/${key}`, {
      method: "DELETE",
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      rowErrors = { [key]: data.error ?? `HTTP ${res.status}` };
      return;
    }

    // Update status
    statusMap = { ...statusMap, [key]: "unset" };
    // Remove from edit state if present
    cancelEdit(key);
    showSuccess(`Secret "${key}" deleted`);
  } catch (err) {
    rowErrors = { [key]: err instanceof Error ? err.message : "Failed to delete" };
  } finally {
    deleting = false;
    deleteDialogOpen = false;
    deleteTargetKey = null;
  }
}

function showSuccess(msg: string) {
  successMsg = msg;
  if (successTimer) clearTimeout(successTimer);
  successTimer = setTimeout(() => (successMsg = null), 3000);
}
</script>

{#if loading}
  <LoadingIndicator message="Loading secrets..." />
{:else if fetchError}
  <p class="text-sm text-destructive">{fetchError}</p>
{:else}
  <form class="space-y-4" onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
    {#each groups as group (group.label ?? "__ungrouped")}
      {#if group.label}
        <div class="flex items-center gap-2 pt-2">
          <h4 class="text-sm font-semibold text-foreground">{group.label}</h4>
          {#if isGroupIncomplete(group.entries)}
            <Badge variant="warning" class="text-xs gap-1">
              <WarningIcon class="w-3 h-3" aria-hidden="true" />
              Incomplete
            </Badge>
          {/if}
        </div>
      {/if}

      <div class="space-y-2">
        {#each group.entries as entry (entry.key)}
          {@const isSet = statusMap[entry.key] === "set"}
          {@const isEditing = editing.has(entry.key)}
          {@const isMissingRequired = entry.required && !isSet}

          <div class="rounded-md border border-border px-3 py-2 space-y-1.5">
            <!-- Header row: key name, badges, status -->
            <div class="flex items-center gap-2">
              <!-- Status indicator -->
              {#if isSet}
                <CheckCircleIcon
                  class="w-4 h-4 text-green-600 dark:text-green-400 shrink-0"
                  aria-label="Secret is set"
                />
              {:else}
                <CircleIcon class="w-4 h-4 text-muted-foreground shrink-0" aria-label="Secret is not set" />
              {/if}

              <!-- Key name -->
              <span class="text-sm font-medium">{entry.key}</span>

              <!-- Required/optional badge -->
              {#if entry.required}
                <Badge variant="outline" class="text-xs font-normal">Required</Badge>
              {:else}
                <Badge variant="secondary" class="text-xs font-normal">Optional</Badge>
              {/if}

              <!-- Amber warning for missing required -->
              {#if isMissingRequired}
                <WarningIcon class="w-4 h-4 text-amber-500 shrink-0" aria-label="Required secret is missing" />
              {/if}

              <!-- Action buttons (right side) -->
              <div class="ml-auto flex items-center gap-1">
                {#if !isEditing}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    class="h-7 w-7"
                    aria-label="Edit {entry.key}"
                    title="Edit"
                    onclick={() => startEdit(entry.key)}
                  >
                    <PencilSimpleIcon class="w-4 h-4" aria-hidden="true" />
                  </Button>
                {/if}
                {#if isSet}
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
                {/if}
              </div>
            </div>

            <!-- Description -->
            {#if entry.description}
              <p class="text-xs text-muted-foreground">{entry.description}</p>
            {/if}

            <!-- Value display / edit -->
            {#if isEditing}
              <div class="flex items-center gap-2">
                <input
                  type="password"
                  maxlength={4096}
                  class="block w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  placeholder="Enter secret value"
                  value={editedValues[entry.key] ?? ""}
                  oninput={(e) => updateValue(entry.key, e.currentTarget.value)}
                >
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  class="shrink-0 text-xs"
                  onclick={() => cancelEdit(entry.key)}
                >
                  Cancel
                </Button>
              </div>
            {:else if isSet}
              <input
                type="password"
                class="block w-full rounded-md border border-border bg-muted/30 px-3 py-1.5 text-sm text-muted-foreground"
                value="********"
                readonly
                tabindex={-1}
              >
            {/if}

            <!-- Row error -->
            {#if rowErrors[entry.key]}
              <p class="text-xs text-destructive">{rowErrors[entry.key]}</p>
            {/if}
          </div>
        {/each}
      </div>
    {/each}

    <!-- Success toast -->
    {#if successMsg}
      <div class="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
        <CheckCircleIcon class="w-4 h-4 shrink-0" aria-hidden="true" />
        <span>{successMsg}</span>
      </div>
    {/if}

    <!-- Submit button -->
    {#if hasChanges}
      <div class="flex items-center gap-2 pt-2">
        <Button type="submit" disabled={submitting} size="sm" class="gap-1.5">
          <FloppyDiskIcon class="w-4 h-4" aria-hidden="true" />
          {submitting ? "Saving..." : "Save Secrets"}
        </Button>
      </div>
    {/if}
  </form>
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
