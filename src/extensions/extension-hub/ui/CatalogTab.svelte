<script lang="ts">
/**
 * Catalog: extensions per source with their install state and actions
 * (install, update, change version, roll back, enable, uninstall), followed by
 * installs whose source or folder vanished and hand-placed local extensions.
 * Laid out like the MCP servers page: bordered table on desktop, cards below.
 */
import type { PalimHost } from "@ext/ui";
import {
  Badge,
  Button,
  LoadingIndicator,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  ToggleSwitch,
} from "@palim/ui";
import ArrowCircleUpIcon from "phosphor-svelte/lib/ArrowCircleUpIcon";
import ArrowCounterClockwiseIcon from "phosphor-svelte/lib/ArrowCounterClockwiseIcon";
import DownloadSimpleIcon from "phosphor-svelte/lib/DownloadSimpleIcon";
import GitBranchIcon from "phosphor-svelte/lib/GitBranchIcon";
import GitCommitIcon from "phosphor-svelte/lib/GitCommitIcon";
import TagIcon from "phosphor-svelte/lib/TagIcon";
import TrashIcon from "phosphor-svelte/lib/TrashIcon";
import WarningIcon from "phosphor-svelte/lib/WarningIcon";
import { onMount } from "svelte";
import { PAGE_ROUTE, UPDATES_CHANGED_EVENT } from "../events";
import {
  type CatalogEntry,
  type CatalogView,
  errorText,
  type InstalledView,
  type InstallResult,
  isInstallable,
  type ReplaceResult,
  request,
  shortSha,
  type VersionChoice,
} from "./api";
import VersionDialog from "./VersionDialog.svelte";

let { palim, canWrite }: { palim: PalimHost; canWrite: boolean } = $props();
const i18n = palim.i18n;

let view = $state<CatalogView | null>(null);
let loading = $state(true);
let loadError: string | null = $state(null);
/** Name of the extension an action is running for. */
let busy: string | null = $state(null);
let dialog: { entry: CatalogEntry; mode: "install" | "update" } | null = $state(null);

async function load() {
  try {
    view = await request<CatalogView>(palim, "/catalog");
    loadError = null;
  } catch (err) {
    loadError = errorText(err);
  } finally {
    loading = false;
  }
}

onMount(() => {
  load();
  return palim.onEvent((event) => {
    if (event === UPDATES_CHANGED_EVENT && !busy) load();
  });
});

/** Runs an action for one extension, then reloads the catalog. */
async function run(name: string, action: () => Promise<void>) {
  busy = name;
  try {
    await action();
  } catch (err) {
    palim.notify(errorText(err), "error");
  } finally {
    busy = null;
    await load();
  }
}

/** Reports a completed install/update/rollback. */
function report(name: string, result: InstallResult, key: "installed" | "updated" | "rolledBack") {
  const t = i18n.current.t;
  if (result.outcome.status === "timeout") {
    palim.notify(t("notify.stillLoading", { name }), "info");
  } else {
    palim.notify(t(`notify.${key}`, { name, version: result.install.version }), "success");
  }
  for (const warning of result.warnings) palim.notify(warning, "info");
}

async function submitDialog(choice: VersionChoice) {
  if (!dialog) return;
  const { entry, mode } = dialog;
  await run(entry.name, async () => {
    if (mode === "install") {
      const result = await request<InstallResult>(palim, "/install", {
        method: "POST",
        body: { sourceId: entry.sourceId, name: entry.name, ...choice },
      });
      report(entry.name, result, "installed");
    } else {
      const result = await request<ReplaceResult>(palim, `/installed/${encodeURIComponent(entry.name)}/update`, {
        method: "POST",
        body: choice,
      });
      report(entry.name, result, "updated");
    }
    dialog = null;
  });
}

async function quickUpdate(entry: CatalogEntry) {
  if (entry.installed?.modified) {
    dialog = { entry, mode: "update" };
    return;
  }
  await run(entry.name, async () => {
    const result = await request<ReplaceResult>(palim, `/installed/${encodeURIComponent(entry.name)}/update`, {
      method: "POST",
      body: {},
    });
    report(entry.name, result, "updated");
  });
}

async function rollback(name: string, installed: InstalledView) {
  const t = i18n.current.t;
  const ok = await palim.confirm({
    title: t("confirm.rollbackTitle", { name }),
    message: t("confirm.rollbackMessage", { from: installed.version, to: installed.previousVersion ?? "?" }),
    confirmLabel: t("actions.rollback"),
  });
  if (!ok) return;
  await run(name, async () => {
    const result = await request<ReplaceResult>(palim, `/installed/${encodeURIComponent(name)}/rollback`, {
      method: "POST",
    });
    report(name, result, "rolledBack");
  });
}

