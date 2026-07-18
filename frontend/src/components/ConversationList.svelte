<script lang="ts">
import PencilSimpleIcon from "phosphor-svelte/lib/PencilSimpleIcon";
import PlusIcon from "phosphor-svelte/lib/PlusIcon";
import TrashIcon from "phosphor-svelte/lib/TrashIcon";
import { tick } from "svelte";
import type { Conversation } from "$lib/chatStore";
import { AlertDialog } from "$lib/components/ui/alert-dialog";
import { Button } from "$lib/components/ui/button";
import { readState } from "$lib/readState.svelte";

interface Props {
  /** All conversations, expected sorted by most recent first. */
  conversations?: Conversation[];
  /** The currently active conversation ID. */
  activeId?: string | null;
  /** Callback when a conversation is selected. */
  onSelect?: (id: string) => void;
  /** Callback to create a new conversation. */
  onCreate?: () => void;
  /** Callback when a conversation is renamed. */
  onRename?: (id: string, title: string) => void;
  /** Callback when a conversation is deleted. */
  onDelete?: (id: string) => void;
}

let { conversations = [], activeId = null, onSelect, onCreate, onRename, onDelete }: Props = $props();

let renamingId = $state<string | null>(null);
let renameValue = $state("");
let renameInputEl = $state<HTMLInputElement | undefined>(undefined);
let confirmDeleteId = $state<string | null>(null);

/** Starts inline rename for a conversation. */
function startRename(conv: Conversation) {
  renamingId = conv.id;
  renameValue = conv.title;
  tick().then(() => renameInputEl?.focus());
}

/** Commits the rename. */
function commitRename(conv: Conversation) {
  if (conv.title === renameValue) {
    renamingId = null;
    return;
  }

  if (renamingId && renameValue.trim()) {
    onRename?.(renamingId, renameValue.trim());
  }
  renamingId = null;
}

/** Handles keydown in the rename input. */
function handleRenameKeydown(e: KeyboardEvent, conv: Conversation) {
  if (e.key === "Enter") {
    e.preventDefault();
    commitRename(conv);
  } else if (e.key === "Escape") {
    renamingId = null;
  }
}

/** The title of the conversation pending deletion (for the dialog). */
let deleteTitle = $derived(
  confirmDeleteId ? (conversations.find((c) => c.id === confirmDeleteId)?.title ?? "this conversation") : "",
);
</script>

<div class="flex flex-col h-full border-r border-border bg-muted/30">
  <div class="p-4 border-b border-border">
    <Button size="sm" variant="outline" class="w-full" onclick={() => onCreate?.()}>
      <PlusIcon class="w-4 h-4 mr-1.5" aria-hidden="true" />
      New Chat
    </Button>
  </div>

  <div class="flex-1 overflow-y-auto">
    {#if conversations.length === 0}
      <p class="text-xs text-muted-foreground text-center p-4">No conversations yet</p>
    {/if}

    {#each conversations as conv (conv.id)}
      <!-- biome-ignore lint/a11y/useSemanticElements: cannot use button element here due to nested rename/delete buttons inside -->
      <div
        role="button"
        tabindex="0"
        class="group flex items-center gap-1 px-3 py-2.5 text-sm cursor-pointer transition-colors
          {conv.id === activeId
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'}"
        onclick={() => onSelect?.(conv.id)}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect?.(conv.id); } }}
      >
        {#if renamingId === conv.id}
          <input
            bind:this={renameInputEl}
            type="text"
            bind:value={renameValue}
            onkeydown={(e) => handleRenameKeydown(e, conv)}
            onblur={() => commitRename(conv)}
            class="flex-1 min-w-0 bg-background border border-input rounded px-0 py-0 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            aria-label="Rename conversation"
          >
        {:else}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <span
            class="flex-1 min-w-0 border border-transparent {readState.isUnread(conv.id, conv.updatedAt) && conv.id !== activeId ? 'font-bold text-foreground' : ''}"
            title={conv.title}
          >
            <span class="block truncate">{conv.title}</span>
          </span>

          <div class="hidden group-hover:flex items-center gap-0.5 shrink-0">
            <button
              type="button"
              class="p-1 rounded hover:bg-muted transition-colors"
              title="Rename"
              onclick={(e) => {
                e.stopPropagation();
                startRename(conv);
              }}
              aria-label="Rename conversation {conv.title}"
            >
              <PencilSimpleIcon class="w-3 h-3" aria-hidden="true" />
            </button>
            <button
              type="button"
              class="p-1 rounded hover:bg-destructive/10 text-destructive transition-colors"
              title="Delete"
              onclick={(e) => {
                e.stopPropagation();
                confirmDeleteId = conv.id;
              }}
              aria-label="Delete conversation {conv.title}"
            >
              <TrashIcon class="w-3 h-3" aria-hidden="true" />
            </button>
          </div>
        {/if}
      </div>
    {/each}
  </div>
</div>

<AlertDialog
  open={confirmDeleteId !== null}
  title="Delete conversation"
  description={`Are you sure you want to delete "${deleteTitle}"? This cannot be undone.`}
  confirmLabel="Delete"
  cancelLabel="Cancel"
  confirmVariant="destructive"
  onConfirm={() => {
    if (confirmDeleteId) onDelete?.(confirmDeleteId);
    confirmDeleteId = null;
  }}
  onCancel={() => { confirmDeleteId = null; }}
/>
