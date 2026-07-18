<script lang="ts">
import ChatTextIcon from "phosphor-svelte/lib/ChatTextIcon";
import { onDestroy, onMount } from "svelte";
import { connected } from "$lib/appStore";
import { chatStream } from "$lib/chatStreamStore.svelte";
import { modelStore } from "$lib/modelStore.svelte";
import { navigate } from "../router";
import ChatInput from "./ChatInput.svelte";
import ConversationList from "./ConversationList.svelte";
import MessageArea from "./MessageArea.svelte";

interface Props {
  conversationId?: string | null;
}

let { conversationId = null }: Props = $props();

let chatInputRef = $state<ChatInput | undefined>(undefined);

// Only show streaming UI when the stream targets the currently viewed conversation
let isStreamingHere = $derived(chatStream.activeStreaming);

// Check if the active conversation is a feedback conversation (no downvote allowed)
let isFeedbackConversation = $derived(
  chatStream.conversations.find((c) => c.id === chatStream.activeConversationId)?.feedbackConversation ?? false,
);

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
        feedbackConversation={isFeedbackConversation}
        contextWindow={modelStore.contextWindow}
        disabled={!$connected}
        disconnected={!$connected}
        onRetry={() => chatStream.handleRetry()}
        onRegenerate={(msg) => chatStream.handleRegenerate(msg)}
        onDeleteMessage={(msg) => chatStream.handleDeleteMessage(msg)}
        onEditMessage={(msg, content) => chatStream.handleEditMessage(msg, content)}
        onDownvote={(msg, comment) => chatStream.handleDownvote(msg, comment)}
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
          <p class="text-sm">Start a new conversation to chat with the agent.</p>
          <button type="button" class="text-sm text-primary hover:underline" onclick={onCreate}>New Chat</button>
        </div>
      </div>
    {/if}
  </div>
</div>
