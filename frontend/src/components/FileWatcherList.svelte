<script lang="ts">
import PencilSimpleIcon from "phosphor-svelte/lib/PencilSimpleIcon";
import PlusIcon from "phosphor-svelte/lib/PlusIcon";
import TrashIcon from "phosphor-svelte/lib/TrashIcon";
import { fileWatcherCount } from "$lib/appStore";
import { authFetch } from "$lib/auth";
import LoadingIndicator from "$lib/components/LoadingIndicator.svelte";
import ToggleSwitch from "$lib/components/ToggleSwitch.svelte";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { Card, CardContent, CardHeader } from "$lib/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "$lib/components/ui/table";
import MultiSelect from "./MultiSelect.svelte";

const ALL_EVENT_TYPES = ["new", "change", "delete"];

interface FileWatcher {
  slug: string;
  name: string;
  path: string;
  patterns: string[];
  events: string[];
  recursive: boolean;
  processExisting: boolean;
  enabled: boolean;
  createdAt: number;
}

let watchers = $state<FileWatcher[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);
let errorDetail = $state<string | null>(null);

let formMode = $state<"create" | "edit" | null>(null);
let editingSlug = $state<string | null>(null);

let formSlug = $state("");
let formName = $state("");
let formPath = $state("");
let formPatterns = $state("");
let formEvents = $state<string[]>(["new"]);
let formRecursive = $state(false);
let formProcessExisting = $state(false);
let formEnabled = $state(true);
let formError = $state<string | null>(null);
let submitting = $state(false);

let confirmingDelete = $state<string | null>(null);

async function fetchWatchers() {
  loading = true;
  error = null;
  errorDetail = null;
  try {
    const res = await authFetch("/ext/filewatcher");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    watchers = await res.json();
    fileWatcherCount.set(watchers.length);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    errorDetail = msg || "Unknown error";
    if (msg.includes("Failed to fetch") || msg.includes("502") || msg.includes("503") || msg.includes("NetworkError")) {
      error = "Unable to reach the server. Please check that the backend is running.";
    } else {
      error = "Failed to load file watchers. Please try again later.";
    }
  } finally {
    loading = false;
  }
}

async function deleteWatcher(slug: string) {
  try {
    const res = await authFetch(`/ext/filewatcher/${slug}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    watchers = watchers.filter((w) => w.slug !== slug);
    fileWatcherCount.set(watchers.length);
    confirmingDelete = null;
    if (editingSlug === slug) resetForm();
  } catch (err) {
    console.error("Failed to delete file watcher:", err);
  }
}

function openCreateForm() {
  resetForm();
  formMode = "create";
}

function openEditForm(watcher: FileWatcher) {
  formMode = "edit";
  editingSlug = watcher.slug;
  formSlug = watcher.slug;
  formName = watcher.name;
  formPath = watcher.path;
  formPatterns = watcher.patterns.join(", ");
  formEvents = watcher.events?.length ? [...watcher.events] : ["new"];
  formRecursive = watcher.recursive;
  formProcessExisting = watcher.processExisting;
  formEnabled = watcher.enabled;
  formError = null;
}

function parsePatterns(raw: string): string[] {
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

async function submitForm() {
  formError = null;

  const patterns = parsePatterns(formPatterns);

  if (formMode === "create") {
    if (!formSlug || !formName || !formPath || patterns.length === 0) {
      formError = "Slug, Name, Path, and at least one Pattern are required.";
      return;
    }
  } else {
    if (!formName || !formPath || patterns.length === 0) {
      formError = "Name, Path, and at least one Pattern are required.";
      return;
    }
  }

  if (formEvents.length === 0) {
    formError = "At least one event type must be selected.";
    return;
  }

  submitting = true;
  try {
    if (formMode === "create") {
      const res = await authFetch("/ext/filewatcher", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: formSlug,
          name: formName,
          path: formPath,
          patterns,
          events: formEvents,
          recursive: formRecursive,
          processExisting: formProcessExisting,
          enabled: formEnabled,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        formError = body.error || `HTTP ${res.status}`;
        return;
      }
    } else {
      const res = await authFetch(`/ext/filewatcher/${editingSlug}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formName,
          path: formPath,
          patterns,
          events: formEvents,
          recursive: formRecursive,
          processExisting: formProcessExisting,
          enabled: formEnabled,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        formError = body.error || `HTTP ${res.status}`;
        return;
      }
    }
    await fetchWatchers();
    resetForm();
  } catch (err) {
    formError = err instanceof Error ? err.message : "Request failed";
  } finally {
    submitting = false;
  }
}

function resetForm() {
  formMode = null;
  editingSlug = null;
  formSlug = "";
  formName = "";
  formPath = "";
  formPatterns = "";
  formEvents = ["new"];
  formRecursive = false;
  formProcessExisting = false;
  formEnabled = true;
  formError = null;
}

