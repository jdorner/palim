<script lang="ts">
import ArrowCounterClockwiseIcon from "phosphor-svelte/lib/ArrowCounterClockwiseIcon";
import BookOpenIcon from "phosphor-svelte/lib/BookOpenIcon";
import BrainIcon from "phosphor-svelte/lib/BrainIcon";
import CaretDownIcon from "phosphor-svelte/lib/CaretDownIcon";
import CaretRightIcon from "phosphor-svelte/lib/CaretRightIcon";
import PencilSimpleIcon from "phosphor-svelte/lib/PencilSimpleIcon";
import SpinnerGapIcon from "phosphor-svelte/lib/SpinnerGapIcon";
import TerminalIcon from "phosphor-svelte/lib/TerminalIcon";
import ThumbsDownIcon from "phosphor-svelte/lib/ThumbsDownIcon";
import TrashIcon from "phosphor-svelte/lib/TrashIcon";
import WrenchIcon from "phosphor-svelte/lib/WrenchIcon";
import { tick } from "svelte";
import { authFetch } from "$lib/auth";
import type { Message } from "$lib/chatStore";
import { updateMessageContent } from "$lib/chatStore";
import type { StreamSegment } from "$lib/chatStreamStore.svelte";
import { settings } from "$lib/settingsStore.svelte";
import { renderMarkdown } from "$lib/utils";
import ContextGauge from "./ContextGauge.svelte";
import PushSegment from "./PushSegment.svelte";

interface Props {
  messages?: Message[];
  streaming?: boolean;
  streamingContent?: string;
  activeTool?: string | null;
  streamSegments?: StreamSegment[];
  error?: string | null;
  feedbackConversation?: boolean;
  /** Context window size of the selected model (in tokens), for percentage display. */
  contextWindow?: number | null;
  /** Whether server-bound actions should be disabled (e.g. no connection). */
  disabled?: boolean;
  /** Whether the server connection is lost (shows overlay). */
  disconnected?: boolean;
  onRetry?: () => void;
  onRegenerate?: (msg: Message) => void;
  onDeleteMessage?: (msg: Message) => void;
  onEditMessage?: (msg: Message, newContent: string) => void;
  onDownvote?: (msg: Message, comment: string) => void;
}

let {
  messages = [],
  streaming = false,
  streamingContent = "",
  activeTool = null,
  streamSegments = [],
  error = null,
  feedbackConversation = false,
  contextWindow = null,
  disabled = false,
  disconnected = false,
  onRetry,
  onRegenerate,
  onDeleteMessage,
  onEditMessage,
  onDownvote,
}: Props = $props();

let container = $state<HTMLDivElement | undefined>(undefined);
let editingId = $state<string | null>(null);
let editValue = $state("");
let editTextareaEl = $state<HTMLTextAreaElement | undefined>(undefined);
let downvotingId = $state<string | null>(null);
let downvoteComment = $state("");
let downvoteInputEl = $state<HTMLInputElement | undefined>(undefined);

/** Tracks which thinking blocks have been toggled from their default state. */
let expandedThinking = $state<Set<string>>(new Set());

/**
 * Whether auto-scroll is active. Starts true, becomes false when the user
 * scrolls away from the bottom, and re-engages when they scroll back down.
 */
let userAtBottom = $state(true);

/** Returns true if the user is near the bottom of the container. */
function isNearBottom(): boolean {
  if (!container) return true;
  return container.scrollTop + container.clientHeight >= container.scrollHeight - 40;
}

/** Handles user scroll events to toggle auto-scroll behavior. */
function handleScroll() {
  userAtBottom = isNearBottom();
}

function toggleThinking(key: string) {
  const next = new Set(expandedThinking);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  expandedThinking = next;
}

/** Returns whether a thinking block should be shown expanded. */
function isThinkingExpanded(key: string): boolean {
  const toggled = expandedThinking.has(key);
  return settings.thinkingExpanded ? !toggled : toggled;
}

