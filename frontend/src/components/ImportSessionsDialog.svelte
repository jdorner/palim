<script lang="ts">
import { chatStream, type ServerChatSession } from "$lib/chatStreamStore.svelte";
import { Button } from "$lib/components/ui/button";
import { Checkbox } from "$lib/components/ui/checkbox";
import { Dialog } from "$lib/components/ui/dialog";
import { i18n, t } from "$lib/i18n.svelte";

interface Props {
  /** Whether the dialog is open. */
  open?: boolean;
  /** Whether the picked sessions are being imported (disables the dialog). */
  importing?: boolean;
  /** Called when the dialog is dismissed. */
  onClose?: () => void;
  /** Called with the server sessions the user picked, in list order (most recent first). */
  onImport?: (sessionIds: string[]) => void;
}

let { open = false, importing = false, onClose, onImport }: Props = $props();

let sessions = $state<ServerChatSession[]>([]);
let selected = $state<Set<string>>(new Set());
let loading = $state(false);
let failed = $state(false);

let allSelected = $derived(sessions.length > 0 && selected.size === sessions.length);

$effect(() => {
  if (!open) return;
  loading = true;
  failed = false;
  sessions = [];
  selected = new Set();
  chatStream
    .listImportableSessions()
    .then((list) => {
      sessions = list;
    })
    .catch((err) => {
      console.error("Failed to list server sessions:", err);
      failed = true;
    })
    .finally(() => {
      loading = false;
    });
});

/** Selects or deselects one session. */
function toggle(id: string, checked: boolean) {
  const next = new Set(selected);
  if (checked) next.add(id);
  else next.delete(id);
  selected = next;
}

/** Selects every session, or none. */
function toggleAll(checked: boolean) {
  selected = checked ? new Set(sessions.map((s) => s.id)) : new Set();
}

function submit() {
  if (selected.size === 0 || importing) return;
  onImport?.(sessions.filter((s) => selected.has(s.id)).map((s) => s.id));
}
</script>

<Dialog {open} title={t("chat.importTitle")} description={t("chat.importDescription")} class="max-w-2xl" {onClose}>
  {#if loading}
    <p class="text-sm text-muted-foreground">{t("common.loading")}</p>
  {:else if failed}
    <p class="text-sm text-destructive">{t("chat.importListFailed")}</p>
  {:else if sessions.length === 0}
    <p class="text-sm text-muted-foreground">{t("chat.importNone")}</p>
  {:else}
    <div class="flex items-center gap-3 px-2 pb-2 border-b border-border -mx-2">
      <Checkbox
        id="import-select-all"
        checked={allSelected}
        disabled={importing}
        onCheckedChange={(v) => toggleAll(v === true)}
      />
      <label for="import-select-all" class="text-sm font-medium cursor-pointer select-none">
        {t("chat.importSelectAll")}
      </label>
      <span class="ml-auto text-xs text-muted-foreground">
        {t("chat.importSelectedCount", { count: selected.size, total: sessions.length })}
      </span>
    </div>
    <ul class="divide-y divide-border -mx-2 max-h-[min(24rem,55vh)] overflow-y-auto">
      {#each sessions as session (session.id)}
        <li class="flex items-center gap-3 px-2 py-2 rounded hover:bg-accent/50 transition-colors">
          <Checkbox
            id={`import-${session.id}`}
            checked={selected.has(session.id)}
            disabled={importing}
            onCheckedChange={(v) => toggle(session.id, v === true)}
          />
          <label for={`import-${session.id}`} class="flex-1 min-w-0 cursor-pointer select-none">
            <span class="block text-sm truncate">{session.title || t("chat.newChat")}</span>
            <span class="block text-xs text-muted-foreground">
              {t("chat.importUpdated", { time: i18n.format.relative(session.updatedAt) })}
            </span>
          </label>
        </li>
      {/each}
    </ul>
  {/if}

  {#snippet footer()}
    <Button variant="outline" size="sm" disabled={importing} onclick={() => onClose?.()}>{t("common.cancel")}</Button>
    <Button size="sm" disabled={selected.size === 0 || importing} onclick={submit}>
      {importing ? t("chat.importing") : t("chat.importSubmit", { count: selected.size })}
    </Button>
  {/snippet}
</Dialog>
