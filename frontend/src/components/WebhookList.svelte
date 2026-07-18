<script lang="ts">
import CheckIcon from "phosphor-svelte/lib/CheckIcon";
import CopyIcon from "phosphor-svelte/lib/CopyIcon";
import CopySimpleIcon from "phosphor-svelte/lib/CopySimpleIcon";
import PencilSimpleIcon from "phosphor-svelte/lib/PencilSimpleIcon";
import PlusIcon from "phosphor-svelte/lib/PlusIcon";
import TrashIcon from "phosphor-svelte/lib/TrashIcon";
import WarningIcon from "phosphor-svelte/lib/WarningIcon";
import { webhookCount } from "$lib/appStore";
import { authFetch } from "$lib/auth";
import LoadingIndicator from "$lib/components/LoadingIndicator.svelte";
import ToggleSwitch from "$lib/components/ToggleSwitch.svelte";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { Card, CardContent, CardHeader } from "$lib/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "$lib/components/ui/table";

interface Webhook {
  slug: string;
  name: string;
  authType: string;
  headerName: string;
  enabled: boolean;
  createdAt: number;
}

let webhooks = $state<Webhook[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);
let errorDetail = $state<string | null>(null);
let copiedSlug = $state<string | null>(null);

let formMode = $state<"create" | "edit" | null>(null);
let editingSlug = $state<string | null>(null);

let formSlug = $state("");
let formName = $state("");
let formAuthType = $state<"hmac-sha256" | "bearer" | "none">("hmac-sha256");
let formSecret = $state("");
let formEnabled = $state(true);
let formError = $state<string | null>(null);
let submitting = $state(false);

let confirmingDelete = $state<string | null>(null);

const NO_AUTH_WARNING = "No authentication - webhook is only available in development mode!";

async function fetchWebhooks() {
  loading = true;
  error = null;
  errorDetail = null;
  try {
    const res = await authFetch("/ext/webhooks");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    webhooks = await res.json();
    webhookCount.set(webhooks.length);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    errorDetail = msg || "Unknown error";
    if (msg.includes("Failed to fetch") || msg.includes("502") || msg.includes("503") || msg.includes("NetworkError")) {
      error = "Unable to reach the server. Please check that the backend is running.";
    } else {
      error = "Failed to load webhooks. Please try again later.";
    }
  } finally {
    loading = false;
  }
}

