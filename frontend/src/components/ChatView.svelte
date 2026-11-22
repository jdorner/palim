<script lang="ts">
import ChatTextIcon from "phosphor-svelte/lib/ChatTextIcon";
import { onDestroy, onMount } from "svelte";
import { connected } from "$lib/appStore";
import { chatStream } from "$lib/chatStreamStore.svelte";
import { t } from "$lib/i18n.svelte";
import { modelStore } from "$lib/modelStore.svelte";
import { navigate } from "../router";
import ChatInput from "./ChatInput.svelte";
import ConversationList from "./ConversationList.svelte";
import ImportSessionsDialog from "./ImportSessionsDialog.svelte";
import MessageArea from "./MessageArea.svelte";

interface Props {
  conversationId?: string | null;
}

let { conversationId = null }: Props = $props();

let chatInputRef = $state<ChatInput | undefined>(undefined);
let importOpen = $state(false);
let importing = $state(false);

// Only show streaming UI when the stream targets the currently viewed conversation
let isStreamingHere = $derived(chatStream.activeStreaming);

onMount(async () => {
  chatStream.chatVisible = true;
  await chatStream.loadConversations();
  if (conversationId) {
    await chatStream.selectConversation(conversationId);
  } else if (chatStream.conversations.length > 0 && chatStream.conversations[0]) {
    await chatStream.selectConversation(chatStream.conversations[0].id);
  }
});

onDestroy(() => {
  chatStream.chatVisible = false;
});

// Sync route param changes to the store
$effect(() => {
  if (conversationId && conversationId !== chatStream.activeConversationId) {
    chatStream.selectConversation(conversationId);
  }
});

async function onCreate() {
  try {
    const id = await chatStream.handleCreate();
    navigate("/chat/:conversationId", { params: { conversationId: id } });
    chatInputRef?.focus();
  } catch (err) {
    console.error("Failed to create conversation:", err);
  }
}

async function onDelete(id: string) {
  try {
    const newId = await chatStream.handleDelete(id);
    if (newId) {
      navigate("/chat/:conversationId", { params: { conversationId: newId } });
    } else {
      navigate("/chat");
    }
  } catch (err) {
    console.error("Failed to delete conversation:", err);
  }
}

/**
 * Imports the picked server sessions one after another, then opens the first
 * one that was imported.
 * @param sessionIds - The server sessions to import, most recent first.
 */
async function onImport(sessionIds: string[]) {
  importing = true;
  let firstId: string | null = null;
  let failed = false;
  try {
    for (const sessionId of sessionIds) {
      const id = await chatStream.importSession(sessionId);
      firstId ??= id;
      if (!id) failed = true;
    }
  } finally {
    importing = false;
    importOpen = false;
  }
  if (firstId) {
    await chatStream.selectConversation(firstId);
    navigate("/chat/:conversationId", { params: { conversationId: firstId } });
  }
  // Each import clears the error; report a failure anywhere in the batch.
  if (failed) chatStream.error = t("chat.importFailed");
}

async function onSubmit(content: string) {
  const convId = await chatStream.handleSubmit(content);
  if (convId) {
    navigate("/chat/:conversationId", { params: { conversationId: convId } });
  }
}
</script>

<div class="flex h-full border border-border rounded-lg overflow-hidden">
  <div class="w-56 shrink-0">
    <ConversationList
      conversations={chatStream.conversations}
      activeId={chatStream.activeConversationId}
      onSelect={(id) => {
        chatStream.selectConversation(id);
        navigate("/chat/:conversationId", { params: { conversationId: id } });
      }}
      {onCreate}
      onRename={(id, title) => chatStream.handleRename(id, title)}
      {onDelete}
      onImport={() => {
        importOpen = true;
      }}
    />
  </div>

  <div class="flex-1 flex flex-col min-w-0">
    {#if chatStream.activeConversationId || isStreamingHere}
      <MessageArea
        messages={chatStream.messages}
        streaming={isStreamingHere}
        streamingContent={isStreamingHere ? chatStream.streamingContent : ""}
        activeTool={isStreamingHere ? chatStream.activeTool : null}
        streamSegments={isStreamingHere ? chatStream.streamSegments : []}
        error={chatStream.error}
        contextWindow={modelStore.contextWindow}
        disabled={!$connected}
        disconnected={!$connected}
        onRetry={() => chatStream.handleRetry()}
        onRegenerate={(msg) => chatStream.handleRegenerate(msg)}
        onDeleteMessage={(msg) => chatStream.handleDeleteMessage(msg)}
        onEditMessage={(msg, content) => chatStream.handleEditMessage(msg, content)}
      />

      <ChatInput
        bind:this={chatInputRef}
        disabled={isStreamingHere || !$connected}
        streaming={isStreamingHere}
        onsubmit={onSubmit}
        oncancel={() => chatStream.handleCancel()}
      />
    {:else}
      <div class="flex-1 flex items-center justify-center">
        <div class="text-center text-muted-foreground space-y-3">
          <ChatTextIcon class="w-12 h-12 mx-auto opacity-50" aria-hidden="true" />
          <p class="text-sm">{t("chat.emptyHint")}</p>
          <button type="button" class="text-sm text-primary hover:underline" onclick={onCreate}>
            {t("chat.newChat")}
          </button>
        </div>
      </div>
    {/if}
  </div>
</div>

<ImportSessionsDialog
  open={importOpen}
  {importing}
  onClose={() => {
    if (!importing) importOpen = false;
  }}
  {onImport}
/>