async function toggleEnabled(watcher: FileWatcher) {
  const newEnabled = !watcher.enabled;
  try {
    const res = await authFetch(`/ext/filewatcher/${watcher.slug}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: newEnabled }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    watchers = watchers.map((w) => (w.slug === watcher.slug ? { ...w, enabled: newEnabled } : w));
  } catch (err) {
    console.error("Failed to toggle file watcher:", err);
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && formMode) resetForm();
  if ((event.key === "s" || event.key === "Enter") && (event.ctrlKey || event.metaKey) && formMode) {
    event.preventDefault();
    submitForm();
  }
}

$effect(() => {
  fetchWatchers();
});
</script>

{#snippet watcherForm()}
  <Card class="bg-accent">
    <CardHeader class="pb-2">
      <span class="text-sm font-medium">
        {formMode === "create" ? "Create File Watcher" : `Edit: ${editingSlug}`}
      </span>
    </CardHeader>
    <CardContent class="space-y-3">
      {#if formMode === "create"}
        <div class="space-y-1">
          <label for="fw-slug" class="text-xs font-medium text-muted-foreground">Slug</label>
          <input
            id="fw-slug"
            type="text"
            bind:value={formSlug}
            placeholder="inbox-ocr"
            pattern="^[a-z0-9][a-z0-9\-]*$"
            class="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          >
        </div>
      {/if}

      <div class="grid grid-cols-2 gap-3">
        <div class="space-y-1">
          <label for="fw-name" class="text-xs font-medium text-muted-foreground">Name</label>
          <input
            id="fw-name"
            type="text"
            bind:value={formName}
            placeholder="OCR Inbox Watcher"
            class="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          >
        </div>
        <div class="space-y-1">
          <label for="fw-path" class="text-xs font-medium text-muted-foreground">Path (relative to work dir)</label>
          <input
            id="fw-path"
            type="text"
            bind:value={formPath}
            placeholder="inbox"
            class="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          >
        </div>
      </div>

      <div class="space-y-1">
        <label for="fw-patterns" class="text-xs font-medium text-muted-foreground">
          File Patterns (comma-separated globs)
        </label>
        <input
          id="fw-patterns"
          type="text"
          bind:value={formPatterns}
          placeholder="*.png, *.jpg, *.pdf"
          class="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
        >
      </div>

      <div class="space-y-1">
        <label for="fw-event-types" class="text-xs font-medium text-muted-foreground">Event Types</label>
        <MultiSelect
          id="fw-event-types"
          items={ALL_EVENT_TYPES}
          bind:selected={formEvents}
          placeholder="Select events..."
        />
      </div>

      <div class="grid grid-cols-3 gap-3">
        <div class="space-y-1">
          <label for="fw-recursive" class="text-xs font-medium text-muted-foreground">Recursive</label>
          <select
            id="fw-recursive"
            bind:value={formRecursive}
            class="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          >
            <option value={false}>No</option>
            <option value={true}>Yes</option>
          </select>
        </div>
        <div class="space-y-1">
          <label for="fw-existing" class="text-xs font-medium text-muted-foreground">Process Existing</label>
          <select
            id="fw-existing"
            bind:value={formProcessExisting}
            class="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          >
            <option value={false}>No</option>
            <option value={true}>Yes</option>
          </select>
        </div>
        <div class="space-y-1">
          <label for="fw-enabled" class="text-xs font-medium text-muted-foreground">Enabled</label>
          <select
            id="fw-enabled"
            bind:value={formEnabled}
            class="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          >
            <option value={true}>Yes</option>
            <option value={false}>No</option>
          </select>
        </div>
      </div>

      {#if formError}
        <p class="text-sm font-bold text-destructive">{formError}</p>
      {/if}
      <div class="h-px w-full bg-current opacity-15">&nbsp;</div>
      <div class="flex gap-2">
        <Button size="sm" disabled={submitting} onclick={submitForm}>
          {submitting ? "Saving..." : formMode === "create" ? "Create" : "Save"}
        </Button>
        <Button size="sm" variant="outline" onclick={resetForm}>Cancel</Button>
      </div>
    </CardContent>
  </Card>
{/snippet}

<svelte:window onkeydown={handleKeydown} />

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <Button size="sm" onclick={() => (formMode ? resetForm() : openCreateForm())}>
      {#if !formMode}
        <PlusIcon size={14} class="mr-1.5" aria-hidden="true" />
      {/if}
      {formMode ? "Cancel" : "New File Watcher"}
    </Button>
  </div>

  {#if formMode === "create"}
    {@render watcherForm()}
  {/if}

  {#if loading}
    <LoadingIndicator />
  {:else if error}
    <div class="error-card">
      <p class="error-card-message">{error}</p>
      {#if errorDetail}
        <p class="error-card-detail">{errorDetail}</p>
      {/if}
    </div>
  {:else if watchers.length === 0 && !formMode}
    <p class="text-sm text-muted-foreground">No file watchers configured. Create one to get started.</p>
  {:else}
    {#if editingSlug}
      {@render watcherForm()}
    {/if}

    <!-- Mobile & Tablet: Card layout -->
    <div class="responsive-cards">
      {#each watchers as watcher (watcher.slug)}
        <div class="rounded-md border border-border p-4 space-y-3 {editingSlug === watcher.slug ? "bg-accent" : ""}">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0 flex-1">
              <span class="font-medium block">{watcher.name}</span>
              <p class="text-xs text-muted-foreground mt-0.5 font-mono truncate">{watcher.slug}</p>
            </div>
            <ToggleSwitch
              checked={watcher.enabled}
              onChange={() => toggleEnabled(watcher)}
              aria-label={watcher.enabled ? "Disable watcher" : "Enable watcher"}
            />
          </div>

          <div class="text-sm space-y-1">
            <div class="flex items-center gap-2">
              Path:<span class="font-mono text-xs text-muted-foreground">{watcher.path}</span>
              {#if watcher.recursive}
                <Badge variant="outline">recursive</Badge>
              {/if}
            </div>
            <span class=""> Patterns: </span>
            {#each watcher.patterns as pattern}
              <Badge variant="secondary" class="font-mono font-normal ml-2">{pattern}</Badge>
            {/each}
            <div class="flex items-center gap-1 mt-1">
              <span>Events:</span>
              {#each watcher.events ?? ["new"] as event}
                <Badge variant="outline" class="ml-1">{event}</Badge>
              {/each}
            </div>
          </div>

          <hr>

          {#if confirmingDelete === watcher.slug}
            <div class="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="destructive" onclick={() => deleteWatcher(watcher.slug)}>Confirm</Button>
              <Button size="sm" variant="outline" onclick={() => { confirmingDelete = null; }}>Cancel</Button>
            </div>
          {:else}
            <div class="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onclick={() => openEditForm(watcher)}>
                <PencilSimpleIcon size={14} class="mr-1.5" aria-hidden="true" />
                Edit
              </Button>
              <Button size="sm" variant="destructive" onclick={() => { confirmingDelete = watcher.slug; }}>
                <TrashIcon size={14} class="mr-1.5" aria-hidden="true" />
                Delete
              </Button>
            </div>
          {/if}
        </div>
      {/each}
    </div>

    <!-- Desktop: Table layout -->
    <div class="responsive-table rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Path</TableHead>
            <TableHead>Patterns</TableHead>
            <TableHead>Events</TableHead>
            <TableHead class="text-center">Enabled</TableHead>
            <TableHead class="text-center">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each watchers as watcher (watcher.slug)}
            <TableRow class={editingSlug === watcher.slug ? "bg-accent" : ""}>
              <TableCell>
                <span class="font-medium">{watcher.name}</span>
                <p class="text-xs text-muted-foreground mt-0.5 font-mono">{watcher.slug}</p>
              </TableCell>
              <TableCell class="font-mono text-sm">
                {watcher.path}
                {#if watcher.recursive}
                  <Badge variant="outline" class="ml-2">recursive</Badge>
                {/if}
              </TableCell>
              <TableCell>
                <div class="flex flex-wrap gap-1">
                  {#each watcher.patterns as pattern}
                    <Badge variant="secondary" class="font-mono text-xs">{pattern}</Badge>
                  {/each}
                </div>
              </TableCell>
              <TableCell>
                <div class="flex flex-wrap gap-1">
                  {#each watcher.events ?? ["new"] as event}
                    <Badge variant="outline" class="text-xs">{event}</Badge>
                  {/each}
                </div>
              </TableCell>
              <TableCell class="text-center">
                <ToggleSwitch
                  checked={watcher.enabled}
                  onChange={() => toggleEnabled(watcher)}
                  aria-label={watcher.enabled ? "Disable watcher" : "Enable watcher"}
                />
              </TableCell>
              <TableCell class="text-right w-1">
                {#if confirmingDelete === watcher.slug}
                  <div class="inline-flex justify-end gap-2 flex-wrap xl:flex-nowrap">
                    <Button size="sm" variant="destructive" onclick={() => deleteWatcher(watcher.slug)}>
                      Confirm
                    </Button>
                    <Button size="sm" variant="outline" onclick={() => { confirmingDelete = null; }}> Cancel </Button>
                  </div>
                {:else}
                  <div class="inline-flex justify-end gap-2 flex-wrap xl:flex-nowrap">
                    <Button size="sm" variant="outline" onclick={() => openEditForm(watcher)}>
                      <PencilSimpleIcon size={14} class="mr-1.5" aria-hidden="true" />
                      Edit
                    </Button>
                    <Button size="sm" variant="destructive" onclick={() => { confirmingDelete = watcher.slug; }}>
                      <TrashIcon size={14} class="mr-1.5" aria-hidden="true" />
                      Delete
                    </Button>
                  </div>
                {/if}
              </TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>
    </div>
  {/if}
</div>

<style>
input::placeholder {
  font-style: italic;
}
</style>