async function deleteWebhook(slug: string) {
  try {
    const res = await authFetch(`/ext/webhooks/${slug}`, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    webhooks = webhooks.filter((w) => w.slug !== slug);
    webhookCount.set(webhooks.length);
    confirmingDelete = null;
    if (editingSlug === slug) resetForm();
  } catch (err) {
    console.error("Failed to delete webhook:", err);
  }
}

function openCreateForm() {
  resetForm();
  formMode = "create";
}

function openEditForm(webhook: Webhook) {
  formMode = "edit";
  editingSlug = webhook.slug;
  formSlug = webhook.slug;
  formName = webhook.name;
  formAuthType = webhook.authType as "hmac-sha256" | "bearer" | "none";
  formSecret = "";
  formEnabled = webhook.enabled;
  formError = null;
}

function duplicateWebhook(webhook: Webhook) {
  resetForm();
  formMode = "create";
  formSlug = `${webhook.slug}-copy`;
  formName = `${webhook.name} (copy)`;
  formAuthType = webhook.authType as "hmac-sha256" | "bearer" | "none";
}

async function submitForm() {
  formError = null;

  if (formMode === "create") {
    if (!formSlug || !formName) {
      formError = "Slug and Name are required.";
      return;
    }
    if (formAuthType !== "none") {
      if (!formSecret) {
        formError = "Secret is required for HMAC-SHA256 and Bearer auth.";
        return;
      }
      if (formSecret.length < 8) {
        formError = "Secret must be at least 8 characters.";
        return;
      }
    }
  } else {
    if (!formName) {
      formError = "Name is required.";
      return;
    }
    if (formAuthType !== "none" && formSecret && formSecret.length < 8) {
      formError = "Secret must be at least 8 characters (or leave blank to keep current).";
      return;
    }
  }

  submitting = true;
  try {
    if (formMode === "create") {
      const res = await authFetch("/ext/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: formSlug,
          name: formName,
          authType: formAuthType,
          secret: formAuthType === "none" ? "" : formSecret,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        formError = body.error || `HTTP ${res.status}`;
        return;
      }
    } else {
      const updates: Record<string, unknown> = {
        name: formName,
        authType: formAuthType,
        enabled: formEnabled,
      };
      if (formSecret) updates.secret = formSecret;
      const res = await authFetch(`/ext/webhooks/${editingSlug}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      const body = await res.json();
      if (!res.ok) {
        formError = body.error || `HTTP ${res.status}`;
        return;
      }
    }
    await fetchWebhooks();
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
  formAuthType = "hmac-sha256";
  formSecret = "";
  formEnabled = true;
  formError = null;
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && formMode) resetForm();
  if ((event.key === "s" || event.key === "Enter") && (event.ctrlKey || event.metaKey) && formMode) {
    event.preventDefault();
    submitForm();
  }
}

function copyEndpoint(slug: string) {
  const url = `${window.location.origin}/ext/webhooks/receive/${slug}`;
  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).catch(() => fallbackCopy(url));
    } else {
      fallbackCopy(url);
    }
  } catch {
    fallbackCopy(url);
  }
  copiedSlug = slug;
  setTimeout(() => {
    copiedSlug = null;
  }, 2000);
}

/** Fallback copy for iOS Safari and other browsers without Clipboard API support. */
function fallbackCopy(text: string) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

async function toggleEnabled(webhook: Webhook) {
  const newEnabled = !webhook.enabled;
  try {
    const res = await authFetch(`/ext/webhooks/${webhook.slug}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: newEnabled }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    webhooks = webhooks.map((w) => (w.slug === webhook.slug ? { ...w, enabled: newEnabled } : w));
  } catch (err) {
    console.error("Failed to toggle webhook:", err);
  }
}

$effect(() => {
  fetchWebhooks();
});
</script>

{#snippet webhookForm()}
  <Card class="bg-accent">
    <CardHeader class="pb-2">
      <span class="text-sm font-medium">
        {formMode === "create" ? "Create Webhook" : `Edit: ${editingSlug}`}
      </span>
    </CardHeader>
    <CardContent class="space-y-3">
      {#if formMode === "create"}
        <div class="space-y-1">
          <label for="wh-slug" class="text-xs font-medium text-muted-foreground">Slug</label>
          <input
            id="wh-slug"
            type="text"
            bind:value={formSlug}
            placeholder="my-webhook"
            pattern="^[a-z0-9][a-z0-9\-]*$"
            class="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          >
        </div>
      {/if}

      <div class="grid grid-cols-2 gap-3">
        <div class="space-y-1">
          <label for="wh-name" class="text-xs font-medium text-muted-foreground">Name</label>
          <input
            id="wh-name"
            type="text"
            bind:value={formName}
            placeholder="My Webhook"
            class="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          >
        </div>
        <div class="space-y-1">
          <label for="wh-enabled" class="text-xs font-medium text-muted-foreground">Enabled</label>
          <select
            id="wh-enabled"
            bind:value={formEnabled}
            class="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          >
            <option value={true}>Yes</option>
            <option value={false}>No</option>
          </select>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div class="space-y-1">
          <label for="wh-auth" class="text-xs font-medium text-muted-foreground">Auth Type</label>
          <select
            id="wh-auth"
            bind:value={formAuthType}
            class="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          >
            <option value="none">None</option>
            <option value="bearer">Bearer Token</option>
            <option value="hmac-sha256">HMAC-SHA256</option>
          </select>
        </div>
        {#if formAuthType !== "none"}
          <div class="space-y-1">
            <label for="wh-secret" class="text-xs font-medium text-muted-foreground">
              Secret
              {formMode === "edit" ? "(leave blank to keep current)" : ""}
            </label>
            <input
              id="wh-secret"
              type="password"
              bind:value={formSecret}
              placeholder={formMode === "edit"
                ? "unchanged"
                : "min 8 characters"}
              class="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
            >
          </div>
        {:else}
          <div class="space-y-1"></div>
        {/if}
      </div>

      {#if formAuthType === "none"}
        <div
          class="flex items-center gap-2 rounded-md bg-yellow-500/10 px-3 py-1.5 text-yellow-600 dark:text-yellow-400"
        >
          <WarningIcon size={14} class="shrink-0" aria-hidden="true" />
          <span class="text-xs font-medium">{NO_AUTH_WARNING}</span>
        </div>
      {/if}

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
      {formMode ? "Cancel" : "New Webhook"}
    </Button>
  </div>

  {#if formMode === "create"}
    {@render webhookForm()}
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
  {:else if webhooks.length === 0 && !formMode}
    <p class="text-sm text-muted-foreground">No webhooks registered. Create one to get started.</p>
  {:else}
    {#if editingSlug}
      {@render webhookForm()}
    {/if}

    <!-- Mobile & Tablet: Card layout -->
    <div class="responsive-cards">
      {#each webhooks as webhook (webhook.slug)}
        <div class="rounded-md border border-border p-4 space-y-3 {editingSlug === webhook.slug ? "bg-accent" : ""}">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0 flex-1">
              <span class="font-medium block">{webhook.name}</span>
              <p class="text-xs text-muted-foreground mt-0.5 font-mono truncate">{webhook.slug}</p>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              {#if webhook.authType === "none"}
                <Badge
                  title={NO_AUTH_WARNING}
                  variant="outline"
                  class="text-yellow-600 dark:text-yellow-400 border-yellow-500/30"
                  aria-label={NO_AUTH_WARNING}
                  >none</Badge
                >
              {:else}
                <Badge variant="outline">{webhook.authType}</Badge>
              {/if}
              <ToggleSwitch
                checked={webhook.enabled}
                onChange={() => toggleEnabled(webhook)}
                aria-label={webhook.enabled ? "Disable webhook" : "Enable webhook"}
              />
            </div>
          </div>

          <div class="text-sm">
            <span>Endpoint:</span>
            <code
              class="text-xs bg-muted px-2 py-0.5 rounded font-mono truncate"
              title={`/ext/webhooks/receive/${webhook.slug}`}
            >
              /ext/webhooks/receive/{webhook.slug}
            </code>
            <Button
              size="icon"
              variant="ghost"
              onclick={() => copyEndpoint(webhook.slug)}
              class="shrink-0 h-6 w-0 py-2 inline"
            >
              {#if copiedSlug === webhook.slug}
                <CheckIcon size={12} class="text-green-600 dark:text-green-400" aria-hidden="true" />
              {:else}
                <CopyIcon size={12} aria-hidden="true" />
              {/if}
              <span class="sr-only">{copiedSlug === webhook.slug ? "Copied" : "Copy URL"}</span>
            </Button>
          </div>

          <hr>

          {#if confirmingDelete === webhook.slug}
            <div class="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="destructive" onclick={() => deleteWebhook(webhook.slug)}>Confirm</Button>
              <Button size="sm" variant="outline" onclick={() => { confirmingDelete = null; }}>Cancel</Button>
            </div>
          {:else}
            <div class="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onclick={() => duplicateWebhook(webhook)}>
                <CopySimpleIcon size={14} class="mr-1.5" aria-hidden="true" />
                Duplicate
              </Button>
              <Button size="sm" variant="outline" onclick={() => openEditForm(webhook)}>
                <PencilSimpleIcon size={14} class="mr-1.5" aria-hidden="true" />
                Edit
              </Button>
              <Button size="sm" variant="destructive" onclick={() => { confirmingDelete = webhook.slug; }}>
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
            <TableHead>Endpoint</TableHead>
            <TableHead>Auth</TableHead>
            <TableHead class="text-center">Enabled</TableHead>
            <TableHead class="text-center">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each webhooks as webhook (webhook.slug)}
            <TableRow class={editingSlug === webhook.slug ? "bg-accent" : ""}>
              <TableCell>
                <span class="font-medium">{webhook.name}</span>
                <p class="text-xs text-muted-foreground mt-0.5 font-mono">
                  {webhook.slug}
                </p>
              </TableCell>
              <TableCell>
                <div class="gap-1.5">
                  <code
                    class="text-xs bg-muted px-2 py-0.5 rounded font-mono truncate text-wrap"
                    title={`/ext/webhooks/receive/${webhook.slug}`}
                  >
                    /ext/webhooks/receive/{webhook.slug}
                  </code>
                  <Button
                    size="icon"
                    variant="ghost"
                    onclick={() => copyEndpoint(webhook.slug)}
                    class="shrink-0 h-6 w-0 p-0 py-2 inline"
                  >
                    {#if copiedSlug === webhook.slug}
                      <CheckIcon size={12} class="text-green-600 dark:text-green-400" aria-hidden="true" />
                    {:else}
                      <CopyIcon size={12} aria-hidden="true" />
                    {/if}
                    <span class="sr-only">{copiedSlug === webhook.slug ? "Copied" : "Copy URL"}</span>
                  </Button>
                </div>
              </TableCell>
              <TableCell>
                {#if webhook.authType === "none"}
                  <div class="flex items-center gap-1.5">
                    <Badge
                      title={NO_AUTH_WARNING}
                      variant="outline"
                      class="text-yellow-600 dark:text-yellow-400 border-yellow-500/30"
                      aria-label={NO_AUTH_WARNING}
                      >none</Badge
                    >
                    <span title={NO_AUTH_WARNING}>
                      <WarningIcon
                        size={14}
                        class="text-yellow-600 dark:text-yellow-400 shrink-0"
                        aria-label={NO_AUTH_WARNING}
                      />
                    </span>
                  </div>
                {:else}
                  <Badge variant="outline">{webhook.authType}</Badge>
                {/if}
              </TableCell>
              <TableCell class="text-center">
                <ToggleSwitch
                  checked={webhook.enabled}
                  onChange={() => toggleEnabled(webhook)}
                  aria-label={webhook.enabled
                    ? "Disable webhook"
                    : "Enable webhook"}
                />
              </TableCell>
              <TableCell class="w-1">
                <div class="inline-flex justify-end gap-2 flex-wrap xl:flex-nowrap">
                  {#if confirmingDelete === webhook.slug}
                    <Button size="sm" variant="destructive" onclick={() => deleteWebhook(webhook.slug)}>
                      Confirm
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onclick={() => {
                        confirmingDelete = null;
                      }}
                    >
                      Cancel
                    </Button>
                  {:else}
                    <Button size="sm" variant="outline" onclick={() => duplicateWebhook(webhook)}>
                      <CopySimpleIcon size={14} class="mr-1.5" aria-hidden="true" />
                      Duplicate
                    </Button>
                    <Button size="sm" variant="outline" onclick={() => openEditForm(webhook)}>
                      <PencilSimpleIcon size={14} class="mr-1.5" aria-hidden="true" />
                      Edit
                    </Button>
                    <div>
                      <Button size="sm" variant="destructive" onclick={() => { confirmingDelete = webhook.slug; }}>
                        <TrashIcon size={14} class="mr-1.5" aria-hidden="true" />
                        Delete
                      </Button>
                    </div>
                  {/if}
                </div>
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
