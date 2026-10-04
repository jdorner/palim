<script lang="ts">
import ArrowsClockwiseIcon from "phosphor-svelte/lib/ArrowsClockwiseIcon";
import ClipboardTextIcon from "phosphor-svelte/lib/ClipboardTextIcon";
import PencilSimpleIcon from "phosphor-svelte/lib/PencilSimpleIcon";
import PlusIcon from "phosphor-svelte/lib/PlusIcon";
import TrashIcon from "phosphor-svelte/lib/TrashIcon";
import { authFetch } from "$lib/auth";
import LoadingIndicator from "$lib/components/LoadingIndicator.svelte";
import NotificationBanner from "$lib/components/NotificationBanner.svelte";
import ToggleSwitch from "$lib/components/ToggleSwitch.svelte";
import { AlertDialog } from "$lib/components/ui/alert-dialog";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { Card, CardContent, CardHeader } from "$lib/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "$lib/components/ui/table";
import { formatTimestamp } from "$lib/utils";

interface McpServer {
  name: string;
  type: string;
  enabled: boolean;
  toolsHash: string | null;
  lastSyncedAt: number | null;
  lastError: string | null;
}

let servers = $state<McpServer[]>([]);
let sortedServers = $derived([...servers].sort((a, b) => a.name.localeCompare(b.name)));
let loading = $state(true);
let error = $state<string | null>(null);
let syncing = $state<string | null>(null);
let notificationMessage = $state<string | null>(null);

type TransportType = "stdio" | "streamable-http" | "sse";

// Create/edit form state
let formMode = $state<"create" | "edit" | null>(null);
let editingName = $state<string | null>(null);
// Original config of the server being edited, so fields the form doesn't expose (env, cwd) survive a save
let editingConfig = $state<Record<string, unknown> | null>(null);
let formName = $state("");
let formType = $state<TransportType>("stdio");
let formCommand = $state("");
let formArgs = $state("");
let formUrl = $state("");
let formHeaders = $state("");
let formError = $state<string | null>(null);
let submitting = $state(false);

// Delete confirmation state
let confirmDeleteName = $state<string | null>(null);

// Import form state
let showImportForm = $state(false);
let importJson = $state("");
let importError = $state<string | null>(null);