function scrollToBottom() {
  if (container && userAtBottom) {
    container.scrollTop = container.scrollHeight;
  }
}

/** Re-engage auto-scroll when a new streaming response starts. */
$effect(() => {
  if (streaming) {
    userAtBottom = true;
  }
});

$effect(() => {
  messages;
  streamingContent;
  streamSegments;
  error;
  scrollToBottom();
});

function startEdit(msg: Message) {
  editingId = msg.id;
  editValue = msg.content;
  tick().then(() => {
    if (editTextareaEl) {
      editTextareaEl.focus();
      autoResizeTextarea(editTextareaEl);
    }
  });
}

function autoResizeTextarea(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

function cancelEdit() {
  editingId = null;
  editValue = "";
}

function commitEdit(msg: Message) {
  const trimmed = editValue.trim();
  if (!trimmed) {
    cancelEdit();
    return;
  }
  onEditMessage?.(msg, trimmed);
  editingId = null;
  editValue = "";
}

function handleEditKeydown(e: KeyboardEvent, msg: Message) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (!disabled) commitEdit(msg);
  } else if (e.key === "Escape") {
    cancelEdit();
  }
}

function startDownvote(msg: Message) {
  downvotingId = msg.id;
  downvoteComment = "";
  tick().then(() => downvoteInputEl?.focus());
}

function cancelDownvote() {
  downvotingId = null;
  downvoteComment = "";
}

function submitDownvote(msg: Message) {
  onDownvote?.(msg, downvoteComment.trim());
  downvotingId = null;
  downvoteComment = "";
}

function handleDownvoteKeydown(e: KeyboardEvent, msg: Message) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submitDownvote(msg);
  } else if (e.key === "Escape") {
    cancelDownvote();
  }
}

/** Tracks which action segments have been executed (by message ID + segment index). */
let executedActions = $state<Set<string>>(new Set());

/**
 * Handles clicking an action button in a message segment.
 * Calls the endpoint, then replaces the actions segment with a result text.
 */
async function handleActionClick(endpoint: string, method: string, msgId: string, segIndex: number) {
  const key = `${msgId}-${segIndex}`;
  if (executedActions.has(key)) return;

  try {
    // Find the action to check if it has a body payload
    const msg = messages.find((m) => m.id === msgId);
    const seg = msg?.segments?.[segIndex];
    const action = seg?.type === "actions" ? seg.actions.find((a) => a.endpoint === endpoint) : undefined;

    const fetchInit: RequestInit = { method };
    if (action?.body) {
      fetchInit.headers = { "Content-Type": "application/json" };
      fetchInit.body = JSON.stringify(action.body);
    }

    const res = await authFetch(endpoint, fetchInit);
    const body = await res.json();
    const resultText = res.ok ? `✓ ${body.message || "Done"}` : `✗ ${body.error || `Failed (${res.status})`}`;

    executedActions = new Set([...executedActions, key]);

    // Update the message content to reflect the action result
    if (msg?.segments) {
      const updatedSegments = msg.segments.map((seg, i) =>
        i === segIndex ? { type: "text" as const, content: resultText } : seg,
      );
      // Mutate in place so Svelte 5 reactivity picks up the change immediately
      msg.segments = updatedSegments;
      await updateMessageContent(msgId, `${msg.content}\n\n${resultText}`, updatedSegments);
    }
  } catch (err) {
    console.error("Action failed:", err);
  }
}
</script>

<div
  bind:this={container}
  onscroll={handleScroll}
  class="flex-1 overflow-y-auto p-4 space-y-4 relative"
  role="log"
  aria-live="polite"
  aria-label="Chat messages"
