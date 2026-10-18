<script lang="ts">
/**
 * Picks what to install or update to: a release, the source branch head, or
 * any tag, branch, or commit ("custom ref").
 */
import type { PalimHost } from "@ext/ui";
import { Button, Checkbox, Dialog, Label } from "@palim/ui";
import { type CatalogEntry, INPUT_CLASS, refLabel, shortSha, type VersionChoice } from "./api";

let {
  palim,
  entry,
  mode,
  busy = false,
  onSubmit,
  onClose,
}: {
  palim: PalimHost;
  entry: CatalogEntry;
  mode: "install" | "update";
  busy?: boolean;
  onSubmit: (choice: VersionChoice) => void;
  onClose: () => void;
} = $props();
const i18n = palim.i18n;

const releases = $derived(entry.releases.filter((r) => r.installable));
const head = $derived(entry.head?.installable ? entry.head : null);
const installed = $derived(entry.installed);

/** Initial selection: the pending update, else the latest release, else the branch head. */
function initialChoice(): string {
  const preferred = entry.update?.ref ?? entry.latest?.tag;
  const release = entry.releases.find((r) => r.installable && r.tag === preferred);
  if (release) return `v:${release.version}`;
  if (entry.update && entry.update.ref === entry.head?.branch) return `r:${entry.update.ref}`;
  if (releases[0]) return `v:${releases[0].version}`;
  if (head) return `r:${head.branch}`;
  return "custom";
}

let choice = $state(initialChoice());
let customRef = $state("");
let force = $state(false);

const selectedRelease = $derived(
  choice.startsWith("v:") ? releases.find((r) => r.version === choice.slice(2)) : undefined,
);
const targetCommit = $derived(selectedRelease?.commit ?? (choice.startsWith("r:") ? head?.commit : undefined));
const sameAsInstalled = $derived(Boolean(installed && targetCommit && targetCommit === installed.commit));
const needsForce = $derived(mode === "update" && Boolean(installed?.modified));
const canSubmit = $derived(
  !busy && (choice !== "custom" || customRef.trim() !== "") && (!needsForce || force) && (!sameAsInstalled || force),
);

function submit() {
  if (!canSubmit) return;
  const result: VersionChoice = {};
  if (choice.startsWith("v:")) result.version = choice.slice(2);
  else if (choice.startsWith("r:")) result.ref = choice.slice(2);
  else result.ref = customRef.trim();
  if (force) result.force = true;
  onSubmit(result);
}

const title = $derived(
  mode === "install"
    ? $i18n.t("dialog.installTitle", { name: entry.name })
    : $i18n.t("dialog.updateTitle", { name: entry.name }),
);
</script>

<Dialog open {title} description={entry.description ?? undefined} class="max-w-lg" {onClose} onSave={submit}>
  <div class="space-y-4 p-4 text-sm">
    {#if installed}
      <p class="text-muted-foreground">
        {$i18n.t("dialog.installed", { version: installed.version, ref: refLabel(installed) })}
      </p>
    {/if}

    <div class="space-y-1.5">
      <Label for="hub-version">{$i18n.t("dialog.version")}</Label>
      <select id="hub-version" class={INPUT_CLASS} bind:value={choice}>
        {#each releases as release (release.tag)}
          <option value={`v:${release.version}`}>
            {release.version}{release.prerelease ? ` (${$i18n.t("dialog.prerelease")})` : ""}{release.tag ===
            entry.latest?.tag
              ? ` - ${$i18n.t("dialog.latest")}`
              : ""}
          </option>
        {/each}
        {#if head}
          <option value={`r:${head.branch}`}>
            {$i18n.t("dialog.branchHead", { branch: head.branch, version: head.version ?? "?" })}
          </option>
        {/if}
        <option value="custom">{$i18n.t("dialog.customRef")}</option>
      </select>
    </div>

    {#if choice === "custom"}
      <div class="space-y-1.5">
        <Label for="hub-ref">{$i18n.t("dialog.ref")}</Label>
        <input
          id="hub-ref"
          class="{INPUT_CLASS} font-mono"
          placeholder={$i18n.t("dialog.refPlaceholder")}
          bind:value={customRef}
          autocomplete="off"
          spellcheck="false"
        >
        <p class="text-xs text-muted-foreground">{$i18n.t("dialog.refHint")}</p>
      </div>
    {:else if targetCommit}
      <p class="text-xs text-muted-foreground">
        {$i18n.t("dialog.commit")} <code class="font-mono">{shortSha(targetCommit)}</code>
        {#if choice.startsWith("r:")}
          · {$i18n.t("dialog.followsBranch")}
        {/if}
      </p>
    {/if}

    {#if selectedRelease?.problem}
      <p class="rounded-md border border-yellow-500/30 px-3 py-2 text-xs text-yellow-700 dark:text-yellow-400">
        {selectedRelease.problem}
      </p>
    {/if}

    {#if needsForce || sameAsInstalled}
      <div class="space-y-2 rounded-md border border-destructive/40 px-3 py-2">
        <p class="text-xs text-destructive">
          {needsForce ? $i18n.t("dialog.modifiedWarning") : $i18n.t("dialog.sameWarning")}
        </p>
        <div class="flex items-center gap-2">
          <Checkbox id="hub-force" bind:checked={force} />
          <Label for="hub-force" class="text-xs">
            {needsForce ? $i18n.t("dialog.discardChanges") : $i18n.t("dialog.reinstall")}
          </Label>
        </div>
      </div>
    {/if}

    <p class="text-xs text-muted-foreground">{$i18n.t("dialog.trustHint")}</p>
  </div>

  {#snippet footer()}
    <Button size="sm" variant="outline" onclick={onClose}>{$i18n.t("common.cancel")}</Button>
    <Button size="sm" disabled={!canSubmit} onclick={submit}>
      {busy ? $i18n.t("dialog.working") : mode === "install" ? $i18n.t("actions.install") : $i18n.t("actions.update")}
    </Button>
  {/snippet}
</Dialog>