async function loadServers() {
  try {
    const resp = await authFetch(`/ext/mcp/servers`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    servers = data.servers;
    error = null;
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load servers";
  } finally {
    loading = false;
  }
}

async function syncServer(name: string) {
  syncing = name;
  notificationMessage = null;
  try {
    const resp = await authFetch(`/ext/mcp/servers/${name}/sync`, { method: "POST" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    notificationMessage = data.changed ? `Skill regenerated for "${name}"` : `No changes detected for "${name}"`;
    await loadServers();
  } catch (err) {
    notificationMessage = `Sync failed: ${err instanceof Error ? err.message : err}`;
  } finally {
    syncing = null;
  }
}

async function deleteServer(name: string) {
  try {
    const resp = await authFetch(`/ext/mcp/servers/${name}`, { method: "DELETE" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    if (editingName === name) resetForm();
    await loadServers();
  } catch (err) {
    error = `Delete failed: ${err instanceof Error ? err.message : err}`;
  }
}

async function toggleEnabled(server: McpServer) {
  try {
    const resp = await authFetch(`/ext/mcp/servers/${server.name}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !server.enabled }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    await loadServers();
  } catch (err) {
    error = `Toggle failed: ${err instanceof Error ? err.message : err}`;
  }
}

function openCreateForm() {
  resetForm();
  showImportForm = false;
  formMode = "create";
}

async function openEditForm(server: McpServer) {
  showImportForm = false;
  formError = null;
  try {
    const resp = await authFetch(`/ext/mcp/servers/${server.name}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = (await resp.json()) as { type: TransportType; config: Record<string, unknown> };
    const config = data.config ?? {};
    formMode = "edit";
    editingName = server.name;
    editingConfig = config;
    formName = server.name;
    formType = data.type;
    formCommand = typeof config.command === "string" ? config.command : "";
    formArgs = Array.isArray(config.args) ? config.args.join(", ") : "";
    formUrl = typeof config.url === "string" ? config.url : "";
    formHeaders =
      config.headers && typeof config.headers === "object"
        ? Object.entries(config.headers as Record<string, string>)
            .map(([key, value]) => `${key}: ${value}`)
            .join("\n")
        : "";
  } catch (err) {
    error = `Failed to load server config: ${err instanceof Error ? err.message : err}`;
  }
}

function buildConfig(): Record<string, unknown> {
  // Keep stdio-only extras (env, cwd) when editing a server that stays stdio
  const preserved =
    formMode === "edit" && formType === "stdio" && editingConfig && "command" in editingConfig
      ? Object.fromEntries(Object.entries(editingConfig).filter(([key]) => key === "env" || key === "cwd"))
      : {};

  if (formType === "stdio") {
    const args = formArgs.trim() ? formArgs.split(",").map((a) => a.trim()) : [];
    return { ...preserved, command: formCommand, args };
  }

  const headers: Record<string, string> = {};
  if (formHeaders.trim()) {
    for (const line of formHeaders.split("\n")) {
      const idx = line.indexOf(":");
      if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return { url: formUrl, headers };
}

async function submitForm() {
  formError = null;
  const config = buildConfig();

  submitting = true;
  try {
    const resp =
      formMode === "create"
        ? await authFetch(`/ext/mcp/servers`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: formName, type: formType, config }),
          })
        : await authFetch(`/ext/mcp/servers/${editingName}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: formType, config }),
          });
    if (!resp.ok) {
      const data = await resp.json();
      formError = data.error || `HTTP ${resp.status}`;
      return;
    }
    resetForm();
    await loadServers();
  } catch (err) {
    formError = err instanceof Error ? err.message : "Request failed";
  } finally {
    submitting = false;
  }
}

function resetForm() {
  formMode = null;
  editingName = null;
  editingConfig = null;
  formName = "";
  formType = "stdio";
  formCommand = "";
  formArgs = "";
  formUrl = "";
  formHeaders = "";
  formError = null;
}

async function importServers() {
  importError = null;
  notificationMessage = null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(importJson);
  } catch {
    importError = "Invalid JSON. Paste a valid MCP server configuration.";
    return;
  }

  try {
    const resp = await authFetch(`/ext/mcp/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed),
    });
    if (!resp.ok) {
      const data = await resp.json();
      importError = data.error || `HTTP ${resp.status}`;
      return;
    }
    const data = await resp.json();
    const results = data.results as Array<{ name: string; status: string; reason?: string }>;
    const created = results.filter((r) => r.status === "created");
    const skipped = results.filter((r) => r.status === "skipped");
    const errors = results.filter((r) => r.status === "error");

    const parts: string[] = [];
    if (created.length) parts.push(`${created.length} added`);
    if (skipped.length) parts.push(`${skipped.length} skipped (already exist)`);
    if (errors.length) {
      const reasons = errors.map((r) => `${r.name}: ${r.reason ?? "unknown error"}`);
      parts.push(`${errors.length} failed: ${reasons.join("; ")}`);
    }
    notificationMessage = parts.join(", ");

    if (created.length > 0) {
      showImportForm = false;
      importJson = "";
      await loadServers();
    }
  } catch (err) {
    importError = err instanceof Error ? err.message : "Import failed";
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    if (formMode) {
      resetForm();
    } else if (showImportForm) {
      showImportForm = false;
      importError = null;
    }
  }
  if ((event.key === "s" || event.key === "Enter") && (event.ctrlKey || event.metaKey)) {
    if (formMode) {
      event.preventDefault();
      submitForm();
    } else if (showImportForm) {
      event.preventDefault();
      importServers();
    }
  }
}

$effect(() => {
  loadServers();
});
</script>

{#snippet serverForm()}
  <Card class="bg-accent">
    <CardHeader class="pb-2">
      <span class="text-sm font-medium">
        {formMode === "create" ? "Add MCP Server" : `Edit: ${editingName}`}
      </span>
    </CardHeader>
    <CardContent class="space-y-3">
      <div class="grid grid-cols-2 gap-3">
        <div class="space-y-1">
          <label for="mcp-name" class="text-xs font-medium text-muted-foreground">Name</label>
          <input
            id="mcp-name"
            type="text"
            bind:value={formName}
            placeholder="my-server"
            disabled={formMode === "edit"}
            class="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm disabled:opacity-60"
          >
        </div>
        <div class="space-y-1">
          <label for="mcp-type" class="text-xs font-medium text-muted-foreground">Type</label>
          <select
            id="mcp-type"
            bind:value={formType}
            class="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          >
            <option value="stdio">stdio</option>
            <option value="streamable-http">streamable-http</option>
            <option value="sse">sse</option>
          </select>
        </div>
      </div>

      {#if formType === "stdio"}
        <div class="space-y-1">
          <label for="mcp-command" class="text-xs font-medium text-muted-foreground">Command</label>
          <input
            id="mcp-command"
            type="text"
            bind:value={formCommand}
            placeholder="/usr/local/bin/mcp-server-postgres"
            class="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          >
        </div>
        <div class="space-y-1">
          <label for="mcp-args" class="text-xs font-medium text-muted-foreground">Arguments (comma-separated)</label>
          <input
            id="mcp-args"
            type="text"
            bind:value={formArgs}
            placeholder="--connection-string=postgres://..."
            class="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          >
        </div>
      {:else}
        <div class="space-y-1">
          <label for="mcp-url" class="text-xs font-medium text-muted-foreground">URL</label>
          <input
            id="mcp-url"
            type="text"
            bind:value={formUrl}
            placeholder="https://api.example.com/mcp"
            class="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          >
        </div>
        <div class="space-y-1">
          <label for="mcp-headers" class="text-xs font-medium text-muted-foreground"
            >Headers (one per line, Key: Value)</label
          >
          <textarea
            id="mcp-headers"
            bind:value={formHeaders}
            placeholder="Authorization: Bearer token"
            rows="2"
            class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          ></textarea>
        </div>
      {/if}

      {#if formError}
        <p class="text-sm font-bold text-destructive">{formError}</p>
      {/if}
      <hr>
      <div class="flex gap-2">
        <Button size="sm" disabled={submitting} onclick={submitForm}>
          {submitting ? "Saving..." : formMode === "create" ? "Add" : "Save"}
        </Button>
        <Button size="sm" variant="outline" onclick={resetForm}>Cancel</Button>
      </div>
    </CardContent>
  </Card>
{/snippet}

<svelte:window onkeydown={handleKeydown} />

<div class="space-y-4">
  <div class="flex items-center gap-2">
    <Button size="sm" onclick={() => (formMode ? resetForm() : openCreateForm())}>
      {#if !formMode}
        <PlusIcon size={14} class="mr-1.5" aria-hidden="true" />
      {/if}
      {formMode ? "Cancel" : "Add Server"}
    </Button>
    <Button
      size="sm"
      onclick={() => {
        showImportForm = !showImportForm;
        resetForm();
      }}
    >
      <ClipboardTextIcon size={14} class="mr-1.5" aria-hidden="true" />
      Import
    </Button>
  </div>

  <NotificationBanner message={notificationMessage} />

  {#if error}
    <div class="error-card">
      <p class="error-card-message">{error}</p>
    </div>
  {/if}

  {#if showImportForm}
    <Card class="bg-accent">
      <CardHeader class="pb-2">
        <span class="text-sm font-medium">Import MCP Configuration</span>
      </CardHeader>
      <CardContent class="space-y-3">
        <p class="text-xs text-muted-foreground">
          Paste JSON config from Claude Desktop, Cursor, or VS Code MCP settings.
        </p>
        <textarea
          bind:value={importJson}
          placeholder={'{\n  "mcpServers": {\n    "server-name": {\n      "command": "npx",\n      "args": ["-y", "@some/mcp-server"]\n    }\n  }\n}'}
          rows="8"
          class="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
        ></textarea>

        {#if importError}
          <p class="text-sm font-bold text-destructive">{importError}</p>
        {/if}

        <div class="flex gap-2">
          <Button size="sm" onclick={importServers}>Import</Button>
          <Button
            size="sm"
            variant="outline"
            onclick={() => {
              showImportForm = false;
              importError = null;
              notificationMessage = null;
            }}
            >Cancel</Button
          >
        </div>
      </CardContent>
    </Card>
  {/if}

  {#if formMode === "create"}
    {@render serverForm()}
  {/if}

  {#if loading}
    <LoadingIndicator />
  {:else if servers.length === 0 && !formMode && !showImportForm}
    <p class="text-sm text-muted-foreground">
      No MCP servers configured. Add one or import a configuration to get started.
    </p>
  {:else}
    {#if editingName}
      {@render serverForm()}
    {/if}

    <!-- Mobile & Tablet: Card layout -->
    <div class="responsive-cards">
      {#each sortedServers as server (server.name)}
        <div class="rounded-md border border-border p-4 space-y-3 {editingName === server.name ? "bg-accent" : ""}">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0 flex-1">
              <span class="font-medium block">{server.name}</span>
              {#if server.lastError}
                <p class="text-xs text-destructive mt-0.5 line-clamp-2">{server.lastError}</p>
              {/if}
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <Badge variant="outline">{server.type}</Badge>
              <ToggleSwitch
                checked={server.enabled}
                onChange={() => toggleEnabled(server)}
                aria-label={server.enabled ? "Disable server" : "Enable server"}
              />
            </div>
          </div>

          <div class="text-sm text-muted-foreground">Last synced: {formatTimestamp(server.lastSyncedAt)}</div>

          <hr>

          <div class="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={syncing === server.name}
              onclick={() => syncServer(server.name)}
            >
              <ArrowsClockwiseIcon
                size={14}
                class="mr-1.5 {syncing === server.name ? "animate-spin" : ""}"
                aria-hidden="true"
              />
              Sync
            </Button>
            <Button size="sm" variant="outline" onclick={() => openEditForm(server)}>
              <PencilSimpleIcon size={14} class="mr-1.5" aria-hidden="true" />
              Edit
            </Button>
            <Button size="sm" variant="destructive" onclick={() => (confirmDeleteName = server.name)}>
              <TrashIcon size={14} class="mr-1.5" aria-hidden="true" />
              Delete
            </Button>
          </div>
        </div>
      {/each}
    </div>

    <!-- Desktop: Table layout -->
    <div class="responsive-table rounded-md border border-border">
      <Table>
        <TableHeader class="bg-muted/30">
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Last Synced</TableHead>
            <TableHead class="text-center">Enabled</TableHead>
            <TableHead class="text-center">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each sortedServers as server (server.name)}
            <TableRow class={editingName === server.name ? "bg-accent" : ""}>
              <TableCell>
                <span class="font-medium">{server.name}</span>
                {#if server.lastError}
                  <p class="text-xs text-destructive mt-0.5">{server.lastError}</p>
                {/if}
              </TableCell>
              <TableCell>
                <Badge variant="outline">{server.type}</Badge>
              </TableCell>
              <TableCell class="text-sm text-muted-foreground">
                {formatTimestamp(server.lastSyncedAt)}
              </TableCell>
              <TableCell class="text-center">
                <ToggleSwitch
                  checked={server.enabled}
                  onChange={() => toggleEnabled(server)}
                  aria-label={server.enabled ? "Disable server" : "Enable server"}
                />
              </TableCell>
              <TableCell class="text-right w-1">
                <div class="inline-flex justify-end gap-2 flex-wrap xl:flex-nowrap">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={syncing === server.name}
                    onclick={() => syncServer(server.name)}
                  >
                    <ArrowsClockwiseIcon
                      size={14}
                      class="mr-1.5 {syncing === server.name ? "animate-spin" : ""}"
                      aria-hidden="true"
                    />
                    Sync
                  </Button>
                  <Button size="sm" variant="outline" onclick={() => openEditForm(server)}>
                    <PencilSimpleIcon size={14} class="mr-1.5" aria-hidden="true" />
                    Edit
                  </Button>
                  <Button size="sm" variant="destructive" onclick={() => (confirmDeleteName = server.name)}>
                    <TrashIcon size={14} class="mr-1.5" aria-hidden="true" />
                    Delete
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>
    </div>
  {/if}

  <AlertDialog
    open={confirmDeleteName !== null}
    title="Delete MCP server"
    description={`Are you sure you want to delete "${confirmDeleteName}"? This will also remove its generated skill.`}
    confirmLabel="Delete"
    cancelLabel="Cancel"
    confirmVariant="destructive"
    onConfirm={() => {
      if (confirmDeleteName) deleteServer(confirmDeleteName);
      confirmDeleteName = null;
    }}
    onCancel={() => {
      confirmDeleteName = null;
    }}
  />
</div>