>
  {#if disconnected}
    <div class="sticky top-0 z-10 flex justify-center pointer-events-none">
      <div
        class="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2 text-sm text-foreground shadow-md pointer-events-auto"
      >
        <span class="w-2 h-2 rounded-full bg-destructive animate-pulse"></span>
        Connection lost. Waiting for server&hellip;
      </div>
    </div>
  {/if}
  {#if messages.length === 0 && !streaming}
    <div class="flex items-center justify-center h-full text-muted-foreground text-sm">
      <p>No messages yet. Start a conversation below.</p>
    </div>
  {/if}

  {#each messages as msg, msgIndex (msg.id)}
    {#if msg.role === "user"}
      <!-- User message -->
      <div class="flex justify-end">
        <div
          class="rounded-lg px-4 py-2 text-sm bg-primary text-primary-foreground {editingId === msg.id ? 'max-w-full w-full' : 'max-w-[80%]'}"
        >
          {#if editingId === msg.id}
            <textarea
              bind:this={editTextareaEl}
              bind:value={editValue}
              onkeydown={(e) => handleEditKeydown(e, msg)}
              oninput={(e) => autoResizeTextarea(e.currentTarget)}
              class="w-full resize-none rounded border-0 border-primary-foreground/30 bg-primary/80 text-primary-foreground px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-primary-foreground/50 overflow-hidden"
              aria-label="Edit message"
            ></textarea>
            <div class="flex justify-end gap-1 mt-1">
              <button
                type="button"
                class="px-2 py-0.5 text-xs rounded bg-primary-foreground/20 text-primary-foreground hover:bg-primary-foreground/30 transition-colors"
                onclick={() => cancelEdit()}
              >
                Cancel
              </button>
              <button
                type="button"
                class="px-2 py-0.5 text-xs rounded bg-primary-foreground/20 text-primary-foreground hover:bg-primary-foreground/30 transition-colors disabled:opacity-50 disabled:pointer-events-none"
                onclick={() => commitEdit(msg)}
                {disabled}
              >
                Send
              </button>
            </div>
          {:else}
            <p class="whitespace-pre-wrap">{msg.content}</p>
          {/if}
        </div>
      </div>
      {#if !streaming && editingId !== msg.id && onEditMessage}
        <div class="flex justify-end pr-1">
          <button
            type="button"
            class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50 disabled:pointer-events-none"
            onclick={() => startEdit(msg)}
            {disabled}
            aria-label="Edit message"
          >
            <PencilSimpleIcon class="w-3 h-3" aria-hidden="true" />
            Edit
          </button>
          {#if onDeleteMessage}
            <button
              type="button"
              class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50 disabled:pointer-events-none"
              onclick={() => onDeleteMessage?.(msg)}
              {disabled}
              aria-label="Delete response"
            >
              <TrashIcon class="w-3 h-3" aria-hidden="true" />
              Delete
            </button>
          {/if}
        </div>
      {/if}
    {:else}
      <!-- Assistant message: render interleaved segments -->
      {#if msg.segments}
        {#each msg.segments as seg, si (si)}
          {#if seg.type === "text"}
            <div class="flex justify-start">
              <div
                class="rounded-lg px-4 py-2 text-sm bg-muted text-foreground prose prose-sm dark:prose-invert max-w-none"
              >
                <span class="markdown">{@html renderMarkdown(seg.content)}</span>
              </div>
            </div>
          {:else if seg.type === "thinking"}
            <div class="flex justify-start">
              <div class="max-w-[80%]">
                <button
                  type="button"
                  class="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors"
                  onclick={() => toggleThinking(`${msg.id}-${si}`)}
                  aria-expanded="{isThinkingExpanded(`${msg.id}-${si}`)}"
                  aria-label="Toggle thinking"
                >
                  {#if isThinkingExpanded(`${msg.id}-${si}`)}
                    <CaretDownIcon class="w-3 h-3 shrink-0" aria-hidden="true" />
                  {:else}
                    <CaretRightIcon class="w-3 h-3 shrink-0" aria-hidden="true" />
                  {/if}
                  <BrainIcon class="w-3 h-3 shrink-0" aria-hidden="true" />
                  <span>Thinking</span>
                </button>
                {#if isThinkingExpanded(`${msg.id}-${si}`)}
                  <div
                    class="mt-1 rounded-lg px-4 py-2 text-sm border border-border/50 bg-muted/30 text-muted-foreground prose prose-sm dark:prose-invert max-w-none italic"
                  >
                    <span class="markdown">{@html renderMarkdown(seg.content)}</span>
                  </div>
                {/if}
              </div>
            </div>
          {:else if seg.type === "tools"}
            <div class="flex justify-start">
              <div class="max-w-[80%] bg-none">
                <div class="flex flex-row flex-wrap gap-1">
                  {#each seg.tools as tc, j (j)}
                    <span
                      title={tc.summary}
                      class="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-mono text-muted-foreground border-muted border cursor-default"
                    >
                      {#if tc.summary.startsWith("skill read")}
                        <BookOpenIcon class="w-3 h-3 shrink-0" aria-hidden="true" />
                        <span class="truncate">{tc.summary.replace("skill read", "")}</span>
                      {:else if tc.name === "exec"}
                        <TerminalIcon class="w-3 h-3 shrink-0" aria-hidden="true" />
                        <span class="truncate">{tc.summary}</span>
                      {:else}
                        <WrenchIcon class="w-3 h-3 shrink-0" aria-hidden="true" />
                        <span class="truncate">{tc.name}</span>
                      {/if}
                    </span>
                  {/each}
                </div>
              </div>
            </div>
          {:else if seg.type === "actions"}
            <div class="flex justify-start">
              <div class="flex gap-2 mt-2">
                {#each seg.actions as action, j (j)}
                  <button
                    type="button"
                    class="inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors
                      {action.variant === 'destructive'
                        ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                        : 'bg-primary text-primary-foreground hover:bg-primary/90'}"
                    onclick={() => handleActionClick(action.endpoint, action.method, msg.id, si)}
                  >
                    {action.label}
                  </button>
                {/each}
              </div>
            </div>
          {:else if seg.type === "push"}
            <PushSegment content={seg.content} contentType={seg.contentType} />
          {/if}
        {/each}
      {/if}
      <!-- Assistant action buttons (hidden for system/action messages and executed actions) -->
      {#if !streaming && msg.role === "assistant" && !msg.segments?.some((s) => s.type === "actions") && !msg.segments?.some((_, i) => executedActions.has(`${msg.id}-${i}`))}
        <div class="flex justify-start pl-1 gap-0.5">
          {#if onRegenerate}
            <button
              type="button"
              class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50 disabled:pointer-events-none"
              onclick={() => onRegenerate?.(msg)}
              {disabled}
              aria-label="Regenerate response"
            >
              <ArrowCounterClockwiseIcon class="w-3 h-3" aria-hidden="true" />
              Regenerate
            </button>
          {/if}
          <!-- {#if onDownvote && !feedbackConversation}
            <button
              type="button"
              class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-orange-500 hover:bg-orange-500/10 transition-colors disabled:opacity-50 disabled:pointer-events-none"
              onclick={() => startDownvote(msg)}
              {disabled}
              aria-label="Downvote response"
            >
              <ThumbsDownIcon class="w-3 h-3" aria-hidden="true" />
              Downvote
            </button>
          {/if} -->
          {#if onDeleteMessage && msgIndex < messages.length - 1}
            <button
              type="button"
              class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50 disabled:pointer-events-none"
              onclick={() => onDeleteMessage?.(msg)}
              {disabled}
              aria-label="Delete response"
            >
              <TrashIcon class="w-3 h-3" aria-hidden="true" />
              Delete
            </button>
          {/if}
          {#if msg.usage && contextWindow && contextWindow > 0}
            <ContextGauge usedTokens={msg.usage.totalTokens} maxTokens={contextWindow} />
          {/if}
        </div>
        {#if downvotingId === msg.id}
          <div class="flex justify-start pl-1 mt-1">
            <div class="flex items-center gap-1.5 rounded-lg border border-border bg-muted/50 px-2 py-1.5 max-w-[80%]">
              <input
                bind:this={downvoteInputEl}
                bind:value={downvoteComment}
                onkeydown={(e) => handleDownvoteKeydown(e, msg)}
                type="text"
                placeholder="What went wrong? (optional)"
                class="flex-1 min-w-0 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
                aria-label="Feedback comment"
              >
              <button
                type="button"
                class="px-2 py-0.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                onclick={() => submitDownvote(msg)}
              >
                Send
              </button>
              <button
                type="button"
                class="px-2 py-0.5 text-xs rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                onclick={() => cancelDownvote()}
              >
                Cancel
              </button>
            </div>
          </div>
        {/if}
      {/if}
    {/if}
  {/each}

  <!-- Streaming: render interleaved segments -->
  {#if streaming}
    {#each streamSegments as seg, i (i)}
      {#if seg.type === "text"}
        <div class="flex justify-start">
          <div
            class="rounded-lg px-4 py-2 text-sm bg-muted text-foreground prose prose-sm dark:prose-invert max-w-none"
          >
            <span class="markdown">{@html renderMarkdown(seg.content)}</span>
          </div>
        </div>
      {:else if seg.type === "thinking"}
        {@const isActiveThinking = i === streamSegments.length - 1}
        <div class="flex justify-start">
          <div class="max-w-[80%]">
            <button
              type="button"
              class="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors"
              onclick={() => toggleThinking(`stream-${i}`)}
              aria-expanded="{isThinkingExpanded(`stream-${i}`)}"
              aria-label="Toggle thinking"
            >
              {#if isThinkingExpanded(`stream-${i}`)}
                <CaretDownIcon class="w-3 h-3 shrink-0" aria-hidden="true" />
              {:else}
                <CaretRightIcon class="w-3 h-3 shrink-0" aria-hidden="true" />
              {/if}
              <BrainIcon class="w-3 h-3 shrink-0 {isActiveThinking ? 'animate-pulse' : ''}" aria-hidden="true" />
              <span>{isActiveThinking ? "Thinking..." : "Thinking"}</span>
            </button>
            {#if isThinkingExpanded(`stream-${i}`)}
              <div
                class="mt-1 rounded-lg px-4 py-2 text-sm border border-border/50 bg-muted/30 text-muted-foreground prose prose-sm dark:prose-invert max-w-none italic"
              >
                <span class="markdown">{@html renderMarkdown(seg.content)}</span>
              </div>
            {/if}
          </div>
        </div>
      {:else if seg.type === "tools"}
        <div class="flex justify-start">
          <div class="max-w-[80%] bg-none">
            <div class="flex flex-row flex-wrap items-start gap-1">
              {#each seg.tools as tc, j (j)}
                <div
                  title={tc.summary}
                  class="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-mono border-muted border cursor-default
                    {tc.running ? 'text-primary' : 'text-muted-foreground'}"
                >
                  {#if tc.running}
                    <SpinnerGapIcon class="w-3 h-3 shrink-0 animate-spin" aria-hidden="true" />
                    <span class="truncate">{tc.summary}</span>
                  {:else if tc.summary.startsWith("skill read")}
                    <BookOpenIcon class="w-3 h-3 shrink-0" aria-hidden="true" />
                    <span class="truncate">{tc.summary.replace("skill read", "")}</span>
                  {:else if tc.name === "exec"}
                    <TerminalIcon class="w-3 h-3 shrink-0" aria-hidden="true" />
                    <span class="truncate">{tc.summary}</span>
                  {:else}
                    <WrenchIcon class="w-3 h-3 shrink-0" aria-hidden="true" />
                    <span class="truncate">{tc.name}</span>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        </div>
      {:else if seg.type === "push"}
        <PushSegment content={seg.content} contentType={seg.contentType} />
      {/if}
    {/each}
    <!-- Typing indicator: show whenever the agent isn't actively producing text or thinking
         (no segments yet, or the last segment is a tool-call group) -->
    {#if streamSegments.length === 0 || streamSegments[streamSegments.length - 1]?.type === "tools"}
      <div class="flex justify-start">
        <div class="max-w-[80%] rounded-lg px-4 py-2 text-sm bg-muted text-foreground prose prose-sm dark:prose-invert">
          <div class="flex items-center gap-2 text-xs text-muted-foreground">
            <span class="inline-flex gap-1">
              <span
                class="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce"
                style="animation-delay: 0ms"
              ></span>
              <span
                class="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce"
                style="animation-delay: 150ms"
              ></span>
              <span
                class="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce"
                style="animation-delay: 300ms"
              ></span>
            </span>
          </div>
        </div>
      </div>
    {/if}
  {/if}

  {#if error}
    <div class="flex justify-start">
      <div
        class="max-w-[80%] rounded-lg px-3 py-2 text-sm bg-red-100 dark:bg-red-500/25 text-red-700 dark:text-red-200 border border-red-300 dark:border-red-400/40"
      >
        <p>{error}</p>
        {#if onRetry}
          <button
            type="button"
            class="mt-2 inline-flex items-center gap-1.5 rounded-md bg-red-200 dark:bg-red-500/30 px-3 py-1 text-xs font-medium text-red-700 dark:text-red-200 hover:bg-red-300 dark:hover:bg-red-500/40 transition-colors disabled:opacity-50 disabled:pointer-events-none"
            onclick={onRetry}
            {disabled}
          >
            <ArrowCounterClockwiseIcon class="w-3 h-3" aria-hidden="true" />
            Retry
          </button>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
:global {
  .markdown h1 {
    margin-top: 1rem;
    margin-bottom: 0.5rem;
    font-size: x-large;
    font-weight: bold;
  }

  .markdown h2 {
    margin-top: 1rem;
    margin-bottom: 0.5rem;
    font-size: large;
    font-weight: bold;
  }

  .markdown h3 {
    margin-top: 1rem;
    margin-bottom: 0.5rem;
    font-size: medium;
    font-weight: bold;
  }

  .markdown p {
    padding-top: 0.5rem;
    padding-bottom: 0.5rem;
  }

  .markdown ol {
    padding-left: 2rem;
    list-style-type: decimal;
  }
  .markdown ul {
    padding-left: 2rem;
    list-style-type: none;
  }
  .markdown ul > li:before {
    content: "–";
    text-indent: -1em;
    display: inline-block;
  }
  .markdown li {
    padding-top: 0.25rem;
  }
  .markdown table thead th,
  .markdown table tfoot th {
    color: hsl(var(--muted-foreground));
    background: hsl(var(--muted-foreground) / 0.15);
  }
  .markdown table thead th,
  .markdown table td {
    padding: 0.4em;
    border: 1px solid hsl(var(--muted-foreground) / 0.3);
  }
  .markdown hr {
    border-color: hsl(var(--muted-foreground));
    margin-top: 1.5rem;
    margin-bottom: 1.5rem;
  }

  .markdown pre {
    border: 1px solid hsl(var(--muted-foreground));
    padding: 0.5rem;
    margin: 0.5rem;
    border-radius: 0.25rem;
    background: hsl(var(--muted-foreground) / 0.15);
  }

  .markdown code:not(pre code) {
    border-radius: 0.25rem;
    background-color: var(--color-background);
    padding: 0.1rem 0.2rem 0.1rem 0.2rem;
    text-wrap-mode: nowrap;
    font-size: 0.8rem;
  }
}
</style>