async function uninstall(name: string) {
  const t = i18n.current.t;
  const ok = await palim.confirm({
    title: t("confirm.uninstallTitle", { name }),
    message: t("confirm.uninstallMessage"),
    confirmLabel: t("actions.uninstall"),
    destructive: true,
  });
  if (!ok) return;
  await run(name, async () => {
    await request(palim, `/installed/${encodeURIComponent(name)}`, { method: "DELETE" });
    palim.notify(t("notify.uninstalled", { name }), "success");
  });
}

/** Enables or disables a loaded extension (the same switch as in the settings). */
async function setEnabled(name: string, extensionName: string, enabled: boolean) {
  await run(name, async () => {
    await request(palim, `/api/extensions/${encodeURIComponent(extensionName)}`, { method: "PUT", body: { enabled } });
    palim.notify(i18n.current.t(enabled ? "notify.enabled" : "notify.disabled", { name: extensionName }), "success");
  });
}

/** Why nothing of an extension can be installed (shown below its name). */
function problem(entry: CatalogEntry): string | null {
  if (entry.installed || entry.blockedByLocal || isInstallable(entry)) return null;
  return entry.head?.problem ?? entry.releases.find((r) => r.problem)?.problem ?? null;
}

const extensionCount = $derived(view?.sources.reduce((n, s) => n + s.extensions.length, 0) ?? 0);
</script>

<!-- Cell snippets, shared by the table and the card layout -->

