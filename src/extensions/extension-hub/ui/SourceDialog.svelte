<script lang="ts">
/** Adds or edits a source repository. */
import type { PalimHost } from "@ext/ui";
import { Button, Checkbox, Dialog, InfoTip, Label } from "@palim/ui";
import { errorText, INPUT_CLASS, request, type SourceInfo } from "./api";

let {
  palim,
  source = null,
  onSaved,
  onClose,
}: {
  palim: PalimHost;
  source?: SourceInfo | null;
  onSaved: () => void;
  onClose: () => void;
} = $props();
const i18n = palim.i18n;

// The dialog is recreated per source, so the initial values are read once.
const initial = source;
let name = $state(initial?.name ?? "");
let url = $state(initial?.url ?? "");
let branch = $state(initial?.branch ?? "");
let token = $state("");
let clearToken = $state(false);
let saving = $state(false);
let error: string | null = $state(null);

const canSave = $derived(!saving && name.trim() !== "" && url.trim() !== "");

async function save() {
  if (!canSave) return;
  saving = true;
  error = null;
  try {
    const body: Record<string, unknown> = { name: name.trim(), url: url.trim(), branch: branch.trim() || null };
    if (token.trim()) body.token = token.trim();
    else if (clearToken) body.token = null;
    const result = await request<{ error: string | null }>(
      palim,
      initial ? `/sources/${encodeURIComponent(initial.id)}` : "/sources",
      { method: initial ? "PUT" : "POST", body },
    );
    if (result.error) palim.notify(i18n.current.t("sources.fetchFailed", { error: result.error }), "error");
    else palim.notify(i18n.current.t("sources.saved", { name: name.trim() }), "success");
    onSaved();
  } catch (err) {
    error = errorText(err);
  } finally {
    saving = false;
  }
}
</script>

<Dialog
  open
  title={initial ? $i18n.t("sources.editTitle", { name: initial.name }) : $i18n.t("sources.addTitle")}
  class="max-w-lg"
  {onClose}
  onSave={save}
>
  <div class="space-y-4 p-4 text-sm">
    <div class="space-y-1.5">
      <Label for="hub-source-name">{$i18n.t("sources.name")}</Label>
      <input id="hub-source-name" class={INPUT_CLASS} bind:value={name} autocomplete="off">
    </div>
    <div class="space-y-1.5">
      <div class="flex items-center gap-1.5">
        <Label for="hub-source-url">{$i18n.t("sources.url")}</Label>
        <InfoTip text={$i18n.t("sources.urlHint")} />
      </div>
      <input
        id="hub-source-url"
        class="{INPUT_CLASS} font-mono"
        placeholder="ssh://git@git.example.com/team/palim-extensions.git"
        bind:value={url}
        autocomplete="off"
        spellcheck="false"
      >
    </div>
    <div class="space-y-1.5">
      <Label for="hub-source-branch">
        {$i18n.t("sources.branch")} <span class="text-muted-foreground">{$i18n.t("common.optional")}</span>
      </Label>
      <input
        id="hub-source-branch"
        class="{INPUT_CLASS} font-mono"
        placeholder={$i18n.t("sources.branchPlaceholder")}
        bind:value={branch}
        autocomplete="off"
        spellcheck="false"
      >
    </div>
    <div class="space-y-1.5">
      <div class="flex items-center gap-1.5">
        <Label for="hub-source-token">
          {$i18n.t("sources.token")} <span class="text-muted-foreground">{$i18n.t("common.optional")}</span>
        </Label>
        <InfoTip text={$i18n.t("sources.tokenHint")} />
      </div>
      <input
        id="hub-source-token"
        type="password"
        class={INPUT_CLASS}
        placeholder={initial?.hasToken ? $i18n.t("sources.tokenStored") : ""}
        bind:value={token}
        autocomplete="new-password"
      >
      {#if initial?.hasToken}
        <div class="flex items-center gap-2">
          <Checkbox id="hub-source-clear-token" bind:checked={clearToken} disabled={token.trim() !== ""} />
          <Label for="hub-source-clear-token" class="text-xs">{$i18n.t("sources.clearToken")}</Label>
        </div>
      {/if}
    </div>
    {#if error}
      <p class="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive">{error}</p>
    {/if}
  </div>

  {#snippet footer()}
    <Button size="sm" variant="outline" onclick={onClose}>{$i18n.t("common.cancel")}</Button>
    <Button size="sm" disabled={!canSave} onclick={save}>
      {saving ? $i18n.t("sources.fetching") : $i18n.t("common.save")}
    </Button>
  {/snippet}
</Dialog>