{#snippet nameCell(
  entry: CatalogEntry,
)}
  {@const reason = problem(entry)}
  <span class="font-medium">{entry.name}</span>
  {#if entry.description}
    <p class="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{entry.description}</p>
  {/if}
  {#if reason}
    <p class="mt-0.5 flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
      <WarningIcon size={12} class="shrink-0" aria-hidden="true" />{reason}
    </p>
  {/if}
{/snippet}

<!--
  One rendering for "what a version is", used by both the Installed and the Latest
  column: release = tag icon + version, branch = branch icon + name + version,
  pinned commit = commit icon + short SHA + version. The full ref is the tooltip.
-->
{#snippet versionRef(
  kind: InstalledView["refKind"],
  ref: string,
  version: string | null,
)}
  <span class="inline-flex items-center gap-1 whitespace-nowrap text-xs" title={ref}>
    {#if kind === "tag"}
      <TagIcon size={12} class="text-muted-foreground" aria-hidden="true" />
      <span class="font-mono">{version ?? ref}</span>
    {:else}
      {#if kind === "branch"}
        <GitBranchIcon size={12} class="text-muted-foreground" aria-hidden="true" />
        <span class="font-mono">{ref}</span>
      {:else}
        <GitCommitIcon size={12} class="text-muted-foreground" aria-hidden="true" />
        <span class="font-mono">{shortSha(ref)}</span>
      {/if}
      {#if version}
        <span class="font-mono text-muted-foreground">{version}</span>
      {/if}
    {/if}
  </span>
{/snippet}

{#snippet installedCell(
  installed: InstalledView | null,
)}
  {#if installed}
    {@render versionRef(installed.refKind, installed.ref, installed.version)}
  {:else}
    <span class="text-muted-foreground">-</span>
  {/if}
{/snippet}

{#snippet availableCell(
  entry: CatalogEntry,
)}
  {#if entry.latest}
    {@render versionRef("tag", entry.latest.tag, entry.latest.version)}
  {:else if entry.head}
    {@render versionRef("branch", entry.head.branch, entry.head.version)}
  {:else}
    <span class="text-muted-foreground">-</span>
  {/if}
{/snippet}

{#snippet statusChips(
  entry: Partial<Pick<CatalogEntry, "update" | "blockedByLocal">>,
  installed: InstalledView | null,
)}
  <div class="flex flex-wrap gap-1">
    {#if entry.update}
      <Badge class="whitespace-nowrap"
        >{$i18n.t("status.updateAvailable", { version: entry.update.version ?? entry.update.ref })}</Badge
      >
    {/if}
    {#if installed}
      {#if !installed.loaded}
        <Badge class="whitespace-nowrap" variant="destructive" title={$i18n.t("status.notLoadedHint")}
          >{$i18n.t("status.notLoaded")}</Badge
        >
      {:else if installed.loaded.error}
        <Badge class="whitespace-nowrap" variant="destructive" title={installed.loaded.error}
          >{$i18n.t("status.error")}</Badge
        >
      {/if}
      {#if installed.modified}
        <Badge class="whitespace-nowrap" variant="warning-outline" title={$i18n.t("status.modifiedHint")}
          >{$i18n.t("status.modified")}</Badge
        >
      {/if}
      {#if installed.loaded && installed.loaded.version !== installed.version}
        <Badge
          class="whitespace-nowrap"
          variant="warning-outline"
          title={$i18n.t("status.versionMismatchHint", {
            manifest: installed.loaded.version,
            package: installed.version,
          })}
        >
          {$i18n.t("status.versionMismatch")}
        </Badge>
      {/if}
    {:else if entry.blockedByLocal}
      <Badge class="whitespace-nowrap" variant="outline" title={$i18n.t("status.localHint")}
        >{$i18n.t("status.local")}</Badge
      >
    {/if}
  </div>
{/snippet}

{#snippet enabledCell(
  name: string,
  installed: InstalledView | null,
)}
  {#if installed?.loaded && !installed.loaded.error}
    {@const loaded = installed.loaded}
    <ToggleSwitch
      checked={loaded.enabled}
      disabled={!canWrite || busy !== null}
      onChange={(checked) => setEnabled(name, loaded.name, checked)}
      aria-label={loaded.enabled ? $i18n.t("actions.disable") : $i18n.t("actions.enable")}
    />
  {:else}
    <span class="text-muted-foreground">-</span>
  {/if}
{/snippet}

{#snippet installedActions(
  name: string,
  installed: InstalledView,
)}
  {#if installed.canRollback}
    <Button
      size="sm"
      variant="outline"
      disabled={busy !== null}
      title={$i18n.t("actions.rollbackTo", { version: installed.previousVersion ?? "?" })}
      onclick={() => rollback(name, installed)}
    >
      <ArrowCounterClockwiseIcon size={14} class="mr-1.5" aria-hidden="true" />{$i18n.t("actions.rollback")}
    </Button>
  {/if}
  <Button size="sm" variant="destructive" disabled={busy !== null} onclick={() => uninstall(name)}>
    <TrashIcon size={14} class="mr-1.5" aria-hidden="true" />{$i18n.t("actions.uninstall")}
  </Button>
{/snippet}

{#snippet actions(
  entry: CatalogEntry,
)}
  {#if busy === entry.name}
    <span class="text-xs text-muted-foreground">{$i18n.t("dialog.working")}</span>
  {:else if entry.installed}
    {#if entry.update}
      <Button size="sm" disabled={busy !== null} onclick={() => quickUpdate(entry)}>
        <ArrowCircleUpIcon size={14} class="mr-1.5" aria-hidden="true" />{$i18n.t("actions.update")}
      </Button>
    {/if}
    <Button size="sm" variant="outline" disabled={busy !== null} onclick={() => (dialog = { entry, mode: "update" })}>
      <TagIcon size={14} class="mr-1.5" aria-hidden="true" />{$i18n.t("actions.changeVersion")}
    </Button>
    {@render installedActions(entry.name, entry.installed)}
  {:else if !entry.blockedByLocal && isInstallable(entry)}
    <Button size="sm" disabled={busy !== null} onclick={() => (dialog = { entry, mode: "install" })}>
      <DownloadSimpleIcon size={14} class="mr-1.5" aria-hidden="true" />{$i18n.t("actions.install")}
    </Button>
  {/if}
{/snippet}

{#if loading}
  <LoadingIndicator message={$i18n.t("catalog.loading")} />
{:else if loadError}
  <p class="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">{loadError}</p>
{:else if view}
  {#if view.sources.length === 0}
    <div class="space-y-3 py-8 text-center text-sm text-muted-foreground">
      <p>{$i18n.t("catalog.noSources")}</p>
      {#if canWrite}
        <Button size="sm" variant="outline" onclick={() => palim.navigate(`${PAGE_ROUTE}/sources`)}>
          {$i18n.t("catalog.addSource")}
        </Button>
      {/if}
    </div>
  {:else if extensionCount === 0 && view.sources.every((s) => !s.lastError)}
    <p class="text-sm text-muted-foreground">{$i18n.t("catalog.emptySource")}</p>
  {/if}

  <div class="space-y-6">
    {#each view.sources as source (source.id)}
      <section class="space-y-2">
        <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 class="text-sm font-semibold">{source.name}</h2>
          <span class="min-w-0 truncate font-mono text-xs text-muted-foreground" title={source.url}>{source.url}</span>
          {#if source.scannedBranch}
            <span class="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <GitBranchIcon size={12} aria-hidden="true" /><span class="font-mono">{source.scannedBranch}</span>
            </span>
          {/if}
          {#if source.lastFetchedAt}
            <span class="ml-auto text-xs text-muted-foreground">
              {$i18n.t("catalog.fetchedAt", { date: $i18n.format.date(source.lastFetchedAt) })}
            </span>
          {/if}
        </div>
        {#if source.lastError}
          <p class="text-xs text-destructive">{$i18n.t("catalog.fetchError", { error: source.lastError })}</p>
        {/if}

        {#if source.extensions.length > 0}
          <!-- Mobile & tablet: cards -->
          <div class="responsive-cards">
            {#each source.extensions as entry (entry.name)}
              <div class="space-y-3 rounded-md border border-border p-4">
                <div class="flex items-start justify-between gap-2">
                  <div class="min-w-0 flex-1">{@render nameCell(entry)}</div>
                  {@render enabledCell(entry.name, entry.installed)}
                </div>
                <div class="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                  <div>
                    <p class="text-xs text-muted-foreground">{$i18n.t("columns.installed")}</p>
                    {@render installedCell(entry.installed)}
                  </div>
                  <div>
                    <p class="text-xs text-muted-foreground">{$i18n.t("columns.latest")}</p>
                    {@render availableCell(entry)}
                  </div>
                  {@render statusChips(entry, entry.installed)}
                </div>
                {#if canWrite}
                  <div class="flex flex-wrap items-center gap-2">{@render actions(entry)}</div>
                {/if}
              </div>
            {/each}
          </div>

          <!-- Desktop: table -->
          <div class="responsive-table rounded-md border border-border">
            <Table>
              <TableHeader class="bg-muted/30">
                <TableRow>
                  <TableHead>{$i18n.t("columns.extension")}</TableHead>
                  <TableHead>{$i18n.t("columns.installed")}</TableHead>
                  <TableHead>{$i18n.t("columns.latest")}</TableHead>
                  <TableHead>{$i18n.t("columns.status")}</TableHead>
                  <TableHead class="text-center">{$i18n.t("columns.enabled")}</TableHead>
                  {#if canWrite}
                    <TableHead class="text-center">{$i18n.t("columns.actions")}</TableHead>
                  {/if}
                </TableRow>
              </TableHeader>
              <TableBody>
                {#each source.extensions as entry (entry.name)}
                  <TableRow>
                    <TableCell class="max-w-md">{@render nameCell(entry)}</TableCell>
                    <TableCell>{@render installedCell(entry.installed)}</TableCell>
                    <TableCell>{@render availableCell(entry)}</TableCell>
                    <TableCell>{@render statusChips(entry, entry.installed)}</TableCell>
                    <TableCell class="text-center">{@render enabledCell(entry.name, entry.installed)}</TableCell>
                    {#if canWrite}
                      <TableCell class="w-1 text-right">
                        <div class="inline-flex flex-wrap justify-end gap-2 xl:flex-nowrap">
                          {@render actions(entry)}
                        </div>
                      </TableCell>
                    {/if}
                  </TableRow>
                {/each}
              </TableBody>
            </Table>
          </div>
        {/if}
      </section>
    {/each}

    {#if view.orphans.length > 0}
      <section class="space-y-2">
        <div>
          <h2 class="text-sm font-semibold">{$i18n.t("orphans.title")}</h2>
          <p class="text-xs text-muted-foreground">{$i18n.t("orphans.hint")}</p>
        </div>
        <div class="divide-y divide-border rounded-md border border-border">
          {#each view.orphans as orphan (orphan.name)}
            <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div class="flex flex-wrap items-center gap-3">
                <span class="font-medium">{orphan.name}</span>
                <span class="font-mono text-xs text-muted-foreground">{orphan.installed.version}</span>
                {@render statusChips({}, orphan.installed)}
              </div>
              <div class="flex flex-wrap items-center gap-2">
                {@render enabledCell(orphan.name, orphan.installed)}
                {#if canWrite}
                  {@render installedActions(orphan.name, orphan.installed)}
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </section>
    {/if}

    {#if view.local.length > 0}
      <section class="space-y-2">
        <div>
          <h2 class="text-sm font-semibold">{$i18n.t("local.title")}</h2>
          <p class="text-xs text-muted-foreground">{$i18n.t("local.hint")}</p>
        </div>
        <div class="flex flex-wrap gap-1.5">
          {#each view.local as local (local.folder)}
            <Badge variant="outline" class="gap-1.5 font-normal">
              {local.folder}
              {#if local.loaded}
                <span class="font-mono text-muted-foreground">{local.loaded.version}</span>
              {:else}
                <span class="text-muted-foreground">{$i18n.t("status.notLoaded")}</span>
              {/if}
            </Badge>
          {/each}
        </div>
      </section>
    {/if}
  </div>
{/if}

{#if dialog}
  {#key dialog.entry.name}
    <VersionDialog
      {palim}
      entry={dialog.entry}
      mode={dialog.mode}
      busy={busy !== null}
      onSubmit={submitDialog}
      onClose={() => (dialog = null)}
    />
  {/key}
{/if}
